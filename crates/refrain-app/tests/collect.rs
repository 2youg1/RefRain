//! 收取一次派发的产出：那些此前只能开一个 Tauri 窗口才能问的规则。
//!
//! 这条流程在 `lib.rs` 里当过 182 行的命令体。它决定的每一件事都是领域规则——
//! 契约从哪里来、作者动过原文时怎么办、三步写入的顺序——而它们当时都没有一条
//! 测试，因为构造它们需要一个真实窗口。搬进用例层之后，下面每条各问一次。

use std::fs;
use std::path::{Path, PathBuf};

use refrain_app::collect::{Collected, collect_attempt};
use refrain_core::context_compiler::DispatchPackage;
use refrain_core::{Id, Lineage, Manuscript, SourceSnapshot};
use refrain_host::host::{AgentHost, HostCommand, Run, RunProgress, TaskProgress};
use refrain_store::project::{ProjectStore, RootLocator};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;

const CHAPTER: &str = "章一.md";
const FIRST: &str = "剑没有松。";
const SECOND: &str = "他久久没有说话。";

fn scratch() -> PathBuf {
    let root = std::env::temp_dir().join(format!("refrain-collect-{}", Id::new()));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join(CHAPTER), format!("{FIRST}\n\n{SECOND}\n")).unwrap();
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

/// 铺出一次派发留下的现场：冻结的请求，以及生产者回来的结果。
///
/// 不走完整的派发链路。那条链路自己有测试，而这里要问的是收取——把它需要的
/// 目录结构直接铺出来，测试就只会因为收取的逻辑而失败。
fn stage(state_dir: &Path, workspace: &str, run_id: Id, before: &str, reply: &str) {
    let dir = state_dir.join(workspace);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("request.md"),
        format!("# Before\n\n<!-- scope ch01:b1 -->\n{before}\n"),
    )
    .unwrap();
    let attempt = dir.join("attempts").join(run_id.to_string());
    fs::create_dir_all(&attempt).unwrap();
    fs::write(attempt.join("result.md"), reply).unwrap();
}

fn replacement(text: &str) -> String {
    format!(
        "<agent-result version=\"2\"><replacement scope=\"ch01:b1\"><![CDATA[{text}]]></replacement></agent-result>"
    )
}

/// 在 host 里造出一个已经发出去、正在等结果的 Run。
fn dispatched_run(store: &mut ProjectStore, workspace: &str) -> Id {
    let context = refrain_host::staging::DirectoryContext::new(store.layout().state_dir.clone());
    let mut host = AgentHost::open(refrain_app::journal::StoreJournal { store }, context).unwrap();
    let baseline = Id::new();
    host.execute(HostCommand::DraftTask {
        baseline,
        document: CHAPTER.to_string(),
        prompt: "看看这一段。".to_string(),
        context_digest: "digest".to_string(),
    })
    .unwrap();
    let task_id = host.tasks()[0].id;
    let agent = Id::new();
    host.execute(HostCommand::AuthorizeDispatch {
        task_id,
        new_agents: vec![agent],
        retry_runs: vec![],
        edges: Vec::new(),
        package: DispatchPackage {
            request_md: String::new(),
            manifest: vec![],
            digest: "package".to_string(),
        },
        // 点下去的必须就是被授权的那一份：host 会比对这两个 digest。
        clicked_digest: "package".to_string(),
        authorized_at: 1,
    })
    .unwrap();
    let run_id = host.runs()[0].id;
    host.execute(HostCommand::LaunchRun {
        run_id,
        workspace: workspace.to_string(),
    })
    .unwrap();
    // 只有真正发出去的 Run 才谈得上收取，所以夹具要走到 Dispatched。
    host.execute(HostCommand::CompleteDispatch {
        run_id,
        receipt: "receipt".to_string(),
    })
    .unwrap();
    run_id
}

#[test]
fn a_result_that_has_not_landed_moves_nothing() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let run_id = dispatched_run(&mut store, "runs/one");
    let manuscripts = [(CHAPTER.to_string(), manuscript_of(&root))]
        .into_iter()
        .collect();

    let collected = collect_attempt(&mut store, &manuscripts, run_id, 10).unwrap();

    assert_eq!(collected, Collected::Waiting);
}

#[test]
fn a_replacement_whose_scope_text_still_matches_becomes_a_proposal() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let state_dir = store.layout().state_dir.clone();
    let run_id = dispatched_run(&mut store, "runs/one");
    stage(
        &state_dir,
        "runs/one",
        run_id,
        FIRST,
        &replacement("剑一直握着。"),
    );
    let manuscripts = [(CHAPTER.to_string(), manuscript_of(&root))]
        .into_iter()
        .collect();

    let collected = collect_attempt(&mut store, &manuscripts, run_id, 10).unwrap();

    assert_eq!(
        collected,
        Collected::Completed {
            proposals: 1,
            memos: 0,
            drafts: 0,
        }
    );
    assert_eq!(store.proposals_for(CHAPTER).unwrap().len(), 1);
}

#[test]
fn a_scope_the_author_has_since_edited_fails_rather_than_guesses() {
    // 派发时冻结的原文，与现在稿子里的字不再逐字相同。此时把提案套在任何一段
    // 上都是猜——这一路必须失败，并说出是哪个范围。
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let state_dir = store.layout().state_dir.clone();
    let run_id = dispatched_run(&mut store, "runs/one");
    stage(
        &state_dir,
        "runs/one",
        run_id,
        "作者后来改掉了的一段原文。",
        &replacement("无处安放的替换。"),
    );
    let manuscripts = [(CHAPTER.to_string(), manuscript_of(&root))]
        .into_iter()
        .collect();

    let collected = collect_attempt(&mut store, &manuscripts, run_id, 10).unwrap();

    assert_eq!(
        collected,
        Collected::Failed {
            code: "scope-text-moved".to_string(),
            detail: "ch01:b1".to_string(),
        }
    );
    assert!(store.proposals_for(CHAPTER).unwrap().is_empty());
}

#[test]
fn a_scope_the_frozen_request_never_carried_is_refused() {
    // 契约来自冻结的请求，不来自结果自己的声称（SPEC 8.4）：结果指名一个请求
    // 里没有的范围时，不能因为它这么说就接受。
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let state_dir = store.layout().state_dir.clone();
    let run_id = dispatched_run(&mut store, "runs/one");
    let reply = "<agent-result version=\"2\"><replacement scope=\"ch01:b9\"><![CDATA[凭空一段。]]></replacement></agent-result>";
    stage(&state_dir, "runs/one", run_id, FIRST, reply);
    let manuscripts = [(CHAPTER.to_string(), manuscript_of(&root))]
        .into_iter()
        .collect();

    let collected = collect_attempt(&mut store, &manuscripts, run_id, 10).unwrap();

    match collected {
        Collected::Failed { code, .. } => assert_ne!(code, "scope-text-moved"),
        other => panic!("a scope outside the contract was accepted: {other:?}"),
    }
    assert!(store.proposals_for(CHAPTER).unwrap().is_empty());
}

#[test]
fn collecting_into_a_document_that_is_not_open_refuses() {
    // 块 id 只存在于打开着的那份稿子里。没有它就无法把原文对回具体的块，
    // 此时应当说明情况，而不是写一份指向不存在的块的提案。
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let state_dir = store.layout().state_dir.clone();
    let run_id = dispatched_run(&mut store, "runs/one");
    stage(
        &state_dir,
        "runs/one",
        run_id,
        FIRST,
        &replacement("剑一直握着。"),
    );
    let manuscripts = std::collections::HashMap::new();

    let error = collect_attempt(&mut store, &manuscripts, run_id, 10).unwrap_err();

    assert!(
        error.to_string().contains(CHAPTER),
        "the refusal should name the document: {error}"
    );
}

#[test]
fn a_run_this_project_does_not_have_refuses() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let manuscripts = [(CHAPTER.to_string(), manuscript_of(&root))]
        .into_iter()
        .collect();

    let stranger = Id::new();
    let error = collect_attempt(&mut store, &manuscripts, stranger, 10).unwrap_err();

    assert!(
        error.to_string().contains(&stranger.to_string()),
        "the refusal should name the run: {error}"
    );
}

#[test]
fn a_failed_collect_is_written_to_the_run_not_only_returned() {
    // 失败是产品要展示的事实：Run 的历史里必须留下这一次，否则作者只在一次
    // 调用的返回值里见过它。
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let state_dir = store.layout().state_dir.clone();
    let run_id = dispatched_run(&mut store, "runs/one");
    stage(
        &state_dir,
        "runs/one",
        run_id,
        "作者后来改掉了的一段原文。",
        &replacement("无处安放的替换。"),
    );
    let manuscripts = [(CHAPTER.to_string(), manuscript_of(&root))]
        .into_iter()
        .collect();

    collect_attempt(&mut store, &manuscripts, run_id, 10).unwrap();

    let context = refrain_host::staging::DirectoryContext::new(state_dir);
    let host = AgentHost::open(
        refrain_app::journal::StoreJournal { store: &mut store },
        context,
    )
    .unwrap();
    let run: &Run = host.runs().iter().find(|run| run.id == run_id).unwrap();
    assert!(
        matches!(run.progress, RunProgress::Failed { .. }),
        "the run should carry the failure, found {:?}",
        run.progress
    );
    assert!(matches!(
        host.tasks()[0].progress,
        TaskProgress::Open { .. } | TaskProgress::Draft
    ));
}
