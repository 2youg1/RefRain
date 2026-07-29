//! Path admission.
//!
//! Every mutating entry point in RootFiles passes its target through
//! [`Guard::admit`] before touching the disk. The guard is the reason a path
//! traversal, a symlink, or a Windows device name cannot reach the manuscript.
//!
//! Two rules:
//!
//! 1. A path must resolve inside one of the workspace roots.
//! 2. A path must never resolve inside a Source Backup (INV-4).
//!
//! The check runs on the *canonical* path, so `a/../../etc/passwd` and a
//! symlink pointing out of the tree are both refused by the same test. Refusing
//! on the literal string would pass both.
//!
//! Ported from legacy `packages/fs/src/guard.rs`; the module was already pure
//! `std` Rust, and the behaviour it encodes is exactly what INV-4 and the Root
//! permit demand, so it moves across unchanged in substance.

use std::path::{Component, Path, PathBuf};

use crate::root::SOURCE_BACKUP_DIR;

/// Why a path was refused. Carried to the UI verbatim: a refusal the user
/// cannot read is a refusal they will work around.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// Resolved outside every workspace root.
    OutsideRoots { path: String },
    /// Resolved inside a Source Backup, which is never written to.
    SourceBackup { path: String },
    /// A component this crate refuses to create on any platform.
    IllegalName { name: String },
    /// The path could not be resolved at all.
    Unresolvable { path: String, reason: String },
}

impl Refusal {
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::OutsideRoots { path } => {
                format!("{path} is outside every workspace root")
            }
            Self::SourceBackup { path } => {
                format!("{path} is inside the Source Backup, which is never written to")
            }
            Self::IllegalName { name } => {
                format!("{name} is not a legal file name on every supported platform")
            }
            Self::Unresolvable { path, reason } => {
                format!("{path} could not be resolved: {reason}")
            }
        }
    }
}

/// Reserved device names on Windows. Creating `nul.md` succeeds on Linux and
/// produces an unopenable file on Windows, so the guard refuses them
/// everywhere: a manuscript must survive being copied between machines.
const WINDOWS_RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// The admission authority. Constructed from the canonical paths of adopted
/// Roots; the composition layer never sees it (Plan M5).
pub struct Guard {
    roots: Vec<PathBuf>,
}

impl Guard {
    /// Roots are canonicalised once. A root that does not exist is kept in
    /// literal form so a workspace can name a folder before it is created.
    pub fn new<I, P>(roots: I) -> Self
    where
        I: IntoIterator<Item = P>,
        P: AsRef<Path>,
    {
        let roots = roots
            .into_iter()
            .map(|root| {
                let path = root.as_ref();
                path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
            })
            .collect();
        Self { roots }
    }

    /// Resolve `candidate` and admit it, or explain the refusal.
    ///
    /// The candidate need not exist: a new chapter is admitted by resolving its
    /// closest existing ancestor and appending the remainder. That keeps
    /// "create a file" and "move a file" on one code path.
    pub fn admit(&self, candidate: &Path) -> Result<PathBuf, Refusal> {
        let resolved = resolve(candidate)?;

        // No roots admits nothing. The empty list used to admit everything,
        // which made the guard that owns "Source Backup is never written to"
        // vanish under the one input a caller can reach by passing an empty
        // vector — a probe confirmed `/etc/shadow` came back admitted.
        let root = self
            .roots
            .iter()
            .find(|root| resolved.starts_with(root))
            .ok_or_else(|| Refusal::OutsideRoots {
                path: resolved.display().to_string(),
            })?;

        // Only the part below the root is ours to name. The ancestors are the
        // author's existing filesystem; the names this application creates
        // start here.
        let inside = resolved.strip_prefix(root).unwrap_or(&resolved);
        for component in inside.components() {
            if let Component::Normal(part) = component {
                let name = part.to_string_lossy();
                if is_illegal(&name) {
                    return Err(Refusal::IllegalName {
                        name: name.into_owned(),
                    });
                }
            }
        }

        if resolved
            .components()
            .any(|c| matches!(c, Component::Normal(p) if p == SOURCE_BACKUP_DIR))
        {
            return Err(Refusal::SourceBackup {
                path: resolved.display().to_string(),
            });
        }

        Ok(resolved)
    }

    /// Admit the directory entry named by `candidate` without following its
    /// final symlink.
    ///
    /// Deleting a symlink means deleting the link, but admission still validates
    /// both sides of that entry: the canonical parent and literal name, then the
    /// resolved referent. The reserved Source Backup component is also checked
    /// as written so a symlink cannot launder `.refrain-source` into Root content.
    pub fn admit_literal(&self, candidate: &Path) -> Result<PathBuf, Refusal> {
        if candidate
            .components()
            .any(|c| matches!(c, Component::Normal(p) if p == SOURCE_BACKUP_DIR))
        {
            return Err(Refusal::SourceBackup {
                path: candidate.display().to_string(),
            });
        }

        let name = candidate.file_name().ok_or_else(|| Refusal::Unresolvable {
            path: candidate.display().to_string(),
            reason: "has no file name".into(),
        })?;
        let name = name.to_string_lossy();
        if is_illegal(&name) {
            return Err(Refusal::IllegalName {
                name: name.into_owned(),
            });
        }

        let parent = candidate.parent().ok_or_else(|| Refusal::Unresolvable {
            path: candidate.display().to_string(),
            reason: "has no parent directory".into(),
        })?;
        let literal = self.admit(parent)?.join(name.as_ref());
        self.admit(&literal)?;
        Ok(literal)
    }
}

/// A name no platform in the support matrix accepts, plus the ones that produce
/// a file the user cannot later open.
fn is_illegal(name: &str) -> bool {
    if name.is_empty() || name.contains('\0') {
        return true;
    }

    // Windows forbids these in a file name; a manuscript that cannot round-trip
    // to Windows is a manuscript the author loses when they change machines.
    if name.contains(['<', '>', ':', '"', '|', '?', '*']) {
        return true;
    }

    // Trailing dot or space: Windows silently strips them, so `chapter ` and
    // `chapter` become the same file and one overwrites the other.
    if name.ends_with('.') || name.ends_with(' ') {
        return true;
    }

    let stem = name.split('.').next().unwrap_or(name).to_ascii_lowercase();
    WINDOWS_RESERVED.contains(&stem.as_str())
}

/// Canonicalise as far as the filesystem allows, then append what does not yet
/// exist. `canonicalize` alone fails on any path whose leaf is absent, which is
/// every file this application is about to create.
fn resolve(candidate: &Path) -> Result<PathBuf, Refusal> {
    let absolute = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| Refusal::Unresolvable {
                path: candidate.display().to_string(),
                reason: error.to_string(),
            })?
            .join(candidate)
    };

    let mut existing = absolute.as_path();
    let mut remainder = Vec::new();

    loop {
        if existing.exists() {
            break;
        }
        match (existing.file_name(), existing.parent()) {
            (Some(name), Some(parent)) => {
                remainder.push(name.to_os_string());
                existing = parent;
            }
            _ => {
                return Err(Refusal::Unresolvable {
                    path: absolute.display().to_string(),
                    reason: "no existing ancestor".into(),
                });
            }
        }
    }

    let mut resolved = existing
        .canonicalize()
        .map_err(|error| Refusal::Unresolvable {
            path: absolute.display().to_string(),
            reason: error.to_string(),
        })?;

    for name in remainder.into_iter().rev() {
        // `..` inside the not-yet-existing tail would escape the resolved
        // prefix, so it is applied rather than appended.
        if name == ".." {
            resolved.pop();
        } else if name != "." {
            resolved.push(name);
        }
    }

    Ok(resolved)
}
