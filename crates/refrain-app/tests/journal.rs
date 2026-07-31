//! host 实体经过 store 走一个来回之后，还是不是原来那个。
//!
//! 这一层的错法很特别：`entity` 列存的是完整实体，而 `progress_kind`、`task_id`
//! 之类的索引列是从实体里抄出来的副本。抄错时实体本身看起来完全正常，只有按索引
//! 列查询才会指到错的行——肉眼审查很难发现。所以下面每条既断言实体还原无损，也
//! 断言索引列与实体内部的值一致。

use refrain_app::journal::{StoreJournal, entity_of, run_kind, run_row, task_kind, task_row};
use refrain_core::Id;
use refrain_host::host::{CloseReason, HostJournal, ReviewTask, Run, RunProgress, TaskProgress};
use refrain_host::run_edge::ResolvedEdge;
use refrain_store::project::{ProjectStore, RootLocator};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};

fn scratch() -> PathBuf {
    let root = std::env::temp_dir().join(format!("refrain-journal-{}", Id::new()));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("章一.md"), "正文。\n").unwrap();
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

fn a_task(progress: TaskProgress) -> ReviewTask {
    ReviewTask {
        id: Id::new(),
        baseline: Id::new(),
        document: "章一.md".to_string(),
        prompt: "请检查这一段的时序。".to_string(),
        context_digest: "digest-abc".to_string(),
        progress,
    }
}

fn a_run(task_id: Id, progress: RunProgress) -> Run {
    Run {
        id: Id::new(),
        task_id,
        agent_id: Id::new(),
        snapshot_digest: "snapshot-xyz".to_string(),
        workspace: "runs/one".to_string(),
        progress,
        retry_of: None,
        edge: None,
    }
}

/// 判据 2-8：编排的边必须活过崩溃恢复。
///
/// 这里逐一列出全部三种边，而不是抽一种代表。原因是 `ResolvedEdge` 的每个变体
/// 各带自己的字段名（`upstream` / `peer` / `subject`），序列化形状因而各不相同：
/// 一种边穿过 round-trip 不构成另外两种也能穿过的证据。
///
/// 用 `Record`-式的穷举形状表达同一件事：这个数组漏掉一个变体时，下面的
/// `every_kind_of_edge_survives_the_round_trip` 断言的数量就对不上——而新增一个
/// 变体时，`edge_kind` 的 `match` 没有兜底分支，编译器会直接指到这里。
fn every_edge() -> Vec<ResolvedEdge> {
    vec![
        ResolvedEdge::Follows {
            upstream: Id::new(),
        },
        ResolvedEdge::Alternates { peer: Id::new() },
        ResolvedEdge::Verifies { subject: Id::new() },
    ]
}

/// 边的种类名。没有兜底分支：新增一个变体时这里编译失败，而不是静默漏测。
fn edge_kind(edge: &ResolvedEdge) -> &'static str {
    match edge {
        ResolvedEdge::Follows { .. } => "Follows",
        ResolvedEdge::Alternates { .. } => "Alternates",
        ResolvedEdge::Verifies { .. } => "Verifies",
    }
}

#[test]
fn a_task_survives_the_round_trip_unchanged() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let task = a_task(TaskProgress::Draft);

    let mut journal = StoreJournal { store: &mut store };
    journal.append_task(&task).unwrap();
    let state = journal.load().unwrap();

    assert_eq!(state.tasks.len(), 1);
    assert_eq!(state.tasks[0], task);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_run_survives_the_round_trip_unchanged() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let task = a_task(TaskProgress::Draft);
    let run = a_run(task.id, RunProgress::Queued);

    let mut journal = StoreJournal { store: &mut store };
    journal.append_task(&task).unwrap();
    journal.append_run(&run).unwrap();
    let state = journal.load().unwrap();

    assert_eq!(state.runs.len(), 1);
    assert_eq!(state.runs[0], run);
    fs::remove_dir_all(root).unwrap();
}

/// 判据 2-8：三种边都必须逐字活过 journal 的一个来回。
///
/// 这条测试补的是一个**造不出红的假绿**。原来唯一的 Run round-trip 测试用
/// `a_run(...)` 构造，而那个夹具里 `edge: None` —— 全文件 `edge` 只出现那一次。
/// 于是 `assert_eq!(state.runs[0], run)` 在 edge 恒为 `None` 的夹具上，对 edge
/// 不构成任何约束；再加上 `Run.edge` 带 `#[serde(default)]`，「entity 里没有
/// edge」与「edge 是 None」在反序列化后不可区分。两件事相乘的结果是：把 edge
/// 的序列化整个丢掉，八个测试照样全绿（实测注入 `skip_serializing`，8 passed）。
///
/// 它失败时作者看到的是——崩溃恢复后编排的边全部消失：`Follows` 不再等上游、
/// `Verifies` 不再被禁止改写、`Alternates` 互相可见。边是编排的全部语义，而它
/// 恰好是唯一没被 round-trip 覆盖的字段。
#[test]
fn every_kind_of_edge_survives_the_round_trip() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let task = a_task(TaskProgress::Draft);
    let edges = every_edge();

    let mut journal = StoreJournal { store: &mut store };
    journal.append_task(&task).unwrap();
    let runs: Vec<Run> = edges
        .iter()
        .map(|edge| {
            let mut run = a_run(task.id, RunProgress::Queued);
            run.edge = Some(*edge);
            journal.append_run(&run).unwrap();
            run
        })
        .collect();

    let state = journal.load().unwrap();

    // 数量先对齐：少一种边时这里就报，而不是让下面的查找静默跳过。
    assert_eq!(state.runs.len(), edges.len(), "每种边各一个 Run");
    for run in &runs {
        let loaded = state
            .runs
            .iter()
            .find(|candidate| candidate.id == run.id)
            .unwrap_or_else(|| {
                panic!(
                    "{} 的 Run 没有被读回来",
                    edge_kind(run.edge.as_ref().unwrap())
                )
            });
        assert_eq!(
            loaded.edge,
            run.edge,
            "{} 没有逐字活过 round-trip",
            edge_kind(run.edge.as_ref().unwrap())
        );
    }
    fs::remove_dir_all(root).unwrap();
}

/// 边的缺席必须与「边是 None」可区分。
///
/// `#[serde(default)]` 让这两件事在读回来之后长得一模一样，所以上面那条测试
/// 只能证明「写进去的边读得回来」，不能证明「写的时候真的写了」。这里直接问
/// 落盘的字节：一个带边的 Run，它的 entity 列里必须真的有 `edge` 这个键。
///
/// 分开写而不是并进上面一条，是因为两者失败时说的是不同的话：上面说「边变了」，
/// 这里说「边根本没落盘」。合成一条会让两种缺陷共用一个失败信息。
#[test]
fn a_run_with_an_edge_writes_the_edge_into_the_entity_column() {
    let task = a_task(TaskProgress::Draft);
    for edge in every_edge() {
        let mut run = a_run(task.id, RunProgress::Queued);
        run.edge = Some(edge);
        let row = run_row(&run).unwrap();
        assert!(
            row.entity.contains("\"edge\""),
            "{} 的边没有出现在落盘的 entity 列里：{}",
            edge_kind(&edge),
            row.entity
        );
    }
}

#[test]
fn the_index_columns_agree_with_what_the_entity_says() {
    // 索引列抄错时实体照样完好，只有查询会指到错的行。这条把两边对起来。
    let task = a_task(TaskProgress::Draft);
    let row = task_row(&task).unwrap();
    assert_eq!(row.id, task.id.to_string());
    assert_eq!(row.baseline, task.baseline.to_string());
    assert_eq!(row.progress_kind, task_kind(&task.progress));
    let decoded: ReviewTask = entity_of(&row.entity, "task").unwrap();
    assert_eq!(decoded, task);

    let run = a_run(
        task.id,
        RunProgress::Dispatched {
            receipt: "r-1".to_string(),
        },
    );
    let row = run_row(&run).unwrap();
    assert_eq!(row.id, run.id.to_string());
    assert_eq!(row.task_id, run.task_id.to_string());
    assert_eq!(row.agent_id, run.agent_id.to_string());
    assert_eq!(row.progress_kind, run_kind(&run.progress));
    assert_eq!(row.retry_of, None);
    let decoded: Run = entity_of(&row.entity, "run").unwrap();
    assert_eq!(decoded, run);
}

#[test]
fn every_task_progress_has_its_own_index_name() {
    // 两个状态共用一个名字，等于按状态查询时永远分不开它们。
    let names = [
        task_kind(&TaskProgress::Draft),
        task_kind(&TaskProgress::Open { opened_at: 1 }),
        task_kind(&TaskProgress::Closed {
            reason: CloseReason::Author,
            closed_at: 2,
        }),
    ];
    let unique: std::collections::HashSet<_> = names.iter().collect();
    assert_eq!(unique.len(), names.len(), "two task states share a name");
}

#[test]
fn every_run_progress_has_its_own_index_name() {
    let names = [
        run_kind(&RunProgress::Queued),
        run_kind(&RunProgress::Authorized {
            request_digest: "d1".to_string(),
        }),
        run_kind(&RunProgress::Launching {
            request_digest: "d2".to_string(),
        }),
        run_kind(&RunProgress::Dispatched {
            receipt: "r-3".to_string(),
        }),
        run_kind(&RunProgress::Completed {
            artifact_digest: "d".to_string(),
        }),
        run_kind(&RunProgress::Failed {
            failure: "e".to_string(),
        }),
        run_kind(&RunProgress::Cancelled),
    ];
    let unique: std::collections::HashSet<_> = names.iter().collect();
    assert_eq!(unique.len(), names.len(), "two run states share a name");
}

#[test]
fn a_retry_remembers_which_run_it_replaces() {
    let task = a_task(TaskProgress::Draft);
    let first = a_run(
        task.id,
        RunProgress::Failed {
            failure: "timeout".to_string(),
        },
    );
    let mut second = a_run(task.id, RunProgress::Queued);
    second.retry_of = Some(first.id);

    let row = run_row(&second).unwrap();
    assert_eq!(row.retry_of, Some(first.id.to_string()));
    let decoded: Run = entity_of(&row.entity, "run").unwrap();
    assert_eq!(decoded.retry_of, Some(first.id));
}

#[test]
fn an_updated_run_replaces_the_row_rather_than_adding_one() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let task = a_task(TaskProgress::Draft);
    let mut run = a_run(task.id, RunProgress::Queued);

    let mut journal = StoreJournal { store: &mut store };
    journal.append_task(&task).unwrap();
    journal.append_run(&run).unwrap();

    run.progress = RunProgress::Cancelled;
    journal.update_run(&run).unwrap();

    let state = journal.load().unwrap();
    assert_eq!(state.runs.len(), 1, "the update added a second row");
    assert_eq!(state.runs[0].progress, RunProgress::Cancelled);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_malformed_entity_column_is_reported_rather_than_guessed() {
    // 读不回来时必须说出来。返回一个默认值会让一条坏行看起来像一条正常的空记录。
    let failure = entity_of::<ReviewTask>("{ not json", "task").unwrap_err();
    assert!(format!("{failure:?}").contains("task"));
}
