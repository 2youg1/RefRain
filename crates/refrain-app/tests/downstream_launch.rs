//! 收取成功后自动发射等待中的下游 Run（2.2 回迁）。
//!
//! 接力（Follows）与校验（Verifies）的下游在 collect 成功后离开发射队列——
//! 编排语义收在领域层（application.rs 的 `CollectRun` 处理），不由界面串。
//! 夹具仿 collect.rs：结果文件手写进工作区，不清临时目录（Windows 上
//! SQLite 的活连接让删目录必败）。

use std::fs;
use std::path::PathBuf;

use refrain_app::dispatch::{
    CarryMode, DispatchChannel, DispatchRequest, DispatchScope, Orchestration,
};
use refrain_app::{
    Application, CollectReport, ProjectImport, ProjectInput, ProjectOutput, ProjectPlatform,
};
use refrain_core::{Id, RefrainError};
use refrain_host::host::{HostCommand, RunProgress};
use refrain_store::root::RootKind;

const CHAPTER: &str = "章.md";
const FIRST: &str = "剑一直握在他手里。";
const SECOND: &str = "雨停了。";

/// 只留一条 memo 的答复：收取是 Completed，但不带提案（上游的职责是存在，
/// 不是提案）。
const MEMO_REPLY: &str =
    "<agent-result version=\"2\"><memo topic=\"测试\">记住</memo></agent-result>";

struct Chosen(std::sync::Mutex<Option<PathBuf>>);

impl ProjectPlatform for Chosen {
    fn choose_root(&self, _kind: RootKind) -> Result<Option<PathBuf>, RefrainError> {
        Ok(self.0.lock().unwrap().take())
    }

    fn choose_project_parent(&self) -> Result<Option<PathBuf>, RefrainError> {
        Ok(None)
    }

    fn choose_import(&self, _kind: ProjectImport) -> Result<Option<PathBuf>, RefrainError> {
        Ok(None)
    }
}

fn scratch(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("refrain-downstream-{label}-{}", Id::new()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn nothing() -> Chosen {
    Chosen(std::sync::Mutex::new(None))
}

/// 起一个应用：adopt root、打开稿子、按给定排法派发两个 Run。
/// 返回上游与下游的 Run id（授权顺序即编排位置）。
fn dispatch_pair(
    label: &str,
    orchestration: Orchestration,
) -> (PathBuf, Application, String, Id, Id) {
    let data = scratch(label);
    let root = scratch(label);
    fs::write(root.join(CHAPTER), format!("{FIRST}\n\n{SECOND}\n")).unwrap();
    let application = Application::open(&data).unwrap();
    let opened = application
        .project(
            &Chosen(std::sync::Mutex::new(Some(root.clone()))),
            ProjectInput::ChooseAndAdoptRoot {
                kind: RootKind::Folder,
            },
        )
        .unwrap();
    let ProjectOutput::Opened(opened) = opened else {
        panic!("adopting a Root answers with the opened project");
    };
    let root_id = opened.root_id;
    let opened = application
        .project(
            &nothing(),
            ProjectInput::OpenDocument {
                root_id: root_id.clone(),
                path: CHAPTER.to_string(),
            },
        )
        .unwrap();
    let ProjectOutput::DocumentOpened(_) = opened else {
        panic!("opening the chapter answers with the document");
    };

    let dispatched = application
        .project(
            &nothing(),
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
                    agents: 2,
                    orchestration,
                    persona: None,
                    channel: DispatchChannel::Harness,
                    result_path: "result.md".to_string(),
                    max_bytes: 65_536,
                    carry: CarryMode::None,
                    materials: vec![],
                    agent: None,
                    expected_digest: None,
                }),
            },
        )
        .unwrap();
    let ProjectOutput::Dispatched(dispatched) = dispatched else {
        panic!("dispatch answers with the dispatched package");
    };
    assert_eq!(dispatched.runs.len(), 2, "two agents mint two runs");
    (
        root,
        application,
        root_id,
        dispatched.runs[0],
        dispatched.runs[1],
    )
}

/// 这个 Root 的编排快照（经 ReadHost，与界面读的是同一条）。
fn host_snapshot(
    application: &Application,
    root_id: &str,
) -> refrain_app::application::HostSnapshot {
    let host = application
        .project(
            &nothing(),
            ProjectInput::ReadHost {
                root_id: root_id.to_string(),
            },
        )
        .unwrap();
    let ProjectOutput::Host(snapshot) = host else {
        panic!("ReadHost answers with the host snapshot");
    };
    *snapshot
}

/// 发射上游 Run 并把它推进到 Dispatched（结果还没落——收取前由夹具写）。
/// 返回它的 workspace（结果要落在那下面）。
fn launch_upstream(application: &Application, root_id: &str, upstream: Id) -> String {
    let agent_id = host_snapshot(application, root_id)
        .runs
        .iter()
        .find(|run| run.id == upstream)
        .expect("the upstream run exists")
        .agent_id;
    // workspace 的组成只有一个权威，与领域层的自动发射同一个。
    let workspace = refrain_host::staging::run_workspace(agent_id, upstream);
    for command in [
        HostCommand::LaunchRun {
            run_id: upstream,
            workspace: workspace.clone(),
        },
        HostCommand::CompleteDispatch {
            run_id: upstream,
            receipt: "receipt".to_string(),
        },
    ] {
        let host = application
            .project(
                &nothing(),
                ProjectInput::HostCommand {
                    root_id: root_id.to_string(),
                    command: Box::new(command),
                },
            )
            .unwrap();
        let ProjectOutput::Host(_) = host else {
            panic!("HostCommand answers with the host snapshot");
        };
    }
    workspace
}

/// 把上游的结果写进它工作区的 attempts（仿 collect.rs 的 stage：领域层
/// 只认落盘的字节）。
fn land_upstream_result(root: &std::path::Path, workspace: &str, upstream: Id) {
    let attempt = root
        .join(".refrain")
        .join(workspace)
        .join("attempts")
        .join(upstream.to_string());
    fs::create_dir_all(&attempt).unwrap();
    fs::write(attempt.join("result.md"), MEMO_REPLY).unwrap();
}

fn collect(application: &Application, root_id: &str, run_id: Id) -> CollectReport {
    let collected = application
        .project(
            &nothing(),
            ProjectInput::CollectRun {
                root_id: root_id.to_string(),
                run_id: run_id.to_string(),
            },
        )
        .unwrap();
    let ProjectOutput::Collected(report) = collected else {
        panic!("CollectRun answers with the collect report");
    };
    report
}

/// 一组排法下收取上游后的下游状态：Follows 与 Verifies 共用这一条流。
fn downstream_leaves_awaiting_after_collect(orchestration: Orchestration) {
    let (root, application, root_id, upstream, downstream) = dispatch_pair("auto", orchestration);
    let workspace = launch_upstream(&application, &root_id, upstream);

    // 收取之前下游还在等：自动发射若生效，差别只能来自 collect。
    let before = host_snapshot(&application, &root_id);
    assert!(before.runs_awaiting_launch.contains(&downstream));

    land_upstream_result(&root, &workspace, upstream);
    let report = collect(&application, &root_id, upstream);
    assert!(
        matches!(report, CollectReport::Completed { .. }),
        "the upstream collect completes: {report:?}"
    );

    let after = host_snapshot(&application, &root_id);
    assert!(
        !after.runs_awaiting_launch.contains(&downstream),
        "the downstream left the awaiting queue"
    );
    let progress = &after
        .runs
        .iter()
        .find(|run| run.id == downstream)
        .expect("the downstream run exists")
        .progress;
    assert!(
        matches!(progress, RunProgress::Launching { .. }),
        "the downstream is launching, not {progress:?}"
    );
}

#[test]
fn a_follows_downstream_launches_itself_once_the_upstream_is_collected() {
    downstream_leaves_awaiting_after_collect(Orchestration::Follows);
}

#[test]
fn a_verifies_downstream_launches_itself_once_the_subject_is_collected() {
    downstream_leaves_awaiting_after_collect(Orchestration::Verifies);
}

#[test]
fn a_waiting_collect_launches_nothing() {
    let (_root, application, root_id, upstream, downstream) =
        dispatch_pair("waiting", Orchestration::Follows);
    let _workspace = launch_upstream(&application, &root_id, upstream);
    // 结果没落盘：收取是 Waiting，不是错误。
    let report = collect(&application, &root_id, upstream);
    assert!(
        matches!(report, CollectReport::Waiting),
        "a missing result is waiting, not {report:?}"
    );
    let after = host_snapshot(&application, &root_id);
    assert!(
        after.runs_awaiting_launch.contains(&downstream),
        "a waiting collect launches nothing"
    );
}
