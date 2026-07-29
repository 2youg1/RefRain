//! The workspace index.
//!
//! One parallel walk produces every fact the UI needs: path, name, size, mtime,
//! kind, and the pre-lowered name the matcher searches against. Holding those
//! in a flat `Vec` rather than a tree is deliberate — sort and filter are linear
//! scans over contiguous memory, and the tree the user sees is reconstructed
//! from `depth` at render time.
//!
//! The walk uses `ignore::WalkBuilder`, the same traversal ripgrep uses. It
//! parallelises across the directory graph and honours `.gitignore`, so a
//! manuscript folder that also holds `node_modules` does not pay for it.
//!
//! Ported from legacy `packages/fs/src/index.rs`; the Source Backup is never
//! read into the index (INV-4): showing it invites a click the guard would
//! then have to refuse.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use ignore::{WalkBuilder, WalkState};

use crate::root::SOURCE_BACKUP_DIR;

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
    /// Milliseconds since the Unix epoch.
    pub modified_ms: i64,
    pub depth: usize,
    /// True when the extension is one this application edits.
    pub manuscript: bool,
}

/// Extensions the workbench treats as manuscript text.
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
#[derive(Debug, Clone, Default)]
pub struct ScanOptions {
    pub hidden: bool,
    pub respect_ignore: bool,
    pub follow_symlinks: bool,
    pub max_depth: Option<usize>,
    /// Only entries this application can edit. The tree still needs directories
    /// to render, so they are kept regardless.
    pub manuscripts_only: bool,
}

impl ScanOptions {
    #[must_use]
    pub fn default_for_open() -> Self {
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
/// mutex is taken once per thread rather than once per entry.
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
        .filter_entry(|entry| entry.file_name() != SOURCE_BACKUP_DIR);

    let collected = Mutex::new(Vec::<Entry>::new());

    builder.build_parallel().run(|| {
        // Each thread fills a local buffer and merges once, through a guard
        // whose Drop runs when the walker retires the thread.
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
