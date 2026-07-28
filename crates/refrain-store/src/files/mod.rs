//! RootFiles: the file space a Root permit constrains (Plan M5).
//!
//! One public surface for the Files reference page: a parallel index that
//! never crosses the bridge whole, ranked search over it, and the guarded
//! mutations. The Guard exists so no path — traversal, symlink, device name —
//! reaches the manuscript unadmitted; it is not exposed, because a caller
//! holding the guard is a caller who can forget to use it.
//!
//! Paths never cross the bridge (SPEC 6.2); the composition layer speaks in
//! opaque ids and this module resolves them against the adopted Roots.

mod guard;
mod index;
mod ops;
mod search;
mod sort;

use std::path::{Path, PathBuf};

pub use guard::Refusal;
pub use index::{Entry, Kind, ScanOptions};
pub use ops::{Done, OpError};
pub use sort::{Direction, Order};

use guard::Guard;

/// One page of the index, after ordering. The bridge carries pages, never the
/// index (SPEC 11.5: a 100k index stays in Rust).
#[derive(Debug, Clone)]
pub struct FilePage {
    pub entries: Vec<Entry>,
    pub total: usize,
}

#[derive(Debug, Clone, Copy)]
pub struct FilePageQuery {
    pub offset: usize,
    pub limit: usize,
    pub order: Order,
    pub direction: Direction,
}

/// A ranked match, with character offsets for highlighting.
#[derive(Debug, Clone)]
pub struct SearchHit {
    pub entry: Entry,
    pub score: i32,
    pub positions: Vec<usize>,
}

#[derive(Debug, Clone)]
pub struct SearchQuery {
    pub text: String,
    pub limit: usize,
    /// Directories only, for a destination picker.
    pub directories_only: bool,
}

/// Every mutation the file space offers. Delete exists only as trash.
#[derive(Debug, Clone)]
pub enum FileCommand {
    Move {
        from: PathBuf,
        to: PathBuf,
        replace: bool,
    },
    Copy {
        from: PathBuf,
        to: PathBuf,
        replace: bool,
    },
    Link {
        target: PathBuf,
        link: PathBuf,
    },
    Trash {
        target: PathBuf,
    },
    TrashViaHome {
        target: PathBuf,
    },
    TrashAll {
        targets: Vec<PathBuf>,
    },
    CreateDirectory {
        path: PathBuf,
    },
}

#[derive(Debug)]
pub enum FileOutcome {
    Done(Done),
    Trashed(PathBuf),
    TrashedAll(Vec<Result<PathBuf, OpError>>),
    Created(PathBuf),
}

/// The index plus the admission authority over the same roots.
pub struct RootFiles {
    guard: Guard,
    entries: Vec<Entry>,
}

impl RootFiles {
    /// Walk the roots in parallel and build the index. The Source Backup is
    /// never indexed (INV-4).
    #[must_use]
    pub fn scan(roots: &[PathBuf]) -> Self {
        let entries = index::scan(roots, &ScanOptions::default_for_open());
        Self {
            guard: Guard::new(roots.iter().map(|root| root.as_path())),
            entries,
        }
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Re-order the index in place, then serve pages against the new order.
    pub fn sort(&mut self, order: Order, direction: Direction) {
        sort::sort(&mut self.entries, order, direction);
    }

    #[must_use]
    pub fn page(&self, query: FilePageQuery) -> FilePage {
        FilePage {
            entries: self
                .entries
                .iter()
                .skip(query.offset)
                .take(query.limit)
                .cloned()
                .collect(),
            total: self.entries.len(),
        }
    }

    #[must_use]
    pub fn search(&self, query: &SearchQuery) -> Vec<SearchHit> {
        let hits = if query.directories_only {
            search::directories(&self.entries, &query.text, query.limit)
        } else {
            search::matches(&self.entries, &query.text, query.limit)
        };
        hits.into_iter()
            .map(|hit| SearchHit {
                entry: hit.entry.clone(),
                score: hit.score,
                positions: hit.positions,
            })
            .collect()
    }

    /// Whether a path would be admitted. The destination picker asks this
    /// instead of trying and failing.
    #[must_use]
    pub fn admits(&self, candidate: &Path) -> bool {
        self.guard.admit(candidate).is_ok()
    }

    #[must_use]
    pub fn unique_name(&self, desired: &Path) -> PathBuf {
        ops::unique_name(desired)
    }

    /// One guarded mutation. There is no permanent delete to expose.
    pub fn execute(&self, command: &FileCommand) -> Result<FileOutcome, OpError> {
        match command {
            FileCommand::Move { from, to, replace } => {
                ops::move_to(&self.guard, from, to, *replace).map(FileOutcome::Done)
            }
            FileCommand::Copy { from, to, replace } => {
                ops::copy(&self.guard, from, to, *replace).map(FileOutcome::Done)
            }
            FileCommand::Link { target, link } => {
                ops::link(&self.guard, target, link).map(FileOutcome::Done)
            }
            FileCommand::Trash { target } => {
                ops::trash(&self.guard, target).map(FileOutcome::Trashed)
            }
            FileCommand::TrashViaHome { target } => {
                ops::trash_via_home(&self.guard, target).map(FileOutcome::Trashed)
            }
            FileCommand::TrashAll { targets } => Ok(FileOutcome::TrashedAll(ops::trash_all(
                &self.guard,
                targets,
            ))),
            FileCommand::CreateDirectory { path } => {
                ops::create_directory(&self.guard, path).map(FileOutcome::Created)
            }
        }
    }
}
