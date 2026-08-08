//! 手动发射一条已授权的 Run（2.11）：`ProjectInput::LaunchRun`。
//!
//! 界面的「开始」按钮只点名 run——workspace 的组成（`staging::run_workspace`
//! 唯一权威）与喂上游的次序（host 先放掉再喂）都收在领域层这条缝里。夹具
//! 仿 downstream_launch.rs：经生产入口派发，结果文件手写进工作区，不清临时
//! 目录（Windows 上 SQLite 的活连接让删目录必败）。

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use refrain_app::application::HostSnapshot;
use refrain_app::dispatch::{
    CarryMode, DispatchChannel, DispatchRequest, DispatchScope, Orchestration,
};
use refrain_app::{Application, ProjectImport, ProjectInput, ProjectOutput, ProjectPlatform};
use refrain_core::{ErrorCode, Id, RefrainError};
use refrain_host::host::{HostCommand, RunProgress};
use refrain_store::root::RootKind;

const CHAPTER: &str = "章.md";
const FIRST: &str = "剑一直握在他手里。";
const SECOND: &str = "雨停了。";

struct Chosen(Mutex<Option<PathBuf>>);

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
    let dir = std::env::temp_dir().join(format!("refrain-launch-{label}-{}", Id::new()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn nothing() -> Chosen {
    Chosen(Mutex::new(None))
}

/// 起一个应用：adopt root、打开稿子。返回 (root 目录, 应用, root_id)。
fn application_with_chapter(label: &str) -> (PathBuf, Application, String) {
    let data = scratch(label);
    let root = scratch(label);
    fs::write(root.join(CHAPTER), format!("{FIRST}\n\n{SECOND}\n")).unwrap();
    let application = Application::open(&data).unwrap();
    let opened = application
        .project(
            &Chosen(Mutex::new(Some(root.clone()))),
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
    (root, application, root_id)
}

/// 经生产入口派发。返回铸出的 Run id（授权顺序即编排位置）。
fn dispatch(
    application: &Application,
    root_id: &str,
    agents: usize,
    orchestration: Orchestration,
) -> Vec<Id> {
    let dispatched = application
        .project(
            &nothing(),
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
                    agents,
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
    dispatched.runs
}

/// 被测的那条缝：手动发射。答复留给调用方断言。
fn launch(
    application: &Application,
    root_id: &str,
    run_id: Id,
) -> Result<ProjectOutput, RefrainError> {
    application.project(
        &nothing(),
        ProjectInput::LaunchRun {
            root_id: root_id.to_string(),
            run_id,
        },
    )
}

/// 这个 Root 的编排快照（经 ReadHost，与界面读的是同一条）。
fn host_snapshot(application: &Application, root_id: &str) -> HostSnapshot {
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

fn host_command(application: &Application, root_id: &str, command: HostCommand) {
    application
        .project(
            &nothing(),
            ProjectInput::HostCommand {
                root_id: root_id.to_string(),
                command: Box::new(command),
            },
        )
        .unwrap();
}

/// 把一次产出写进 Run 工作区的 attempts（仿 collect.rs 的 stage：领域层
/// 只认落盘的字节）。
fn land_result(root: &std::path::Path, workspace: &str, run_id: Id, artifact: &str) {
    let attempt = root
        .join(".refrain")
        .join(workspace)
        .join("attempts")
        .join(run_id.to_string());
    fs::create_dir_all(&attempt).unwrap();
    fs::write(attempt.join("result.md"), artifact).unwrap();
}

#[test]
fn an_authorized_run_launches_with_the_workspace_the_authority_names() {
    let (root, application, root_id) = application_with_chapter("single");
    let runs = dispatch(&application, &root_id, 1, Orchestration::Alternates);
    let run_id = runs[0];
    let agent_id = host_snapshot(&application, &root_id)
        .runs
        .iter()
        .find(|run| run.id == run_id)
        .expect("the minted run exists")
        .agent_id;

    let reply = launch(&application, &root_id, run_id).unwrap();

    // 答复与读/执行编排同形：host 快照，线上的 kind 名是 "host"——Zig 的
    // deskHost 槽与轮询链按这个形状消费，零新机制。
    let ProjectOutput::Host(snapshot) = &reply else {
        panic!("LaunchRun answers with the refreshed host snapshot: {reply:?}");
    };
    let wire = serde_json::to_string(&reply).unwrap();
    assert!(
        wire.starts_with(r#"{"kind":"host","value":"#),
        "the reply is a host snapshot on the wire: {wire}"
    );
    let row = snapshot
        .runs
        .iter()
        .find(|run| run.id == run_id)
        .expect("the launched run is in the snapshot");
    assert!(
        matches!(row.progress, RunProgress::Launching { .. }),
        "the run left Authorized: {:?}",
        row.progress
    );
    // workspace 的组成只有一个权威，界面与领域层都经它命名。
    let workspace = refrain_host::staging::run_workspace(agent_id, run_id);
    assert_eq!(row.workspace, workspace);
    assert!(
        !snapshot.runs_awaiting_launch.contains(&run_id),
        "the run left the awaiting queue"
    );

    // 请求真的提升进了工作区：冻结的请求在 agents/<agent>/runs/<run>/ 下。
    let request =
        fs::read_to_string(root.join(".refrain").join(&workspace).join("request.md")).unwrap();
    assert!(
        request.contains(FIRST),
        "the frozen before text is promoted"
    );
    assert!(request.contains("# Request"));
}

#[test]
fn launching_a_run_that_is_no_longer_authorized_is_refused_by_name() {
    let (_root, application, root_id) = application_with_chapter("twice");
    let runs = dispatch(&application, &root_id, 1, Orchestration::Alternates);
    let run_id = runs[0];
    launch(&application, &root_id, run_id).unwrap();

    // 已经在 Launching 的 Run 不是 Authorized：第二次发射必须被具名拒绝。
    let refusal = launch(&application, &root_id, run_id)
        .expect_err("a launched run is not authorized anymore");
    assert_eq!(refusal.code, ErrorCode::StateUnavailable);
    assert!(
        refusal.subject.contains("is not authorized"),
        "the author reads the host's own words: {refusal:?}"
    );
}

#[test]
fn launching_a_follows_run_before_its_upstream_is_terminal_is_refused_by_name() {
    let (_root, application, root_id) = application_with_chapter("waiting");
    let runs = dispatch(&application, &root_id, 2, Orchestration::Follows);
    let downstream = runs[1];

    // 上游还没终态：手动发射不吞 UpstreamNotTerminal——「等上游」是作者
    // 要读到的实话（自动路径才吞它）。
    let refusal = launch(&application, &root_id, downstream)
        .expect_err("a follows run waits on its upstream");
    assert_eq!(refusal.code, ErrorCode::StateUnavailable);
    assert!(
        refusal.subject.contains("not terminal"),
        "the author is told to wait for the upstream: {refusal:?}"
    );

    // 拒绝之后什么都没动：下游仍在等发射，状态还是 Authorized。
    let snapshot = host_snapshot(&application, &root_id);
    assert!(snapshot.runs_awaiting_launch.contains(&downstream));
    let progress = &snapshot
        .runs
        .iter()
        .find(|run| run.id == downstream)
        .expect("the downstream run exists")
        .progress;
    assert!(
        matches!(progress, RunProgress::Authorized { .. }),
        "a refused launch changes nothing: {progress:?}"
    );
}

#[test]
fn launching_a_follows_run_feeds_the_upstream_into_its_request() {
    let (root, application, root_id) = application_with_chapter("follows");
    let runs = dispatch(&application, &root_id, 2, Orchestration::Follows);
    let (upstream, downstream) = (runs[0], runs[1]);
    let artifact = "他握着剑，没有说话。".repeat(500);

    // 上游经同一条缝发射，再推进到终态：dispatched → 产出落盘 → completed。
    let reply = launch(&application, &root_id, upstream).unwrap();
    let ProjectOutput::Host(snapshot) = &reply else {
        panic!("LaunchRun answers with the refreshed host snapshot");
    };
    let workspace = snapshot
        .runs
        .iter()
        .find(|run| run.id == upstream)
        .expect("the upstream run is in the snapshot")
        .workspace
        .clone();
    host_command(
        &application,
        &root_id,
        HostCommand::CompleteDispatch {
            run_id: upstream,
            receipt: "receipt".to_string(),
        },
    );
    land_result(&root, &workspace, upstream, &artifact);
    host_command(
        &application,
        &root_id,
        HostCommand::CollectAttempt {
            run_id: upstream,
            artifact_digest: "digest".to_string(),
            at: 2,
        },
    );

    // 下游手动发射：与 HostCommand 路径同一条次序——先提升请求，再喂上游。
    launch(&application, &root_id, downstream).unwrap();

    let downstream_workspace = host_snapshot(&application, &root_id)
        .runs
        .iter()
        .find(|run| run.id == downstream)
        .expect("the downstream run exists")
        .workspace
        .clone();
    let request = fs::read_to_string(
        root.join(".refrain")
            .join(downstream_workspace)
            .join("request.md"),
    )
    .unwrap();
    assert!(
        request.contains(&artifact),
        "the downstream request carries the upstream's bytes:\n{request}"
    );
    assert!(
        request.contains("<upstream"),
        "the section says where it came from:\n{request}"
    );
    // 冻结的原文也还在：喂上游不是替换，是加一节。
    assert!(request.contains("# Request"));
}
