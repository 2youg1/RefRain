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
    CarryMode, DispatchChannel, DispatchRequest, DispatchScope, Orchestration, RoundFacts,
    ScopeSpan, dispatch_round, preview_round, resolve_materials, round_facts, verdict_changes,
};
use refrain_app::journal::StoreJournal;
use refrain_core::digest::content_hex;
use refrain_core::material_listing::Disclosure;
use refrain_core::persona::Persona;
use refrain_core::{Id, Lineage, Manuscript, SourceSnapshot};
use refrain_host::adapters::{channel, channel_skill_bytes};
use refrain_host::host::AgentHost;
use refrain_host::run_edge::ResolvedEdge;
use refrain_host::staging::DirectoryContext;
use refrain_store::config::{AdapterKind, AgentProfile, Config, HarnessConnection};
use refrain_store::ledger::{VerdictKindName, VerdictRecord};
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
            blocks: None,
        }],
        agents,
        orchestration: Orchestration::Alternates,
        persona: None,
        channel: DispatchChannel::Harness,
        result_path: "result.md".to_string(),
        max_bytes: 64 * 1024,
        carry: CarryMode::None,
        materials: Vec::new(),
        agent: None,
        expected_digest: None,
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
    match dispatch_round(&mut host, &manuscript, request, &RoundFacts::default()) {
        Ok(dispatched) => Ok((dispatched.runs, dispatched.prefix_bytes)),
        Err(error) => Err(error.to_string()),
    }
}

#[test]
fn preview_compiles_the_package_and_a_stale_digest_refuses_the_dispatch() {
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    let (_app, mut store) = store_at(&root);
    let manuscript = manuscript_of(&root);
    let base = request(FIRST, 1);

    // 预览：编译出请求包（清单与 digest），不铸 Run。
    let package = preview_round(&manuscript, &base, &RoundFacts::default()).unwrap();
    assert!(
        !package.manifest.is_empty(),
        "the preview carries the section list"
    );
    assert!(!package.digest.is_empty(), "the preview carries the digest");

    // 送前核对：digest 对得上就放行。
    let mut matched = base.clone();
    matched.expected_digest = Some(package.digest.clone());
    run_dispatch(&root, &mut store, &matched).expect("a matching preview digest dispatches");

    // 对不上（预览之后稿子或资料变了的样子）就具名拒绝。
    let mut stale = base;
    stale.expected_digest = Some("not-the-digest".to_string());
    let error = run_dispatch(&root, &mut store, &stale).unwrap_err();
    assert!(
        error.contains("stale preview"),
        "the refusal names the stale preview: {error}"
    );
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
    dispatch_round(&mut host, &manuscript, &wanted, &RoundFacts::default()).unwrap();
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
fn frozen_request(root: &Path, store: &mut ProjectStore, wanted: &DispatchRequest) -> String {
    let manuscript = manuscript_of(root);
    let state_dir = store.layout().state_dir.clone();
    let context = DirectoryContext::new(state_dir.clone());
    let mut host = AgentHost::open(StoreJournal { store }, context).unwrap();
    let dispatched =
        dispatch_round(&mut host, &manuscript, wanted, &RoundFacts::default()).unwrap();
    staged_request(&state_dir, dispatched.runs[0])
}

fn staged_request(state_dir: &Path, run: Id) -> String {
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
    let mut wanted = request(FIRST, 1);
    wanted.persona = Some(Persona::Work {
        body: identity.to_string(),
    });
    let text = frozen_request(&root, &mut store, &wanted);
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
    let mut wanted = request(FIRST, 1);
    wanted.channel = DispatchChannel::Manual;
    wanted.persona = Some(Persona::Work {
        body: identity.to_string(),
    });
    let text = frozen_request(&root, &mut store, &wanted);
    assert!(
        text.contains(identity),
        "the manual request has no identity at all:\n{text}"
    );
}

// ── 资料勾选、接续轮与协议装载（v0.3 接通的三个休眠功能）──────────────────

/// 带上从 Config 与工作区查出的事实派发一次，读回那份冻结的请求。
fn dispatch_with_round(
    root: &Path,
    store: &mut ProjectStore,
    wanted: &DispatchRequest,
    config: &Config,
) -> String {
    let manuscript = manuscript_of(root);
    let state_dir = store.layout().state_dir.clone();
    let context = DirectoryContext::new(state_dir.clone());
    let materials = resolve_materials(store, &wanted.materials).unwrap();
    let round = round_facts(config, &context, wanted, materials).unwrap();
    let mut host = AgentHost::open(StoreJournal { store }, context).unwrap();
    let dispatched = dispatch_round(&mut host, &manuscript, wanted, &round).unwrap();
    staged_request(&state_dir, dispatched.runs[0])
}

fn config_with_agent(agent: Id, connection: Option<HarnessConnection>) -> Config {
    let mut config = Config::default();
    let connection_id = connection.as_ref().map(|one| one.id);
    if let Some(connection) = connection {
        config.harness_connections.push(connection);
    }
    config.agents.push(AgentProfile {
        id: agent,
        name: "甲".to_string(),
        connection_id,
        persona: None,
        argv: Vec::new(),
    });
    config
}

fn connection(kind: AdapterKind, skill_digest: Option<String>) -> HarnessConnection {
    HarnessConnection {
        id: Id::new(),
        adapter: kind,
        executable: PathBuf::from("kimi"),
        argv: Vec::new(),
        env_allow: Vec::new(),
        version: None,
        skill_digest,
    }
}

/// 勾选的资料以目录条目进冻结请求，档位取自名录——这里是 outline-only，
/// 正文一个字都不许走。
#[test]
fn a_ticked_material_rides_as_a_listing_with_the_catalogs_disclosure() {
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    fs::create_dir_all(root.join("资料")).unwrap();
    fs::write(
        root.join("资料/人物志.md"),
        "# 人物志\n\n陆沉舟，四十二岁。\n",
    )
    .unwrap();
    let (_app, mut store) = store_at(&root);
    store.refresh_documents().unwrap();
    store
        .set_disclosure("资料/人物志.md", Disclosure::OutlineOnly)
        .unwrap();

    let mut wanted = request(FIRST, 1);
    wanted.materials = vec!["资料/人物志.md".to_string()];
    let text = dispatch_with_round(&root, &mut store, &wanted, &Config::default());

    assert!(text.contains("<material path=\"资料/人物志.md\""), "{text}");
    assert!(text.contains("access=\"outline-only\""), "{text}");
    // 目录给的是作者写的标题结构；正文一个字也不许走。
    assert!(text.contains("<h level=\"1\">人物志</h>"), "{text}");
    assert!(
        !text.contains("陆沉舟"),
        "outline-only 的资料把正文泄漏进了请求:\n{text}"
    );
}

/// 与 outline-only 配对的近失手：同一份资料只差一档（默认 retrievable），
/// 摘录可以走，全文仍然不走——目录制的全部立意就是按需取回。
#[test]
fn a_retrievable_material_shows_an_excerpt_but_never_its_whole_body() {
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    fs::create_dir_all(root.join("资料")).unwrap();
    // 超过摘录上限（180 字节），让末尾那句成为「全文才有的地方」。
    let body = format!(
        "# 年表\n\n{}\n\n这一句在很后面，摘录够不着。",
        "开篇介绍。".repeat(40)
    );
    fs::write(root.join("资料/年表.md"), body).unwrap();
    let (_app, mut store) = store_at(&root);
    store.refresh_documents().unwrap();

    let mut wanted = request(FIRST, 1);
    wanted.materials = vec!["资料/年表.md".to_string()];
    let text = dispatch_with_round(&root, &mut store, &wanted, &Config::default());

    assert!(text.contains("access=\"retrievable\""), "{text}");
    assert!(text.contains("<excerpt>"), "{text}");
    assert!(text.contains("开篇介绍"), "{text}");
    assert!(
        !text.contains("这一句在很后面"),
        "retrievable 的资料把全文送上了请求，而不是等 Agent 来取:\n{text}"
    );
}

/// 近失手：请求替作者写了一个不在册的路径。静默忽略会让作者以为资料随了
/// 这一轮，而 Agent 根本没看见它。
#[test]
fn a_ticked_material_that_is_not_registered_is_a_typed_refusal() {
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    let (_app, mut store) = store_at(&root);
    store.refresh_documents().unwrap();

    let error = resolve_materials(&mut store, &["资料/没有.md".to_string()]).unwrap_err();
    assert!(
        error.to_string().contains("not registered"),
        "unexpected refusal: {error}"
    );
}

/// 同一个 Agent 的第二轮是接续轮：它的工作区里已有 Memo.md，请求必须把
/// 「没有上文」写在纸面上——不说，Agent 会把「没有上文」读成「本来就没有」。
#[test]
fn the_second_round_of_one_agent_is_marked_as_a_resumption() {
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    let (_app, mut store) = store_at(&root);
    let agent = Id::new();
    let config = config_with_agent(agent, None);
    let mut wanted = request(FIRST, 1);
    wanted.agent = Some(agent);

    // 首轮：还没有 Memo.md，请求不提接续——近失手：无条件写「接续轮」，
    // 第一次派发就会对着一段不存在的历史说话。
    let first = dispatch_with_round(&root, &mut store, &wanted, &config);
    assert!(!first.contains("接续轮"), "{first}");

    // Memo.md 是 Agent 自己的地盘：它在第一轮工作之后留下，应用只问在不在。
    let memo = store
        .layout()
        .state_dir
        .join("agents")
        .join(agent.to_string())
        .join("Memo.md");
    fs::create_dir_all(memo.parent().unwrap()).unwrap();
    fs::write(&memo, "上一轮：作者不接受设问句结尾。").unwrap();

    let second = dispatch_with_round(&root, &mut store, &wanted, &config);
    assert!(second.contains("此为接续轮"), "{second}");
    assert!(second.contains("Memo.md"), "{second}");
}

/// 请求具名了一个 Config 里不存在的 Agent。替它匿名派发会让 Run 落进一个
/// 与作者选择不同的身份下——具名拒绝。
#[test]
fn dispatching_under_an_agent_that_is_not_configured_is_refused() {
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    let (_app, store) = store_at(&root);
    let mut wanted = request(FIRST, 1);
    wanted.agent = Some(Id::new());

    let context = DirectoryContext::new(store.layout().state_dir.clone());
    let error = round_facts(&Config::default(), &context, &wanted, Vec::new()).unwrap_err();
    assert!(
        error.to_string().contains("not configured"),
        "unexpected refusal: {error}"
    );
}

/// 已装载连接的首轮：请求只带一行指向协议文件的话，不再内嵌全文
/// （协议装载，SPEC 8.4——装一次，省下的是每一轮都要付的字节）。
#[test]
fn an_installed_connection_turns_the_first_round_into_one_pointer_line() {
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    let (_app, mut store) = store_at(&root);
    let agent = Id::new();
    // 「已装载」的登记：摘要与本构建会写出的字节相等。
    let digest = content_hex(&channel_skill_bytes(
        channel("kimi-print").expect("registered"),
    ));
    let config = config_with_agent(agent, Some(connection(AdapterKind::KimiCode, Some(digest))));
    let mut wanted = request(FIRST, 1);
    wanted.agent = Some(agent);

    let text = dispatch_with_round(&root, &mut store, &wanted, &config);
    assert!(text.contains("协议已安装到"), "{text}");
    assert!(text.contains("SKILL.md"), "{text}");
    // 全文不再内嵌：材料目录的形状是全文独有的标记。
    assert!(
        !text.contains("<material path="),
        "已装载之后协议全文仍在请求里:\n{text}"
    );
}

/// 登记摘要对不上本构建：协议升级过，装的那份是旧的。请求要明说副本过期
/// 并照旧背全文——悄悄信任漂移过的字节，等于教 Agent 一套本构建已经不
/// 说的协议。
#[test]
fn a_stale_install_is_named_and_the_full_text_rides_anyway() {
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    let (_app, mut store) = store_at(&root);
    let agent = Id::new();
    let config = config_with_agent(
        agent,
        Some(connection(
            AdapterKind::KimiCode,
            Some("not-the-current-digest".to_string()),
        )),
    );
    let mut wanted = request(FIRST, 1);
    wanted.agent = Some(agent);

    let text = dispatch_with_round(&root, &mut store, &wanted, &config);
    assert!(text.contains("已过期"), "{text}");
    assert!(text.contains("<material path="), "{text}");
}

/// 已装载的接续轮：协议在 skill 目录、记忆在 Memo.md，都在 Agent 自己
/// 那边，请求只带一行指针。多带一个字都是每轮白付的字节。
#[test]
fn an_installed_agents_resumed_round_carries_only_the_pointer_line() {
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    let (_app, mut store) = store_at(&root);
    let agent = Id::new();
    let digest = content_hex(&channel_skill_bytes(
        channel("kimi-print").expect("registered"),
    ));
    let config = config_with_agent(agent, Some(connection(AdapterKind::KimiCode, Some(digest))));
    let mut wanted = request(FIRST, 1);
    wanted.agent = Some(agent);
    let memo = store
        .layout()
        .state_dir
        .join("agents")
        .join(agent.to_string())
        .join("Memo.md");
    fs::create_dir_all(memo.parent().unwrap()).unwrap();
    fs::write(&memo, "上一轮：作者不接受设问句结尾。").unwrap();

    let text = dispatch_with_round(&root, &mut store, &wanted, &config);
    assert!(text.contains("按 RefRain 兼容格式输出。"), "{text}");
    assert!(text.contains("此为接续轮"), "{text}");
    assert!(
        !text.contains("One <replacement> per scope at most"),
        "Pointer 档不该背短契约:\n{text}"
    );
    assert!(!text.contains("协议已安装到"), "{text}");
}

/// 近失手：把「有连接」当成「已装载」。`skill_digest` 是 `None` 时首轮
/// 必须照旧背短契约——未装载的既有规则一个字也不动。
#[test]
fn a_connection_that_was_never_installed_keeps_the_short_contract() {
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    let (_app, mut store) = store_at(&root);
    let agent = Id::new();
    let config = config_with_agent(agent, Some(connection(AdapterKind::KimiCode, None)));
    let mut wanted = request(FIRST, 1);
    wanted.agent = Some(agent);

    let text = dispatch_with_round(&root, &mut store, &wanted, &config);
    assert!(
        text.contains("One <replacement> per scope at most"),
        "未装载的首轮丢掉了短契约:\n{text}"
    );
    assert!(!text.contains("协议已安装到"), "{text}");
}

// ---------- 2.2 派发深度回迁：块段（DispatchScope.blocks）与带稿模式（carry） ----------

const THIRD: &str = "第三段写到这里。";

/// 带块段的请求：`before` 送空串，块由 Rust 取、原文由 Rust 拼。
fn span_request(from: u32, count: u32) -> DispatchRequest {
    let mut wanted = request(FIRST, 1);
    wanted.scopes = vec![DispatchScope {
        label: "s1".to_string(),
        before: String::new(),
        blocks: Some(ScopeSpan { from, count }),
    }];
    wanted
}

#[test]
fn a_block_span_scope_names_the_blocks_and_rust_joins_their_text() {
    let root = scratch(&format!(
        "{FIRST}

{SECOND}

{THIRD}
"
    ));
    let (_app, _store) = store_at(&root);
    let manuscript = manuscript_of(&root);
    let ids = manuscript.head().block_ids();
    assert_eq!(ids.len(), 3, "the fixture has three blocks");

    let package = preview_round(&manuscript, &span_request(1, 2), &RoundFacts::default())
        .expect("a span whose start block is present compiles");
    // 块 id 按顺序进 BeforeScope：从第二块起取两块。
    assert_eq!(package.scopes[0].blocks, vec![ids[1], ids[2]]);
    // 原文由 Rust 用稿子自己的分隔符拼回——界面送的空串被忽略。
    assert_eq!(
        package.scopes[0].text,
        format!(
            "{SECOND}

{THIRD}"
        )
    );
    assert!(
        package.request_md.contains(&format!(
            "{SECOND}

{THIRD}"
        )),
        "the joined before text lands in the request:
{}",
        package.request_md
    );
}

#[test]
fn a_block_span_whose_start_block_is_gone_is_a_named_refusal() {
    let root = scratch(&format!(
        "{FIRST}

{SECOND}
"
    ));
    let (_app, _store) = store_at(&root);
    let manuscript = manuscript_of(&root);

    // 起始序号越出稿子（清单过期或稿子被改短）：具名拒绝，不是拿别的块顶替。
    let error = preview_round(&manuscript, &span_request(99, 1), &RoundFacts::default())
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("start block is no longer in the manuscript"),
        "unexpected refusal: {error}"
    );
}

#[test]
fn a_block_span_past_the_end_clamps_to_the_last_block() {
    let root = scratch(&format!(
        "{FIRST}

{SECOND}

{THIRD}
"
    ));
    let (_app, _store) = store_at(&root);
    let manuscript = manuscript_of(&root);
    let ids = manuscript.head().block_ids();

    // 剩余不足 count 就取到末尾：作者指名的是「从这里起的这些块」。
    let package = preview_round(&manuscript, &span_request(1, 99), &RoundFacts::default())
        .expect("an over-long span clamps to the end");
    assert_eq!(package.scopes[0].blocks, vec![ids[1], ids[2]]);
    assert_eq!(
        package.scopes[0].text,
        format!(
            "{SECOND}

{THIRD}"
        )
    );
}

#[test]
fn a_block_span_of_zero_blocks_is_a_named_refusal() {
    let root = scratch(&format!(
        "{FIRST}

{SECOND}
"
    ));
    let (_app, _store) = store_at(&root);
    let manuscript = manuscript_of(&root);
    let error = preview_round(&manuscript, &span_request(0, 0), &RoundFacts::default())
        .unwrap_err()
        .to_string();
    assert!(error.contains("zero blocks"), "unexpected refusal: {error}");
}

#[test]
fn carry_full_embeds_the_whole_manuscript() {
    let root = scratch(&format!(
        "{FIRST}

{SECOND}
"
    ));
    let (_app, _store) = store_at(&root);
    let manuscript = manuscript_of(&root);
    let mut wanted = request(FIRST, 1);
    wanted.carry = CarryMode::Full;

    let package = preview_round(&manuscript, &wanted, &RoundFacts::default()).unwrap();
    // 全文进包：不在任何 scope 里的第二段也在。
    assert!(
        package.request_md.contains(FIRST) && package.request_md.contains(SECOND),
        "the full text rides the request:
{}",
        package.request_md
    );
    assert!(
        !package.request_md.contains("<changes>"),
        "full carry brings no verdict lines:
{}",
        package.request_md
    );
}

#[test]
fn carry_diff_embeds_the_verdict_lines_but_not_the_manuscript() {
    let root = scratch(&format!(
        "{FIRST}

{SECOND}
"
    ));
    let (_app, _store) = store_at(&root);
    let manuscript = manuscript_of(&root);
    let mut wanted = request(FIRST, 1);
    wanted.carry = CarryMode::Diff;
    let record = VerdictRecord {
        id: "v1".to_string(),
        proposal_id: "p1".to_string(),
        slice_id: "p1:0".to_string(),
        kind: VerdictKindName::AcceptModified,
        final_text: Some("改后的一段。".to_string()),
        reason: Some("语气".to_string()),
        decided_at: 7,
        legacy_baseline: None,
    };
    let round = RoundFacts {
        changes: verdict_changes(&[record]),
        ..RoundFacts::default()
    };

    let package = preview_round(&manuscript, &wanted, &round).unwrap();
    assert!(
        package.request_md.contains("<changes>")
            && package.request_md.contains("ref=\"p1:0\"")
            && package.request_md.contains("kind=\"accept-modified\""),
        "the verdict line rides the request:
{}",
        package.request_md
    );
    // 增量不带全文：不在 scope 里的第二段不出现。
    assert!(
        !package.request_md.contains(SECOND),
        "diff carry brings no full text:
{}",
        package.request_md
    );
}

#[test]
fn carry_none_keeps_the_old_payload_shape() {
    let root = scratch(&format!(
        "{FIRST}

{SECOND}
"
    ));
    let (_app, _store) = store_at(&root);
    let manuscript = manuscript_of(&root);
    // 旧载荷（没有 carry 这个词）= 旧行为：即使装配层递了裁决行也不进包。
    let wanted = request(FIRST, 1);
    assert_eq!(
        wanted.carry,
        CarryMode::None,
        "the wire default carries nothing"
    );
    let round = RoundFacts {
        changes: verdict_changes(&[VerdictRecord {
            id: "v1".to_string(),
            proposal_id: "p1".to_string(),
            slice_id: "p1:0".to_string(),
            kind: VerdictKindName::Accept,
            final_text: None,
            reason: None,
            decided_at: 7,
            legacy_baseline: None,
        }]),
        ..RoundFacts::default()
    };

    let package = preview_round(&manuscript, &wanted, &round).unwrap();
    assert!(
        !package.request_md.contains("<changes>") && !package.request_md.contains(SECOND),
        "none carries neither verdicts nor manuscript:
{}",
        package.request_md
    );
}

#[test]
fn verdict_lines_map_the_four_states_and_skip_countermands() {
    let record = |slice: &str, kind: VerdictKindName| VerdictRecord {
        id: format!("v-{slice}"),
        proposal_id: "p1".to_string(),
        slice_id: slice.to_string(),
        kind,
        final_text: None,
        reason: None,
        decided_at: 7,
        legacy_baseline: None,
    };
    let changes = verdict_changes(&[
        record("p1:0", VerdictKindName::Accept),
        record("p1:1", VerdictKindName::AcceptModified),
        record("p2:0", VerdictKindName::Reject),
        record("p3:0", VerdictKindName::CommentOnly),
        record("p4:0", VerdictKindName::Countermanded),
    ]);
    // 四态一一对应；冲销行进不了包——那笔决定已经不在正文里。
    let kinds: Vec<refrain_core::ChangeKind> = changes.iter().map(|change| change.kind).collect();
    assert_eq!(
        kinds,
        vec![
            refrain_core::ChangeKind::Accept,
            refrain_core::ChangeKind::AcceptModified,
            refrain_core::ChangeKind::Reject,
            refrain_core::ChangeKind::CommentOnly,
        ]
    );
    assert_eq!(changes[0].reference, "p1:0");
    assert!(changes.iter().all(|change| change.reference != "p4:0"));
}
