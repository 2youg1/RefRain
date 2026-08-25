//! The producer runner (M9) against the real state machine.
//!
//! 适配器是脚本化的假货（起一个真子进程、回一份罐装产出），其余全部走真
//! 路径：授权、提升、派发、回执、落盘、收取、下游自动发射与清孤。泵本身
//! 非阻塞，测试反复泵到终态——与界面 2.5 秒的轮询同一种驱动方式。

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use refrain_app::ProjectEntry;
use refrain_app::journal::StoreJournal;
use refrain_app::runner::{ChannelFactory, LaunchChannel, PumpReport, Runner, pump_with};
use refrain_core::context_compiler::DispatchPackage;
use refrain_core::{Id, Lineage, Manuscript, SourceSnapshot};
use refrain_host::adapters::{
    DispatchReceipt, DispatchSpec, HarnessAdapter, ProducerOutcome, ProducerUsage,
};
use refrain_host::host::{AgentHost, HostCommand, RunProgress};
use refrain_host::process::{self, LaunchSpec, ProcessHandle};
use refrain_host::run_edge::RunEdge;
use refrain_host::{Tier, staging::DirectoryContext};
use refrain_store::config::Config;
use refrain_store::project::{ProjectStore, RootLocator};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;

const CHAPTER: &str = "章一.md";
const FIRST: &str = "剑没有松。";
const SECOND: &str = "他久久没有说话。";
const REQUEST: &str = "# Before\n\n<!-- scope ch01:b1 -->\n剑没有松。\n";

fn scratch(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("refrain-runner-{label}-{}", Id::new()));
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

/// 假适配器：dispatch 起一个立刻退出的真子进程（回执与句柄都是真的），
/// observe 等它退出后回一份罐装产出。要测的是 runner 与状态机的咬合，
/// 不是某个 harness 的字节流。
struct FakeAdapter {
    reply: String,
    exit_code: Option<i32>,
}

/// 进程夹具（refrain-host 的 examples/process_fixture）：只在缺失时构建
/// 一次，与 host 自己测试用的是同一份二进制。
fn fixture_program() -> PathBuf {
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
}

impl HarnessAdapter for FakeAdapter {
    fn tier(&self) -> Tier {
        Tier::L1
    }

    fn probe(&self) -> Option<refrain_host::adapters::HarnessProbe> {
        None
    }

    fn dispatch(&self, spec: &DispatchSpec) -> io::Result<DispatchReceipt> {
        let handle: ProcessHandle = process::launch(&LaunchSpec {
            program: fixture_program(),
            args: vec!["--exit".to_string(), "0".to_string()],
            env: vec![],
            cwd: spec.workspace.clone(),
        })?;
        Ok(DispatchReceipt {
            receipt: format!("fake:pid={}", handle.pid()),
            handle,
        })
    }

    fn observe(&self, receipt: DispatchReceipt) -> io::Result<ProducerOutcome> {
        receipt.handle.wait()?;
        Ok(ProducerOutcome {
            exit_code: self.exit_code,
            reply_text: self.reply.clone(),
            session_hint: None,
            usage: ProducerUsage::Unknown,
        })
    }

    fn cancel(&self, receipt: DispatchReceipt) -> io::Result<ProducerOutcome> {
        receipt.handle.cancel_tree()?;
        Ok(ProducerOutcome {
            exit_code: None,
            reply_text: String::new(),
            session_hint: None,
            usage: ProducerUsage::Unknown,
        })
    }
}

/// 按 agent 给罐装产出的启动工厂。
fn factory_of(
    replies: HashMap<Id, (String, Option<i32>)>,
) -> impl Fn(&Config, Id) -> Result<Option<LaunchChannel>, (String, String)> {
    move |_config, agent| {
        let (reply, exit_code) = replies.get(&agent).cloned().unwrap_or_default();
        Ok(Some(LaunchChannel {
            adapter: Box::new(FakeAdapter { reply, exit_code }),
            connection_argv: vec![],
            agent_argv: vec![],
        }))
    }
}

fn replacement(text: &str) -> String {
    format!(
        "<agent-result version=\"2\"><replacement scope=\"ch01:b1\"><![CDATA[{text}]]></replacement></agent-result>"
    )
}

/// 授权一轮：两个 agent（或一个，edges 为空时），请求节是真的——收取的
/// 契约只认冻结的请求字节。
fn authorize(store: &mut ProjectStore, agents: &[Id], edges: Vec<Option<RunEdge>>) -> Id {
    let context = DirectoryContext::new(store.layout().state_dir.clone());
    let mut host = AgentHost::open(StoreJournal { store }, context).unwrap();
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
        new_agents: agents.to_vec(),
        retry_runs: vec![],
        edges,
        package: DispatchPackage {
            scopes: Vec::new(),
            prefix_bytes: 0,
            request_md: REQUEST.to_string(),
            manifest: vec![],
            digest: "package".to_string(),
        },
        clicked_digest: "package".to_string(),
        authorized_at: 1,
    })
    .unwrap();
    task_id
}

fn progress_of(store: &mut ProjectStore, run_id: Id) -> RunProgress {
    let context = DirectoryContext::new(store.layout().state_dir.clone());
    let host = AgentHost::open(StoreJournal { store }, context).unwrap();
    host.runs()
        .iter()
        .find(|run| run.id == run_id)
        .unwrap()
        .progress
        .clone()
}

/// 反复泵，直到 `done` 说可以停（或 15 秒用尽——泵漏了哪一步，这个测试
/// 就该挂在超时上，而不是安静放过）。
fn pump_until(
    entry: &mut ProjectEntry,
    runner: &mut Runner,
    factory: &ChannelFactory,
    done: impl Fn(&mut ProjectStore) -> bool,
) -> PumpReport {
    let config = Config::default();
    let mut total = PumpReport::default();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while std::time::Instant::now() < deadline {
        // 报告按泵累计：派发与收尾多半不在同一泵，只看最后一泵等于把
        // 前面做过的事扔掉。
        let report = pump_with("root", entry, runner, &config, 10, factory).unwrap();
        total.dispatched.extend(report.dispatched);
        total.completed.extend(report.completed);
        total.failed.extend(report.failed);
        if done(&mut entry.store) {
            return total;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    panic!("the pump never drove the runs to their terminal states");
}

fn entry_of(root: &Path, store: ProjectStore) -> ProjectEntry {
    let manuscripts = [(CHAPTER.to_string(), manuscript_of(root))]
        .into_iter()
        .collect();
    ProjectEntry { store, manuscripts }
}

#[test]
fn the_pump_drives_an_authorized_run_to_a_frozen_proposal() {
    let root = scratch("happy");
    let (_app, store) = store_at(&root);
    let mut entry = entry_of(&root, store);
    let agent = Id::new();
    authorize(&mut entry.store, &[agent], vec![]);
    let run_id = {
        let context = DirectoryContext::new(entry.store.layout().state_dir.clone());
        let host = AgentHost::open(
            StoreJournal {
                store: &mut entry.store,
            },
            context,
        )
        .unwrap();
        host.runs()[0].id
    };
    let mut runner = Runner::default();
    let factory = factory_of(HashMap::from([(
        agent,
        (replacement("剑一直握着。"), Some(0)),
    )]));

    let report = pump_until(&mut entry, &mut runner, &factory, |store| {
        matches!(progress_of(store, run_id), RunProgress::Completed { .. })
    });

    assert!(report.dispatched.contains(&run_id), "{report:?}");
    assert_eq!(report.completed, vec![(run_id, 1)]);
    // 提案真的冻结了：runner 走的收取与手动路径是同一条。
    let proposals = entry.store.proposals_for(CHAPTER).unwrap();
    assert_eq!(proposals.len(), 1);
    assert_eq!(proposals[0].after_text.as_deref(), Some("剑一直握着。"));
    // result.md 落在工作区的 attempt 目录——与手动往返读的是同一处。
    let workspace = refrain_host::staging::run_workspace(agent, run_id);
    let landed = entry
        .store
        .layout()
        .state_dir
        .join(&workspace)
        .join("attempts")
        .join(run_id.to_string())
        .join("result.md");
    assert!(landed.is_file(), "{}", landed.display());
}

#[test]
fn a_verifier_is_auto_launched_and_its_comments_land_as_annotations() {
    let root = scratch("verify");
    let (_app, store) = store_at(&root);
    let mut entry = entry_of(&root, store);
    let writer = Id::new();
    let verifier = Id::new();
    authorize(
        &mut entry.store,
        &[writer, verifier],
        vec![None, Some(RunEdge::Verifies { subject: 0 })],
    );
    let (run_a, run_b) = {
        let context = DirectoryContext::new(entry.store.layout().state_dir.clone());
        let host = AgentHost::open(
            StoreJournal {
                store: &mut entry.store,
            },
            context,
        )
        .unwrap();
        (host.runs()[0].id, host.runs()[1].id)
    };
    let mut runner = Runner::default();
    let factory = factory_of(HashMap::from([
        (writer, (replacement("剑一直握着。"), Some(0))),
        (
            verifier,
            (
                "<agent-result version=\"2\"><comments><comment target=\"ch01:b1\"><![CDATA[这段的节奏偏慢。]]></comment></comments></agent-result>"
                    .to_string(),
                Some(0),
            ),
        ),
    ]));

    pump_until(&mut entry, &mut runner, &factory, |store| {
        matches!(progress_of(store, run_a), RunProgress::Completed { .. })
            && matches!(progress_of(store, run_b), RunProgress::Completed { .. })
    });

    // M9 的另一半：验证者的批注不再被解析后丢弃——它落在批注面上，锚在
    // 目标 scope 的块上，quote 是冻结的原文。
    let annotations = entry.store.annotations(CHAPTER).unwrap();
    assert_eq!(annotations.len(), 1, "{annotations:?}");
    assert_eq!(annotations[0].body.as_deref(), Some("这段的节奏偏慢。"));
    assert!(annotations[0].quote.contains(FIRST), "{:?}", annotations[0]);
}

#[test]
fn a_failed_upstream_leaves_its_follower_failed_with_a_reason() {
    let root = scratch("orphan");
    let (_app, store) = store_at(&root);
    let mut entry = entry_of(&root, store);
    let upstream_agent = Id::new();
    let follower_agent = Id::new();
    authorize(
        &mut entry.store,
        &[upstream_agent, follower_agent],
        vec![None, Some(RunEdge::Follows { upstream: 0 })],
    );
    let (run_a, run_b) = {
        let context = DirectoryContext::new(entry.store.layout().state_dir.clone());
        let host = AgentHost::open(
            StoreJournal {
                store: &mut entry.store,
            },
            context,
        )
        .unwrap();
        (host.runs()[0].id, host.runs()[1].id)
    };
    let mut runner = Runner::default();
    // 上游退出而只字未留：runner 记 producer-exited。
    let factory = factory_of(HashMap::from([(upstream_agent, (String::new(), Some(1)))]));

    pump_until(&mut entry, &mut runner, &factory, |store| {
        matches!(progress_of(store, run_b), RunProgress::Failed { .. })
    });

    // 上游自己的失败也具名：退出而只字未留，是 producer-exited。
    let upstream = progress_of(&mut entry.store, run_a);
    assert!(
        matches!(upstream, RunProgress::Failed { ref failure } if failure.starts_with("producer-exited")),
        "{upstream:?}"
    );
    let progress = progress_of(&mut entry.store, run_b);
    let RunProgress::Failed { failure } = progress else {
        panic!("the follower must be failed, not waiting forever: {progress:?}");
    };
    assert!(
        failure.starts_with("upstream-failed: producer-exited"),
        "{failure}"
    );
}

#[test]
fn a_dispatch_that_cannot_start_fails_the_run_by_name() {
    let root = scratch("nospawn");
    let (_app, store) = store_at(&root);
    let mut entry = entry_of(&root, store);
    let agent = Id::new();
    authorize(&mut entry.store, &[agent], vec![]);
    let run_id = {
        let context = DirectoryContext::new(entry.store.layout().state_dir.clone());
        let host = AgentHost::open(
            StoreJournal {
                store: &mut entry.store,
            },
            context,
        )
        .unwrap();
        host.runs()[0].id
    };
    let mut runner = Runner::default();
    // agent 不在 Config 里：这条 Run 永远不会有人起，具名失败而不是
    // 永远占着 Launching。
    let factory = |_config: &Config, _agent: Id| {
        Err::<Option<LaunchChannel>, (String, String)>((
            "agent-unconfigured".to_string(),
            "the agent is not in the config".to_string(),
        ))
    };
    let config = Config::default();
    pump_with("root", &mut entry, &mut runner, &config, 10, &factory).unwrap();

    let progress = progress_of(&mut entry.store, run_id);
    let RunProgress::Failed { failure } = progress else {
        panic!("an unservable run must fail by name: {progress:?}");
    };
    assert!(failure.starts_with("agent-unconfigured"), "{failure}");
}

#[test]
fn the_file_channel_is_left_to_the_manual_round_trip() {
    let root = scratch("l0");
    let (_app, store) = store_at(&root);
    let mut entry = entry_of(&root, store);
    let agent = Id::new();
    authorize(&mut entry.store, &[agent], vec![]);
    let run_id = {
        let context = DirectoryContext::new(entry.store.layout().state_dir.clone());
        let host = AgentHost::open(
            StoreJournal {
                store: &mut entry.store,
            },
            context,
        )
        .unwrap();
        host.runs()[0].id
    };
    let mut runner = Runner::default();
    // L0（无连接，含匿名 agent）：没有进程可起。runner 不代劳——Run 留在
    // Authorized 等作者手动发射，起点与 runner 出现之前相同；收取路径
    // 原样等作者落 result.md。
    let factory = |_config: &Config, _agent: Id| Ok::<_, (String, String)>(None);
    let config = Config::default();
    pump_with("root", &mut entry, &mut runner, &config, 10, &factory).unwrap();

    let progress = progress_of(&mut entry.store, run_id);
    assert!(
        matches!(progress, RunProgress::Authorized { .. }),
        "the file channel waits for the author, not for a process: {progress:?}"
    );
    let context = DirectoryContext::new(entry.store.layout().state_dir.clone());
    let host = AgentHost::open(
        StoreJournal {
            store: &mut entry.store,
        },
        context,
    )
    .unwrap();
    assert!(host.runs_awaiting_launch().contains(&run_id));
}
