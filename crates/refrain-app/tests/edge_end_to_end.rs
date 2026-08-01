//! 判据 2-1：三种边各有一条端到端用例，用真实进程，不用 mock。
//!
//! 「端到端」在这里的含义是具体的：一条测试要走过冻结请求 → 授权 → 提升 →
//! **真的把一个进程启动起来** → 那个进程读到磁盘上的请求、写出产出 → 收取 →
//! 解析 → 落成提案或批注。中间任何一步用假的，这条判据就不成立，因为每一步都
//! 是真实使用时会失败的地方。
//!
//! 用的 producer 是 `examples/process_fixture.rs --produce`。它不是 mock：它
//! 真的以 Run 工作区为 cwd 启动，真的读 `request.md`，真的把 scope id 从冻结的
//! 请求里取出来（而不是凭空造一个——那正是解析器必须拒绝的东西），真的把产出
//! 写到契约说的位置。
//!
//! 三条边各测什么，是按它们各自**唯一**成立的性质选的：
//!
//! - `Alternates`：两个 Run 并列跑完，谁都不等谁，各自留下自己的提案。
//! - `Follows`：下游在上游终态**之前**启动会被具名拒绝；上游终态之后能跑通。
//! - `Verifies`：验证者只出批注时收取成功，出改写时整份被拒（越界的细节在
//!   `refrain-app/tests/collect.rs`，这里测的是它在真实链路上同样成立）。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use refrain_app::collect::{Collected, collect_attempt};
use refrain_core::context_compiler::DispatchPackage;
use refrain_core::{Id, Lineage, Manuscript, SourceSnapshot};
use refrain_host::host::{AgentHost, HostCommand, HostRefusal};
use refrain_host::process::{LaunchSpec, launch};
use refrain_host::run_edge::RunEdge;
use refrain_host::staging::DirectoryContext;
use refrain_store::project::{ProjectStore, RootLocator};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;

const CHAPTER: &str = "章一.md";
const FIRST: &str = "剑一直握在他手里。";
const SECOND: &str = "他没有说话。";

/// 与 `process.rs` 的单元测试同一套按需构建：`cargo test --all-targets` 会把
/// example 包成 libtest，只有 `cargo build --example` 产出可执行文件，所以干净
/// 检出时第一次用到就地构建一次。
fn fixture_path() -> &'static Path {
    static FIXTURE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
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
        assert!(built.exists(), "{}", built.display());
        built
    })
}

fn scratch() -> PathBuf {
    let root = std::env::temp_dir().join(format!("refrain-edge-e2e-{}", Id::new()));
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

fn manuscripts_of(root: &Path) -> HashMap<String, Manuscript> {
    let bytes = fs::read(root.join(CHAPTER)).unwrap();
    let snapshot = SourceSnapshot::read(bytes);
    let lineage = Lineage::fresh(snapshot.block_count());
    [(
        CHAPTER.to_string(),
        Manuscript::open(snapshot, lineage).unwrap(),
    )]
    .into_iter()
    .collect()
}

/// 一份冻结请求：作者选的范围逐字在里面，scope 标记就是 producer 要读的东西。
fn package() -> DispatchPackage {
    DispatchPackage {
        request_md: format!(
            "# Before\n\n<!-- scope ch01:b1 -->\n{FIRST}\n\n# Request\n\n改克制些。\n"
        ),
        manifest: vec![],
        digest: "package-e2e".to_string(),
    }
}

/// 起一个 Task，授权若干个 Run，边按位置给出。返回 Run 的 id，顺序与授权一致。
fn authorize(store: &mut ProjectStore, count: usize, edges: Vec<Option<RunEdge>>) -> Vec<Id> {
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
        new_agents: (0..count).map(|_| Id::new()).collect(),
        retry_runs: vec![],
        edges,
        package: package(),
        clicked_digest: "package-e2e".to_string(),
        authorized_at: 1,
    })
    .unwrap();
    host.runs().iter().map(|run| run.id).collect()
}

/// 启动一个 Run，跑真进程，收取结果。
///
/// `mode` 决定 producer 写什么：`edit` 出改写，`memo` 只出批注。
fn run_to_completion(
    store: &mut ProjectStore,
    root: &Path,
    run_id: Id,
    workspace: &str,
    mode: &str,
) -> Collected {
    let state_dir = store.layout().state_dir.clone();
    {
        let context = DirectoryContext::new(state_dir.clone());
        let mut host =
            AgentHost::open(refrain_app::journal::StoreJournal { store }, context).unwrap();
        host.execute(HostCommand::LaunchRun {
            run_id,
            workspace: workspace.to_string(),
        })
        .unwrap();
        host.execute(HostCommand::CompleteDispatch {
            run_id,
            receipt: "receipt".to_string(),
        })
        .unwrap();
    }

    // 真进程：cwd 是 Run 的工作区，请求已被提升到那里。
    let handle = launch(&LaunchSpec {
        program: fixture_path().to_path_buf(),
        args: vec![
            "--produce".to_string(),
            run_id.to_string(),
            mode.to_string(),
        ],
        env: vec![],
        cwd: state_dir.join(workspace),
    })
    .expect("the producer must actually start");
    let outcome = handle.wait().expect("waiting on the producer");
    assert_eq!(outcome.code, Some(0), "producer failed: {}", outcome.stderr);

    collect_attempt(store, &manuscripts_of(root), run_id, 10).unwrap()
}

/// `Alternates`：两个 Run 并列，谁都不等谁，各自留下自己的提案。
///
/// 断言两条提案都在，是因为「互不影响」的可观察形式就是这个：一个并列 Run 的
/// 成功不以另一个的状态为条件，两份产出也不互相覆盖。
#[test]
fn alternates_both_run_and_neither_waits() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let runs = authorize(
        &mut store,
        2,
        vec![
            Some(RunEdge::Alternates { peer: 1 }),
            Some(RunEdge::Alternates { peer: 0 }),
        ],
    );

    // 第二个先跑：并列不排序，顺序不该有任何影响。
    let second = run_to_completion(&mut store, &root, runs[1], "runs/b", "edit");
    let first = run_to_completion(&mut store, &root, runs[0], "runs/a", "edit");

    for (label, collected) in [("第二个", &second), ("第一个", &first)] {
        assert!(
            matches!(collected, Collected::Completed { proposals: 1, .. }),
            "{label}并列 Run 应当各自留下一条提案，实际是 {collected:?}"
        );
    }
    assert_eq!(
        store.proposals_for(CHAPTER).unwrap().len(),
        2,
        "两个并列 Run 的提案都应当在"
    );
    // Windows 上文件句柄不解就删目录会吃到 code 32；先放掉现场再清。
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

/// `Follows`：上游终态之前启动会被具名拒绝，之后能跑通。
///
/// 两半都要测。只测「之后能跑通」的话，一个根本不检查上游的实现也会全绿——
/// 而那正是这条边唯一在做的事。
#[test]
fn follows_refuses_before_the_upstream_is_terminal_and_runs_after() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let runs = authorize(
        &mut store,
        2,
        vec![None, Some(RunEdge::Follows { upstream: 0 })],
    );
    let state_dir = store.layout().state_dir.clone();

    // 上游还没跑，下游不许启动。
    {
        let context = DirectoryContext::new(state_dir.clone());
        let mut host = AgentHost::open(
            refrain_app::journal::StoreJournal { store: &mut store },
            context,
        )
        .unwrap();
        let refusal = host.execute(HostCommand::LaunchRun {
            run_id: runs[1],
            workspace: "runs/downstream".to_string(),
        });
        assert!(
            matches!(refusal, Err(HostRefusal::UpstreamNotTerminal { .. })),
            "下游不该在上游终态之前启动，实际是 {refusal:?}"
        );
    }

    // 上游跑完，下游就能跑。
    let upstream = run_to_completion(&mut store, &root, runs[0], "runs/upstream", "edit");
    assert!(matches!(upstream, Collected::Completed { .. }));

    let downstream = run_to_completion(&mut store, &root, runs[1], "runs/downstream", "memo");
    assert!(
        matches!(downstream, Collected::Completed { memos: 1, .. }),
        "上游终态之后下游应当跑通，实际是 {downstream:?}"
    );
    // Windows 上文件句柄不解就删目录会吃到 code 32；先放掉现场再清。
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

/// `Verifies`：验证者只出批注时收取成功。
///
/// 越界（出改写）被整份拒绝的细节在 `refrain-app/tests/collect.rs`，那里用的是
/// 铺出来的现场。这里要问的是另一件事：同一条规则在**真实链路**上也成立——
/// 真进程写出的批注能被收下，而不是被那条越界检查误伤。
#[test]
fn a_verifier_that_only_comments_is_collected() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let runs = authorize(
        &mut store,
        2,
        vec![None, Some(RunEdge::Verifies { subject: 0 })],
    );

    let subject = run_to_completion(&mut store, &root, runs[0], "runs/subject", "edit");
    assert!(matches!(subject, Collected::Completed { proposals: 1, .. }));

    let verifier = run_to_completion(&mut store, &root, runs[1], "runs/verifier", "verdict");
    assert!(
        matches!(
            verifier,
            Collected::Completed {
                memos: 1,
                proposals: 0,
                ..
            }
        ),
        "只出批注的验证者应当被收下且不产生提案，实际是 {verifier:?}"
    );
    // Windows 上文件句柄不解就删目录会吃到 code 32；先放掉现场再清。
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
