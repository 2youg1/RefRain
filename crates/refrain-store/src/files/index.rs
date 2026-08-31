// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

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

use ignore::{DirEntry, WalkBuilder, WalkState};
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
    /// Take the walk's own entry, because the walk already knows the type.
    ///
    /// This function used to receive a bare `PathBuf` and call
    /// `symlink_metadata` on it. That signature is what forced the waste: the
    /// caller held a `DirEntry` carrying the file type from the directory
    /// iteration — walkdir documents `file_type()` as "never makes any system
    /// calls" — threw it away, and this function then re-asked the filesystem
    /// for the fact it had just been handed, once per entry.
    ///
    /// Measured on Windows at 100,000 files, that second call was 651 ms of a
    /// 1,080 ms warm refresh, against 69 ms for the whole traversal that
    /// produced it (`tests/refresh_phase_probe.rs`). Passing the `DirEntry` is
    /// what makes the duplicate call unrepresentable; it is not a faster way
    /// to make it.
    ///
    /// `follow_links` is false at every call site, so `file_type()` reports the
    /// link itself and not its target, which is the distinction `Kind` needs.
    fn from(entry: DirEntry) -> Result<Self, String> {
        // `None` reaches here only from the stdin pseudo-entry, which this
        // walk never produces. It still refuses rather than skips: this scan
        // feeds reconciliation, where an omitted path is read as a deletion.
        let Some(file_type) = entry.file_type() else {
            return Err(format!(
                "inspect {}: the walk reported no file type",
                entry.path().display()
            ));
        };

        let kind = if file_type.is_symlink() {
            Kind::Symlink
        } else if file_type.is_dir() {
            Kind::Directory
        } else {
            Kind::File
        };

        let path = entry.into_path();
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

            match Entry::from(entry) {
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

    fn scratch(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "refrain-index-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |duration| duration.as_nanos())
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// Windows refuses a symlink without Developer Mode or elevation, so the
    /// caller skips instead of failing on a permission this test does not own.
    fn link_file(target: &PathBuf, link: &PathBuf) -> bool {
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(target, link);
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(target, link);
        made.is_ok()
    }

    /// A directory reparse point, which an ordinary Windows account *can*
    /// create: `mklink /J` needs no elevation, while `symlink_dir` does. This
    /// is also the link a writer meets in practice, since OneDrive and the
    /// package managers plant junctions.
    fn link_directory(target: &PathBuf, link: &PathBuf) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(windows)]
        {
            std::process::Command::new("cmd")
                .arg("/C")
                .arg("mklink")
                .arg("/J")
                .arg(link)
                .arg(target)
                .output()
                .is_ok_and(|done| done.status.success())
        }
    }

    /// The scan must report a linked directory as a link and must not walk
    /// through it. Descending would let a junction that points at its own
    /// parent turn reconciliation into a non-terminating walk, and it would
    /// register documents whose bytes are outside the Root the guard checks.
    ///
    /// This test carries the change to `Entry::from`: the type now comes from
    /// the walk rather than from `symlink_metadata`, and the two agree only
    /// while `follow_links` stays false.
    #[test]
    fn a_linked_directory_is_a_link_and_the_scan_stops_at_it() {
        let root = scratch("linked-directory");
        let real = root.join("真目录");
        std::fs::create_dir(&real).unwrap();
        std::fs::write(real.join("章节.md"), "第一章。\n").unwrap();
        let link = root.join("影目录");
        if !link_directory(&real, &link) {
            eprintln!("skipped: this platform refused to create a directory link");
            return;
        }

        let entries = scan_checked(
            std::slice::from_ref(&root),
            &ScanOptions::default_for_open(),
        )
        .unwrap();

        let shadow = entries
            .iter()
            .find(|entry| entry.path == link)
            .expect("the link is listed");
        assert_eq!(
            shadow.kind,
            Kind::Symlink,
            "a reparse point is a link, not the directory it resolves to"
        );
        assert!(
            !entries
                .iter()
                .any(|entry| entry.path.starts_with(&link) && entry.path != link),
            "the scan must not descend through a link"
        );
        assert!(
            entries
                .iter()
                .any(|entry| entry.path == real.join("章节.md")),
            "the real directory is still walked"
        );
    }

    /// `Entry::from` now reads the type the walk carries instead of calling
    /// `symlink_metadata`. The two agree only because `follow_links` is false,
    /// which makes `file_type()` describe the link and not its target. Pin
    /// that: a link named like a manuscript must not enter the catalogue as
    /// one, or reconciliation would register a document whose bytes live
    /// outside the Root the guard checks.
    #[test]
    fn a_symlink_named_like_a_manuscript_is_not_one() {
        let root = scratch("symlink-kind");
        let target = root.join("真章节.md");
        std::fs::write(&target, "第一章。\n").unwrap();
        let link = root.join("影子.md");
        if !link_file(&target, &link) {
            eprintln!("skipped: this platform refused to create a symlink");
            return;
        }

        let entries = scan_checked(
            std::slice::from_ref(&root),
            &ScanOptions::default_for_open(),
        )
        .unwrap();

        let real = entries
            .iter()
            .find(|entry| entry.path == target)
            .expect("the regular file is in the scan");
        assert_eq!(real.kind, Kind::File);
        assert!(real.manuscript, "a real .md file is a manuscript");

        let shadow = entries
            .iter()
            .find(|entry| entry.path == link)
            .expect("the symlink is listed, not followed");
        assert_eq!(shadow.kind, Kind::Symlink);
        assert!(
            !shadow.manuscript,
            "a symlink is not a manuscript even when it is named like one"
        );
    }

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
