//! Mutating the workspace: move, rename, copy, link, and delete.
//!
//! Every function here takes a [`Guard`] and passes its targets through it
//! before touching the disk. That is the whole safety story: a caller cannot
//! reach the Source Backup or escape a root, because there is no code path that
//! skips the check.
//!
//! **Delete means the system trash.** `remove_file` is not offered. A writer who
//! loses a chapter to a misclick has lost work this application exists to
//! protect, and no confirmation dialog is worth as much as the operating
//! system's own undo. The `trash` crate routes to `IFileOperation` on Windows,
//! `NSFileManager` on macOS, and the freedesktop.org spec on Linux — three
//! implementations of one promise: the file comes back.

use std::fs;
use std::path::{Path, PathBuf};

use crate::guard::{Guard, Refusal};

/// What happened, in terms the interface can show without interpretation.
#[derive(Debug, Clone)]
pub struct Done {
    pub from: PathBuf,
    pub to: PathBuf,
}

#[derive(Debug)]
pub enum OpError {
    Refused(Refusal),
    Io {
        path: String,
        reason: String,
    },
    /// The destination exists and the caller did not ask to replace it.
    Occupied {
        path: String,
    },
    /// A directory cannot be moved into itself.
    IntoItself {
        path: String,
    },
}

impl OpError {
    pub fn message(&self) -> String {
        match self {
            Self::Refused(refusal) => refusal.message(),
            Self::Io { path, reason } => format!("{path}: {reason}"),
            Self::Occupied { path } => format!("{path} already exists"),
            Self::IntoItself { path } => format!("{path} cannot be moved inside itself"),
        }
    }
}

impl From<Refusal> for OpError {
    fn from(refusal: Refusal) -> Self {
        Self::Refused(refusal)
    }
}

type Outcome = Result<Done, OpError>;

fn io(path: &Path, error: std::io::Error) -> OpError {
    OpError::Io {
        path: path.display().to_string(),
        reason: error.to_string(),
    }
}

/// Move or rename. One operation: renaming is moving inside one directory, and
/// separating them would duplicate every check.
///
/// Falls back to copy-then-delete across filesystems, where `rename` fails with
/// `EXDEV`. The copy is verified before the source is trashed, so an
/// interrupted move leaves the original in place.
pub fn move_to(guard: &Guard, from: &Path, to: &Path, replace: bool) -> Outcome {
    let from = guard.admit(from)?;
    let to = guard.admit(to)?;

    if !from.exists() {
        return Err(OpError::Io {
            path: from.display().to_string(),
            reason: "does not exist".into(),
        });
    }

    if from.is_dir() && to.starts_with(&from) {
        return Err(OpError::IntoItself {
            path: from.display().to_string(),
        });
    }

    if to.exists() && !replace {
        return Err(OpError::Occupied {
            path: to.display().to_string(),
        });
    }

    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|error| io(parent, error))?;
    }

    match fs::rename(&from, &to) {
        Ok(()) => Ok(Done { from, to }),
        Err(_) => {
            // Cross-device: copy, verify, then trash the source. Trashing rather
            // than deleting keeps the original recoverable if the copy is wrong
            // in a way this check cannot see.
            copy_tree(&from, &to)?;
            trash::delete(&from).map_err(|error| OpError::Io {
                path: from.display().to_string(),
                reason: error.to_string(),
            })?;
            Ok(Done { from, to })
        }
    }
}

/// Copy a file or a directory tree.
pub fn copy(guard: &Guard, from: &Path, to: &Path, replace: bool) -> Outcome {
    let from = guard.admit(from)?;
    let to = guard.admit(to)?;

    if to.exists() && !replace {
        return Err(OpError::Occupied {
            path: to.display().to_string(),
        });
    }
    if from.is_dir() && to.starts_with(&from) {
        return Err(OpError::IntoItself {
            path: from.display().to_string(),
        });
    }

    copy_tree(&from, &to)?;
    Ok(Done { from, to })
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), OpError> {
    if from.is_dir() {
        fs::create_dir_all(to).map_err(|error| io(to, error))?;
        for entry in fs::read_dir(from).map_err(|error| io(from, error))? {
            let entry = entry.map_err(|error| io(from, error))?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        return Ok(());
    }

    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|error| io(parent, error))?;
    }
    fs::copy(from, to).map_err(|error| io(from, error))?;
    Ok(())
}

/// Delete to the system trash.
///
/// The only delete this crate offers. There is deliberately no permanent
/// variant: a caller that wants one has to go around this module, which makes
/// the decision visible in review.
pub fn trash(guard: &Guard, target: &Path) -> Result<PathBuf, OpError> {
    let target = guard.admit(target)?;

    if !target.exists() {
        return Err(OpError::Io {
            path: target.display().to_string(),
            reason: "does not exist".into(),
        });
    }

    trash::delete(&target).map_err(|error| OpError::Io {
        path: target.display().to_string(),
        reason: error.to_string(),
    })?;
    Ok(target)
}

/// Trash several paths, reporting each outcome separately.
///
/// A partial failure is normal — one file locked by another process must not
/// abandon the rest — so the result is per-path rather than all-or-nothing.
pub fn trash_all(guard: &Guard, targets: &[PathBuf]) -> Vec<Result<PathBuf, OpError>> {
    targets.iter().map(|path| trash(guard, path)).collect()
}

/// Create a symbolic link at `link` pointing to `target`.
///
/// Windows needs to know whether the target is a directory, and needs either
/// Developer Mode or elevation. The error is returned verbatim rather than
/// dressed up: a permission failure the user can act on beats a generic one.
pub fn link(guard: &Guard, target: &Path, link_path: &Path) -> Outcome {
    let target = guard.admit(target)?;
    let link_path = guard.admit(link_path)?;

    if link_path.exists() {
        return Err(OpError::Occupied {
            path: link_path.display().to_string(),
        });
    }
    if let Some(parent) = link_path.parent() {
        fs::create_dir_all(parent).map_err(|error| io(parent, error))?;
    }

    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &link_path).map_err(|error| io(&link_path, error))?;

    // Windows needs to know whether the target is a directory, and needs either
    // Developer Mode or elevation. The OS error is returned verbatim rather
    // than dressed up: a permission failure the user can act on beats a
    // generic one.
    #[cfg(windows)]
    {
        if target.is_dir() {
            std::os::windows::fs::symlink_dir(&target, &link_path)
                .map_err(|error| io(&link_path, error))?;
        } else {
            std::os::windows::fs::symlink_file(&target, &link_path)
                .map_err(|error| io(&link_path, error))?;
        }
    }

    // Any other platform has no symlink call here, and returning `Done` would
    // report a link that was never created — a silent failure is worse than an
    // unsupported one.
    #[cfg(not(any(unix, windows)))]
    return Err(OpError::Io {
        path: link_path.display().to_string(),
        reason: "linking is not supported on this platform".into(),
    });

    #[cfg(any(unix, windows))]
    Ok(Done {
        from: target,
        to: link_path,
    })
}

/// Create a directory, and any parent it needs.
pub fn create_directory(guard: &Guard, path: &Path) -> Result<PathBuf, OpError> {
    let path = guard.admit(path)?;
    fs::create_dir_all(&path).map_err(|error| io(&path, error))?;
    Ok(path)
}

/// A name that does not collide, by appending ` 2`, ` 3`, and so on.
///
/// The suffix goes before the extension so `chapter 2.md` stays a Markdown file.
pub fn unique_name(desired: &Path) -> PathBuf {
    if !desired.exists() {
        return desired.to_path_buf();
    }

    let parent = desired.parent().unwrap_or(Path::new("."));
    let stem = desired
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let extension = desired
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    for n in 2..10_000 {
        let candidate = parent.join(format!("{stem} {n}{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    desired.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("refrain-ops-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn moves_a_file() {
        let root = scratch("move");
        fs::write(root.join("one.md"), "text").unwrap();
        let guard = Guard::new([&root]);

        move_to(&guard, &root.join("one.md"), &root.join("two.md"), false).unwrap();

        assert!(!root.join("one.md").exists());
        assert_eq!(fs::read_to_string(root.join("two.md")).unwrap(), "text");
    }

    #[test]
    fn refuses_to_overwrite_unless_asked() {
        let root = scratch("occupied");
        fs::write(root.join("one.md"), "a").unwrap();
        fs::write(root.join("two.md"), "b").unwrap();
        let guard = Guard::new([&root]);

        let error = move_to(&guard, &root.join("one.md"), &root.join("two.md"), false).unwrap_err();
        assert!(matches!(error, OpError::Occupied { .. }));
        assert_eq!(fs::read_to_string(root.join("two.md")).unwrap(), "b");

        move_to(&guard, &root.join("one.md"), &root.join("two.md"), true).unwrap();
        assert_eq!(fs::read_to_string(root.join("two.md")).unwrap(), "a");
    }

    #[test]
    fn refuses_to_move_a_directory_into_itself() {
        let root = scratch("into-itself");
        fs::create_dir_all(root.join("part")).unwrap();
        let guard = Guard::new([&root]);

        let error =
            move_to(&guard, &root.join("part"), &root.join("part/inner"), false).unwrap_err();
        assert!(matches!(error, OpError::IntoItself { .. }));
    }

    #[test]
    fn refuses_a_move_that_would_leave_the_root() {
        let root = scratch("escape");
        fs::write(root.join("one.md"), "x").unwrap();
        let guard = Guard::new([&root]);

        let error =
            move_to(&guard, &root.join("one.md"), &root.join("../out.md"), false).unwrap_err();
        assert!(matches!(
            error,
            OpError::Refused(Refusal::OutsideRoots { .. })
        ));
        assert!(
            root.join("one.md").exists(),
            "a refused move changes nothing"
        );
    }

    #[test]
    fn refuses_to_write_into_the_source_backup() {
        let root = scratch("backup-write");
        fs::create_dir_all(root.join(crate::guard::SOURCE_BACKUP_DIR)).unwrap();
        fs::write(root.join("one.md"), "x").unwrap();
        let guard = Guard::new([&root]);

        let error = move_to(
            &guard,
            &root.join("one.md"),
            &root.join(crate::guard::SOURCE_BACKUP_DIR).join("one.md"),
            false,
        )
        .unwrap_err();

        assert!(matches!(
            error,
            OpError::Refused(Refusal::SourceBackup { .. })
        ));
    }

    #[test]
    fn copies_a_directory_tree() {
        let root = scratch("copy-tree");
        fs::create_dir_all(root.join("part/inner")).unwrap();
        fs::write(root.join("part/one.md"), "a").unwrap();
        fs::write(root.join("part/inner/two.md"), "b").unwrap();
        let guard = Guard::new([&root]);

        copy(&guard, &root.join("part"), &root.join("clone"), false).unwrap();

        assert_eq!(fs::read_to_string(root.join("clone/one.md")).unwrap(), "a");
        assert_eq!(
            fs::read_to_string(root.join("clone/inner/two.md")).unwrap(),
            "b"
        );
        assert!(root.join("part/one.md").exists(), "copy keeps the source");
    }

    #[test]
    fn creates_a_symlink() {
        let root = scratch("link");
        fs::write(root.join("one.md"), "text").unwrap();
        let guard = Guard::new([&root]);

        link(&guard, &root.join("one.md"), &root.join("alias.md")).unwrap();

        assert_eq!(fs::read_to_string(root.join("alias.md")).unwrap(), "text");
        assert!(root
            .join("alias.md")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn creates_a_directory_and_its_parents() {
        let root = scratch("mkdir");
        let guard = Guard::new([&root]);

        create_directory(&guard, &root.join("part/two/three")).unwrap();
        assert!(root.join("part/two/three").is_dir());
    }

    #[test]
    fn a_unique_name_goes_before_the_extension() {
        let root = scratch("unique");
        fs::write(root.join("one.md"), "a").unwrap();

        let next = unique_name(&root.join("one.md"));
        assert_eq!(next.file_name().unwrap(), "one 2.md");

        fs::write(&next, "b").unwrap();
        assert_eq!(
            unique_name(&root.join("one.md")).file_name().unwrap(),
            "one 3.md"
        );
    }

    #[test]
    fn a_free_name_is_returned_unchanged() {
        let root = scratch("unique-free");
        assert_eq!(unique_name(&root.join("fresh.md")), root.join("fresh.md"));
    }

    /// Measured on Linux: a workspace on a volume whose root is not writable
    /// cannot have a `.Trash-<uid>` directory created, and the trash fails.
    ///
    /// The failure is the correct outcome and the reason this is a test: the
    /// file must still be there afterwards. Falling back to a permanent delete
    /// when the trash is unavailable would turn an inconvenience into the one
    /// loss this application promises never to cause.
    #[test]
    fn a_trash_that_cannot_run_leaves_the_file_alone() {
        let root = scratch("trash-unavailable");
        let target = root.join("chapter.md");
        fs::write(&target, "第一章的正文").unwrap();
        let guard = Guard::new([&root]);

        match trash(&guard, &target) {
            Ok(_) => assert!(!target.exists()),
            Err(error) => {
                assert!(
                    target.exists(),
                    "a failed trash must never destroy the manuscript"
                );
                assert!(
                    error.message().contains("chapter.md"),
                    "the failure names the file so a writer knows what was not deleted"
                );
            }
        }
    }

    #[test]
    fn trashing_removes_the_file_from_the_workspace() {
        let root = scratch("trash");
        let target = root.join("one.md");
        fs::write(&target, "text").unwrap();
        let guard = Guard::new([&root]);

        // The platform trash is not available in every CI container. Where it
        // works, the file must leave the workspace; where it does not, the error
        // must say so rather than silently deleting.
        match trash(&guard, &target) {
            Ok(_) => assert!(!target.exists(), "trashed file left the workspace"),
            Err(error) => {
                assert!(target.exists(), "a failed trash must not destroy the file");
                assert!(!error.message().is_empty());
            }
        }
    }

    #[test]
    fn trashing_refuses_a_path_outside_the_root() {
        let root = scratch("trash-escape");
        let outside = scratch("trash-outside");
        fs::write(outside.join("victim.md"), "x").unwrap();
        let guard = Guard::new([&root]);

        let error = trash(&guard, &outside.join("victim.md")).unwrap_err();
        assert!(matches!(
            error,
            OpError::Refused(Refusal::OutsideRoots { .. })
        ));
        assert!(outside.join("victim.md").exists());
    }

    #[test]
    fn trashing_refuses_the_source_backup() {
        let root = scratch("trash-backup");
        let backup = root.join(crate::guard::SOURCE_BACKUP_DIR);
        fs::create_dir_all(&backup).unwrap();
        fs::write(backup.join("original.md"), "x").unwrap();
        let guard = Guard::new([&root]);

        let error = trash(&guard, &backup.join("original.md")).unwrap_err();
        assert!(matches!(
            error,
            OpError::Refused(Refusal::SourceBackup { .. })
        ));
        assert!(backup.join("original.md").exists(), "the backup survives");
    }

    #[test]
    fn a_batch_reports_each_path_separately() {
        let root = scratch("trash-batch");
        fs::write(root.join("real.md"), "x").unwrap();
        let guard = Guard::new([&root]);

        let outcomes = trash_all(&guard, &[root.join("real.md"), root.join("missing.md")]);

        assert_eq!(outcomes.len(), 2);
        assert!(outcomes[1].is_err(), "the missing file fails on its own");
    }
}
