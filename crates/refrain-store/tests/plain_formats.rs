//! Plain-text formats: every extension the workbench edits opens, edits,
//! saves back to the same format, and round-trips byte for byte.
//!
//! The failure each test names: the Markdown machinery reaching bytes it was
//! never invited into — a fence marker swallowing a blank line in code, a
//! `**` stripped from the index, a backup that holds only the `.md` family.
//!
//! Windows discipline: a live `ProjectStore` holds the project database open,
//! and Windows will not delete a directory tree containing an open file.
//! Every test drops its stores before `remove_dir_all`.

use refrain_core::chinese_index::Precision;
use refrain_core::document_format::DocumentFormat;
use refrain_core::source_layout::BlockScan;
use refrain_core::{
    EditorAction, EditorChange, Insertion, Lineage, Manuscript, Replacement, SourceSnapshot,
    TextCommand,
};
use refrain_store::project::{BackupStatus, DocumentCommit, ProjectStore, RootLocator};
use refrain_store::root::{self, RootKind};
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static SEQUENCE: AtomicU32 = AtomicU32::new(0);

fn scratch() -> PathBuf {
    let unique = format!(
        "refrain-plain-formats-{}-{}-{}",
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

/// Every plain-text extension v0.2.4 admits.
const EXTENSIONS: &[&str] = &[
    "tex", "ts", "rs", "py", "go", "lean", "css", "html", "htm", "xml", "toml", "yaml", "yml",
];

/// The Markdown traps every fixture carries: structure punctuation that must
/// stay literal in plain text, full-width punctuation that must not be
/// squeezed or converted, and an astral character whose bytes must not shift
/// an offset.
const TRAPS: &str = "# a hash is a comment, not a heading\n\
```\n\
a fence marker with a blank line after it\n\
\n\
```\n\
| a | b |\n\
|---|---|\n\
**加粗** stays literal，标点、不动。🎈";

/// One document per extension: a format-shaped first line, the traps, and
/// alternating endings — even indices end with a newline, odd ones do not.
/// `css` rides on CRLF so the `\r` gap path is covered too.
fn fixture(extension: &str, index: usize) -> Vec<u8> {
    let head = match extension {
        "tex" => "\\documentclass{article}",
        "ts" => "const answer: number = 42;",
        "rs" => "fn main() { let 营销 = 1; }",
        "py" => "def main():",
        "go" => "package main",
        "lean" => "theorem one_eq_one : 1 = 1 := rfl",
        "css" => "body { margin: 0; }",
        "html" => "<!DOCTYPE html>",
        "htm" => "<html lang=\"zh\">",
        "xml" => "<?xml version=\"1.0\"?>",
        "toml" => "[package]",
        "yaml" => "version: 2",
        "yml" => "name: workflow",
        other => panic!("no fixture for {other}"),
    };
    let ending = if index.is_multiple_of(2) { "\n" } else { "" };
    let lf = format!("{head}\n{TRAPS}{ending}");
    if extension == "css" {
        lf.replace('\n', "\r\n").into_bytes()
    } else {
        lf.into_bytes()
    }
}

fn adopt(app: &mut Connection, root: &Path, kind: RootKind) -> (ProjectStore, BackupStatus) {
    ProjectStore::adopt(
        app,
        &RootLocator {
            path: root.to_path_buf(),
            kind,
        },
    )
    .unwrap()
}

/// Open the file the way the bridge does, replay one author edit through the
/// manuscript domain, save through the store, and byte-compare every step.
fn roundtrip_one(root: &Path, extension: &str, index: usize) {
    let name = format!("main.{extension}");
    let original = fixture(extension, index);
    fs::write(root.join(&name), &original).unwrap();
    let mut app = app_db();

    let (mut store, backup) = adopt(&mut app, root, RootKind::Folder);
    assert_eq!(backup, BackupStatus::Taken { files: 1 }, "{extension}");
    // The Source Backup holds the file as adopted, byte for byte.
    assert_eq!(
        fs::read(root.join(".refrain-source").join(&name)).unwrap(),
        original,
        "{extension}: the backup drifted"
    );

    // Reconciliation admits the file into the catalog.
    let rows = store.refresh_documents().unwrap();
    assert!(
        rows.iter().any(|row| row.path == name),
        "{extension}: not reconciled into the catalog"
    );

    // Open: the bytes cross unchanged.
    let opened = store.open_registered_document(&name).unwrap();
    assert_eq!(opened.bytes, original, "{extension}: open changed bytes");

    // The manuscript reads it with the format's own scan: one block per line,
    // fences and hashes literal.
    let scan = DocumentFormat::of_path(&name).block_scan();
    assert_eq!(scan, BlockScan::Plain, "{extension}");
    let snapshot = SourceSnapshot::read_checked_with(opened.bytes.clone(), scan).unwrap();
    let line_count = snapshot.block_count();
    let expected_lines = {
        let text = String::from_utf8(original.clone()).unwrap();
        text.split('\n').count()
    };
    assert_eq!(
        line_count, expected_lines,
        "{extension}: plain blocks must be lines"
    );

    let mut manuscript = Manuscript::open(snapshot, Lineage::fresh(line_count)).unwrap();
    // A no-edit materialisation is already a byte round-trip.
    assert_eq!(
        manuscript.materialize().unwrap(),
        original,
        "{extension}: materialise drifted"
    );

    // One author edit: replace the second line, through the same EditorAction
    // the bridge executes.
    let ids = manuscript.head().block_ids();
    let edited_line = "编辑过的第二行 edited";
    manuscript
        .execute(TextCommand::Editor(EditorAction::new(
            manuscript.head().id(),
            vec![EditorChange::Replace(
                Replacement::new(vec![ids[1]], Some(edited_line.to_string())).unwrap(),
            )],
            "author edit",
        )))
        .unwrap();
    let edited = manuscript.materialize().unwrap();
    let expected: Vec<u8> = {
        let text = String::from_utf8(original.clone()).unwrap();
        let mut lines: Vec<String> = text.split('\n').map(String::from).collect();
        // A replaced line keeps the file's own line ending: the gap between
        // blocks reproduces from the source, so a CRLF file stays CRLF.
        let carriage = lines[1].ends_with('\r');
        lines[1] = format!("{edited_line}{}", if carriage { "\r" } else { "" });
        lines.join("\n").into_bytes()
    };
    assert_eq!(edited, expected, "{extension}: edit materialised wrong");

    // Save: the store commits exactly those bytes to the same file.
    store
        .commit(&DocumentCommit {
            path: name.clone(),
            bytes: edited.clone(),
            expected: Some(opened.stamp.clone()),
        })
        .unwrap();
    assert_eq!(
        fs::read(root.join(&name)).unwrap(),
        expected,
        "{extension}: save wrote different bytes"
    );

    // Reopen from disk and resume: same bytes, same scan.
    let reopened = store.open_registered_document(&name).unwrap();
    assert_eq!(reopened.bytes, expected, "{extension}: reopen drifted");

    // Undo restores the adopted bytes exactly.
    manuscript.undo_last().unwrap();
    assert_eq!(
        manuscript.materialize().unwrap(),
        original,
        "{extension}: undo did not restore the original"
    );

    drop(store);
    drop(app);
}

#[test]
fn every_plain_text_extension_round_trips_byte_for_byte() {
    for (index, extension) in EXTENSIONS.iter().enumerate() {
        let root = scratch();
        roundtrip_one(&root, extension, index);
        fs::remove_dir_all(&root).unwrap();
    }
}

/// A single-file Root of a plain-text format adopts, backs up, opens, edits
/// and saves with the same byte discipline as a folder Root.
#[test]
fn a_single_file_root_round_trips_a_rust_source() {
    let root = scratch();
    let file = root.join("tool.rs");
    let original = b"fn main() {\n    let x = \"**not bold**\";\n}\n";
    fs::write(&file, original).unwrap();
    let mut app = app_db();

    let (mut store, backup) = adopt(&mut app, &file, RootKind::File);
    assert_eq!(backup, BackupStatus::Taken { files: 1 });
    // The backup lives in the companion and holds the file as adopted.
    let companion = root.join(".tool.rs.refrain");
    assert_eq!(
        fs::read(companion.join(".refrain-source").join("tool.rs")).unwrap(),
        original
    );
    store.refresh_documents().unwrap();

    let opened = store.open_registered_document("tool.rs").unwrap();
    assert_eq!(opened.bytes, original);

    let scan = DocumentFormat::of_path("tool.rs").block_scan();
    let snapshot = SourceSnapshot::read_checked_with(opened.bytes.clone(), scan).unwrap();
    let count = snapshot.block_count();
    let mut manuscript = Manuscript::open(snapshot, Lineage::fresh(count)).unwrap();
    let ids = manuscript.head().block_ids();
    // Enter at the end of line 2 in the editor is an Insert of one new line.
    manuscript
        .execute(TextCommand::Editor(EditorAction::new(
            manuscript.head().id(),
            vec![EditorChange::Insert(
                Insertion::new(Some(ids[2]), vec!["    let y = 2;".to_string()], scan).unwrap(),
            )],
            "author edit",
        )))
        .unwrap();
    // The new line joins with ONE newline — a blank line here would be the
    // Markdown separator leaking into code.
    let expected = b"fn main() {\n    let x = \"**not bold**\";\n    let y = 2;\n}\n";
    assert_eq!(manuscript.materialize().unwrap(), expected);

    store
        .commit(&DocumentCommit {
            path: "tool.rs".to_string(),
            bytes: manuscript.materialize().unwrap(),
            expected: Some(opened.stamp.clone()),
        })
        .unwrap();
    assert_eq!(fs::read(&file).unwrap(), expected);

    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
}

/// The Source Backup preserves every editable format, not only the Markdown
/// family — a folder of mixed sources is held as adopted.
#[test]
fn the_source_backup_covers_every_editable_extension() {
    let root = scratch();
    for (index, extension) in EXTENSIONS.iter().enumerate() {
        fs::write(
            root.join(format!("main.{extension}")),
            fixture(extension, index),
        )
        .unwrap();
    }
    fs::write(root.join("chapter.md"), "# 章\n").unwrap();
    let mut app = app_db();

    let (store, backup) = adopt(&mut app, &root, RootKind::Folder);
    assert_eq!(
        backup,
        BackupStatus::Taken {
            files: (EXTENSIONS.len() + 1) as u32
        }
    );
    let backup_dir = root.join(".refrain-source");
    for (index, extension) in EXTENSIONS.iter().enumerate() {
        assert_eq!(
            fs::read(backup_dir.join(format!("main.{extension}"))).unwrap(),
            fixture(extension, index),
            "{extension}: not preserved as adopted"
        );
    }

    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
}

/// `is_document_name` is the backup's admission: every v0.2.4 extension is
/// preserved, DOCX and PDF stay outside (they are imports, never edited).
#[test]
fn the_backup_admission_matches_the_format_table() {
    for extension in EXTENSIONS {
        assert!(root::is_document_name(&format!("main.{extension}")));
    }
    for extension in ["md", "markdown", "mdown", "txt"] {
        assert!(root::is_document_name(&format!("chapter.{extension}")));
    }
    for extension in ["docx", "pptx", "xlsx", "epub", "pdf"] {
        assert!(!root::is_document_name(&format!("import.{extension}")));
    }
}

/// Search over a Rust source finds the tokens as written: the `**` a code
/// author typed is indexed verbatim, never stripped as Markdown emphasis.
///
/// The two fixtures differ only in format. Stripping `**x**` out of a CJK
/// run glues the run together, so the joined query `这是加粗` matches prose
/// only; in code the asterisks keep the run split and the joined query must
/// honestly miss. Both directions are asserted, because an assertion that
/// cannot fail proves nothing.
#[test]
fn search_over_plain_text_indexes_the_bytes_verbatim() {
    let root = scratch();
    fs::write(
        root.join("main.rs"),
        "fn main() {}\n// 这是**加粗**的注释\n",
    )
    .unwrap();
    fs::write(root.join("chapter.md"), "这是**加粗**的文字。\n").unwrap();
    let mut app = app_db();
    let (mut store, _) = adopt(&mut app, &root, RootKind::Folder);
    store.refresh_documents().unwrap();

    // The joined query finds the prose paragraph: stripping glued the run.
    let joined = store
        .search_blocks_with("这是加粗", Precision::Exact, 10)
        .unwrap();
    assert!(
        joined.iter().any(|hit| hit.path == "chapter.md"),
        "prose should match after stripping: {joined:?}"
    );
    assert!(
        joined.iter().all(|hit| hit.path != "main.rs"),
        "code must not be stripped: {joined:?}"
    );

    // The plain word finds both, and the Rust hit seeks back to exact bytes.
    let hits = store
        .search_blocks_with("加粗", Precision::Exact, 10)
        .unwrap();
    let rust_hit = hits
        .iter()
        .find(|hit| hit.path == "main.rs")
        .expect("the Rust line is found");
    assert_eq!(rust_hit.ordinal, 1, "the second line is one block");
    // The excerpt reads from disk: it must carry the asterisks verbatim.
    assert!(rust_hit.text.contains("**加粗**"), "{:?}", rust_hit.text);
    // The caret jump: the hit's byte offset lands exactly where the line starts.
    let on_disk = fs::read_to_string(root.join("main.rs")).unwrap();
    assert!(
        on_disk[rust_hit.start_byte as usize..].starts_with("// 这是"),
        "the hit must seek to the line's first byte"
    );

    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
}

/// Plain-text indexing never splits on Markdown structure: a hash line, a
/// fence triple and a pipe table are ordinary lines, and the fence swallows
/// no blank line.
#[test]
fn the_plain_index_does_not_markdown_split() {
    let root = scratch();
    let source = "# not a heading\n```\ninside\n\n```\n| a |\n|---|\ntail";
    fs::write(root.join("main.rs"), source).unwrap();
    let mut app = app_db();
    let (mut store, _) = adopt(&mut app, &root, RootKind::Folder);
    store.refresh_documents().unwrap();

    // Force the index build, then ask for the block that prose search would
    // have merged into a fence: "tail" is its own block, not fence content.
    let hits = store
        .search_blocks_with("tail", Precision::Exact, 10)
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "main.rs");
    // Lines: 0 hash, 1 fence, 2 inside, 3 (empty, unindexed), 4 fence,
    // 5 pipe, 6 rule, 7 tail.
    assert_eq!(hits[0].ordinal, 7, "{:?}", hits[0]);
    assert_eq!(hits[0].text, "tail");

    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
}
