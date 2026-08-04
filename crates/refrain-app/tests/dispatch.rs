//! 派发一次改写请求：从作者选中的一段正文，到若干个就绪的 Run。
//!
//! 这条链此前没有生产调用者——`AuthorizeDispatch` 只在测试里被构造过。
//! 界面拼不出它（要 `task_id`、要编译好的 `DispatchPackage`、要按位置排的
//! agent 列表），所以顺序知识收进 `refrain_app::dispatch`，这里逐条问它。
//!
//! 每条测试问的是一个**只在派发时成立**的性质：
//!
//! - 派发之后 Run 就绪，数量等于作者要的 agent 数。
//! - 选中的范围在派发那一刻必须还在稿子里（近失手：作者改过它）。
//! - 重复出现的原文不替作者选（近失手：F-02 曾把提案落在另一段上）。
//! - 空 agent、空范围各自具名拒绝，而不是派出一个什么也不做的 Run。

use std::fs;
use std::path::{Path, PathBuf};

use refrain_app::dispatch::{
    DispatchChannel, DispatchRequest, DispatchScope, Orchestration, dispatch,
};
use refrain_app::journal::StoreJournal;
use refrain_core::persona::Persona;
use refrain_core::{Id, Lineage, Manuscript, SourceSnapshot};
use refrain_host::host::AgentHost;
use refrain_host::run_edge::ResolvedEdge;
use refrain_host::staging::DirectoryContext;
use refrain_store::project::{ProjectStore, RootLocator};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;

const CHAPTER: &str = "章一.md";
const FIRST: &str = "剑一直握在他手里。";
const SECOND: &str = "他没有说话。";

fn scratch(body: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("refrain-dispatch-{}", Id::new()));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join(CHAPTER), body).unwrap();
    root
}

fn store_at(root: &Path) -> (Connection, ProjectStore) {
    let mut app = Connection::open_in_memory().unwrap();
    AppDb::migrate(&mut app).unwrap();
    let (store, _) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: root.to_path_buf(),
            kind: RootKind::Folder,
        },
    )
    .unwrap();
    (app, store)
}

fn manuscript_of(root: &Path) -> Manuscript {
    let bytes = fs::read(root.join(CHAPTER)).unwrap();
    let snapshot = SourceSnapshot::read(bytes);
    let lineage = Lineage::fresh(snapshot.block_count());
    Manuscript::open(snapshot, lineage).unwrap()
}

fn request(before: &str, agents: usize) -> DispatchRequest {
    DispatchRequest {
        document: CHAPTER.to_string(),
        prompt: "改克制些。".to_string(),
        scopes: vec![DispatchScope {
            label: "s1".to_string(),
            before: before.to_string(),
        }],
        agents,
        orchestration: Orchestration::Alternates,
        persona: None,
        channel: DispatchChannel::Harness,
        result_path: "result.md".to_string(),
        max_bytes: 64 * 1024,
    }
}

/// 跑一次派发，返回结果与铸出来的 Run 数。
fn run_dispatch(
    root: &Path,
    store: &mut ProjectStore,
    request: &DispatchRequest,
) -> Result<(Vec<Id>, u32), String> {
    let manuscript = manuscript_of(root);
    let context = DirectoryContext::new(store.layout().state_dir.clone());
    let mut host = AgentHost::open(StoreJournal { store }, context).unwrap();
    match dispatch(&mut host, &manuscript, request) {
        Ok(dispatched) => Ok((dispatched.runs, dispatched.prefix_bytes)),
        Err(error) => Err(error.to_string()),
    }
}

#[test]
fn dispatching_one_scope_mints_one_run_per_agent() {
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    let (_app, mut store) = store_at(&root);
    let (runs, prefix_bytes) = run_dispatch(&root, &mut store, &request(FIRST, 3)).unwrap();
    // 三个 agent 三个 Run：它们并列，读同一份请求，各写各的产出。
    assert_eq!(runs.len(), 3, "one run per agent");
    // 稳定前缀报的是字节，不是「已命中」——命中由 provider 决定，而这个
    // 进程不出网（D14）。这里只要求它真的算过：0 表示合同没有排在变化点前。
    assert!(prefix_bytes > 0, "the request has no stable prefix");
}

#[test]
fn a_scope_the_author_has_since_edited_refuses_before_the_agent_is_paid() {
    // 近失手：作者选了一段、去改了它、再回来点派发。派出去之后 agent 会照着
    // 一份指向不存在文本的请求改，而收取时才发现对不上——那时这次调用已经
    // 花掉了。所以失败必须发生在编译请求之前。
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    let (_app, mut store) = store_at(&root);
    let error = run_dispatch(&root, &mut store, &request("这一段稿子里没有。", 1)).unwrap_err();
    assert!(
        error.contains("no longer in the manuscript"),
        "unexpected refusal: {error}"
    );
}

#[test]
fn text_that_appears_twice_is_not_chosen_for_the_author() {
    // 近失手：副歌、空行、`}` 这类文字在同一份文件里反复出现。默认选第一处
    // 会把提案落在另一段上（F-02），而两段逐字相同，界面上分辨不出选错了。
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n\n{FIRST}\n"));
    let (_app, mut store) = store_at(&root);
    let error = run_dispatch(&root, &mut store, &request(FIRST, 1)).unwrap_err();
    assert!(
        error.contains("more than once") && error.contains("2 places"),
        "unexpected refusal: {error}"
    );
}

#[test]
fn a_dispatch_needs_someone_to_dispatch_to() {
    // 极端：零个 agent。铸不出 Run 的派发会开一个永远不动的 Task，
    // 而作者在名录上看到的是一行「等待中」。
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    let (_app, mut store) = store_at(&root);
    let error = run_dispatch(&root, &mut store, &request(FIRST, 0)).unwrap_err();
    assert!(error.contains("at least one agent"), "{error}");
}

#[test]
fn a_dispatch_needs_something_to_rewrite() {
    // 极端：一个范围也没选。没有范围的请求让 agent 无从下手，它会自己找
    // 一段来改——那正是「只有人类裁决能改正文」要防的事。
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    let (_app, mut store) = store_at(&root);
    let mut empty = request(FIRST, 1);
    empty.scopes.clear();
    let error = run_dispatch(&root, &mut store, &empty).unwrap_err();
    assert!(error.contains("select the text"), "{error}");
}

#[test]
fn two_dispatches_on_one_document_do_not_share_runs() {
    // 每次派发起自己的 Task，铸自己的 Run。共用会让第二次派发的产出
    // 落进第一次的 Run 里，而两次的请求并不相同。
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    let (_app, mut store) = store_at(&root);
    let (first, _) = run_dispatch(&root, &mut store, &request(FIRST, 2)).unwrap();
    let (second, _) = run_dispatch(&root, &mut store, &request(SECOND, 1)).unwrap();
    assert_eq!(first.len(), 2);
    assert_eq!(second.len(), 1);
    for run in &second {
        assert!(!first.contains(run), "the second dispatch reused a run");
    }
}

/// 用一个真实的 host 读回边：铸出来的 Run 上挂的是不是作者选的那种排法。
///
/// 返回 (这个 Run 的 id, 它的边指向谁)。host 在授权时已经把位置解析成了
/// Run id，所以这里按 id 核对拓扑——比按位置读更严，也更接近它真实的样子。
fn topology_of(
    root: &Path,
    store: &mut ProjectStore,
    orchestration: Orchestration,
    agents: usize,
) -> Vec<(Id, Option<(String, Id)>)> {
    let mut wanted = request(FIRST, agents);
    wanted.orchestration = orchestration;
    let manuscript = manuscript_of(root);
    let context = DirectoryContext::new(store.layout().state_dir.clone());
    let mut host = AgentHost::open(StoreJournal { store }, context).unwrap();
    dispatch(&mut host, &manuscript, &wanted).unwrap();
    host.runs()
        .iter()
        .map(|run| {
            let edge = run.edge.map(|edge| match edge {
                ResolvedEdge::Follows { upstream } => ("follows".to_string(), upstream),
                ResolvedEdge::Verifies { subject } => ("verifies".to_string(), subject),
                ResolvedEdge::Alternates { peer } => ("alternates".to_string(), peer),
            });
            (run.id, edge)
        })
        .collect()
}

#[test]
fn alternates_leaves_the_runs_unable_to_see_each_other() {
    // 「他们看不见彼此」正是没有边的含义。给并列的 Run 加一条边，它就
    // 不再是并列——而两种情况下 Run 的数量一样，名录上分辨不出来。
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    let (_app, mut store) = store_at(&root);
    let runs = topology_of(&root, &mut store, Orchestration::Alternates, 3);
    assert_eq!(runs.len(), 3);
    for (id, edge) in &runs {
        assert!(edge.is_none(), "run {id} sees another run");
    }
}

#[test]
fn follows_chains_each_run_onto_the_one_before_it() {
    // 作者的用例是「先列提纲，再照着写」。链断在中间，第三个就会在没有
    // 提纲的情况下开写，而它自己不知道少读了什么。
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    let (_app, mut store) = store_at(&root);
    let runs = topology_of(&root, &mut store, Orchestration::Follows, 3);
    assert!(runs[0].1.is_none(), "the first run has nothing to follow");
    for position in 1..3 {
        let (kind, target) = runs[position].1.clone().expect("a chained run has an edge");
        assert_eq!(kind, "follows");
        // 指向前一个，不是指向第一个：那是 `Verifies` 的形状。
        assert_eq!(
            target,
            runs[position - 1].0,
            "run {position} follows the wrong run"
        );
    }
}

#[test]
fn verifiers_all_check_the_writer_rather_than_each_other() {
    // 近失手：按 `Follows` 的形状排成一串，第三个会去检查第二个的批注——
    // 而批注不是被检查的对象，那一轮的产出因此毫无意义。两种排法都产生
    // 两条边，只有指向不同。
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    let (_app, mut store) = store_at(&root);
    let runs = topology_of(&root, &mut store, Orchestration::Verifies, 3);
    assert!(runs[0].1.is_none(), "the writer verifies nobody");
    for position in 1..3 {
        let (kind, target) = runs[position].1.clone().expect("a verifier has an edge");
        assert_eq!(kind, "verifies");
        assert_eq!(
            target, runs[0].0,
            "verifier {position} checks the wrong run"
        );
    }
}

#[test]
fn one_agent_never_carries_an_edge_whatever_the_author_picked() {
    // 极端：一个 agent 配 `Follows`。它没有上游可跟，一条指向自己的边
    // 会让这个 Run 永远等不到它的上游终态。
    //
    // 每种排法各用一份新 store：`host.runs()` 返回这个 Root 上累计的全部
    // Run，共用一份会让第二轮读到第一轮的那个，而断言仍然「通过」。
    for orchestration in [Orchestration::Follows, Orchestration::Verifies] {
        let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
        let (_app, mut store) = store_at(&root);
        let runs = topology_of(&root, &mut store, orchestration, 1);
        assert_eq!(runs.len(), 1);
        assert!(
            runs[0].1.is_none(),
            "{orchestration:?} gave a lone run an edge"
        );
    }
}

/// 派发一次并读回那份冻结的请求。
fn frozen_request(
    root: &Path,
    store: &mut ProjectStore,
    channel: DispatchChannel,
    persona: Option<Persona>,
) -> String {
    let mut wanted = request(FIRST, 1);
    wanted.channel = channel;
    wanted.persona = persona;
    let manuscript = manuscript_of(root);
    let state_dir = store.layout().state_dir.clone();
    let context = DirectoryContext::new(state_dir.clone());
    let mut host = AgentHost::open(StoreJournal { store }, context).unwrap();
    let dispatched = dispatch(&mut host, &manuscript, &wanted).unwrap();
    let run = dispatched.runs[0];
    fs::read_to_string(
        state_dir
            .join("dispatch")
            .join("staging")
            .join("requests")
            .join(format!("{run}.md")),
    )
    .unwrap()
}

#[test]
fn a_harness_dispatch_leaves_the_identity_to_agents_md() {
    // D14：两条路不得同时携带身份全文。Harness 通道的身份由 `AGENTS.md`
    // 承载（harness CLI 自己发现它），请求里一个字也不带——两边都带，
    // 同一份身份就投递了两次，此后各自漂移：作者改了设置，Agent 却还在
    // 按请求里那份旧的说话。
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    let (_app, mut store) = store_at(&root);
    let identity = "我是沈青，二十七岁，话很少。";
    let text = frozen_request(
        &root,
        &mut store,
        DispatchChannel::Harness,
        Some(Persona::Work {
            body: identity.to_string(),
        }),
    );
    assert!(
        !text.contains(identity),
        "the harness request carried the identity a second time:\n{text}"
    );
}

#[test]
fn a_manual_dispatch_carries_the_identity_because_nothing_else_will() {
    // 手动往返没有自动规则文件：不带，Agent 就完全不知道自己是谁。
    // 近失手：把两条路做成同一条（都不带／都带），其中一条必然错——
    // 而两次派发都「成功」，差别只在 Agent 的回答质量上。
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    let (_app, mut store) = store_at(&root);
    let identity = "我是沈青，二十七岁，话很少。";
    let text = frozen_request(
        &root,
        &mut store,
        DispatchChannel::Manual,
        Some(Persona::Work {
            body: identity.to_string(),
        }),
    );
    assert!(
        text.contains(identity),
        "the manual request has no identity at all:\n{text}"
    );
}
