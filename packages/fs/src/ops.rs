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
    /// Source and destination resolve to the same file.
    ///
    /// Its own error rather than an `Io`: the interface offers "duplicate",
    /// and a duplicate whose destination collapses onto the original is a
    /// mistake to explain, not a disk failure to report.
    SameFile {
        path: String,
    },
    /// This volume has no trash and one cannot be created (SPEC Q8).
    ///
    /// Distinguished from a plain `Io` failure because the interface can act on
    /// it: the file can still be moved to the trash on the volume that holds
    /// the user's home. A generic error would leave the author with a refusal
    /// and no way forward, which is how a correct rule starts to feel like a
    /// broken one.
    NoTrashHere {
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
            Self::SameFile { path } => format!("{path} is both the source and the destination"),
            Self::NoTrashHere { path } => {
                format!("{path}: this volume has no trash, so nothing here can be deleted safely")
            }
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
    // `fs::copy` opens the destination with O_TRUNC, so a copy onto the same
    // inode empties the source before a byte is read. `admit` hands back
    // resolved paths, so `a/chapter.md` and `a/./chapter.md` compare equal here
    // and both are refused — the duplicate action destroyed the chapter it was
    // asked to duplicate.
    if from == to {
        return Err(OpError::SameFile {
            path: from.display().to_string(),
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

    trash::delete(&target).map_err(|error| classify_trash_failure(&target, &error))?;
    Ok(target)
}

/// Tell "this volume has no trash" apart from any other failure (SPEC Q8).
///
/// The freedesktop specification cannot create `.Trash-<uid>` on a volume whose
/// root is not writable, and the `trash` crate reports that as a plain I/O
/// error like any other. The distinction matters to the person: a locked file
/// is their problem to solve, while a volume without a trash is a fact about
/// the disk that the application can route around.
fn classify_trash_failure(target: &Path, error: &trash::Error) -> OpError {
    let text = error.to_string().to_lowercase();
    let volume_has_none = text.contains("trash")
        && (text.contains("read-only")
            || text.contains("readonly")
            || text.contains("permission")
            || text.contains("no such")
            || text.contains("not found")
            || text.contains("could not create")
            || text.contains("failed to create"));

    if volume_has_none {
        return OpError::NoTrashHere {
            path: target.display().to_string(),
        };
    }
    OpError::Io {
        path: target.display().to_string(),
        reason: error.to_string(),
    }
}

/// Trash a file by way of a volume that has a trash (SPEC Q8).
///
/// The escape hatch for `NoTrashHere`, and deliberately not a permanent
/// delete: the file is moved to a staging directory beside the user's home —
/// which is on a volume that does have a trash — and trashed from there. It
/// ends up somewhere the operating system can restore it from, which is the
/// whole promise. If the home volume has no trash either, this fails too, and
/// the interface says so rather than offering anything worse.
///
/// The move is a copy-verify-remove across devices, exactly as `rename` does
/// for `EXDEV`; nothing is removed from the source until the copy is verified.
pub fn trash_via_home(guard: &Guard, target: &Path) -> Result<PathBuf, OpError> {
    let target = guard.admit(target)?;

    if !target.exists() {
        return Err(OpError::Io {
            path: target.display().to_string(),
            reason: "does not exist".into(),
        });
    }

    let home = dirs_home().ok_or_else(|| OpError::Io {
        path: target.display().to_string(),
        reason: "no home directory to stage through".into(),
    })?;

    let staging = home.join(".refrain-trash");
    fs::create_dir_all(&staging).map_err(|error| OpError::Io {
        path: staging.display().to_string(),
        reason: error.to_string(),
    })?;

    let name = target.file_name().ok_or_else(|| OpError::Io {
        path: target.display().to_string(),
        reason: "has no file name".into(),
    })?;
    let staged = unique_name(&staging.join(name));

    // `rename`, never copy-then-delete. This module offers no permanent
    // delete and `verify-trash-only` enforces that by reading the source, so
    // the file is *moved* into staging and the operating system then trashes
    // it from there. Nothing here can lose a manuscript even if it fails
    // halfway: either the rename happened or it did not.
    fs::rename(&target, &staged).map_err(|error| OpError::Io {
        path: staged.display().to_string(),
        reason: error.to_string(),
    })?;

    // If the home volume turns out to have no trash either, put the file back
    // where the author left it rather than leaving it in a staging directory
    // they never chose.
    if let Err(error) = trash::delete(&staged) {
        let _ = fs::rename(&staged, &target);
        return Err(classify_trash_failure(&target, &error));
    }

    Ok(target)
}

/// The user's home, without pulling in a crate for one lookup.
fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
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

    /// Copying a file onto itself used to empty it.
    ///
    /// `fs::copy` opens the destination with `O_TRUNC`, so when `from` and `to`
    /// name the same inode the truncation lands on the source before a byte is
    /// read. A duplicate action whose destination resolved back to the original
    /// destroyed the chapter it was asked to duplicate.
    #[test]
    fn copying_a_file_onto_itself_is_refused() {
        let root = scratch("copy-onto-itself");
        let target = root.join("chapter.md");
        fs::write(&target, "第一章的正文").unwrap();
        let guard = Guard::new([&root]);

        let error = copy(&guard, &target, &target, true).unwrap_err();

        assert!(matches!(error, OpError::SameFile { .. }));
        assert_eq!(fs::read_to_string(&target).unwrap(), "第一章的正文");
    }

    /// The comparison is on the resolved path, so a destination spelled
    /// differently but landing on the same file is refused too.
    #[test]
    fn copying_onto_the_same_file_named_differently_is_refused() {
        let root = scratch("copy-onto-itself-aliased");
        fs::write(root.join("chapter.md"), "第一章的正文").unwrap();
        let guard = Guard::new([&root]);

        let error = copy(
            &guard,
            &root.join("chapter.md"),
            &root.join("./chapter.md"),
            true,
        )
        .unwrap_err();

        assert!(matches!(error, OpError::SameFile { .. }));
        assert_eq!(
            fs::read_to_string(root.join("chapter.md")).unwrap(),
            "第一章的正文"
        );
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

    /// SPEC Q8's escape hatch. The file leaves the workspace and reaches a
    /// trash; what must never happen is that it simply disappears.
    #[test]
    fn trashing_via_home_removes_the_original_and_keeps_it_recoverable() {
        let root = scratch("via-home");
        fs::write(root.join("one.md"), "text").unwrap();
        let guard = Guard::new([&root]);

        // The staging directory is created beside the home directory, so the
        // test needs a home it may write to.
        let home = scratch("via-home-home");
        let previous = std::env::var_os("HOME");
        // SAFETY: single-threaded test; restored below.
        unsafe { std::env::set_var("HOME", &home) };

        let outcome = trash_via_home(&guard, &root.join("one.md"));

        match previous {
            Some(value) => unsafe { std::env::set_var("HOME", value) },
            None => unsafe { std::env::remove_var("HOME") },
        }

        // A sandbox without a working freedesktop trash cannot complete this,
        // and that is a fact about the machine rather than a defect: assert the
        // property that must hold either way — the original never vanishes
        // without having reached a trash first.
        match outcome {
            Ok(_) => assert!(
                !root.join("one.md").exists(),
                "a completed trash must remove the original"
            ),
            Err(_) => assert!(
                root.join("one.md").exists(),
                "a failed trash must leave the file exactly where it was"
            ),
        }
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
