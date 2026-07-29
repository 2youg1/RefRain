//! C13 legacy-migration vectors (SPEC 10.2, 10.3): every plane imports, a
//! rerun is a no-op, a kill reruns to the same result, and every judgment
//! call stops in the quarantine list instead of guessing.
//!
//! Windows discipline: drop every database handle before `remove_dir_all`.

use refrain_store::config::AdapterKind;
use refrain_store::migrate::{
    AgentOutcome, MigrationFailure, MigrationReport, MigrationStatus, migrate_legacy,
};
use refrain_store::project::ProjectStore;
use refrain_store::project::RootLocator;
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static SEQUENCE: AtomicU32 = AtomicU32::new(0);

fn scratch() -> PathBuf {
    let unique = format!(
        "refrain-migrate-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let dir = std::env::temp_dir().join(unique);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(root: &Path, relative: &str, content: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn write_bytes(root: &Path, relative: &str, content: &[u8]) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

/// A digest over the whole tree: sorted (path, sha-256) pairs, folded. Two
/// runs with the same effect have the same tree digest; a no-op run leaves
/// the digest alone.
fn tree_digest(root: &Path) -> String {
    let mut entries: Vec<(String, String)> = Vec::new();
    walk(root, root, &mut |path, relative| {
        let bytes = fs::read(&path).unwrap();
        entries.push((relative, format!("{:x}", Sha256::digest(&bytes))));
    });
    entries.sort();
    let mut text = String::new();
    for (path, digest) in entries {
        text.push_str(&format!("{path} {digest}\n"));
    }
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn walk(base: &Path, root: &Path, visit: &mut impl FnMut(PathBuf, String)) {
    if !base.try_exists().unwrap_or(false) {
        return;
    }
    for entry in fs::read_dir(base).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if entry.file_type().unwrap().is_dir() {
            walk(&path, root, visit);
        } else {
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            visit(path, relative);
        }
    }
}

/// The happy-path legacy project: every plane present and well-formed.
fn build_legacy(root: &Path) {
    write(root, "01.md", "第一章第一段。\n\n第一章第二段。\n");
    write(root, "02.md", "第二章。\n");
    write(root, "资料/年表.md", "一九三一年。\n");
    write(root, "notes/deep.md", "未分类的深文。\n");
    write(
        root,
        ".refrain/agents.json",
        r#"[
  { "id": "a-file", "name": "文件通道", "harness": "file", "model": "m-x", "reasoningEffort": "high" },
  { "id": "a-cmd", "name": "命令行", "harness": "command:a-cmd", "model": "gpt-x", "reasoningEffort": "low", "template": ["kimi", "-p", "{prompt}"] }
]
"#,
    );
    write(
        root,
        ".refrain/host.json",
        r#"{
  "version": 2,
  "sequence": 2,
  "drifted": [],
  "queue": [
    { "id": "t-queue", "agentId": "a-file", "baseline": "th:b1", "prompt": "改第一段。",
      "contextScope": [], "editScopes": [ { "id": "s1", "blockIds": ["01.md:b0"] } ] }
  ],
  "runs": [
    { "id": "run1", "state": "completed",
      "task": { "id": "t-1", "agentId": "a-cmd", "baseline": "th:b2", "prompt": "改写。",
        "contextScope": [], "editScopes": [ { "id": "s2", "blockIds": ["01.md:b0"] } ] },
      "comments": [],
      "proposals": [
        { "id": "run1:s2", "runId": "run1", "baseline": "th:b2",
          "scope": { "id": "s2", "blockIds": ["01.md:b0"] },
          "before": "第一章第一段。", "after": "改过的第一段。" }
      ] },
    { "id": "run2", "state": "failed",
      "task": { "id": "t-2", "agentId": "a-file", "baseline": "th:b3", "prompt": "再改。",
        "contextScope": [], "editScopes": [] },
      "failure": "timeout", "comments": [], "proposals": [] }
  ]
}
"#,
    );
    build_verdicts_db(
        root,
        &[
            (
                "v-s1-1",
                "run1:s2",
                Some("run1:s2.s0"),
                "accept",
                None,
                Some("好。"),
                "th:b2",
                "2024-03-01T10:00:00.000Z",
            ),
            (
                "v-s1-2",
                "run1:s2",
                Some("run1:s2.s1"),
                "reject",
                None,
                None,
                "th:b2",
                "2024-03-01T11:00:00.500Z",
            ),
        ],
        1,
    );
    write(
        root,
        ".refrain/memos/a-cmd.md",
        "# 命令行 的工作记忆\n\n## 2024-01-01T00:00:00.000Z · 语气\n\n<!-- run run1 -->\n\n结尾偏议论。\n",
    );
    write(
        root,
        ".refrain/runs/run1/request.md",
        "# Context\n\n# Request\n\n改写。\n",
    );
    write(
        root,
        ".refrain/runs/run1/result.md",
        "<agent-result version=\"2\">\n</agent-result>\n",
    );
    write(
        root,
        ".refrain-source/01.md",
        "第一章第一段。\n\n第一章第二段。\n",
    );
    write(root, ".refrain-source/资料/年表.md", "一九三一年。\n");
    write(
        root,
        ".refrain-source/taken.json",
        "{ \"taken\": \"2024-01-01T00:00:00.000Z\", \"files\": 2 }\n",
    );
}

type VerdictRow<'a> = (
    &'a str,
    &'a str,
    Option<&'a str>,
    &'a str,
    Option<&'a str>,
    Option<&'a str>,
    &'a str,
    &'a str,
);

/// The old `verdicts.db`, with the legacy DDL (`ledger.ts`), closed before
/// return so the file is self-contained.
fn build_verdicts_db(root: &Path, rows: &[VerdictRow], kara_notes: u32) {
    let path = root.join(".refrain").join("verdicts.db");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let db = Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS verdicts (
             id TEXT PRIMARY KEY,
             proposal_id TEXT NOT NULL,
             slice_id TEXT,
             kind TEXT NOT NULL,
             final_text TEXT,
             reason TEXT,
             baseline TEXT NOT NULL,
             decided_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS kara_notes (
             id TEXT PRIMARY KEY,
             text TEXT NOT NULL,
             chapter_id TEXT,
             block_id TEXT,
             captured_at TEXT NOT NULL
         );
         DELETE FROM verdicts;
         DELETE FROM kara_notes;",
    )
    .unwrap();
    for (id, proposal, slice, kind, final_text, reason, baseline, decided_at) in rows {
        db.execute(
            "INSERT INTO verdicts (id, proposal_id, slice_id, kind, final_text, reason, baseline, decided_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![id, proposal, slice, kind, final_text, reason, baseline, decided_at],
        )
        .unwrap();
    }
    for index in 0..kara_notes {
        db.execute(
            "INSERT INTO kara_notes (id, text, chapter_id, block_id, captured_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                format!("note-{index}"),
                "一条笔记。",
                "01.md",
                "01.md:b0",
                "2024-03-01T12:00:00.000Z"
            ],
        )
        .unwrap();
    }
    drop(db);
}

fn target_db(target: &Path) -> Connection {
    Connection::open(target.join(".refrain").join("refrain.db")).unwrap()
}

fn count(db: &Connection, table: &str) -> u32 {
    db.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
        row.get(0)
    })
    .unwrap()
}

fn documents(db: &Connection) -> Vec<(String, String, String, String)> {
    let mut statement = db
        .prepare("SELECT path, role, digest, legacy_id FROM documents ORDER BY path")
        .unwrap();
    statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

fn digest_of(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

#[test]
fn a_full_legacy_project_migrates_every_plane() {
    let legacy = scratch();
    let target = scratch();
    build_legacy(&legacy);
    let legacy_before = tree_digest(&legacy);

    let report = migrate_legacy(&legacy, &target).unwrap();
    assert_eq!(report.status, MigrationStatus::Completed);
    assert!(report.quarantine.is_empty(), "{:?}", report.quarantine);

    // The planes, by the numbers.
    assert_eq!(report.planes.documents.found, 4);
    assert_eq!(report.planes.documents.imported, 4);
    assert_eq!(report.planes.agents.found, 2);
    assert_eq!(report.planes.agents.imported, 2);
    assert_eq!(report.planes.tasks.found, 3);
    assert_eq!(report.planes.tasks.imported, 3);
    assert_eq!(report.planes.runs.found, 2);
    assert_eq!(report.planes.runs.imported, 2);
    assert_eq!(report.planes.proposals.found, 1);
    assert_eq!(report.planes.proposals.imported, 1);
    assert_eq!(report.planes.verdicts.found, 2);
    assert_eq!(report.planes.verdicts.imported, 2);
    assert_eq!(report.planes.kara_notes.found, 1);
    assert_eq!(report.planes.kara_notes.imported, 0);
    assert_eq!(report.planes.authorizations.found, 0);
    assert_eq!(report.planes.preserved_files.found, 6);
    assert_eq!(report.planes.preserved_files.imported, 6);

    // The legacy Root is read-only evidence: byte-identical afterwards.
    assert_eq!(tree_digest(&legacy), legacy_before);

    // Manuscripts landed, roles by the migration-time hint, legacy_id kept.
    assert_eq!(
        fs::read_to_string(target.join("01.md")).unwrap(),
        "第一章第一段。\n\n第一章第二段。\n"
    );
    assert_eq!(
        fs::read_to_string(target.join("资料/年表.md")).unwrap(),
        "一九三一年。\n"
    );
    let db = target_db(&target);
    assert_eq!(
        documents(&db),
        vec![
            (
                "01.md".to_string(),
                "chapter".to_string(),
                digest_of("第一章第一段。\n\n第一章第二段。\n"),
                "01.md".to_string(),
            ),
            (
                "02.md".to_string(),
                "chapter".to_string(),
                digest_of("第二章。\n"),
                "02.md".to_string(),
            ),
            (
                "notes/deep.md".to_string(),
                "document".to_string(),
                digest_of("未分类的深文。\n"),
                "notes/deep.md".to_string(),
            ),
            (
                "资料/年表.md".to_string(),
                "material".to_string(),
                digest_of("一九三一年。\n"),
                "资料/年表.md".to_string(),
            ),
        ]
    );

    // Tasks and runs, with the agent mapping applied: the command agent's
    // run names the planned Connection, the file agent's run names L0.
    let connection_id = report.connections[0].id.to_string();
    let tasks: Vec<(String, String)> = {
        let mut statement = db
            .prepare("SELECT baseline, progress_kind FROM tasks ORDER BY baseline")
            .unwrap();
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    assert_eq!(
        tasks,
        vec![
            ("th:b1".to_string(), "draft".to_string()),
            ("th:b2".to_string(), "open".to_string()),
            ("th:b3".to_string(), "open".to_string()),
        ]
    );
    let runs: Vec<(String, String)> = {
        let mut statement = db
            .prepare("SELECT agent_id, progress_kind FROM runs ORDER BY rowid")
            .unwrap();
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    assert_eq!(
        runs,
        vec![
            (connection_id.clone(), "completed".to_string()),
            (
                "00000000-0000-0000-0000-0000000000e0".to_string(),
                "failed".to_string(),
            ),
        ]
    );
    let entity: String = db
        .query_row(
            r#"SELECT entity FROM tasks WHERE entity LIKE '%"legacyId":"t-queue"%'"#,
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(entity.contains(r#""legacyId":"t-queue""#), "{entity}");

    // The proposal keeps its old id and scope; the run column names the new
    // run; the old world recorded no time, so the stamp is zero.
    let proposal: (String, String, String, String, String, Option<String>, i64) = db
        .query_row(
            "SELECT id, baseline, document_path, scope, before_text, after_text, created_at FROM proposals",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        proposal,
        (
            "run1:s2".to_string(),
            "th:b2".to_string(),
            "01.md".to_string(),
            "s2".to_string(),
            "第一章第一段。".to_string(),
            Some("改过的第一段。".to_string()),
            0,
        )
    );

    // Verdicts keep their old ids; the ISO time parsed; the old baseline
    // rides in legacy_baseline.
    let verdicts: Vec<(String, String, i64, String)> = {
        let mut statement = db
            .prepare("SELECT id, kind, decided_at, legacy_baseline FROM verdicts ORDER BY id")
            .unwrap();
        statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    assert_eq!(
        verdicts,
        vec![
            (
                "v-s1-1".to_string(),
                "accept".to_string(),
                1_709_287_200_000_i64,
                "th:b2".to_string(),
            ),
            (
                "v-s1-2".to_string(),
                "reject".to_string(),
                1_709_290_800_500_i64,
                "th:b2".to_string(),
            ),
        ]
    );
    let log: (String,) = db
        .query_row("SELECT name FROM migration_log", [], |row| {
            Ok((row.get(0)?,))
        })
        .unwrap();
    assert_eq!(log.0, "legacy-v0.1.6");

    // The v1 backup: every old plane byte-for-byte under .refrain/legacy,
    // plus the digest manifest and the completion mark.
    for relative in [
        "agents.json",
        "host.json",
        "verdicts.db",
        "memos/a-cmd.md",
        "runs/run1/request.md",
        "runs/run1/result.md",
    ] {
        assert_eq!(
            fs::read(target.join(".refrain/legacy").join(relative)).unwrap(),
            fs::read(legacy.join(".refrain").join(relative)).unwrap(),
            "{relative} was not preserved byte-for-byte"
        );
    }
    assert!(report.manifest_path.try_exists().unwrap());
    assert!(
        target
            .join(".refrain/migration-complete.json")
            .try_exists()
            .unwrap()
    );
    drop(db);

    // The agent mapping: the command agent became a KimiCode connection with
    // argv verbatim and trust never carried; model/effort stay requested.
    assert_eq!(report.connections.len(), 1);
    let connection = &report.connections[0];
    assert_eq!(connection.adapter, AdapterKind::KimiCode);
    assert_eq!(connection.executable, Path::new("kimi"));
    assert_eq!(
        connection.argv,
        vec!["-p".to_string(), "{prompt}".to_string()]
    );
    let file_agent = report
        .agent_map
        .iter()
        .find(|mapping| mapping.legacy_id == "a-file")
        .unwrap();
    assert_eq!(file_agent.outcome, AgentOutcome::FileChannel);
    assert_eq!(
        file_agent.legacy_requested,
        Some(("m-x".to_string(), "high".to_string()))
    );

    // The migrated project adopts and refreshes like any other: the roles
    // the migration wrote survive the walk.
    let mut app = Connection::open_in_memory().unwrap();
    AppDb::migrate(&mut app).unwrap();
    let (mut store, _backup) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: target.clone(),
            kind: RootKind::Folder,
        },
    )
    .unwrap();
    let rows = store.refresh_documents().unwrap();
    let roles: Vec<(String, String)> = rows
        .iter()
        .map(|row| (row.path.clone(), row.role.as_str().to_string()))
        .collect();
    assert_eq!(
        roles,
        vec![
            ("01.md".to_string(), "chapter".to_string()),
            ("02.md".to_string(), "chapter".to_string()),
            ("notes/deep.md".to_string(), "document".to_string()),
            ("资料/年表.md".to_string(), "material".to_string()),
        ]
    );
    drop(store);
    drop(app);

    fs::remove_dir_all(&legacy).unwrap();
    fs::remove_dir_all(&target).unwrap();
}

#[test]
fn a_second_and_third_run_change_nothing() {
    let legacy = scratch();
    let target = scratch();
    build_legacy(&legacy);
    let first = migrate_legacy(&legacy, &target).unwrap();
    let tree_after_first = tree_digest(&target);

    let second = migrate_legacy(&legacy, &target).unwrap();
    assert_eq!(
        tree_digest(&target),
        tree_after_first,
        "run two wrote something"
    );
    assert_eq!(second, first, "run two returned a different report");

    let third = migrate_legacy(&legacy, &target).unwrap();
    assert_eq!(
        tree_digest(&target),
        tree_after_first,
        "run three wrote something"
    );
    assert_eq!(third, first);

    fs::remove_dir_all(&legacy).unwrap();
    fs::remove_dir_all(&target).unwrap();
}

/// Logical equality across a rebuild: ids mint fresh each time, so the
/// comparison normalizes them out and everything else must match.
fn normalized(report: &MigrationReport) -> String {
    let mut text = format!(
        "{:?}{:?}{:?}",
        report.status, report.planes, report.quarantine
    );
    for mapping in &report.agent_map {
        let outcome = match &mapping.outcome {
            AgentOutcome::Connection(_) => "connection".to_string(),
            other => format!("{other:?}"),
        };
        text.push_str(&format!(
            "{}{}{}{:?}",
            mapping.legacy_id, mapping.name, outcome, mapping.legacy_requested
        ));
    }
    for connection in &report.connections {
        text.push_str(&format!(
            "{:?}{:?}{:?}{:?}",
            connection.adapter, connection.executable, connection.argv, connection.env_allow
        ));
    }
    text
}

#[test]
fn a_kill_before_the_mark_reruns_to_the_same_result() {
    let legacy = scratch();
    let target = scratch();
    build_legacy(&legacy);
    let first = migrate_legacy(&legacy, &target).unwrap();
    let first_documents = documents(&target_db(&target));

    // The kill: everything but the completion mark landed.
    fs::remove_file(target.join(".refrain/migration-complete.json")).unwrap();

    let second = migrate_legacy(&legacy, &target).unwrap();
    assert_eq!(normalized(&second), normalized(&first));
    assert_eq!(documents(&target_db(&target)), first_documents);
    let db = target_db(&target);
    for (table, wanted) in [
        ("documents", 4),
        ("tasks", 3),
        ("runs", 2),
        ("proposals", 1),
        ("verdicts", 2),
        ("migration_log", 1),
    ] {
        assert_eq!(count(&db, table), wanted, "{table}");
    }
    drop(db);
    assert_eq!(
        fs::read(target.join(".refrain/legacy/host.json")).unwrap(),
        fs::read(legacy.join(".refrain/host.json")).unwrap()
    );

    fs::remove_dir_all(&legacy).unwrap();
    fs::remove_dir_all(&target).unwrap();
}

#[test]
fn a_kill_mid_shadow_reruns_clean() {
    let legacy = scratch();
    let target = scratch();
    build_legacy(&legacy);
    let first = migrate_legacy(&legacy, &target).unwrap();

    // A kill mid-build: no mark, and a partial shadow left behind.
    fs::remove_file(target.join(".refrain/migration-complete.json")).unwrap();
    write_bytes(&target, ".refrain-shadow/refrain.db", b"half a database");

    let second = migrate_legacy(&legacy, &target).unwrap();
    assert_eq!(normalized(&second), normalized(&first));
    assert!(!target.join(".refrain-shadow").try_exists().unwrap());
    let db = target_db(&target);
    assert_eq!(count(&db, "documents"), 4);
    assert_eq!(count(&db, "verdicts"), 2);
    drop(db);

    fs::remove_dir_all(&legacy).unwrap();
    fs::remove_dir_all(&target).unwrap();
}

#[test]
fn a_damaged_agents_plane_quarantines_and_continues() {
    let legacy = scratch();
    let target = scratch();
    build_legacy(&legacy);
    write(&legacy, ".refrain/agents.json", "{ this is not json");

    let report = migrate_legacy(&legacy, &target).unwrap();
    assert_eq!(report.status, MigrationStatus::QuarantinedItems);
    let stop = report
        .quarantine
        .iter()
        .find(|item| item.plane == "agents.json")
        .unwrap();
    assert_eq!(stop.kind, "plane-unparseable");
    assert!(report.connections.is_empty());
    // The rest went on: documents imported, and every run stopped for its
    // unmappable agent rather than guessing one.
    assert_eq!(report.planes.documents.imported, 4);
    assert_eq!(report.planes.runs.imported, 0);
    assert_eq!(report.planes.runs.quarantined, 2);
    assert!(
        report
            .quarantine
            .iter()
            .all(|item| item.plane != "runs" || item.kind == "unknown-agent")
    );
    let db = target_db(&target);
    assert_eq!(count(&db, "documents"), 4);
    assert_eq!(count(&db, "tasks"), 3);
    drop(db);

    fs::remove_dir_all(&legacy).unwrap();
    fs::remove_dir_all(&target).unwrap();
}

#[test]
fn a_divergent_run_agent_quarantines_the_run() {
    let legacy = scratch();
    let target = scratch();
    build_legacy(&legacy);
    // The queued t-1 names a-file; the run embedding t-1 names a-cmd.
    write(
        &legacy,
        ".refrain/host.json",
        r#"{
  "version": 2, "sequence": 2, "drifted": [],
  "queue": [
    { "id": "t-1", "agentId": "a-file", "baseline": "th:b2", "prompt": "改写。",
      "contextScope": [], "editScopes": [ { "id": "s2", "blockIds": ["01.md:b0"] } ] }
  ],
  "runs": [
    { "id": "run1", "state": "completed",
      "task": { "id": "t-1", "agentId": "a-cmd", "baseline": "th:b2", "prompt": "改写。",
        "contextScope": [], "editScopes": [ { "id": "s2", "blockIds": ["01.md:b0"] } ] },
      "comments": [],
      "proposals": [
        { "id": "run1:s2", "runId": "run1", "baseline": "th:b2",
          "scope": { "id": "s2", "blockIds": ["01.md:b0"] },
          "before": "第一章第一段。", "after": "改过的第一段。" }
      ] },
    { "id": "run2", "state": "failed",
      "task": { "id": "t-2", "agentId": "a-file", "baseline": "th:b3", "prompt": "再改。",
        "contextScope": [], "editScopes": [] },
      "failure": "timeout", "comments": [], "proposals": [] }
  ]
}
"#,
    );

    let report = migrate_legacy(&legacy, &target).unwrap();
    assert_eq!(report.status, MigrationStatus::QuarantinedItems);
    let stop = report
        .quarantine
        .iter()
        .find(|item| item.kind == "agent-divergence")
        .unwrap();
    assert_eq!(stop.subject, "run1");
    // The divergent run and its proposal stop; the task and the clean run go.
    assert_eq!(report.planes.runs.imported, 1);
    assert_eq!(report.planes.runs.quarantined, 1);
    assert_eq!(report.planes.proposals.quarantined, 1);
    let db = target_db(&target);
    assert_eq!(count(&db, "runs"), 1);
    assert_eq!(count(&db, "tasks"), 2);
    assert_eq!(count(&db, "proposals"), 0);
    drop(db);

    fs::remove_dir_all(&legacy).unwrap();
    fs::remove_dir_all(&target).unwrap();
}

#[test]
fn corrupt_verdict_rows_are_isolated_and_the_rest_import() {
    let legacy = scratch();
    let target = scratch();
    build_legacy(&legacy);
    build_verdicts_db(
        &legacy,
        &[
            (
                "v-good",
                "run1:s2",
                Some("run1:s2.s0"),
                "accept",
                None,
                Some("好。"),
                "th:b2",
                "2024-03-01T10:00:00.000Z",
            ),
            (
                "v-bad-kind",
                "run1:s2",
                None,
                "shrug",
                None,
                None,
                "th:b2",
                "2024-03-01T10:00:00.000Z",
            ),
            (
                "v-bad-date",
                "run1:s2",
                Some("run1:s2.s1"),
                "reject",
                None,
                None,
                "th:b2",
                "三月一日",
            ),
            (
                "v-modified",
                "run1:s2",
                Some("run1:s2.s0"),
                "accept-modified",
                None,
                None,
                "th:b2",
                "2024-03-01T10:00:00.000Z",
            ),
            (
                "v-no-slice",
                "run1:s2",
                None,
                "accept",
                None,
                None,
                "th:b2",
                "2024-03-01T10:00:00.000Z",
            ),
        ],
        0,
    );

    let report = migrate_legacy(&legacy, &target).unwrap();
    assert_eq!(report.status, MigrationStatus::QuarantinedItems);
    assert_eq!(report.planes.verdicts.found, 5);
    assert_eq!(report.planes.verdicts.imported, 1);
    assert_eq!(report.planes.verdicts.quarantined, 4);
    for kind in [
        "unknown-kind",
        "bad-time",
        "missing-final-text",
        "missing-slice-id",
    ] {
        assert!(
            report.quarantine.iter().any(|item| item.kind == kind),
            "missing quarantine kind {kind}: {:?}",
            report.quarantine
        );
    }
    let db = target_db(&target);
    assert_eq!(count(&db, "verdicts"), 1);
    let id: String = db
        .query_row("SELECT id FROM verdicts", [], |row| row.get(0))
        .unwrap();
    assert_eq!(id, "v-good");
    drop(db);

    fs::remove_dir_all(&legacy).unwrap();
    fs::remove_dir_all(&target).unwrap();
}

#[test]
fn conflicting_proposal_ids_are_all_isolated() {
    let legacy = scratch();
    let target = scratch();
    build_legacy(&legacy);
    // Two completed runs carry the same proposal id. Both instances are
    // isolated; the runs themselves are not to blame.
    write(
        &legacy,
        ".refrain/host.json",
        r#"{
  "version": 2, "sequence": 2, "drifted": [], "queue": [],
  "runs": [
    { "id": "run1", "state": "completed",
      "task": { "id": "t-1", "agentId": "a-cmd", "baseline": "th:b2", "prompt": "改写。",
        "contextScope": [], "editScopes": [ { "id": "s2", "blockIds": ["01.md:b0"] } ] },
      "comments": [],
      "proposals": [
        { "id": "dup:s2", "runId": "run1", "baseline": "th:b2",
          "scope": { "id": "s2", "blockIds": ["01.md:b0"] },
          "before": "第一章第一段。", "after": "改过的第一段。" }
      ] },
    { "id": "run2", "state": "completed",
      "task": { "id": "t-2", "agentId": "a-file", "baseline": "th:b3", "prompt": "再改。",
        "contextScope": [], "editScopes": [ { "id": "s3", "blockIds": ["01.md:b1"] } ] },
      "comments": [],
      "proposals": [
        { "id": "dup:s2", "runId": "run2", "baseline": "th:b3",
          "scope": { "id": "s3", "blockIds": ["01.md:b1"] },
          "before": "第一章第二段。", "after": "改过的第二段。" }
      ] }
  ]
}
"#,
    );

    let report = migrate_legacy(&legacy, &target).unwrap();
    assert_eq!(report.status, MigrationStatus::QuarantinedItems);
    assert_eq!(report.planes.runs.imported, 2);
    assert_eq!(report.planes.proposals.found, 2);
    assert_eq!(report.planes.proposals.imported, 0);
    assert_eq!(report.planes.proposals.quarantined, 2);
    assert!(
        report
            .quarantine
            .iter()
            .any(|item| item.plane == "proposals" && item.kind == "id-conflict"),
        "{:?}",
        report.quarantine
    );
    let db = target_db(&target);
    assert_eq!(count(&db, "proposals"), 0);
    assert_eq!(count(&db, "runs"), 2);
    drop(db);

    fs::remove_dir_all(&legacy).unwrap();
    fs::remove_dir_all(&target).unwrap();
}

#[test]
fn a_partial_source_backup_is_a_quarantine_stop() {
    let legacy = scratch();
    let target = scratch();
    build_legacy(&legacy);
    write(
        &legacy,
        ".refrain-source/taken.json",
        "{ \"taken\": \"2024-01-01T00:00:00.000Z\", \"files\": 5 }\n",
    );

    let report = migrate_legacy(&legacy, &target).unwrap();
    assert_eq!(report.status, MigrationStatus::QuarantinedItems);
    let stop = report
        .quarantine
        .iter()
        .find(|item| item.kind == "partial-backup")
        .unwrap();
    assert_eq!(stop.plane, ".refrain-source");
    // The backup is read-only evidence: nothing regenerated, nothing moved,
    // and the rest of the migration went on.
    assert!(legacy.join(".refrain-source/01.md").try_exists().unwrap());
    assert!(!target.join(".refrain-source").try_exists().unwrap());
    assert_eq!(report.planes.documents.imported, 4);

    // A missing manifest is partial too.
    let legacy2 = scratch();
    let target2 = scratch();
    build_legacy(&legacy2);
    fs::remove_file(legacy2.join(".refrain-source/taken.json")).unwrap();
    let report2 = migrate_legacy(&legacy2, &target2).unwrap();
    assert!(
        report2
            .quarantine
            .iter()
            .any(|item| item.kind == "partial-backup"),
        "{:?}",
        report2.quarantine
    );

    fs::remove_dir_all(&legacy).unwrap();
    fs::remove_dir_all(&target).unwrap();
    fs::remove_dir_all(&legacy2).unwrap();
    fs::remove_dir_all(&target2).unwrap();
}

#[test]
fn identical_bytes_dedup_and_same_names_with_different_bytes_stay() {
    let legacy = scratch();
    let target = scratch();
    write(&legacy, "01.md", "第一章。\n");
    write(&legacy, "资料/dup.md", "同一份材料。\n");
    write(&legacy, "material/dup.md", "同一份材料。\n");
    write(&legacy, "资料/uniq.md", "资料的版本。\n");
    write(&legacy, "material/uniq.md", "另一个版本。\n");

    let report = migrate_legacy(&legacy, &target).unwrap();
    assert_eq!(report.planes.documents.found, 5);
    assert_eq!(report.planes.documents.imported, 4);
    let db = target_db(&target);
    let rows = documents(&db);
    assert_eq!(rows.len(), 4);
    assert!(
        rows.iter()
            .any(|(path, role, _, _)| path == "material/dup.md" && role == "material"),
        "{rows:?}"
    );
    // The digest-identical duplicate is deduped: no row, no copied file, and
    // the manifest records where it went. The sorted walk keeps the first.
    assert!(!rows.iter().any(|(path, _, _, _)| path == "资料/dup.md"));
    assert!(!target.join("资料/dup.md").try_exists().unwrap());
    assert!(target.join("material/dup.md").try_exists().unwrap());
    // Same name, different bytes: both stay.
    assert!(rows.iter().any(|(path, _, _, _)| path == "资料/uniq.md"));
    assert!(
        rows.iter()
            .any(|(path, _, _, _)| path == "material/uniq.md")
    );
    drop(db);
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(target.join(".refrain/legacy/manifest.json")).unwrap())
            .unwrap();
    let deduped = manifest["deduped"].as_array().unwrap();
    assert_eq!(deduped.len(), 1);
    assert_eq!(deduped[0]["dropped"], "资料/dup.md");
    assert_eq!(deduped[0]["kept"], "material/dup.md");

    fs::remove_dir_all(&legacy).unwrap();
    fs::remove_dir_all(&target).unwrap();
}

#[test]
fn an_orphaned_run_directory_is_recorded_and_preserved() {
    let legacy = scratch();
    let target = scratch();
    build_legacy(&legacy);
    write(
        &legacy,
        ".refrain/runs/run9/request.md",
        "# Request\n\n孤儿。\n",
    );
    write(&legacy, ".refrain/runs/run9/result.md", "截断的结果");

    let report = migrate_legacy(&legacy, &target).unwrap();
    assert_eq!(report.status, MigrationStatus::QuarantinedItems);
    let stop = report
        .quarantine
        .iter()
        .find(|item| item.kind == "orphaned-legacy-artifact")
        .unwrap();
    assert_eq!(stop.subject, "runs/run9");
    // The bytes are preserved with a digest in the manifest, truncation and
    // all — history is evidence, not something to repair.
    assert_eq!(
        fs::read_to_string(target.join(".refrain/legacy/runs/run9/result.md")).unwrap(),
        "截断的结果"
    );
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(target.join(".refrain/legacy/manifest.json")).unwrap())
            .unwrap();
    assert!(
        manifest["preserved_files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file["path"] == "runs/run9/result.md" && file["digest"].is_string())
    );

    fs::remove_dir_all(&legacy).unwrap();
    fs::remove_dir_all(&target).unwrap();
}

#[test]
fn an_unreadable_command_records_unavailable() {
    let legacy = scratch();
    let target = scratch();
    build_legacy(&legacy);
    write(
        &legacy,
        ".refrain/agents.json",
        r#"[
  { "id": "a-file", "name": "文件通道", "harness": "file", "model": "m-x", "reasoningEffort": "high" },
  { "id": "a-bad", "name": "坏命令", "harness": "command:a-bad", "model": "gpt-x", "reasoningEffort": "low" }
]
"#,
    );
    write(
        &legacy,
        ".refrain/host.json",
        r#"{
  "version": 2, "sequence": 1, "drifted": [], "queue": [],
  "runs": [
    { "id": "run1", "state": "completed",
      "task": { "id": "t-1", "agentId": "a-bad", "baseline": "th:b2", "prompt": "改写。",
        "contextScope": [], "editScopes": [ { "id": "s2", "blockIds": ["01.md:b0"] } ] },
      "comments": [], "proposals": [] }
  ]
}
"#,
    );

    let report = migrate_legacy(&legacy, &target).unwrap();
    let bad = report
        .agent_map
        .iter()
        .find(|mapping| mapping.legacy_id == "a-bad")
        .unwrap();
    assert!(
        matches!(&bad.outcome, AgentOutcome::Unavailable(reason) if reason.contains("argv")),
        "{:?}",
        bad.outcome
    );
    assert_eq!(
        bad.legacy_requested,
        Some(("gpt-x".to_string(), "low".to_string()))
    );
    assert!(report.connections.is_empty());
    // A run naming an unmappable agent stops; it is never guessed onto L0.
    assert!(
        report
            .quarantine
            .iter()
            .any(|item| item.kind == "unknown-agent" && item.subject == "run1")
    );

    fs::remove_dir_all(&legacy).unwrap();
    fs::remove_dir_all(&target).unwrap();
}

#[test]
fn a_strangers_target_is_refused() {
    let legacy = scratch();
    let target = scratch();
    build_legacy(&legacy);
    let legacy_before = tree_digest(&legacy);
    write(&target, "别人的文件.md", "不要碰。\n");

    let error = migrate_legacy(&legacy, &target).unwrap_err();
    assert!(
        matches!(error, MigrationFailure::TargetOccupied(_)),
        "{error:?}"
    );
    assert_eq!(tree_digest(&legacy), legacy_before);
    assert_eq!(
        fs::read_to_string(target.join("别人的文件.md")).unwrap(),
        "不要碰。\n"
    );

    fs::remove_dir_all(&legacy).unwrap();
    fs::remove_dir_all(&target).unwrap();
}

#[test]
fn the_same_root_is_refused() {
    let legacy = scratch();
    build_legacy(&legacy);
    let error = migrate_legacy(&legacy, &legacy).unwrap_err();
    assert!(matches!(error, MigrationFailure::SameRoot), "{error:?}");
    fs::remove_dir_all(&legacy).unwrap();
}
