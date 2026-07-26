//! The N-API surface.
//!
//! Electron is the runtime that ships, so the binding is N-API rather than
//! `bun:ffi`: one ABI serves Electron, Node, and Bun alike, and this repository
//! has already paid once for a Bun-only builtin that broke the Electron launch.
//!
//! Everything crossing this boundary is a plain object. `PathBuf` becomes a
//! string, `SystemTime` became milliseconds during the walk, and an error
//! becomes a refusal with a `code` the interface can branch on and a `message`
//! it can show. Throwing a bare string across the boundary would force the
//! renderer to parse prose.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::path::PathBuf;

use crate::guard::{Guard, Refusal};
use crate::index::{self, Kind, ScanOptions};
use crate::ops;
use crate::search;
use crate::sort::{self, Direction, Order};

#[napi(object)]
pub struct JsEntry {
    pub path: String,
    pub name: String,
    /// "file" | "directory" | "symlink"
    pub kind: String,
    /// Bytes. `f64` because JavaScript has no integer wider than 53 bits and a
    /// file can exceed it; the alternative is BigInt at every call site.
    pub size: f64,
    pub modified_ms: f64,
    pub depth: u32,
    pub manuscript: bool,
}

impl From<&index::Entry> for JsEntry {
    fn from(entry: &index::Entry) -> Self {
        Self {
            path: entry.path.display().to_string(),
            name: entry.name.clone(),
            kind: match entry.kind {
                Kind::File => "file",
                Kind::Directory => "directory",
                Kind::Symlink => "symlink",
            }
            .to_string(),
            size: entry.size as f64,
            modified_ms: entry.modified_ms as f64,
            depth: entry.depth as u32,
            manuscript: entry.manuscript,
        }
    }
}

#[napi(object)]
pub struct JsScanOptions {
    pub hidden: Option<bool>,
    pub respect_ignore: Option<bool>,
    pub follow_symlinks: Option<bool>,
    pub max_depth: Option<u32>,
    pub manuscripts_only: Option<bool>,
}

impl From<Option<JsScanOptions>> for ScanOptions {
    fn from(options: Option<JsScanOptions>) -> Self {
        let defaults = ScanOptions::default();
        let Some(options) = options else {
            return defaults;
        };
        Self {
            hidden: options.hidden.unwrap_or(defaults.hidden),
            respect_ignore: options.respect_ignore.unwrap_or(defaults.respect_ignore),
            follow_symlinks: options.follow_symlinks.unwrap_or(defaults.follow_symlinks),
            max_depth: options.max_depth.map(|depth| depth as usize),
            manuscripts_only: options
                .manuscripts_only
                .unwrap_or(defaults.manuscripts_only),
        }
    }
}

#[napi(object)]
pub struct JsHit {
    pub entry: JsEntry,
    pub score: i32,
    /// Character offsets into `entry.name`, for highlighting.
    pub positions: Vec<u32>,
}

/// A refusal the interface can branch on without reading prose.
fn refuse(code: &str, message: String) -> Error {
    Error::new(Status::GenericFailure, format!("{code}: {message}"))
}

fn refusal_code(refusal: &Refusal) -> &'static str {
    match refusal {
        Refusal::OutsideRoots { .. } => "OUTSIDE_ROOTS",
        Refusal::SourceBackup { .. } => "SOURCE_BACKUP",
        Refusal::IllegalName { .. } => "ILLEGAL_NAME",
        Refusal::Unresolvable { .. } => "UNRESOLVABLE",
    }
}

/// The stable code for a failure, separate from its human sentence.
fn op_error_code(error: &ops::OpError) -> &'static str {
    match error {
        ops::OpError::Refused(refusal) => refusal_code(refusal),
        ops::OpError::Io { .. } => "IO",
        ops::OpError::Occupied { .. } => "OCCUPIED",
        ops::OpError::IntoItself { .. } => "INTO_ITSELF",
        // The interface keys the "move it to the system trash" offer off this
        // code, so it must stay distinguishable from a plain IO failure.
        ops::OpError::NoTrashHere { .. } => "NO_TRASH_HERE",
    }
}

fn op_error(error: ops::OpError) -> Error {
    refuse(op_error_code(&error), error.message())
}

/// A handle over one workspace: the roots, the index, and the guard that
/// protects them. Holding the index in Rust rather than shipping it to
/// JavaScript is the point — a filter over 100k entries stays a memory scan
/// instead of a structured-clone across the boundary.
#[napi]
pub struct Workspace {
    roots: Vec<PathBuf>,
    guard: Guard,
    entries: Vec<index::Entry>,
    options: ScanOptions,
}

#[napi]
impl Workspace {
    #[napi(constructor)]
    pub fn new(roots: Vec<String>, options: Option<JsScanOptions>) -> Self {
        let roots: Vec<PathBuf> = roots.into_iter().map(PathBuf::from).collect();
        Self {
            guard: Guard::new(roots.iter()),
            options: options.into(),
            entries: Vec::new(),
            roots,
        }
    }

    /// Walk the roots and replace the index. Returns the entry count so a caller
    /// can report progress without pulling the whole index across.
    #[napi]
    pub fn scan(&mut self) -> u32 {
        self.entries = index::scan(&self.roots, &self.options);
        self.entries.len() as u32
    }

    #[napi(getter)]
    pub fn size(&self) -> u32 {
        self.entries.len() as u32
    }

    /// A page of the index. The tree view is virtualised, so it asks for the
    /// rows it can actually show rather than the whole workspace.
    #[napi]
    pub fn page(&self, offset: u32, limit: u32) -> Vec<JsEntry> {
        self.entries
            .iter()
            .skip(offset as usize)
            .take(limit as usize)
            .map(JsEntry::from)
            .collect()
    }

    /// Rank the index against a query.
    #[napi]
    pub fn search(&self, query: String, limit: u32) -> Vec<JsHit> {
        search::matches(&self.entries, &query, limit as usize)
            .into_iter()
            .map(|hit| JsHit {
                entry: JsEntry::from(hit.entry),
                score: hit.score,
                positions: hit.positions.into_iter().map(|p| p as u32).collect(),
            })
            .collect()
    }

    /// Directories only, for a move destination picker.
    #[napi]
    pub fn search_directories(&self, query: String, limit: u32) -> Vec<JsHit> {
        search::directories(&self.entries, &query, limit as usize)
            .into_iter()
            .map(|hit| JsHit {
                entry: JsEntry::from(hit.entry),
                score: hit.score,
                positions: hit.positions.into_iter().map(|p| p as u32).collect(),
            })
            .collect()
    }

    /// Reorder the held index in place.
    #[napi]
    pub fn sort(&mut self, order: String, descending: bool) -> Result<()> {
        let order = match order.as_str() {
            "name" => Order::Name,
            "modified" => Order::Modified,
            "size" => Order::Size,
            "kind" => Order::Kind,
            other => {
                return Err(refuse(
                    "UNKNOWN_ORDER",
                    format!("{other} is not a sort order"),
                ))
            }
        };
        let direction = if descending {
            Direction::Descending
        } else {
            Direction::Ascending
        };
        sort::sort(&mut self.entries, order, direction);
        Ok(())
    }

    /// Move or rename.
    #[napi]
    pub fn move_entry(&self, from: String, to: String, replace: Option<bool>) -> Result<String> {
        ops::move_to(
            &self.guard,
            &PathBuf::from(from),
            &PathBuf::from(to),
            replace.unwrap_or(false),
        )
        .map(|done| done.to.display().to_string())
        .map_err(op_error)
    }

    #[napi]
    pub fn copy_entry(&self, from: String, to: String, replace: Option<bool>) -> Result<String> {
        ops::copy(
            &self.guard,
            &PathBuf::from(from),
            &PathBuf::from(to),
            replace.unwrap_or(false),
        )
        .map(|done| done.to.display().to_string())
        .map_err(op_error)
    }

    /// Delete to the system trash. There is no permanent variant on this object;
    /// a writer's misclick must stay recoverable through the operating system.
    #[napi]
    pub fn trash(&self, target: String) -> Result<String> {
        ops::trash(&self.guard, &PathBuf::from(target))
            .map(|path| path.display().to_string())
            .map_err(op_error)
    }

    /// Trash by way of the volume that holds the user's home (SPEC Q8).
    ///
    /// The escape hatch when `trash` returns `NO_TRASH_HERE`. Still not a
    /// permanent delete: the file is staged beside the home directory and
    /// trashed from there, so the operating system can restore it.
    #[napi]
    pub fn trash_via_home(&self, target: String) -> Result<String> {
        ops::trash_via_home(&self.guard, &PathBuf::from(target))
            .map(|path| path.display().to_string())
            .map_err(op_error)
    }

    /// Trash several paths, reporting each outcome separately: one locked file
    /// must not abandon the rest of the selection.
    #[napi]
    pub fn trash_all(&self, targets: Vec<String>) -> Vec<JsTrashOutcome> {
        let paths: Vec<PathBuf> = targets.into_iter().map(PathBuf::from).collect();
        ops::trash_all(&self.guard, &paths)
            .into_iter()
            .zip(paths.iter())
            .map(|(outcome, path)| match outcome {
                Ok(trashed) => JsTrashOutcome {
                    path: trashed.display().to_string(),
                    trashed: true,
                    code: None,
                    error: None,
                },
                Err(error) => JsTrashOutcome {
                    path: path.display().to_string(),
                    trashed: false,
                    // Code and sentence in separate fields. The interface has
                    // to branch on NO_TRASH_HERE to offer SPEC Q8's escape
                    // hatch, and regex over a human sentence is not a contract.
                    code: Some(op_error_code(&error).to_string()),
                    error: Some(error.message()),
                },
            })
            .collect()
    }

    #[napi]
    pub fn link(&self, target: String, link_path: String) -> Result<String> {
        ops::link(
            &self.guard,
            &PathBuf::from(target),
            &PathBuf::from(link_path),
        )
        .map(|done| done.to.display().to_string())
        .map_err(op_error)
    }

    #[napi]
    pub fn create_directory(&self, path: String) -> Result<String> {
        ops::create_directory(&self.guard, &PathBuf::from(path))
            .map(|path| path.display().to_string())
            .map_err(op_error)
    }

    /// A name that does not collide, for a paste or a duplicate.
    #[napi]
    pub fn unique_name(&self, desired: String) -> String {
        ops::unique_name(&PathBuf::from(desired))
            .display()
            .to_string()
    }

    /// Check a path without touching the disk. The interface calls this to grey
    /// out a destination before the user commits to it.
    #[napi]
    pub fn admits(&self, path: String) -> bool {
        self.guard.admit(&PathBuf::from(path)).is_ok()
    }
}

#[napi(object)]
pub struct JsTrashOutcome {
    pub path: String,
    pub trashed: bool,
    /// A stable code the interface can branch on, e.g. `NO_TRASH_HERE`.
    pub code: Option<String>,
    /// The same failure as a sentence, for the person reading it.
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn entry(kind: Kind, size: u64) -> index::Entry {
        index::Entry {
            path: PathBuf::from("/root/第一章.md"),
            name: "第一章.md".into(),
            name_folded: "第一章.md".into(),
            kind,
            size,
            modified_ms: 1_700_000_000_000,
            depth: 2,
            manuscript: true,
        }
    }

    #[test]
    fn kind_crosses_the_boundary_as_the_string_the_renderer_branches_on() {
        assert_eq!(JsEntry::from(&entry(Kind::File, 0)).kind, "file");
        assert_eq!(JsEntry::from(&entry(Kind::Directory, 0)).kind, "directory");
        assert_eq!(JsEntry::from(&entry(Kind::Symlink, 0)).kind, "symlink");
    }

    /// JavaScript has no integer wider than 53 bits. A file larger than that is
    /// unusual but not impossible, and the conversion must not wrap into a
    /// negative size in the interface.
    #[test]
    fn a_very_large_file_survives_the_conversion_to_f64() {
        let huge = JsEntry::from(&entry(Kind::File, u64::MAX));
        assert!(huge.size > 0.0);
        assert!(huge.size.is_finite());
    }

    #[test]
    fn a_cjk_name_crosses_the_boundary_intact() {
        let converted = JsEntry::from(&entry(Kind::File, 12));
        assert_eq!(converted.name, "第一章.md");
        assert!(converted.path.contains("第一章"));
    }

    #[test]
    fn scan_options_default_when_the_caller_sends_nothing() {
        let defaults: ScanOptions = None.into();
        assert!(!defaults.hidden, "hidden files stay hidden unless asked");
        assert!(defaults.respect_ignore);
        assert!(
            !defaults.follow_symlinks,
            "a symlink loop must not hang the walk"
        );
    }

    /// A partially specified options object must keep the defaults for
    /// everything it did not mention, rather than zeroing them.
    #[test]
    fn scan_options_merge_rather_than_replace() {
        let partial = JsScanOptions {
            hidden: Some(true),
            respect_ignore: None,
            follow_symlinks: None,
            max_depth: Some(3),
            manuscripts_only: None,
        };
        let merged: ScanOptions = Some(partial).into();

        assert!(merged.hidden);
        assert_eq!(merged.max_depth, Some(3));
        assert!(
            merged.respect_ignore,
            "an unmentioned field keeps its default"
        );
    }

    #[test]
    fn every_refusal_carries_a_distinct_code_for_the_interface_to_branch_on() {
        let codes = [
            refusal_code(&Refusal::OutsideRoots { path: "x".into() }),
            refusal_code(&Refusal::SourceBackup { path: "x".into() }),
            refusal_code(&Refusal::IllegalName { name: "x".into() }),
            refusal_code(&Refusal::Unresolvable {
                path: "x".into(),
                reason: "y".into(),
            }),
        ];

        let unique: std::collections::HashSet<_> = codes.iter().collect();
        assert_eq!(unique.len(), codes.len(), "codes must not collide");
    }

    #[test]
    fn an_unknown_sort_order_is_refused_rather_than_silently_defaulted() {
        let mut workspace = Workspace::new(vec!["/tmp".into()], None);
        assert!(workspace.sort("sideways".into(), false).is_err());
        assert!(workspace.sort("name".into(), false).is_ok());
    }
}
