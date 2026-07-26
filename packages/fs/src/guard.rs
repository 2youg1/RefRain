//! Path admission.
//!
//! Every mutating entry point in this crate passes its target through
//! [`Guard::admit`] before touching the disk. The guard is the reason a path
//! traversal, a symlink, or a Windows device name cannot reach the manuscript.
//!
//! Two rules, both from SPEC §1.3 and the invariant list in AGENTS.md:
//!
//! 1. A path must resolve inside one of the workspace roots.
//! 2. A path must never resolve inside a Source Backup.
//!
//! The check runs on the *canonical* path, so `a/../../etc/passwd` and a
//! symlink pointing out of the tree are both refused by the same test. Refusing
//! on the literal string would pass both.

use std::path::{Component, Path, PathBuf};

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

/// The directory name a Source Backup lives under.
pub const SOURCE_BACKUP_DIR: &str = ".refrain-source";

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

        for component in resolved.components() {
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

        if self.roots.is_empty() || self.roots.iter().any(|root| resolved.starts_with(root)) {
            return Ok(resolved);
        }

        Err(Refusal::OutsideRoots {
            path: resolved.display().to_string(),
        })
    }

    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
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
                })
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("refrain-guard-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn admits_a_path_inside_a_root() {
        let root = scratch("inside");
        fs::write(root.join("one.md"), "x").unwrap();
        let guard = Guard::new([&root]);

        assert_eq!(
            guard.admit(&root.join("one.md")).unwrap(),
            root.join("one.md")
        );
    }

    #[test]
    fn admits_a_file_that_does_not_exist_yet() {
        let root = scratch("new");
        let guard = Guard::new([&root]);

        let admitted = guard.admit(&root.join("chapters/three.md")).unwrap();
        assert_eq!(admitted, root.join("chapters/three.md"));
    }

    #[test]
    fn refuses_traversal_out_of_the_root() {
        let root = scratch("traversal");
        let guard = Guard::new([&root]);

        let refusal = guard.admit(&root.join("../escape.md")).unwrap_err();
        assert!(matches!(refusal, Refusal::OutsideRoots { .. }));
    }

    #[test]
    fn refuses_a_symlink_that_leaves_the_root() {
        let root = scratch("symlink");
        let outside = scratch("symlink-target");
        fs::write(outside.join("secret.md"), "x").unwrap();

        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&outside, root.join("link")).unwrap();

        let guard = Guard::new([&root]);
        let refusal = guard.admit(&root.join("link/secret.md")).unwrap_err();
        assert!(matches!(refusal, Refusal::OutsideRoots { .. }));
    }

    #[test]
    fn refuses_the_source_backup() {
        let root = scratch("backup");
        fs::create_dir_all(root.join(SOURCE_BACKUP_DIR)).unwrap();
        let guard = Guard::new([&root]);

        let refusal = guard
            .admit(&root.join(SOURCE_BACKUP_DIR).join("one.md"))
            .unwrap_err();
        assert!(matches!(refusal, Refusal::SourceBackup { .. }));
    }

    #[test]
    fn refuses_windows_reserved_names_on_every_platform() {
        let root = scratch("reserved");
        let guard = Guard::new([&root]);

        for name in ["nul.md", "con", "LPT1.md", "aux.markdown"] {
            let refusal = guard.admit(&root.join(name)).unwrap_err();
            assert!(
                matches!(refusal, Refusal::IllegalName { .. }),
                "{name} should be refused"
            );
        }
    }

    #[test]
    fn refuses_a_nul_byte_in_a_name() {
        let root = scratch("nul-byte");
        let guard = Guard::new([&root]);

        assert!(guard.admit(&root.join("chapter\0.md")).is_err());
    }

    #[test]
    fn refuses_a_trailing_dot_windows_would_silently_strip() {
        let root = scratch("trailing");
        let guard = Guard::new([&root]);

        assert!(matches!(
            guard.admit(&root.join("chapter.")).unwrap_err(),
            Refusal::IllegalName { .. }
        ));
    }
}
