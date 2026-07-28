//! RootFiles boundary vectors, ported from legacy `boundary.test.ts` (C4).
//! The failure each test names: the Source Backup visible to a click, a
//! numbered manuscript sorted as text, a delete that cannot be undone, or a
//! path that escapes its Root.

use refrain_store::files::{
    Direction, FileCommand, FileOutcome, FilePageQuery, Kind, Order, RootFiles, SearchQuery,
};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering as AtomicOrdering};

static SEQUENCE: AtomicU32 = AtomicU32::new(0);

struct Fixture {
    root: PathBuf,
    outside: PathBuf,
}

/// The boundary suite's tree: numbered chapters, a CJK name, a non-manuscript
/// sibling, a nested part, a Source Backup with an original, and an outside
/// victim directory.
fn fixture() -> Fixture {
    let unique = format!(
        "refrain-files-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
        SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed)
    );
    let base = std::env::temp_dir().join(unique);
    fs::create_dir_all(&base).unwrap();
    let base = base.canonicalize().unwrap();
    let root = base.join("root");
    let outside = base.join("outside");
    fs::create_dir_all(root.join("part-one")).unwrap();
    fs::create_dir_all(root.join(".refrain-source")).unwrap();
    fs::create_dir_all(&outside).unwrap();

    fs::write(root.join("chapter-1.md"), "first\n\nsecond\n").unwrap();
    fs::write(root.join("chapter-10.md"), "tenth\n").unwrap();
    fs::write(root.join("chapter-2.md"), "second\n").unwrap();
    fs::write(root.join("第一章.md"), "中文正文\n").unwrap();
    fs::write(root.join("cover.png"), "not text").unwrap();
    fs::write(root.join("part-one").join("nested.md"), "nested\n").unwrap();
    fs::write(
        root.join(".refrain-source").join("original.md"),
        "pristine\n",
    )
    .unwrap();
    fs::write(outside.join("victim.md"), "outside\n").unwrap();

    Fixture { root, outside }
}

impl Fixture {
    fn open(&self) -> RootFiles {
        RootFiles::scan(std::slice::from_ref(&self.root))
    }

    fn cleanup(self) {
        let _ = fs::remove_dir_all(self.root);
        let _ = fs::remove_dir_all(self.outside);
    }
}

fn page_all(files: &RootFiles) -> Vec<String> {
    files
        .page(FilePageQuery {
            offset: 0,
            limit: 10_000,
            order: Order::Name,
            direction: Direction::Ascending,
        })
        .entries
        .iter()
        .map(|entry| entry.name.clone())
        .collect()
}

#[test]
fn indexes_a_tree_and_never_the_source_backup() {
    let fixture = fixture();
    let files = fixture.open();

    assert!(!files.is_empty());
    let names = page_all(&files);
    assert!(names.contains(&"chapter-1.md".to_string()));
    assert!(!names.contains(&"original.md".to_string()));
    assert!(!names.contains(&".refrain-source".to_string()));
    fixture.cleanup();
}

#[test]
fn marks_manuscripts_and_other_files_apart() {
    let fixture = fixture();
    let files = fixture.open();
    let page = files.page(FilePageQuery {
        offset: 0,
        limit: 100,
        order: Order::Name,
        direction: Direction::Ascending,
    });

    let chapter = page
        .entries
        .iter()
        .find(|entry| entry.name == "chapter-1.md")
        .unwrap();
    assert_eq!(chapter.kind, Kind::File);
    assert!(chapter.manuscript);
    let cover = page
        .entries
        .iter()
        .find(|entry| entry.name == "cover.png")
        .unwrap();
    assert!(!cover.manuscript);
    fixture.cleanup();
}

#[test]
fn numbered_chapters_sort_the_way_a_reader_reads() {
    let fixture = fixture();
    let mut files = fixture.open();
    files.sort(Order::Name, Direction::Ascending);
    let chapters: Vec<String> = page_all(&files)
        .into_iter()
        .filter(|name| name.starts_with("chapter-"))
        .collect();

    assert_eq!(chapters, ["chapter-1.md", "chapter-2.md", "chapter-10.md"]);

    files.sort(Order::Name, Direction::Descending);
    let first = files
        .page(FilePageQuery {
            offset: 0,
            limit: 1,
            order: Order::Name,
            direction: Direction::Descending,
        })
        .entries
        .first()
        .unwrap()
        .clone();
    assert_eq!(
        first.kind,
        Kind::Directory,
        "reversed order keeps directories first"
    );
    fixture.cleanup();
}

#[test]
fn a_substring_outranks_a_scattered_match_and_cjk_positions_are_characters() {
    let fixture = fixture();
    let files = fixture.open();

    let hits = files.search(&SearchQuery {
        text: "chapter".to_string(),
        limit: 10,
        directories_only: false,
    });
    assert!(!hits.is_empty());
    assert!(hits[0].entry.name.starts_with("chapter"));

    let cjk = files.search(&SearchQuery {
        text: "第一".to_string(),
        limit: 10,
        directories_only: false,
    });
    assert_eq!(cjk[0].entry.name, "第一章.md");
    // Bytes would be [0, 3]; the renderer highlights by character.
    assert_eq!(cjk[0].positions, [0, 1]);
    fixture.cleanup();
}

#[test]
fn directories_can_be_found_on_their_own_for_a_destination_picker() {
    let fixture = fixture();
    let files = fixture.open();

    let hits = files.search(&SearchQuery {
        text: "part".to_string(),
        limit: 10,
        directories_only: true,
    });
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].entry.kind, Kind::Directory);
    fixture.cleanup();
}

#[test]
fn a_move_reports_where_it_landed_and_a_refusal_changes_nothing() {
    let fixture = fixture();
    let files = fixture.open();
    let from = fixture.root.join("chapter-2.md");
    let to = fixture.root.join("part-one").join("chapter-2.md");

    let outcome = files
        .execute(&FileCommand::Move {
            from: from.clone(),
            to: to.clone(),
            replace: false,
        })
        .unwrap();
    let FileOutcome::Done(done) = outcome else {
        panic!("got {outcome:?}");
    };
    assert_eq!(fs::read_to_string(&done.to).unwrap(), "second\n");
    assert!(to.try_exists().unwrap());
    assert!(!from.try_exists().unwrap());

    let refusal = files
        .execute(&FileCommand::Move {
            from: to.clone(),
            to: fixture.outside.join("stolen.md"),
            replace: false,
        })
        .unwrap_err();
    assert!(refusal.message().contains("outside every workspace root"));
    assert!(to.try_exists().unwrap());
    assert!(!fixture.outside.join("stolen.md").try_exists().unwrap());
    fixture.cleanup();
}

#[test]
fn the_source_backup_refuses_moves_in_and_trash() {
    let fixture = fixture();
    let files = fixture.open();
    let backup = fixture.root.join(".refrain-source");

    let moved = files.execute(&FileCommand::Move {
        from: fixture.root.join("chapter-1.md"),
        to: backup.join("x.md"),
        replace: false,
    });
    assert!(moved.unwrap_err().message().contains("Source Backup"));
    assert!(fixture.root.join("chapter-1.md").try_exists().unwrap());

    let trashed = files.execute(&FileCommand::Trash {
        target: backup.join("original.md"),
    });
    assert!(trashed.unwrap_err().message().contains("Source Backup"));
    assert!(backup.join("original.md").try_exists().unwrap());
    fixture.cleanup();
}

#[test]
fn trashing_outside_the_roots_is_refused_and_the_file_stays() {
    let fixture = fixture();
    let files = fixture.open();

    let refusal = files
        .execute(&FileCommand::Trash {
            target: fixture.outside.join("victim.md"),
        })
        .unwrap_err();
    assert!(refusal.message().contains("outside every workspace root"));
    assert!(fixture.outside.join("victim.md").try_exists().unwrap());
    fixture.cleanup();
}

/// The real trash, on the release platform: a trashed fixture file leaves the
/// disk through `IFileOperation` and the per-path outcome is reported.
#[test]
fn trash_goes_to_the_system_trash_and_batches_report_per_path() {
    let fixture = fixture();
    let files = fixture.open();
    let doomed = fixture.root.join("chapter-10.md");

    files
        .execute(&FileCommand::Trash {
            target: doomed.clone(),
        })
        .unwrap();
    assert!(!doomed.try_exists().unwrap());

    let outcome = files
        .execute(&FileCommand::TrashAll {
            targets: vec![
                fixture.root.join("missing-a.md"),
                fixture.root.join("missing-b.md"),
            ],
        })
        .unwrap();
    let FileOutcome::TrashedAll(outcomes) = outcome else {
        panic!("got {outcome:?}");
    };
    assert_eq!(outcomes.len(), 2);
    assert!(outcomes.iter().all(|outcome| outcome.is_err()));
    fixture.cleanup();
}

#[test]
fn names_windows_would_mangle_are_not_admitted() {
    let fixture = fixture();
    let files = fixture.open();

    assert!(!files.admits(&fixture.root.join("nul.md")));
    assert!(!files.admits(&fixture.root.join("chapter.")));
    assert!(files.admits(&fixture.root.join("chapter-3.md")));
    fixture.cleanup();
}

#[test]
fn a_copy_keeps_the_source_and_directories_are_created() {
    let fixture = fixture();
    let files = fixture.open();
    let from = fixture.root.join("chapter-1.md");
    let to = fixture.root.join("part-one").join("copy.md");

    files
        .execute(&FileCommand::Copy {
            from: from.clone(),
            to: to.clone(),
            replace: false,
        })
        .unwrap();
    assert!(from.try_exists().unwrap());
    assert!(to.try_exists().unwrap());

    let made = files
        .execute(&FileCommand::CreateDirectory {
            path: fixture.root.join("part-two").join("deep"),
        })
        .unwrap();
    let FileOutcome::Created(path) = made else {
        panic!("got {made:?}");
    };
    assert!(path.try_exists().unwrap());

    let unique = files.unique_name(&from);
    assert!(unique.to_string_lossy().contains("chapter-1 2"));
    assert_eq!(unique.extension().unwrap(), "md");
    fixture.cleanup();
}

/// A junction inside the Root that points outside it must not launder writes
/// out of the Root: admission resolves the target, and the write is refused.
#[cfg(windows)]
#[test]
fn a_junction_out_of_the_root_admits_nothing_through_it() {
    let fixture = fixture();
    let link = fixture.root.join("junction");
    let status = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&link)
        .arg(&fixture.outside)
        .status()
        .unwrap();
    assert!(status.success(), "mklink /J failed");

    let files = fixture.open();
    assert!(!files.admits(&link.join("victim.md")));
    let refusal = files
        .execute(&FileCommand::Trash {
            target: link.join("victim.md"),
        })
        .unwrap_err();
    assert!(refusal.message().contains("outside every workspace root"));
    assert!(fixture.outside.join("victim.md").try_exists().unwrap());
    fixture.cleanup();
}
