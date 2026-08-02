//! The persisted undo history: rows written at execute, reconciled at save,
//! walked at open. The failure each test names: an author told their undo
//! chain died with the window, or a crash leaving a chain that does not
//! describe the bytes on disk.
//!
//! Windows discipline: a live `ProjectStore` holds the project database open,
//! and Windows will not delete a directory tree containing an open file.
//! Every test drops its stores before `remove_dir_all`.

use refrain_core::{
    EditorAction, EditorChange, Id, Lineage, Manuscript, Replacement, SourceSnapshot, TextCommand,
    TextTransition,
};
use refrain_store::history::HYDRATION_DEPTH;
use refrain_store::project::{DocumentCommit, DocumentPageQuery, ProjectStore, RootLocator};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

static SEQUENCE: AtomicU32 = AtomicU32::new(0);

fn scratch() -> PathBuf {
    let unique = format!(
        "refrain-history-{}-{}-{}",
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

/// A root holding one three-block chapter, adopted and registered.
fn adopted_chapter() -> (PathBuf, Connection, ProjectStore, String) {
    let root = scratch();
    fs::write(root.join("章.md"), "一\n\n二\n\n三").unwrap();
    let mut app = app_db();
    let (mut store, _) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: root.clone(),
            kind: RootKind::Folder,
        },
    )
    .unwrap();
    store
        .refresh_document_page(DocumentPageQuery {
            after: None,
            limit: 16,
        })
        .unwrap();
    (root, app, store, "章.md".to_string())
}

fn manuscript_of(store: &mut ProjectStore, path: &str) -> Manuscript {
    let opened = store.open_registered_document(path).unwrap();
    let snapshot = SourceSnapshot::read(opened.bytes.clone());
    let blocks = snapshot.block_count();
    Manuscript::open(snapshot, Lineage::fresh(blocks)).unwrap()
}

/// Execute one single-block replace and record the row, exactly as the
/// bridge's write path does: execute first, then the history row.
fn type_over(
    store: &ProjectStore,
    manuscript: &mut Manuscript,
    path: &str,
    block: Id,
    text: &str,
) -> TextTransition {
    let transition = manuscript
        .execute(TextCommand::Editor(EditorAction::new(
            manuscript.head().id(),
            vec![EditorChange::Replace(
                Replacement::new(vec![block], Some(text.to_owned())).unwrap(),
            )],
            "author edit",
        )))
        .unwrap();
    store
        .action_history()
        .record(path, transition.action(), transition.head().id())
        .unwrap();
    transition
}

/// The save half of the write path: bytes, then continuity.
fn save(store: &mut ProjectStore, manuscript: &Manuscript, path: &str) {
    store
        .commit(&DocumentCommit {
            path: path.to_string(),
            bytes: manuscript.materialize().unwrap(),
            expected: None,
        })
        .unwrap();
    store
        .save_continuity(
            path,
            &manuscript.head().id().to_string(),
            &serde_json::to_string(&manuscript.lineage_ids()).unwrap(),
        )
        .unwrap();
}

/// The open half, from the store's own records: continuity, hydration, and
/// the resumed manuscript — what the bridge's `open_in_entry` assembles.
fn reopen(store: &mut ProjectStore, path: &str) -> Manuscript {
    let opened = store.open_registered_document(path).unwrap();
    let row = opened.row.clone();
    assert_eq!(
        row.digest.as_deref(),
        Some(opened.stamp.digest.as_str()),
        "the test saved before it reopened"
    );
    let head: Id = row.current_head.unwrap().parse().unwrap();
    let lineage: Vec<Id> = serde_json::from_str(&row.head_block_ids.unwrap()).unwrap();
    let history = store
        .action_history()
        .chain(path, head, HYDRATION_DEPTH)
        .unwrap();
    Manuscript::open_at(
        SourceSnapshot::read(opened.bytes),
        Lineage::from_ids(lineage),
        head,
        history,
    )
    .unwrap()
}

/// The restart promise, end to end: write actions, save, "close the window",
/// reopen from the store's records alone, and undo restores the exact bytes.
#[test]
fn undo_survives_a_restart_byte_for_byte() {
    let (root, _app, mut store, path) = adopted_chapter();
    let mut manuscript = manuscript_of(&mut store, &path);
    let blocks = manuscript.head().block_ids();
    type_over(&store, &mut manuscript, &path, blocks[0], "壹");
    type_over(&store, &mut manuscript, &path, blocks[1], "贰");
    save(&mut store, &manuscript, &path);
    drop(manuscript);

    let mut reopened = reopen(&mut store, &path);
    assert_eq!(reopened.head().text(), "壹\n\n贰\n\n三");
    assert_eq!(reopened.actions().len(), 2);

    reopened.undo_last().unwrap();
    assert_eq!(reopened.head().text(), "壹\n\n二\n\n三");
    reopened.undo_last().unwrap();
    assert_eq!(
        reopened.materialize().unwrap(),
        "一\n\n二\n\n三".as_bytes().to_vec(),
        "undo across a restart must restore the exact bytes"
    );

    drop(store);
    fs::remove_dir_all(root).unwrap();
}

/// Undo marks are written at save, not at undo: the session pops, and the
/// save that makes the new state durable reconciles the rows it left.
#[test]
fn a_save_marks_the_rows_the_live_chain_no_longer_names() {
    let (root, _app, mut store, path) = adopted_chapter();
    let mut manuscript = manuscript_of(&mut store, &path);
    let blocks = manuscript.head().block_ids();
    type_over(&store, &mut manuscript, &path, blocks[0], "壹");
    let second = type_over(&store, &mut manuscript, &path, blocks[1], "贰")
        .action()
        .id();
    let third = type_over(&store, &mut manuscript, &path, blocks[2], "叁")
        .action()
        .id();

    // The session undoes the newest two; nothing is marked yet.
    manuscript.undo_last().unwrap();
    manuscript.undo_last().unwrap();
    let before_save = store.action_history().list_recent(&path, 10).unwrap();
    assert!(
        before_save.iter().all(|row| !row.undone),
        "undo moves session memory; the rows stay live until the save"
    );

    save(&mut store, &manuscript, &path);
    let live: Vec<Id> = manuscript.actions().iter().map(|a| a.id()).collect();
    store.action_history().sync_chain(&path, &live).unwrap();

    let rows = store.action_history().list_recent(&path, 10).unwrap();
    let undone_of = |id: Id| rows.iter().find(|row| row.id == id).unwrap().undone;
    assert!(!undone_of(live[0]));
    assert!(undone_of(second), "undone in the session, marked at save");
    assert!(undone_of(third));

    // The durable chain the next open walks names only the live row.
    let mut reopened = reopen(&mut store, &path);
    assert_eq!(reopened.actions().len(), 1);
    reopened.undo_last().unwrap();
    assert_eq!(reopened.materialize().unwrap(), "一\n\n二\n\n三".as_bytes());

    drop(store);
    fs::remove_dir_all(root).unwrap();
}

/// A kill between execute and the journal clear leaves a history row whose
/// head nothing saved. The walk must never reach it, and the replay that
/// follows must extend the chain, not corrupt it.
#[test]
fn a_crash_orphan_never_enters_the_chain_and_replay_continues_it() {
    let (root, _app, mut store, path) = adopted_chapter();
    let mut manuscript = manuscript_of(&mut store, &path);
    let blocks = manuscript.head().block_ids();
    let first = type_over(&store, &mut manuscript, &path, blocks[0], "壹");
    save(&mut store, &manuscript, &path);

    // The crash: an action executed and its row was written, but the window
    // died before the author ever saved its bytes.
    let orphan = type_over(&store, &mut manuscript, &path, blocks[1], "贰");

    // Reopen resumes the saved head: the orphan's head is not it, so the
    // walk cannot reach the orphan.
    let mut reopened = reopen(&mut store, &path);
    assert_eq!(reopened.actions().len(), 1);
    assert_eq!(reopened.actions()[0].id(), first.action().id());

    // The journal replay re-executes the same logical edit under fresh ids
    // and records its row; the chain continues without a gap or a duplicate.
    let replay = type_over(&store, &mut reopened, &path, blocks[1], "贰");
    let chain = store
        .action_history()
        .chain(&path, replay.head().id(), HYDRATION_DEPTH)
        .unwrap();
    assert_eq!(chain.len(), 2);
    assert_eq!(chain[0].id(), first.action().id());
    assert_eq!(chain[1].id(), replay.action().id());

    // And the orphan is reconciled away at the next save, never deleted.
    save(&mut store, &reopened, &path);
    let live: Vec<Id> = reopened.actions().iter().map(|a| a.id()).collect();
    store.action_history().sync_chain(&path, &live).unwrap();
    let rows = store.action_history().list_recent(&path, 10).unwrap();
    assert!(
        rows.iter()
            .find(|row| row.id == orphan.action().id())
            .unwrap()
            .undone
    );
    assert_eq!(rows.len(), 3, "the audit keeps every row");

    drop(store);
    fs::remove_dir_all(root).unwrap();
}

/// Hydration caps at the depth it is asked for: the newest rows walk back,
/// the rest stay in the table for the audit.
#[test]
fn hydration_stops_at_the_depth_cap() {
    let (root, _app, mut store, path) = adopted_chapter();
    let mut manuscript = manuscript_of(&mut store, &path);
    let block = manuscript.head().block_ids()[0];
    let mut tip = manuscript.head().id();
    for round in 0..8 {
        tip = type_over(
            &store,
            &mut manuscript,
            &path,
            block,
            &format!("第{round}稿"),
        )
        .head()
        .id();
    }

    let chain = store.action_history().chain(&path, tip, 3).unwrap();

    assert_eq!(chain.len(), 3);
    let session: Vec<Id> = manuscript.actions().iter().map(|a| a.id()).collect();
    assert_eq!(
        chain.iter().map(|action| action.id()).collect::<Vec<_>>(),
        session[5..8].to_vec(),
        "the cap keeps the newest rows, oldest-first"
    );

    drop(store);
    fs::remove_dir_all(root).unwrap();
}
