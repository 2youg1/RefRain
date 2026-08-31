// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! k3 全流程（P4.2）：协议装载 → 连接配置 → 派发 → 真进程产出 → 收取 →
//! 提案 → 裁决 → 提交 → 正文落盘，一条链上全部真实。
//!
//! 与 `edge_end_to_end.rs` 的分工：那边分边测编排语义，这里把「作者从
//! 装协议到看见正文改好」的每一步串成一条——任何一步的缺失都不会让
//! 前面的步骤红，而作者真正走的正是这条路。
//!
//! 中间没有 mock：producer 是 `examples/process_fixture.rs`（与 edge 同
//! 一套），协议是注册表通道的真实字节，每一步都走 `Application` 的真实
//! 入口。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use refrain_app::dispatch::{
    CarryMode, DispatchChannel, DispatchRequest, DispatchScope, Orchestration,
};
use refrain_app::{
    Application, CollectReport, ProjectImport, ProjectInput, ProjectOutput, ProjectPlatform,
};
use refrain_core::context_compiler::SkillStatus;
use refrain_core::persona::Persona;
use refrain_core::{Id, RefrainError};
use refrain_host::adapters::{
    CHANNELS, PrintAdapter, channel_skill_bytes, channel_skill_path, install_skill_at,
    skill_status_at,
};
use refrain_host::process::{LaunchSpec, launch};
use refrain_store::config::{AdapterKind, HarnessConnection};
use refrain_store::root::RootKind;

const CHAPTER: &str = "章一.md";
const FIRST: &str = "剑一直握在他手里。";

/// 与 `process.rs` 的单元测试同一套按需构建。
fn fixture_path() -> &'static Path {
    static FIXTURE: OnceLock<PathBuf> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let workspace = manifest.parent().and_then(Path::parent).unwrap();
        let built = workspace
            .join("target/debug/examples")
            .join(format!("process_fixture{}", std::env::consts::EXE_SUFFIX));
        if !built.exists() {
            let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
            let status = std::process::Command::new(cargo)
                .args([
                    "build",
                    "-p",
                    "refrain-host",
                    "--example",
                    "process_fixture",
                    "--offline",
                ])
                .current_dir(workspace)
                .status()
                .unwrap();
            assert!(status.success(), "building the process fixture failed");
        }
        built
    })
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("refrain-k3-{name}-{}", Id::new()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

struct Chosen(std::sync::Mutex<Option<PathBuf>>);

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

fn choose(path: &Path) -> Chosen {
    Chosen(std::sync::Mutex::new(Some(path.to_path_buf())))
}

fn nothing() -> Chosen {
    Chosen(std::sync::Mutex::new(None))
}

/// 作者走的路：装协议 → 配连接 → 打开项目与稿子 → 派发 → 真进程产出 →
/// 收取 → 提案 → 接受 → 提交 → 正文落盘。
#[test]
fn the_author_flow_from_protocol_install_to_committed_edit() {
    // —— 第一步：协议装载。注册表里的每一条通道都要能装进自己的 skill
    // 目录，装完的状态是 Current（读文件本身，不信任记录）。
    let home = scratch("home");
    let channel = &CHANNELS[0];
    let (installed_path, digest) = install_skill_at(
        &channel_skill_path(&home, channel),
        &channel_skill_bytes(channel),
    )
    .unwrap();
    assert_eq!(installed_path, channel_skill_path(&home, channel));
    assert!(!digest.is_empty());
    assert_eq!(
        skill_status_at(
            &channel_skill_path(&home, channel),
            &channel_skill_bytes(channel)
        ),
        SkillStatus::Current
    );
    // 注册表自洽：表里那条通道的探测路径认得自己的字节（PATH 上有没有
    // 这个 CLI 是机器的事，不是协议的事）。
    let _ = PrintAdapter::detect(channel);

    // —— 第二步：连接配置。作者在设置面板存下的连接要能过 Config 校验，
    // 派发时按通道读它。
    let connection = HarnessConnection {
        id: Id::new(),
        adapter: AdapterKind::KimiCode,
        executable: "kimi".into(),
        argv: vec![],
        env_allow: vec![],
        version: Some("fixture".to_string()),
        skill_digest: Some(digest),
    };
    let data = scratch("data");
    let root = scratch("root");
    fs::write(
        root.join(CHAPTER),
        format!("# Before\n\n{FIRST}\n\n# Request\n\n改克制些。\n"),
    )
    .unwrap();
    let application = Application::open(&data).unwrap();

    // —— 第三步：连接进 Config（设置面板的同一条消息），打开项目与稿子。
    let config = application
        .apply_config(refrain_app::ConfigChange::UpsertHarnessConnection(
            connection,
        ))
        .unwrap();
    assert_eq!(config.harness_connections.len(), 1);
    let opened = application
        .project(
            &choose(&root),
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

    // —— 第四步：派发。冻结请求 → 授权 → 提升（Application 内部），
    // 真进程从工作区读请求、写产出。
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
                    agents: 1,
                    orchestration: Orchestration::Alternates,
                    persona: Some(Persona::Work {
                        body: "改稿".to_string(),
                    }),
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
    assert_eq!(dispatched.runs.len(), 1);
    let run_id = dispatched.runs[0];

    // 工作区名由 LaunchRun 的调用方给定（authorize 时 Run 的 workspace
    // 还是空的）——与 edge 测试同款：一个测试自己的目录名。
    let workspace = "run-workspace".to_string();

    // LaunchRun：提升请求到工作区（与派发台的「开始」按钮同一条命令）。
    let host = application
        .project(
            &nothing(),
            ProjectInput::HostCommand {
                root_id: root_id.clone(),
                command: Box::new(refrain_host::host::HostCommand::LaunchRun {
                    run_id,
                    workspace: workspace.clone(),
                }),
            },
        )
        .unwrap();
    let ProjectOutput::Host(host) = host else {
        panic!("HostCommand answers with the host snapshot");
    };
    assert!(!host.runs.is_empty());

    // 真进程：cwd 是 Run 的工作区，请求已被提升到那里。
    let handle = launch(&LaunchSpec {
        program: fixture_path().to_path_buf(),
        args: vec![
            "--produce".to_string(),
            run_id.to_string(),
            "edit".to_string(),
        ],
        env: vec![],
        cwd: root.join(".refrain").join(&workspace),
    })
    .expect("the producer must actually start");
    let outcome = handle.wait().expect("waiting on the producer");
    assert_eq!(outcome.code, Some(0), "producer failed: {}", outcome.stderr);

    // CompleteDispatch：把 Run 从 Launching 推进到 Dispatched（与编排台
    // 的「完成」同一条命令）——CollectRun 只认终态。
    let completed = application
        .project(
            &nothing(),
            ProjectInput::HostCommand {
                root_id: root_id.clone(),
                command: Box::new(refrain_host::host::HostCommand::CompleteDispatch {
                    run_id,
                    receipt: "receipt".to_string(),
                }),
            },
        )
        .unwrap();
    let ProjectOutput::Host(completed) = completed else {
        panic!("CompleteDispatch answers with the host snapshot");
    };
    assert!(!completed.runs.is_empty());

    // —— 第五步：收取 → 提案。
    let collected = application
        .project(
            &nothing(),
            ProjectInput::CollectRun {
                root_id: root_id.clone(),
                run_id: run_id.to_string(),
            },
        )
        .unwrap();
    let ProjectOutput::Collected(collected) = collected else {
        panic!("CollectRun answers with a collect report");
    };
    assert!(
        matches!(collected, CollectReport::Completed { proposals: 1, .. }),
        "the edit producer must land exactly one proposal: {collected:?}"
    );

    let proposals = application
        .project(
            &nothing(),
            ProjectInput::ReadProposals {
                root_id: root_id.clone(),
                path: CHAPTER.to_string(),
            },
        )
        .unwrap();
    let ProjectOutput::Proposals(proposals) = proposals else {
        panic!("ReadProposals answers with proposals");
    };
    assert_eq!(
        proposals.proposals.len(),
        1,
        "the producer left one proposal"
    );
    let proposal_id = proposals.proposals[0].id.clone();

    // —— 第六步：接受 → 提交（裁决即落盘，D1/F-01）。
    let staged = application
        .project(
            &nothing(),
            ProjectInput::StageVerdict {
                root_id: root_id.clone(),
                path: CHAPTER.to_string(),
                proposal_id: proposal_id.clone(),
                kind: refrain_store::ledger::VerdictKindName::Accept,
                final_text: None,
                reason: None,
            },
        )
        .unwrap();
    let ProjectOutput::Proposals(staged) = staged else {
        panic!("StageVerdict answers with the refreshed proposals");
    };
    assert!(staged.staged.contains(&proposal_id));
    let committed = application
        .project(
            &nothing(),
            ProjectInput::CommitVerdicts {
                root_id: root_id.clone(),
                path: CHAPTER.to_string(),
            },
        )
        .unwrap();
    let ProjectOutput::Decided(report) = committed else {
        panic!("CommitVerdicts answers with a decision report");
    };
    assert!(
        matches!(report, refrain_app::DecisionReport::Durable),
        "the committed batch must be durable: {report:?}"
    );

    // —— 第七步：正文真的改了、落盘了，提案清空了（裁决账本已落）。
    let text = fs::read_to_string(root.join(CHAPTER)).unwrap();
    assert!(
        text.contains("克制") && !text.contains(FIRST),
        "the committed edit must be on disk: {text}"
    );
    // 提交后提案不再待判——批次已被账本接走（读历史是另一条领域：正文
    // 编辑链；裁决在账本与审计里，不在这里）。
    let after = application
        .project(
            &nothing(),
            ProjectInput::ReadProposals {
                root_id: root_id.clone(),
                path: CHAPTER.to_string(),
            },
        )
        .unwrap();
    let ProjectOutput::Proposals(after) = after else {
        panic!("ReadProposals answers with proposals");
    };
    // 提案行留着供审计（decide.rs 的注释），批次必须已经清空。
    assert!(
        after.staged.is_empty(),
        "the committed batch is no longer staged"
    );

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(home).unwrap();
}
