//! The workspace index.
//!
//! One parallel walk produces every fact the UI needs: path, name, size, mtime,
//! kind, and the pre-lowered name the matcher searches against. Holding those
//! in a flat `Vec` rather than a tree is deliberate — sort and filter are linear
//! scans over contiguous memory, which is the shape a CPU is fastest at, and
//! the tree the user sees is reconstructed from `depth` at render time.
//!
//! The walk uses `ignore::WalkBuilder`, the same traversal ripgrep uses. It
//! parallelises across the directory graph and honours `.gitignore`, so a
//! manuscript folder that also holds `node_modules` does not pay for it.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use ignore::{WalkBuilder, WalkState};

/// What a path is. Kept separate from the extension because the tree renders
/// directories first and the sort needs the distinction without a string test.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Directory,
    Symlink,
}

/// One entry in the workspace.
///
/// `name_folded` is the lowercase form, computed once during the walk. Folding
/// during a search instead would repeat the allocation on every keystroke, for
/// every entry — the single largest avoidable cost in an incremental filter.
#[derive(Debug, Clone)]
pub struct Entry {
    pub path: PathBuf,
    pub name: String,
    pub name_folded: String,
    pub kind: Kind,
    pub size: u64,
    /// Milliseconds since the Unix epoch. `SystemTime` does not cross the FFI
    /// boundary, and milliseconds are what the UI formats anyway.
    pub modified_ms: i64,
    pub depth: usize,
    /// True when the extension is one this application edits.
    pub manuscript: bool,
}

/// Extensions the workbench treats as manuscript text. Matches `project.ts`,
/// which is the authority; this list exists so the walk can flag entries
/// without a second pass.
const MANUSCRIPT: &[&str] = &["md", "markdown", "mdown", "txt"];

impl Entry {
    fn from(path: PathBuf, depth: usize) -> Option<Self> {
        let metadata = path.symlink_metadata().ok()?;
        let file_type = metadata.file_type();

        let kind = if file_type.is_symlink() {
            Kind::Symlink
        } else if file_type.is_dir() {
            Kind::Directory
        } else {
            Kind::File
        };

        let name = path.file_name()?.to_string_lossy().into_owned();
        let name_folded = name.to_lowercase();

        let manuscript = matches!(kind, Kind::File)
            && path
                .extension()
                .map(|ext| {
                    let ext = ext.to_string_lossy().to_lowercase();
                    MANUSCRIPT.contains(&ext.as_str())
                })
                .unwrap_or(false);

        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|since| since.as_millis() as i64)
            .unwrap_or(0);

        Some(Self {
            path,
            name,
            name_folded,
            kind,
            size: metadata.len(),
            modified_ms,
            depth,
            manuscript,
        })
    }
}

/// How the walk should behave. Defaults match what a writer expects on opening
/// a folder: hidden files stay hidden, ignore rules apply, symlinks are listed
/// but not followed.
#[derive(Debug, Clone)]
pub struct ScanOptions {
    pub hidden: bool,
    pub respect_ignore: bool,
    pub follow_symlinks: bool,
    pub max_depth: Option<usize>,
    /// Only entries this application can edit. The tree still needs directories
    /// to render, so they are kept regardless.
    pub manuscripts_only: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            hidden: false,
            respect_ignore: true,
            // Following symlinks can loop, and a manuscript tree has no reason
            // to. The guard refuses writes through them separately.
            follow_symlinks: false,
            max_depth: None,
            manuscripts_only: false,
        }
    }
}

/// Walk every root in parallel and return one flat index.
///
/// The threads append into per-thread buffers and merge once, so the shared
/// mutex is taken once per thread rather than once per entry. Locking per entry
/// turned the walk serial in an early draft and cost roughly the whole speedup.
pub fn scan(roots: &[PathBuf], options: &ScanOptions) -> Vec<Entry> {
    let Some((first, rest)) = roots.split_first() else {
        return Vec::new();
    };

    let mut builder = WalkBuilder::new(first);
    for root in rest {
        builder.add(root);
    }

    builder
        .hidden(!options.hidden)
        .git_ignore(options.respect_ignore)
        .git_global(options.respect_ignore)
        .git_exclude(options.respect_ignore)
        .ignore(options.respect_ignore)
        .parents(options.respect_ignore)
        .follow_links(options.follow_symlinks)
        .max_depth(options.max_depth)
        // The Source Backup is never read into the index either: showing it
        // invites a click that the guard would then have to refuse.
        .filter_entry(|entry| entry.file_name() != crate::guard::SOURCE_BACKUP_DIR);

    let collected = Mutex::new(Vec::<Entry>::new());

    builder.build_parallel().run(|| {
        // Each thread fills a local buffer and merges once, through a guard
        // whose Drop runs when the walker retires the thread. Locking per entry
        // serialised the walk in an early draft and cost most of the speedup.
        let mut sink = Sink {
            local: Vec::new(),
            shared: &collected,
        };
        Box::new(move |result| {
            let Ok(entry) = result else {
                return WalkState::Continue;
            };
            let depth = entry.depth();
            if depth == 0 {
                return WalkState::Continue;
            }

            if let Some(item) = Entry::from(entry.into_path(), depth) {
                let keep = !options.manuscripts_only
                    || item.manuscript
                    || matches!(item.kind, Kind::Directory);
                if keep {
                    sink.local.push(item);
                }
            }
            WalkState::Continue
        })
    });

    collected.into_inner().unwrap_or_default()
}

/// Merges a worker's buffer into the shared index exactly once.
///
/// `build_parallel` has no completion callback, so the merge hangs off Drop:
/// the walker drops each per-thread visitor when it finishes, which is the only
/// moment the buffer is known to be complete.
struct Sink<'a> {
    local: Vec<Entry>,
    shared: &'a Mutex<Vec<Entry>>,
}

impl Drop for Sink<'_> {
    fn drop(&mut self) {
        if self.local.is_empty() {
            return;
        }
        if let Ok(mut shared) = self.shared.lock() {
            shared.append(&mut self.local);
        }
    }
}

/// Scan a single root. The common case, and the one the tree view calls.
pub fn scan_one(root: &Path, options: &ScanOptions) -> Vec<Entry> {
    scan(&[root.to_path_buf()], options)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("refrain-index-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn finds_every_manuscript_in_a_tree() {
        let root = scratch("tree");
        fs::create_dir_all(root.join("part-one")).unwrap();
        fs::write(root.join("one.md"), "a").unwrap();
        fs::write(root.join("part-one/two.md"), "bb").unwrap();
        fs::write(root.join("part-one/notes.txt"), "ccc").unwrap();

        let entries = scan_one(&root, &ScanOptions::default());
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();

        assert!(names.contains(&"one.md"));
        assert!(names.contains(&"two.md"));
        assert!(names.contains(&"notes.txt"));
        assert!(names.contains(&"part-one"));
    }

    #[test]
    fn records_size_and_kind() {
        let root = scratch("meta");
        fs::write(root.join("one.md"), "hello").unwrap();
        fs::create_dir_all(root.join("sub")).unwrap();

        let entries = scan_one(&root, &ScanOptions::default());
        let file = entries.iter().find(|e| e.name == "one.md").unwrap();
        let dir = entries.iter().find(|e| e.name == "sub").unwrap();

        assert_eq!(file.kind, Kind::File);
        assert_eq!(file.size, 5);
        assert!(file.manuscript);
        assert_eq!(dir.kind, Kind::Directory);
    }

    #[test]
    fn folds_the_name_once_during_the_walk() {
        let root = scratch("fold");
        fs::write(root.join("Chapter-One.MD"), "x").unwrap();

        let entries = scan_one(&root, &ScanOptions::default());
        let entry = entries.iter().find(|e| e.name == "Chapter-One.MD").unwrap();

        assert_eq!(entry.name_folded, "chapter-one.md");
        assert!(
            entry.manuscript,
            "uppercase extension is still a manuscript"
        );
    }

    #[test]
    fn skips_the_source_backup() {
        let root = scratch("backup");
        fs::create_dir_all(root.join(crate::guard::SOURCE_BACKUP_DIR)).unwrap();
        fs::write(
            root.join(crate::guard::SOURCE_BACKUP_DIR)
                .join("original.md"),
            "x",
        )
        .unwrap();
        fs::write(root.join("working.md"), "y").unwrap();

        let entries = scan_one(&root, &ScanOptions::default());
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();

        assert!(names.contains(&"working.md"));
        assert!(!names.contains(&"original.md"));
        assert!(!names.contains(&crate::guard::SOURCE_BACKUP_DIR));
    }

    #[test]
    fn hides_dotfiles_unless_asked() {
        let root = scratch("hidden");
        fs::write(root.join(".secret.md"), "x").unwrap();
        fs::write(root.join("open.md"), "y").unwrap();

        let visible = scan_one(&root, &ScanOptions::default());
        assert!(!visible.iter().any(|e| e.name == ".secret.md"));

        let all = scan_one(
            &root,
            &ScanOptions {
                hidden: true,
                ..Default::default()
            },
        );
        assert!(all.iter().any(|e| e.name == ".secret.md"));
    }

    #[test]
    fn manuscripts_only_keeps_directories_so_the_tree_still_renders() {
        let root = scratch("only");
        fs::create_dir_all(root.join("part")).unwrap();
        fs::write(root.join("part/one.md"), "a").unwrap();
        fs::write(root.join("part/cover.png"), "b").unwrap();

        let entries = scan_one(
            &root,
            &ScanOptions {
                manuscripts_only: true,
                ..Default::default()
            },
        );
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();

        assert!(names.contains(&"one.md"));
        assert!(names.contains(&"part"));
        assert!(!names.contains(&"cover.png"));
    }

    #[test]
    fn an_empty_root_list_yields_an_empty_index() {
        assert!(scan(&[], &ScanOptions::default()).is_empty());
    }
}
