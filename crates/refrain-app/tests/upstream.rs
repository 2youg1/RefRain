//! 上游产物的另一半：下游启动时，它的请求里真的有上游写下的全部字节。

use std::fs;
use std::path::{Path, PathBuf};

use refrain_app::upstream::feed_upstream;
use refrain_core::Id;
use refrain_core::context_compiler::DispatchPackage;
use refrain_host::host::{AgentHost, HostCommand};
use refrain_host::run_edge::RunEdge;
use refrain_host::staging::DirectoryContext;
use refrain_store::project::{ProjectStore, RootLocator};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;

const CHAPTER: &str = "章一.md";
const FIRST: &str = "剑一直握在他手里。";

fn scratch() -> PathBuf {
    let root = std::env::temp_dir().join(format!("refrain-upstream-{}", Id::new()));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join(CHAPTER), format!("{FIRST}\n\n他没有说话。\n")).unwrap();
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

fn package() -> DispatchPackage {
    DispatchPackage {
        scopes: Vec::new(),
        request_md: format!(
            "# Before\n\n<!-- scope ch01:b1 -->\n{FIRST}\n\n# Request\n\n改克制些。\n"
        ),
        manifest: vec![],
        digest: "package-upstream".to_string(),
    }
}

/// 授权两个 Run：第二个 Follows 第一个。返回两个 Run 的 id。
fn authorize(store: &mut ProjectStore) -> [Id; 2] {
    let context = DirectoryContext::new(store.layout().state_dir.clone());
    let mut host = AgentHost::open(refrain_app::journal::StoreJournal { store }, context).unwrap();
    host.execute(HostCommand::DraftTask {
        baseline: Id::new(),
        document: CHAPTER.to_string(),
        prompt: "看看这一段。".to_string(),
        context_digest: "digest".to_string(),
    })
    .unwrap();
    let task_id = host.tasks()[0].id;
    host.execute(HostCommand::AuthorizeDispatch {
        task_id,
        new_agents: vec![Id::new(), Id::new()],
        retry_runs: vec![],
        edges: vec![None, Some(RunEdge::Follows { upstream: 0 })],
        package: package(),
        clicked_digest: "package-upstream".to_string(),
        authorized_at: 1,
    })
    .unwrap();
    [host.runs()[0].id, host.runs()[1].id]
}

/// 把上游跑到终态：launch，再亲手把产出放进它的 attempt 目录，然后终态化。
fn complete(store: &mut ProjectStore, run_id: Id, artifact: &str) {
    let state_dir = store.layout().state_dir.clone();
    let context = DirectoryContext::new(state_dir.clone());
    let mut host = AgentHost::open(refrain_app::journal::StoreJournal { store }, context).unwrap();
    let workspace = format!("runs/{run_id}");
    host.execute(HostCommand::LaunchRun {
        run_id,
        workspace: workspace.clone(),
    })
    .unwrap();
    host.execute(HostCommand::CompleteDispatch {
        run_id,
        receipt: "receipt".to_string(),
    })
    .unwrap();
    let attempt = state_dir
        .join(&workspace)
        .join("attempts")
        .join(run_id.to_string());
    fs::create_dir_all(&attempt).unwrap();
    fs::write(attempt.join("result.md"), artifact).unwrap();
    host.execute(HostCommand::CollectAttempt {
        run_id,
        artifact_digest: "digest".to_string(),
        at: 2,
    })
    .unwrap();
}

#[test]
fn a_follows_request_carries_the_upstream_artifact_at_launch() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let [upstream_id, downstream_id] = authorize(&mut store);
    let artifact = "他握着剑，没有说话。".repeat(500);
    complete(&mut store, upstream_id, &artifact);

    // 下游启动：先 launch（提升冻结请求），再喂上游——与桌面的两条路径同序。
    let state_dir = store.layout().state_dir.clone();
    {
        let context = DirectoryContext::new(state_dir.clone());
        let mut host = AgentHost::open(
            refrain_app::journal::StoreJournal { store: &mut store },
            context,
        )
        .unwrap();
        host.execute(HostCommand::LaunchRun {
            run_id: downstream_id,
            workspace: format!("runs/{downstream_id}"),
        })
        .unwrap();
    }
    let fed = feed_upstream(&mut store, downstream_id).unwrap();
    assert!(fed, "有边的 Run 启动时必须真的喂进上游");

    let context = DirectoryContext::new(state_dir);
    let request = context
        .read_workspace_request(&format!("runs/{downstream_id}"))
        .unwrap()
        .expect("提升之后请求必须在工作区里");
    assert!(
        request.contains(&artifact),
        "下游的请求里必须有上游写下的全部字节"
    );
    assert!(
        request.contains("<upstream"),
        "这一节必须说出来源——下游读的不是作者的话"
    );
    // 冻结的原文也还在：喂上游不是替换，是加一节。
    assert!(request.contains("# Request"));

    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_run_without_an_edge_is_left_untouched() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let context = DirectoryContext::new(store.layout().state_dir.clone());
    let mut host = AgentHost::open(
        refrain_app::journal::StoreJournal { store: &mut store },
        context,
    )
    .unwrap();
    host.execute(HostCommand::DraftTask {
        baseline: Id::new(),
        document: CHAPTER.to_string(),
        prompt: "看看这一段。".to_string(),
        context_digest: "digest".to_string(),
    })
    .unwrap();
    let task_id = host.tasks()[0].id;
    host.execute(HostCommand::AuthorizeDispatch {
        task_id,
        new_agents: vec![Id::new()],
        retry_runs: vec![],
        edges: vec![None],
        package: package(),
        clicked_digest: "package-upstream".to_string(),
        authorized_at: 1,
    })
    .unwrap();
    let run_id = host.runs()[0].id;
    drop(host);

    assert!(!feed_upstream(&mut store, run_id).unwrap());

    drop(store);
    fs::remove_dir_all(root).unwrap();
}
