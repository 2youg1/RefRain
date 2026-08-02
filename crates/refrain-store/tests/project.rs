//! M5 ProjectStore and Verdict Ledger vectors, ported from legacy
//! `store.test.ts`, `external-edit.test.ts`, and `source-backup.test.ts`.
//! The failure each test names: an author's edit overwritten without
//! warning, an original drifting toward the working copy, or an audit row
//! rewritten by a retry.
//!
//! Windows discipline: a live `ProjectStore` holds the project database
//! open, and Windows will not delete a directory tree containing an open
//! file. Every test drops its stores before `remove_dir_all`.

use refrain_core::DocumentRole;
use refrain_core::material_listing::Disclosure;
use refrain_store::ledger::{VerdictKindName, VerdictRecord};
use refrain_store::project::{
    BackupStatus, CreateDocument, DocumentCommit, ProjectFailure, ProjectStore, ProposalRow,
    RootLocator,
};
use refrain_store::root::{self, RootKind};
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static SEQUENCE: AtomicU32 = AtomicU32::new(0);

fn scratch() -> PathBuf {
    let unique = format!(
        "refrain-project-{}-{}-{}",
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

fn app_db() -> Connection {
    let mut db = Connection::open_in_memory().unwrap();
    AppDb::migrate(&mut db).unwrap();
    db
}

fn adopt(app: &mut Connection, root: &Path) -> (ProjectStore, BackupStatus) {
    ProjectStore::adopt(
        app,
        &RootLocator {
            path: root.to_path_buf(),
            kind: RootKind::Folder,
        },
    )
    .unwrap()
}

#[test]
fn adopting_a_folder_takes_the_original_once_and_never_again() {
    let root = scratch();
    fs::write(root.join("01.md"), "　　原文第一段。\n").unwrap();
    fs::create_dir(root.join("資料")).unwrap();
    fs::write(root.join("資料").join("年表.md"), "1931\n").unwrap();
    let mut app = app_db();

    let (store, backup) = adopt(&mut app, &root);
    assert_eq!(backup, BackupStatus::Taken { files: 2 });
    let backup_dir = root.join(".refrain-source");
    assert_eq!(
        fs::read(backup_dir.join("01.md")).unwrap(),
        "　　原文第一段。\n".as_bytes()
    );
    assert_eq!(
        fs::read(backup_dir.join("資料").join("年表.md")).unwrap(),
        b"1931\n"
    );

    // The permit persisted: re-adopting is the same Root, not a new project.
    let first_id = store.permit().root_id;
    fs::write(root.join("01.md"), "作者改过的。\n").unwrap();
    let (again, second) = adopt(&mut app, &root);
    assert_eq!(second, BackupStatus::AlreadyPresent);
    assert_eq!(again.permit().root_id, first_id);
    assert_eq!(
        fs::read(backup_dir.join("01.md")).unwrap(),
        "　　原文第一段。\n".as_bytes()
    );
    drop(store);
    drop(again);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_empty_adopted_folder_never_turns_later_text_into_an_original() {
    let root = scratch();
    let mut app = app_db();

    let (first, backup) = adopt(&mut app, &root);
    assert_eq!(backup, BackupStatus::NothingToCopy);
    assert!(!root.join(".refrain-source").try_exists().unwrap());

    fs::write(root.join("01.md"), "在 RefRain 内新写的。\n").unwrap();
    let (second, second_backup) = adopt(&mut app, &root);
    assert_eq!(second_backup, BackupStatus::AlreadyPresent);
    assert!(!root.join(".refrain-source").try_exists().unwrap());
    drop(first);
    drop(second);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn the_backup_never_copies_the_applications_own_directories() {
    let root = scratch();
    fs::write(root.join("01.md"), "原文。\n").unwrap();
    fs::create_dir(root.join(".refrain")).unwrap();
    fs::write(root.join(".refrain").join("notes.md"), "应用自己的\n").unwrap();
    let mut app = app_db();

    let (store, backup) = adopt(&mut app, &root);
    assert_eq!(backup, BackupStatus::Taken { files: 1 });
    assert!(
        !root
            .join(".refrain-source")
            .join(".refrain")
            .try_exists()
            .unwrap()
    );
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_single_file_root_backs_up_only_itself() {
    let parent = scratch();
    let source = parent.join("essay.md");
    fs::write(&source, "原稿。\n").unwrap();
    fs::write(parent.join("neighbour.md"), "别人的。\n").unwrap();
    let mut app = app_db();

    let (store, backup) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: source.clone(),
            kind: RootKind::File,
        },
    )
    .unwrap();
    assert_eq!(backup, BackupStatus::Taken { files: 1 });
    let companion = parent.join(".essay.md.refrain");
    assert_eq!(
        fs::read(companion.join(".refrain-source").join("essay.md")).unwrap(),
        "原稿。\n".as_bytes()
    );
    assert!(
        !companion
            .join(".refrain-source")
            .join("neighbour.md")
            .try_exists()
            .unwrap()
    );
    assert_eq!(store.permit().kind, RootKind::File);
    drop(store);
    fs::remove_dir_all(parent).unwrap();
}

#[test]
fn an_unowned_single_file_companion_is_refused_not_overwritten() {
    let parent = scratch();
    let source = parent.join("essay.md");
    fs::write(&source, "原稿。\n").unwrap();
    fs::create_dir(parent.join(".essay.md.refrain")).unwrap();
    fs::write(
        parent.join(".essay.md.refrain").join("mine.txt"),
        "不是 RefRain 的。\n",
    )
    .unwrap();
    let mut app = app_db();

    let failure = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: source.clone(),
            kind: RootKind::File,
        },
    )
    .unwrap_err();
    assert!(
        matches!(failure, ProjectFailure::Io { .. }),
        "got {failure:?}"
    );
    assert_eq!(
        fs::read_to_string(parent.join(".essay.md.refrain").join("mine.txt")).unwrap(),
        "不是 RefRain 的。\n"
    );
    fs::remove_dir_all(parent).unwrap();
}

#[test]
fn a_root_whose_identity_moved_is_a_safety_surface_not_a_new_project() {
    let root = scratch();
    fs::write(root.join("01.md"), "原文。\n").unwrap();
    let mut app = app_db();
    let (store, _) = adopt(&mut app, &root);

    // The stored identity no longer matches the file system — the same path
    // on another volume must not quietly become "the same Root".
    app.execute("UPDATE root_permits SET identity = 'elsewhere:0'", [])
        .unwrap();

    let failure = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: root.clone(),
            kind: RootKind::Folder,
        },
    )
    .unwrap_err();
    assert!(
        matches!(failure, ProjectFailure::IdentityChanged { ref stored, .. } if stored == "elsewhere:0"),
        "got {failure:?}"
    );
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_unchanged_document_commits_and_the_stamp_advances() {
    let root = scratch();
    fs::write(root.join("第一章.md"), "原来的一句。\n").unwrap();
    let mut app = app_db();
    let (mut store, _) = adopt(&mut app, &root);

    let opened = store.open_document("第一章.md").unwrap();
    assert_eq!(opened.bytes, "原来的一句。\n".as_bytes());
    assert_eq!(opened.row.role, DocumentRole::Chapter);

    let outcome = store
        .commit(&DocumentCommit {
            path: "第一章.md".to_string(),
            bytes: "改写过的一句。\n".as_bytes().to_vec(),
            expected: Some(opened.stamp.clone()),
        })
        .unwrap();
    assert_eq!(
        fs::read(root.join("第一章.md")).unwrap(),
        "改写过的一句。\n".as_bytes()
    );
    assert_ne!(outcome.stamp.digest, opened.stamp.digest);
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_file_edited_underneath_is_refused_and_keeps_the_other_edit() {
    let root = scratch();
    fs::write(root.join("第一章.md"), "原来的一句。\n").unwrap();
    let mut app = app_db();
    let (mut store, _) = adopt(&mut app, &root);
    let stale = store.open_document("第一章.md").unwrap().stamp;

    // Someone else writes — another editor, a script, a checkout.
    fs::write(root.join("第一章.md"), "别处改写的一句，长度也不同。\n").unwrap();

    let failure = store
        .commit(&DocumentCommit {
            path: "第一章.md".to_string(),
            bytes: "这边写的一句。\n".as_bytes().to_vec(),
            expected: Some(stale),
        })
        .unwrap_err();
    let ProjectFailure::ChangedUnderneath(conflict) = failure else {
        panic!("got {failure:?}");
    };
    assert_eq!(
        conflict.on_disk,
        "别处改写的一句，长度也不同。\n".as_bytes()
    );
    assert_eq!(
        fs::read(root.join("第一章.md")).unwrap(),
        "别处改写的一句，长度也不同。\n".as_bytes()
    );
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_edit_with_the_same_byte_count_is_still_refused() {
    let root = scratch();
    fs::write(root.join("第一章.md"), "甲说：可以。\n").unwrap();
    let mut app = app_db();
    let (mut store, _) = adopt(&mut app, &root);
    let stale = store.open_document("第一章.md").unwrap().stamp;

    // Same length, different bytes: mtime and size cannot see it, digest can.
    fs::write(root.join("第一章.md"), "乙说：不可。\n").unwrap();

    let failure = store
        .commit(&DocumentCommit {
            path: "第一章.md".to_string(),
            bytes: "这边仍在写。\n".as_bytes().to_vec(),
            expected: Some(stale),
        })
        .unwrap_err();
    assert!(
        matches!(failure, ProjectFailure::ChangedUnderneath(_)),
        "got {failure:?}"
    );
    assert_eq!(
        fs::read(root.join("第一章.md")).unwrap(),
        "乙说：不可。\n".as_bytes()
    );
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_vanished_file_is_written_rather_than_refused() {
    let root = scratch();
    fs::write(root.join("第一章.md"), "原来的一句。\n").unwrap();
    let mut app = app_db();
    let (mut store, _) = adopt(&mut app, &root);
    let stamp = store.open_document("第一章.md").unwrap().stamp;
    fs::remove_file(root.join("第一章.md")).unwrap();

    store
        .commit(&DocumentCommit {
            path: "第一章.md".to_string(),
            bytes: "回来的一句。\n".as_bytes().to_vec(),
            expected: Some(stamp),
        })
        .unwrap();
    assert_eq!(
        fs::read(root.join("第一章.md")).unwrap(),
        "回来的一句。\n".as_bytes()
    );
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_read_error_is_not_mistaken_for_a_missing_document() {
    let root = scratch();
    fs::create_dir(root.join("第一章.md")).unwrap();
    let mut app = app_db();
    let (mut store, _) = adopt(&mut app, &root);

    let failure = store.open_document("第一章.md").unwrap_err();
    assert!(
        matches!(failure, ProjectFailure::NotADocument(_)),
        "got {failure:?}"
    );
    assert!(!root.join("第一章.md.writing").try_exists().unwrap());
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn creating_documents_places_roles_and_refuses_the_occupied_and_the_illegal() {
    let root = scratch();
    let mut app = app_db();
    let (mut store, _) = adopt(&mut app, &root);

    let chapter = store
        .create(&CreateDocument {
            title: "第一章".to_string(),
            role: DocumentRole::Chapter,
        })
        .unwrap();
    assert!(root.join("第一章.md").try_exists().unwrap());
    assert_eq!(chapter.row.role, DocumentRole::Chapter);

    let material = store
        .create(&CreateDocument {
            title: "年表".to_string(),
            role: DocumentRole::Material,
        })
        .unwrap();
    assert!(root.join("material").join("年表.md").try_exists().unwrap());
    assert_eq!(material.row.role, DocumentRole::Material);

    let occupied = store
        .create(&CreateDocument {
            title: "第一章".to_string(),
            role: DocumentRole::Chapter,
        })
        .unwrap_err();
    assert!(
        matches!(occupied, ProjectFailure::Domain(_)),
        "got {occupied:?}"
    );

    for title in [
        "../escaped",
        "..\\escaped",
        "bad\0name",
        "nul",
        "chapter.",
        "chapter ",
        "a:b",
    ] {
        let failure = store
            .create(&CreateDocument {
                title: title.to_string(),
                role: DocumentRole::Chapter,
            })
            .unwrap_err();
        assert!(
            matches!(failure, ProjectFailure::Domain(_)),
            "{title}: got {failure:?}"
        );
    }
    assert!(
        !root
            .join("..")
            .join("escaped.md")
            .try_exists()
            .unwrap_or(false)
    );
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn writing_into_the_source_backup_is_refused_even_when_it_is_the_project() {
    let root = scratch();
    let backup = root.join(".refrain-source");
    fs::create_dir(&backup).unwrap();
    fs::write(backup.join("original.md"), "不可改写的原稿。\n").unwrap();
    let mut app = app_db();
    let (mut store, _) = adopt(&mut app, &backup);
    let stamp = store.open_document("original.md").unwrap().stamp;

    let failure = store
        .commit(&DocumentCommit {
            path: "original.md".to_string(),
            bytes: "试图改写。\n".as_bytes().to_vec(),
            expected: Some(stamp),
        })
        .unwrap_err();
    let ProjectFailure::Domain(error) = failure else {
        panic!("got {failure:?}");
    };
    assert_eq!(error.code, refrain_core::ErrorCode::SourceBackup);
    assert_eq!(
        fs::read(backup.join("original.md")).unwrap(),
        "不可改写的原稿。\n".as_bytes()
    );
    assert!(!backup.join("original.md.writing").try_exists().unwrap());
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn the_guard_table_holds_for_segments() {
    for legal in ["年表", "chapter-2", "01.opening", "第 一 章"] {
        assert!(root::is_legal_segment(legal), "{legal}");
    }
    for illegal in [
        "", "..", "nul", "COM1", "aux.md", "x.", "x ", "a:b", "a/b", "a\\b",
    ] {
        assert!(!root::is_legal_segment(illegal), "{illegal}");
    }
}

fn verdict(id: &str, reason: Option<&str>, decided_at: u64) -> VerdictRecord {
    VerdictRecord {
        id: id.to_string(),
        proposal_id: "p1".to_string(),
        slice_id: "s1".to_string(),
        kind: VerdictKindName::Accept,
        final_text: None,
        reason: reason.map(str::to_string),
        decided_at,
        legacy_baseline: None,
    }
}

#[test]
fn a_recorded_verdict_survives_reopening_the_ledger() {
    let root = scratch();
    let mut app = app_db();
    let written = verdict("v1", Some("语气更冷"), 1_000);
    {
        let (store, _) = adopt(&mut app, &root);
        store.ledger().record(&written).unwrap();
        drop(store);
    }
    let (reopened, _) = adopt(&mut app, &root);
    assert_eq!(reopened.ledger().all().unwrap(), vec![written]);
    drop(reopened);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_baseline_spellings_survive_byte_for_byte() {
    let root = scratch();
    let mut app = app_db();
    let (store, _) = adopt(&mut app, &root);
    let baselines = [
        "h7",
        "/old/path.md@load",
        "01.md@1720000000000",
        "01.md@current",
    ];
    for (index, baseline) in baselines.iter().enumerate() {
        store
            .ledger()
            .record(&VerdictRecord {
                legacy_baseline: Some((*baseline).to_string()),
                ..verdict(&format!("legacy-{index}"), None, index as u64)
            })
            .unwrap();
    }
    let found: Vec<Option<String>> = store
        .ledger()
        .all()
        .unwrap()
        .into_iter()
        .map(|row| row.legacy_baseline)
        .collect();
    assert_eq!(
        found,
        baselines
            .iter()
            .map(|b| Some((*b).to_string()))
            .collect::<Vec<_>>()
    );
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_unstated_reason_stays_absent_and_verdicts_return_in_decision_order() {
    let root = scratch();
    let mut app = app_db();
    let (store, _) = adopt(&mut app, &root);
    store.ledger().record(&verdict("b", None, 2_000)).unwrap();
    store.ledger().record(&verdict("a", None, 1_000)).unwrap();

    let all = store.ledger().all().unwrap();
    assert_eq!(
        all.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
        ["a", "b"]
    );
    assert_eq!(all[0].reason, None);
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn like_wildcards_in_the_query_are_characters_not_operators() {
    let root = scratch();
    let mut app = app_db();
    let (store, _) = adopt(&mut app, &root);
    store
        .ledger()
        .record(&verdict("a", Some("改成 snake_case 更一致"), 1))
        .unwrap();
    store
        .ledger()
        .record(&verdict("b", Some("snakeXcase 是错的"), 2))
        .unwrap();
    store
        .ledger()
        .record(&verdict("c", Some("这段有 30% 是套话"), 3))
        .unwrap();
    store
        .ledger()
        .record(&verdict("d", Some("路径写成 C:\\书稿 了"), 4))
        .unwrap();
    store
        .ledger()
        .record(&verdict("e", Some("毫无关系的理由"), 5))
        .unwrap();

    let ids = |fragment: &str| {
        store
            .ledger()
            .search(fragment)
            .unwrap()
            .into_iter()
            .map(|row| row.id)
            .collect::<Vec<_>>()
    };
    assert_eq!(ids("snake_case"), ["a"]);
    assert_eq!(ids("30%"), ["c"]);
    assert_eq!(ids("%"), ["c"]);
    assert_eq!(ids("C:\\书稿"), ["d"]);
    assert_eq!(ids("节奏"), Vec::<String>::new());
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_duplicate_id_cannot_rewrite_the_original_audit_record() {
    let root = scratch();
    let mut app = app_db();
    let (store, _) = adopt(&mut app, &root);
    let original = verdict("fixed", Some("原来的理由"), 1);
    store.ledger().record(&original).unwrap();
    store
        .ledger()
        .record(&VerdictRecord {
            kind: VerdictKindName::Reject,
            reason: Some("后来改写".to_string()),
            ..original.clone()
        })
        .unwrap();

    assert_eq!(store.ledger().all().unwrap(), vec![original]);
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn the_journal_replays_in_order_and_clears_on_confirmation() {
    let root = scratch();
    let mut app = app_db();
    let (mut store, _) = adopt(&mut app, &root);
    store
        .create(&CreateDocument {
            title: "第一章".to_string(),
            role: DocumentRole::Chapter,
        })
        .unwrap();

    let first = store
        .journal_append("第一章.md", r#"{"base":"h1","changes":[]}"#)
        .unwrap();
    let second = store
        .journal_append("第一章.md", r#"{"base":"h2","changes":[]}"#)
        .unwrap();

    let pending = store.journal_take("第一章.md").unwrap();
    assert_eq!(pending.len(), 2);
    assert_eq!(
        pending[0].0, first,
        "journal order is the order actions were taken"
    );
    assert_eq!(pending[1].0, second);

    store.journal_remove(first).unwrap();
    assert_eq!(store.journal_take("第一章.md").unwrap().len(), 1);
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn continuity_survives_reopening_and_migrates_from_v1() {
    let root = scratch();
    fs::write(root.join("01.md"), "原文。\n").unwrap();
    let db_path = root.join(".refrain").join("refrain.db");

    // A v1 database from before the continuity columns existed.
    fs::create_dir_all(db_path.parent().unwrap()).unwrap();
    {
        let db = Connection::open(&db_path).unwrap();
        db.execute_batch(
            "CREATE TABLE migration_log (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, name TEXT NOT NULL) STRICT;
             CREATE TABLE documents (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, role TEXT NOT NULL, digest TEXT, legacy_id TEXT) STRICT;
             CREATE TABLE verdicts (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, slice_id TEXT NOT NULL, kind TEXT NOT NULL, final_text TEXT, reason TEXT, decided_at INTEGER NOT NULL, legacy_baseline TEXT) STRICT;
             PRAGMA user_version = 1;
             INSERT INTO documents (id, path, role, digest) VALUES ('018f2e4a-0000-7000-8000-000000000001', '01.md', 'chapter', 'x');",
        )
        .unwrap();
    }

    let mut app = app_db();
    let (mut store, _) = adopt(&mut app, &root);
    let version: u32 = store.schema_version().unwrap();
    assert_eq!(
        version,
        refrain_store::schema::ProjectDb::latest().0,
        "the ladder advanced the old database to the latest version"
    );

    store
        .save_continuity("01.md", "head-9", r#"["b1","b2"]"#)
        .unwrap();
    let opened = store.open_document("01.md").unwrap();
    assert_eq!(opened.row.current_head.as_deref(), Some("head-9"));
    assert_eq!(opened.row.head_block_ids.as_deref(), Some(r#"["b1","b2"]"#));
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn adopting_scans_existing_manuscripts_into_rows() {
    let root = scratch();
    fs::write(root.join("第一章.md"), "第一句。\n").unwrap();
    fs::create_dir(root.join("material")).unwrap();
    fs::write(root.join("material").join("年表.md"), "1931\n").unwrap();
    fs::write(root.join("notes.bin"), "not a manuscript").unwrap();
    let mut app = app_db();
    let (mut store, _) = adopt(&mut app, &root);

    let rows = store.refresh_documents().unwrap();
    let paths: Vec<&str> = rows.iter().map(|row| row.path.as_str()).collect();
    assert_eq!(paths, ["material/年表.md", "第一章.md"]);
    assert_eq!(rows[0].role, DocumentRole::Material);
    assert_eq!(rows[1].role, DocumentRole::Chapter);
    assert!(store.open_registered_document("第一章.md").is_ok());
    assert!(
        matches!(
            store.open_registered_document("notes.bin"),
            Err(ProjectFailure::NotADocument(_))
        ),
        "a contained file is not authorised until indexing registers it"
    );
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_deleted_document_goes_to_the_recycle_bin_and_leaves_the_catalog() {
    let root = scratch();
    fs::write(root.join("第一章.md"), "会被删掉的一句。\n").unwrap();
    let mut app = app_db();
    let (mut store, _) = adopt(&mut app, &root);
    store.refresh_documents().unwrap();

    // Stage facts that name the document. The audit (a proposal) must stay;
    // the staging (a review session, a journaled action) must go.
    store
        .proposal_insert(&ProposalRow {
            id: refrain_core::Id::new().to_string(),
            run: refrain_core::Id::new().to_string(),
            baseline: "h1".to_string(),
            document_path: "第一章.md".to_string(),
            scope: "[]".to_string(),
            before_text: "会被删掉的一句。".to_string(),
            after_text: None,
            created_at: 1_000,
        })
        .unwrap();
    store.review_session_set("第一章.md", 3, "[]").unwrap();
    store
        .journal_append("第一章.md", r#"{"base":"h1","changes":[]}"#)
        .unwrap();

    let deleted = store.delete_document("第一章.md").unwrap();

    assert_eq!(deleted.path, "第一章.md");
    assert!(
        !root.join("第一章.md").try_exists().unwrap(),
        "the file left the Root — through the recycle bin, never an unlink"
    );
    assert!(
        store.documents().unwrap().is_empty(),
        "the catalog row left with the file"
    );
    assert!(store.review_session_get("第一章.md").unwrap().is_none());
    assert!(store.journal_take("第一章.md").unwrap().is_empty());
    assert_eq!(
        store.proposals_for("第一章.md").unwrap().len(),
        1,
        "the audit stays: deleting a document does not rewrite decisions"
    );
    assert!(
        matches!(
            store.delete_document("第一章.md"),
            Err(ProjectFailure::Domain(_))
        ),
        "deleting twice is a typed refusal, not a silent success"
    );
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_deleted_document_leaves_the_search_index_too() {
    let root = scratch();
    fs::write(root.join("第一章.md"), "只在索引里的词。\n").unwrap();
    let mut app = app_db();
    let (mut store, _) = adopt(&mut app, &root);
    store.refresh_documents().unwrap();
    assert_eq!(
        store.indexed_paths("只在索引里", 10).unwrap(),
        vec!["第一章.md".to_string()]
    );

    store.delete_document("第一章.md").unwrap();

    assert!(
        store.indexed_paths("只在索引里", 10).unwrap().is_empty(),
        "a query must not return a chapter that no longer exists"
    );
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn deleting_an_imported_material_keeps_the_source_clone_in_the_backup() {
    let root = scratch();
    let mut app = app_db();
    let (mut store, _) = adopt(&mut app, &root);
    let incoming = scratch();
    let source = incoming.join("参考.html");
    fs::write(&source, "<p>原件的字节。</p>").unwrap();
    let prepared = refrain_store::materials::prepare_material_source(
        &source,
        &store.layout().source_backup_dir.join("materials"),
    )
    .unwrap();

    let created = store
        .create(&CreateDocument {
            title: "参考".to_string(),
            role: DocumentRole::Material,
        })
        .unwrap();
    let path = created.row.path.clone();
    store
        .record_imported_source(&path, &prepared.material.source_digest, "html")
        .unwrap();

    store.delete_document(&path).unwrap();

    assert!(!root.join(&path).try_exists().unwrap());
    assert_eq!(
        fs::read(&prepared.clone).unwrap(),
        "<p>原件的字节。</p>".as_bytes(),
        "the original bytes are not RefRain's to remove — the backup is never written"
    );
    drop(store);
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(incoming).unwrap();
}

#[test]
fn disclosure_writes_both_ways_and_refuses_an_unknown_document() {
    let root = scratch();
    fs::create_dir(root.join("material")).unwrap();
    fs::write(root.join("material").join("年表.md"), "1931\n").unwrap();
    fs::write(root.join("第一章.md"), "第一句。\n").unwrap();
    let mut app = app_db();
    let (mut store, _) = adopt(&mut app, &root);
    store.refresh_documents().unwrap();
    let stored = |store: &ProjectStore, path: &str| {
        store
            .documents()
            .unwrap()
            .into_iter()
            .find(|row| row.path == path)
            .expect("the row is there")
    };

    // "Never asked" is `None`, and the readers treat it as the default.
    assert_eq!(stored(&store, "material/年表.md").disclosure, None);

    let row = store
        .set_disclosure("material/年表.md", Disclosure::OutlineOnly)
        .unwrap();
    assert_eq!(row.disclosure, Some(Disclosure::OutlineOnly));
    assert_eq!(
        stored(&store, "material/年表.md").disclosure,
        Some(Disclosure::OutlineOnly),
        "the database, not the return value, is the authority"
    );

    let row = store
        .set_disclosure("material/年表.md", Disclosure::Full)
        .unwrap();
    assert_eq!(row.disclosure, Some(Disclosure::Full));
    assert_eq!(
        stored(&store, "material/年表.md").disclosure,
        Some(Disclosure::Full)
    );

    assert!(
        matches!(
            store.set_disclosure("没有.md", Disclosure::Full),
            Err(ProjectFailure::Domain(_))
        ),
        "a permission for a document that does not exist is refused"
    );
    // One document's setting never leaks into a sibling's.
    assert_eq!(stored(&store, "第一章.md").disclosure, None);
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
