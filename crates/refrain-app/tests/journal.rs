//! host 实体经过 store 走一个来回之后，还是不是原来那个。
//!
//! 这一层的错法很特别：`entity` 列存的是完整实体，而 `progress_kind`、`task_id`
//! 之类的索引列是从实体里抄出来的副本。抄错时实体本身看起来完全正常，只有按索引
//! 列查询才会指到错的行——肉眼审查很难发现。所以下面每条既断言实体还原无损，也
//! 断言索引列与实体内部的值一致。

use refrain_app::journal::{StoreJournal, entity_of, run_kind, run_row, task_kind, task_row};
use refrain_core::Id;
use refrain_host::host::{CloseReason, HostJournal, ReviewTask, Run, RunProgress, TaskProgress};
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
