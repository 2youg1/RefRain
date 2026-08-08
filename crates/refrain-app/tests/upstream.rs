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
        prefix_bytes: 0,
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

// ── 生产路径：经 ProjectInput 的 LaunchRun 在提升之后自动喂上游 ────────────
//
// 上面两条直接调 `feed_upstream`；这两条问的是它的第一个生产调用者——
// `ProjectInput::HostCommand` 那一臂。界面（Zig）发过来的 LaunchRun 走的
// 正是这条路，所以喂不喂要在这里断言，而不是只在用例函数上断言。

use std::sync::Mutex;

use refrain_app::dispatch::{
    CarryMode, DispatchChannel, DispatchRequest, DispatchScope, Orchestration,
};
use refrain_app::{Application, ProjectImport, ProjectInput, ProjectOutput, ProjectPlatform};
use refrain_core::RefrainError;

struct Chosen(Mutex<Option<PathBuf>>);

impl ProjectPlatform for Chosen {
    fn choose_root(&self, _kind: RootKind) -> Result<Option<PathBuf>, RefrainError> {
        Ok(self.0.lock().unwrap().take())
    }

    fn choose_project_parent(&self) -> Result<Option<PathBuf>, RefrainError> {
        Ok(self.0.lock().unwrap().take())
    }

    fn choose_import(&self, _kind: ProjectImport) -> Result<Option<PathBuf>, RefrainError> {
        Ok(self.0.lock().unwrap().take())
    }
}

/// 开一个 Application，收养一个带一章的 Root，打开那章，返回
/// (数据目录, Root, Application, root_id)。
fn application_with_chapter(label: &str) -> (PathBuf, PathBuf, Application, String) {
    let data = std::env::temp_dir().join(format!("refrain-upstream-app-{label}-{}", Id::new()));
    let root =
        std::env::temp_dir().join(format!("refrain-upstream-app-{label}-root-{}", Id::new()));
    fs::create_dir_all(&data).unwrap();
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join(CHAPTER), format!("{FIRST}\n\n他没有说话。\n")).unwrap();

    let application = Application::open(&data).unwrap();
    let platform = Chosen(Mutex::new(Some(root.clone())));
    let opened = application
        .project(
            &platform,
            ProjectInput::ChooseAndAdoptRoot {
                kind: RootKind::Folder,
            },
        )
        .unwrap();
    let ProjectOutput::Opened(opened) = opened else {
        panic!("adopt must return the opened project");
    };
    let root_id = opened.root_id;
    application
        .project(
            &platform,
            ProjectInput::OpenDocument {
                root_id: root_id.clone(),
                path: CHAPTER.to_string(),
            },
        )
        .unwrap();
    (data, root, application, root_id)
}

/// 经生产入口派发：两个 agent，Follows 排法。返回 [上游, 下游] 的 Run id。
fn dispatch_follows(application: &Application, root_id: &str) -> [Id; 2] {
    let platform = Chosen(Mutex::new(None));
    let dispatched = application
        .project(
            &platform,
            ProjectInput::Dispatch {
                root_id: root_id.to_string(),
                request: Box::new(DispatchRequest {
                    document: CHAPTER.to_string(),
                    prompt: "改克制些。".to_string(),
                    scopes: vec![DispatchScope {
                        label: "s1".to_string(),
                        before: FIRST.to_string(),
                        blocks: None,
                    }],
                    agents: 2,
                    orchestration: Orchestration::Follows,
                    persona: None,
                    channel: DispatchChannel::Harness,
                    result_path: "result.md".to_string(),
                    max_bytes: 64 * 1024,
                    carry: CarryMode::None,
                    materials: Vec::new(),
                    agent: None,
                    expected_digest: None,
                }),
            },
        )
        .unwrap();
    let ProjectOutput::Dispatched(dispatched) = dispatched else {
        panic!("dispatch must return the minted runs");
    };
    [dispatched.runs[0], dispatched.runs[1]]
}

fn host_command(application: &Application, root_id: &str, command: HostCommand) {
    let platform = Chosen(Mutex::new(None));
    application
        .project(
            &platform,
            ProjectInput::HostCommand {
                root_id: root_id.to_string(),
                command: Box::new(command),
            },
        )
        .unwrap();
}

/// 生产调用者：Follows 的下游经 ProjectInput 启动后，它的请求里真的有
/// 上游写下的全部字节——不再需要谁记得单独去喂。
#[test]
fn launching_a_follows_run_through_the_project_input_feeds_the_upstream() {
    let (data, root, application, root_id) = application_with_chapter("follows");
    let [upstream, downstream] = dispatch_follows(&application, &root_id);
    let artifact = "他握着剑，没有说话。".repeat(500);

    // 上游跑到终态：launch → dispatched → 产出落盘 → completed。
    host_command(
        &application,
        &root_id,
        HostCommand::LaunchRun {
            run_id: upstream,
            workspace: format!("runs/{upstream}"),
        },
    );
    host_command(
        &application,
        &root_id,
        HostCommand::CompleteDispatch {
            run_id: upstream,
            receipt: "receipt".to_string(),
        },
    );
    let attempt = root
        .join(".refrain")
        .join(format!("runs/{upstream}"))
        .join("attempts")
        .join(upstream.to_string());
    fs::create_dir_all(&attempt).unwrap();
    fs::write(attempt.join("result.md"), &artifact).unwrap();
    host_command(
        &application,
        &root_id,
        HostCommand::CollectAttempt {
            run_id: upstream,
            artifact_digest: "digest".to_string(),
            at: 2,
        },
    );

    // 下游启动：与界面上作者点「启动」是同一条输入。
    host_command(
        &application,
        &root_id,
        HostCommand::LaunchRun {
            run_id: downstream,
            workspace: format!("runs/{downstream}"),
        },
    );

    let request = fs::read_to_string(
        root.join(".refrain")
            .join(format!("runs/{downstream}"))
            .join("request.md"),
    )
    .unwrap();
    assert!(
        request.contains(&artifact),
        "生产路径启动的下游请求里没有上游写下的字节:\n{request}"
    );
    assert!(
        request.contains("<upstream"),
        "这一节必须说出来源——下游读的不是作者的话:\n{request}"
    );
    assert!(request.contains("# Request"));

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(root).unwrap();
}

/// 近失手：喂的动作挂在「启动」上而不是挂在「边」上——一个无边的 Run
/// 启动后，请求必须原样。每个普通发送都多一段别人的产出，既费字节又
/// 让 Agent 读一段与它无关的话。
#[test]
fn launching_a_run_without_an_edge_leaves_its_request_alone() {
    let (data, root, application, root_id) = application_with_chapter("star");
    let platform = Chosen(Mutex::new(None));
    let dispatched = application
        .project(
            &platform,
            ProjectInput::Dispatch {
                root_id: root_id.clone(),
                request: Box::new(DispatchRequest {
                    document: CHAPTER.to_string(),
                    prompt: "改克制些。".to_string(),
                    scopes: vec![DispatchScope {
                        label: "s1".to_string(),
                        before: FIRST.to_string(),
                        blocks: None,
                    }],
                    agents: 1,
                    orchestration: Orchestration::Alternates,
                    persona: None,
                    channel: DispatchChannel::Harness,
                    result_path: "result.md".to_string(),
                    max_bytes: 64 * 1024,
                    carry: CarryMode::None,
                    materials: Vec::new(),
                    agent: None,
                    expected_digest: None,
                }),
            },
        )
        .unwrap();
    let ProjectOutput::Dispatched(dispatched) = dispatched else {
        panic!("dispatch must return the minted runs");
    };
    let run = dispatched.runs[0];

    host_command(
        &application,
        &root_id,
        HostCommand::LaunchRun {
            run_id: run,
            workspace: format!("runs/{run}"),
        },
    );

    let request = fs::read_to_string(
        root.join(".refrain")
            .join(format!("runs/{run}"))
            .join("request.md"),
    )
    .unwrap();
    assert!(
        !request.contains("<upstream"),
        "无边的 Run 被喂进了别人的产出:\n{request}"
    );

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(root).unwrap();
}
