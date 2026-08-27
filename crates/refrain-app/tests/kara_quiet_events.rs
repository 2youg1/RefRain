// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 安静事件的生产者：事实发生处（保存、收取、索引建成）必须把事件产进
//! KARA 机器的队列——2.3 的离场小结带读的是这条队列，不是界面的记忆。

use std::fs;
use std::path::{Path, PathBuf};

use refrain_app::{Application, ProjectInput, ProjectOutput};
use refrain_core::context_compiler::DispatchPackage;
use refrain_core::{Id, QuietEvent};
use refrain_host::host::{AgentHost, HostCommand};
use refrain_store::root::RootKind;
use std::collections::VecDeque;
use std::sync::Mutex;

const CHAPTER: &str = "章一.md";
const FIRST: &str = "剑没有松。";
const SECOND: &str = "他久久没有说话。";

fn scratch(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("refrain-kara-quiet-{label}-{}", Id::new()));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join(CHAPTER), format!("{FIRST}\n\n{SECOND}\n")).unwrap();
    root
}

struct ChosenPaths {
    paths: Mutex<VecDeque<Option<PathBuf>>>,
}

impl ChosenPaths {
    fn new(paths: impl IntoIterator<Item = Option<PathBuf>>) -> Self {
        Self {
            paths: Mutex::new(paths.into_iter().collect()),
        }
    }
}

impl refrain_app::ProjectPlatform for ChosenPaths {
    fn choose_root(&self, _kind: RootKind) -> Result<Option<PathBuf>, refrain_core::RefrainError> {
        Ok(self.paths.lock().unwrap().pop_front().flatten())
    }

    fn choose_project_parent(&self) -> Result<Option<PathBuf>, refrain_core::RefrainError> {
        Ok(None)
    }

    fn choose_import(
        &self,
        _kind: refrain_app::ProjectImport,
    ) -> Result<Option<PathBuf>, refrain_core::RefrainError> {
        Ok(None)
    }
}

fn open_project(application: &Application, root: &Path) -> String {
    let ProjectOutput::Opened(project) = application
        .project(
            &ChosenPaths::new([Some(root.to_path_buf())]),
            ProjectInput::ChooseAndAdoptRoot {
                kind: RootKind::Folder,
            },
        )
        .unwrap()
    else {
        panic!("adoption must open the project");
    };
    project.root_id
}

fn queued(application: &Application) -> Vec<QuietEvent> {
    application.kara().state().unwrap().queued
}

#[test]
fn native_saved_queues_a_save_succeeded_quiet_event() {
    let data = scratch("save-data");
    let root = scratch("save-root");
    let application = Application::open(&data).unwrap();
    let root_id = open_project(&application, &root);

    application
        .project(
            &ChosenPaths::new([]),
            ProjectInput::NativeSaved {
                root_id: root_id.clone(),
                path: CHAPTER.to_string(),
            },
        )
        .unwrap();

    assert!(
        queued(&application).contains(&QuietEvent::SaveSucceeded),
        "a landed save must queue its quiet event"
    );

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn the_first_search_queues_index_refreshed_and_the_second_does_not() {
    let data = scratch("index-data");
    let root = scratch("index-root");
    let application = Application::open(&data).unwrap();
    let root_id = open_project(&application, &root);

    for _ in 0..2 {
        application
            .project(
                &ChosenPaths::new([]),
                ProjectInput::DocumentSearch {
                    root_id: root_id.clone(),
                    query: "剑".to_string(),
                    precision: refrain_app::SearchPrecision::Exact,
                },
            )
            .unwrap();
    }

    // 懒建索引只在第一次搜索时建成；第二次走现成索引，没有「刷新」这个事实。
    let events = queued(&application);
    assert_eq!(
        events
            .iter()
            .filter(|event| **event == QuietEvent::IndexRefreshed)
            .count(),
        1,
        "exactly one index build means exactly one quiet event: {events:?}"
    );

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(root).unwrap();
}

/// 铺一个已发出、等结果的 Run 需要的最小现场：task、授权、发射、完成派发，
/// 再把结果文件放进 attempt 目录。与 collect.rs 测试同一夹具形状。
fn dispatched_run_with_result(application: &Application, root_id: &str, reply: &str) -> Id {
    application
        .with_project(root_id, |entry| {
            let state_dir = entry.store.layout().state_dir.clone();
            let run_id = {
                let mut host = AgentHost::open(
                    refrain_app::journal::StoreJournal {
                        store: &mut entry.store,
                    },
                    refrain_host::staging::DirectoryContext::new(state_dir.clone()),
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
                    edges: vec![],
                    package: DispatchPackage {
                        scopes: Vec::new(),
                        prefix_bytes: 0,
                        request_md: String::new(),
                        manifest: vec![],
                        digest: "package".to_string(),
                    },
                    clicked_digest: "package".to_string(),
                    authorized_at: 1,
                })
                .unwrap();
                let run_id = host.runs().last().unwrap().id;
                host.execute(HostCommand::LaunchRun {
                    run_id,
                    workspace: "runs/one".to_string(),
                })
                .unwrap();
                host.execute(HostCommand::CompleteDispatch {
                    run_id,
                    receipt: "receipt".to_string(),
                })
                .unwrap();
                run_id
            };
            // 冻结的请求与回来的结果，放在与真实派发相同的位置。
            let dir = state_dir.join("runs/one");
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("request.md"),
                format!("# Before\n\n<!-- scope ch01:b1 -->\n{FIRST}\n"),
            )
            .unwrap();
            let attempt = dir.join("attempts").join(run_id.to_string());
            fs::create_dir_all(&attempt).unwrap();
            fs::write(attempt.join("result.md"), reply).unwrap();
            Ok(run_id)
        })
        .unwrap()
}

#[test]
fn a_completed_run_queues_agent_completed_and_proposal_arrived() {
    let data = scratch("collect-data");
    let root = scratch("collect-root");
    let application = Application::open(&data).unwrap();
    let root_id = open_project(&application, &root);

    // 收取要把冻结原文对回块 id，稿子在打开着的那批里才有块 id。
    let ProjectOutput::DocumentOpened(_) = application
        .project(
            &ChosenPaths::new([]),
            ProjectInput::OpenDocument {
                root_id: root_id.clone(),
                path: CHAPTER.to_string(),
            },
        )
        .unwrap()
    else {
        panic!("the chapter must open");
    };

    let reply = "<agent-result version=\"2\"><replacement scope=\"ch01:b1\"><![CDATA[剑一直握着。]]></replacement></agent-result>".to_string();
    let run_id = dispatched_run_with_result(&application, &root_id, &reply);

    let collected = application
        .project(
            &ChosenPaths::new([]),
            ProjectInput::CollectRun {
                root_id: root_id.clone(),
                run_id: run_id.to_string(),
            },
        )
        .unwrap();
    assert!(
        matches!(
            collected,
            ProjectOutput::Collected(refrain_app::CollectReport::Completed { .. })
        ),
        "the staged result must collect: {collected:?}"
    );

    let events = queued(&application);
    assert!(
        events.contains(&QuietEvent::AgentCompleted),
        "a completed run must queue AgentCompleted: {events:?}"
    );
    assert!(
        events.contains(&QuietEvent::ProposalArrived),
        "a run that brought proposals must queue ProposalArrived: {events:?}"
    );

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(root).unwrap();
}
