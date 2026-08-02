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

use std::fmt;
use std::path::PathBuf;
use std::sync::Mutex;

use ignore::{WalkBuilder, WalkState};
use refrain_core::DocumentFormat;

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
/// 名录只读两样：路径与「是不是手稿」。树形呈现、排序、折叠名字都属于已退役
/// 的门面，不在索引里留位置。
#[derive(Debug, Clone)]
pub struct Entry {
    pub path: PathBuf,
    kind: Kind,
    /// True when the extension is one this application edits.
    pub manuscript: bool,
}

impl Entry {
    fn from(path: PathBuf) -> Result<Self, String> {
        let metadata = path
            .symlink_metadata()
            .map_err(|error| format!("inspect {}: {error}", path.display()))?;
        let file_type = metadata.file_type();

        let kind = if file_type.is_symlink() {
            Kind::Symlink
        } else if file_type.is_dir() {
            Kind::Directory
        } else {
            Kind::File
        };

        let manuscript = matches!(kind, Kind::File)
            && path
                .extension()
                .map(|ext| DocumentFormat::of_extension(&ext.to_string_lossy()).is_some())
                .unwrap_or(false);

        Ok(Self {
            path,
            kind,
            manuscript,
        })
    }
}

/// Why a database-authoritative walk cannot be used for reconciliation.
///
/// The ordinary file browser tolerates individual unreadable paths and shows
/// the rest. A reconcile is different: treating an unreadable path as absent
/// would erase its identity and confirmed-head metadata from the database.
#[derive(Debug)]
pub(crate) struct ScanFailure {
    errors: Vec<String>,
}

impl fmt::Display for ScanFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let first = self
            .errors
            .first()
            .map_or("unknown scan error", String::as_str);
        write!(formatter, "filesystem scan was incomplete: {first}")?;
        if self.errors.len() > 1 {
            write!(formatter, " (and {} more errors)", self.errors.len() - 1)?;
        }
        Ok(())
    }
}

impl std::error::Error for ScanFailure {}

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

/// Walk every root in parallel and refuse a partial result.
///
/// Use this at reconciliation boundaries where omission means deletion. The
/// threads append into per-thread buffers and merge once, so the shared
/// mutex is taken once per thread rather than once per entry.
pub(crate) fn scan_checked(
    roots: &[PathBuf],
    options: &ScanOptions,
) -> Result<Vec<Entry>, ScanFailure> {
    let (entries, errors) = scan_all(roots, options);
    if errors.is_empty() {
        Ok(entries)
    } else {
        Err(ScanFailure { errors })
    }
}

fn scan_all(roots: &[PathBuf], options: &ScanOptions) -> (Vec<Entry>, Vec<String>) {
    let Some((first, rest)) = roots.split_first() else {
        return (Vec::new(), Vec::new());
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
    let errors = Mutex::new(Vec::<String>::new());

    builder.build_parallel().run(|| {
        let errors = &errors;
        // Each thread fills a local buffer and merges once, through a guard
        // whose Drop runs when the walker retires the thread.
        let mut sink = Sink {
            local: Vec::new(),
            shared: &collected,
        };
        Box::new(move |result| {
            let entry = match result {
                Ok(entry) => entry,
                Err(error) => {
                    errors
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .push(error.to_string());
                    return WalkState::Continue;
                }
            };
            let depth = entry.depth();
            if depth == 0 {
                return WalkState::Continue;
            }

            match Entry::from(entry.into_path()) {
                Ok(item) => {
                    let keep = !options.manuscripts_only
                        || item.manuscript
                        || matches!(item.kind, Kind::Directory);
                    if keep {
                        sink.local.push(item);
                    }
                }
                Err(error) => {
                    errors
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .push(error);
                }
            }
            WalkState::Continue
        })
    });

    (
        collected
            .into_inner()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
        errors
            .into_inner()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
    )
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
        self.shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .append(&mut self.local);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checked_scan_refuses_a_missing_root() {
        let missing = std::env::temp_dir().join(format!(
            "refrain-missing-scan-root-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |duration| duration.as_nanos())
        ));

        let failure = scan_checked(&[missing], &ScanOptions::default_for_open()).unwrap_err();
        assert!(
            failure
                .to_string()
                .contains("filesystem scan was incomplete")
        );
    }
}
