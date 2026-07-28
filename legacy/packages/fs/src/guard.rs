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

        // No roots admits nothing. The empty list used to admit everything,
        // which made the guard that owns "Source Backup is never written to"
        // vanish under the one input a caller can reach by passing an empty
        // vector — a probe confirmed `/etc/shadow` came back admitted. Every
        // test here builds a real root, so nothing depended on the old default.
        let root = self
            .roots
            .iter()
            .find(|root| resolved.starts_with(root))
            .ok_or_else(|| Refusal::OutsideRoots {
                path: resolved.display().to_string(),
            })?;

        // Only the part below the root is ours to name. The check used to run
        // over the whole absolute path, and `:` is illegal on Windows — so a
        // project under `/tmp/a:b/` had every save, move and delete refused for
        // the lifetime of the folder, and on Windows the drive letter would
        // have done the same. The ancestors are the author's existing
        // filesystem; the names this application creates start here.
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

    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
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

    /// An empty root list admits nothing.
    ///
    /// It used to admit everything: `roots.is_empty() ||` short-circuited the
    /// containment check, so the guard holding "Source Backup is never written
    /// to" and "no path outside a workspace" disappeared entirely under an
    /// input a caller can produce by passing an empty vector. A probe run
    /// against the old code came back with `/etc/shadow` admitted.
    #[test]
    fn a_guard_with_no_roots_admits_nothing() {
        let guard = Guard::new(Vec::<PathBuf>::new());

        for candidate in ["/etc/passwd", "/etc/shadow", "/"] {
            assert!(
                guard.admit(Path::new(candidate)).is_err(),
                "an empty root list admitted {candidate}"
            );
        }
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

    /// `admit_literal` answers the safety questions but keeps the path written.
    ///
    /// This is what makes deleting a symlink delete the link. `trash` used the
    /// resolved path, so removing a shortcut to chapter three removed chapter
    /// three — and a sandbox without a trash directory cannot demonstrate that
    /// end to end, because the delete refuses first. It is provable here.
    #[cfg(unix)]
    #[test]
    fn admit_literal_keeps_the_path_as_written() {
        let root = scratch("literal");
        let chapter = root.join("03.md");
        fs::write(&chapter, "第三章").unwrap();
        let link = root.join("near.md");
        std::os::unix::fs::symlink(&chapter, &link).unwrap();

        let guard = Guard::new([&root]);

        assert_eq!(
            guard.admit(&link).unwrap(),
            chapter,
            "admit resolves, which is what every safety check needs"
        );
        assert_eq!(
            guard.admit_literal(&link).unwrap(),
            link,
            "admit_literal hands back the link, which is what a delete needs"
        );
    }

    /// A link stored in the Source Backup stays immutable even when its target
    /// is ordinary Root content. Canonical admission alone sees only the target.
    #[cfg(unix)]
    #[test]
    fn admit_literal_refuses_a_symlink_entry_inside_the_source_backup() {
        let root = scratch("literal-backup-entry");
        let chapter = root.join("03.md");
        fs::write(&chapter, "第三章").unwrap();
        let backup = root.join(SOURCE_BACKUP_DIR);
        fs::create_dir(&backup).unwrap();
        let link = backup.join("03.md");
        std::os::unix::fs::symlink(&chapter, &link).unwrap();
        let guard = Guard::new([&root]);

        assert_eq!(guard.admit(&link).unwrap(), chapter);
        assert!(matches!(
            guard.admit_literal(&link).unwrap_err(),
            Refusal::SourceBackup { .. }
        ));
    }

    /// The reserved component is protected as written too. A directory link
    /// named `.refrain-source` must not launder the path into ordinary content.
    #[cfg(unix)]
    #[test]
    fn admit_literal_refuses_a_lexical_source_backup_alias() {
        let root = scratch("literal-backup-alias");
        let ordinary = root.join("ordinary");
        fs::create_dir(&ordinary).unwrap();
        fs::write(ordinary.join("03.md"), "第三章").unwrap();
        let alias = root.join(SOURCE_BACKUP_DIR);
        std::os::unix::fs::symlink(&ordinary, &alias).unwrap();
        let candidate = alias.join("03.md");
        let guard = Guard::new([&root]);

        assert_eq!(guard.admit(&candidate).unwrap(), ordinary.join("03.md"));
        assert!(matches!(
            guard.admit_literal(&candidate).unwrap_err(),
            Refusal::SourceBackup { .. }
        ));
    }

    /// The safety checks still run. A literal path is not an unchecked one.
    #[test]
    fn admit_literal_still_refuses_what_admit_refuses() {
        let root = scratch("literal-refuses");
        let guard = Guard::new([&root]);

        assert!(guard.admit_literal(&root.join("../escape.md")).is_err());
        assert!(guard.admit_literal(Path::new("/etc/passwd")).is_err());
        assert!(guard
            .admit_literal(&root.join(SOURCE_BACKUP_DIR).join("01.md"))
            .is_err());
    }

    /// A colon in an ancestor directory used to refuse every write.
    ///
    /// The name check ran over the whole absolute path, and `:` is illegal on
    /// Windows — so a project living under `/tmp/a:b/` had every save, move and
    /// delete refused for the lifetime of the folder. The rule belongs to the
    /// names this application creates, which are the ones below the root; the
    /// ancestors are the author's existing filesystem and are not ours to
    /// judge. On Windows the drive letter would otherwise fail the same way.
    ///
    /// Unix-only because of how it is built, not because of what it proves:
    /// Windows refuses to *create* `refrain-guard-colon:dir` at all, so the
    /// fixture cannot exist there. The rule it checks holds on both platforms
    /// — a Windows drive letter is exactly the ancestor colon this admits.
    #[cfg(unix)]
    #[test]
    fn allows_an_illegal_character_in_an_ancestor_of_the_root() {
        let base = std::env::temp_dir().join("refrain-guard-colon:dir");
        let _ = fs::remove_dir_all(&base);
        let root = base.join("proj");
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        fs::write(root.join("01.md"), "第一章").unwrap();

        let guard = Guard::new([&root]);

        assert!(
            guard.admit(&root.join("01.md")).is_ok(),
            "a colon above the root is the author's filesystem, not our name"
        );
        assert!(
            matches!(
                guard.admit(&root.join("bad:name.md")).unwrap_err(),
                Refusal::IllegalName { .. }
            ),
            "a colon in a name we would create is still refused"
        );
    }
}
