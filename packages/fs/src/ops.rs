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
use std::io::{self, Read};
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
        // Only a cross-device rename earns the fallback. `Err(_)` used to catch
        // everything — a full disk, a permission failure, a vanished parent —
        // and answer it by copying and then trashing the source, so a failure
        // that had changed nothing became a move that put the manuscript
        // somewhere else. ErrorKind::CrossesDevices is the one case a copy can
        // actually stand in for.
        Err(error) if error.kind() != io::ErrorKind::CrossesDevices => Err(io(&from, error)),
        Err(_) => {
            copy_tree(&from, &to)?;
            // The comment here used to claim the copy was verified. It was not.
            // A truncated copy followed by a trashed source is the one outcome
            // this crate exists to prevent, so the claim is now a check: sizes
            // must agree before anything is removed, and when they do not the
            // source stays and the destination is left as evidence.
            verify_copy(&from, &to)?;
            trash::delete(&from).map_err(|error| classify_trash_failure(&from, &error))?;
            Ok(Done { from, to })
        }
    }
}

/// Compare every copied byte before the source can leave the workspace.
///
/// Size alone cannot distinguish a same-length corrupt copy. This path is paid
/// only for an explicit cross-volume move, where reading the bytes a second time
/// is cheaper than discovering that the recoverable copy was not the manuscript.
fn verify_copy(from: &Path, to: &Path) -> Result<(), OpError> {
    let source_metadata = fs::symlink_metadata(from).map_err(|error| io(from, error))?;
    if source_metadata.file_type().is_symlink() {
        let copied_metadata = fs::symlink_metadata(to).map_err(|error| io(to, error))?;
        let same_link = copied_metadata.file_type().is_symlink()
            && fs::read_link(from).map_err(|error| io(from, error))?
                == fs::read_link(to).map_err(|error| io(to, error))?;
        if !same_link {
            return Err(OpError::Io {
                path: to.display().to_string(),
                reason: "copy does not preserve the original symbolic link".into(),
            });
        }
        return Ok(());
    }

    if source_metadata.is_dir() {
        let source_entries = fs::read_dir(from)
            .map_err(|error| io(from, error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| io(from, error))?;
        let copied_count = fs::read_dir(to)
            .map_err(|error| io(to, error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| io(to, error))?
            .len();
        if source_entries.len() != copied_count {
            return Err(OpError::Io {
                path: to.display().to_string(),
                reason: "copy has a different set of directory entries; the original is untouched"
                    .into(),
            });
        }
        for entry in source_entries {
            verify_copy(&entry.path(), &to.join(entry.file_name()))?;
        }
        return Ok(());
    }

    let mut source = fs::File::open(from).map_err(|error| io(from, error))?;
    let mut copied = fs::File::open(to).map_err(|error| io(to, error))?;
    let mut source_bytes = [0_u8; 64 * 1024];
    let mut copied_bytes = [0_u8; 64 * 1024];
    loop {
        let count = source
            .read(&mut source_bytes)
            .map_err(|error| io(from, error))?;
        if count == 0 {
            if copied
                .read(&mut copied_bytes[..1])
                .map_err(|error| io(to, error))?
                == 0
            {
                return Ok(());
            }
            break;
        }
        if copied.read_exact(&mut copied_bytes[..count]).is_err()
            || source_bytes[..count] != copied_bytes[..count]
        {
            break;
        }
    }
    Err(OpError::Io {
        path: to.display().to_string(),
        reason: "copy differs from the original; the original is untouched".into(),
    })
}

/// Remove the source of a cross-volume move after its verified copy has reached
/// system trash. This is private and intentionally has one caller; exposing it
/// would create the permanent-delete variant the file layer forbids.
fn remove_after_recovery(path: &Path) -> Result<(), OpError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| io(path, error))?;
    let result = if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    result.map_err(|error| io(path, error))
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
    let metadata = fs::symlink_metadata(from).map_err(|error| io(from, error))?;
    if metadata.file_type().is_symlink() {
        return copy_symlink(from, to);
    }

    if metadata.is_dir() {
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
    let mut source = fs::File::open(from).map_err(|error| io(from, error))?;
    let mut copied = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(to)
        .map_err(|error| io(to, error))?;
    io::copy(&mut source, &mut copied).map_err(|error| io(to, error))?;
    copied.sync_all().map_err(|error| io(to, error))?;
    fs::set_permissions(to, metadata.permissions()).map_err(|error| io(to, error))?;
    Ok(())
}

fn copy_symlink(from: &Path, to: &Path) -> Result<(), OpError> {
    let target = fs::read_link(from).map_err(|error| io(from, error))?;
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|error| io(parent, error))?;
    }

    #[cfg(unix)]
    return std::os::unix::fs::symlink(target, to).map_err(|error| io(to, error));

    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;

        let file_type = fs::symlink_metadata(from)
            .map_err(|error| io(from, error))?
            .file_type();
        if file_type.is_symlink_dir() {
            return std::os::windows::fs::symlink_dir(target, to).map_err(|error| io(to, error));
        }
        return std::os::windows::fs::symlink_file(target, to).map_err(|error| io(to, error));
    }

    #[cfg(not(any(unix, windows)))]
    Err(OpError::Io {
        path: to.display().to_string(),
        reason: "copying symbolic links is not supported on this platform".into(),
    })
}

/// Delete to the system trash.
///
/// The only delete this crate offers. There is deliberately no permanent
/// variant: a caller that wants one has to go around this module, which makes
/// the decision visible in review.
pub fn trash(guard: &Guard, target: &Path) -> Result<PathBuf, OpError> {
    // Literal, not resolved. `admit` still answers every safety question
    // against the resolved path, but deleting a symlink means deleting the
    // link — handing the resolved path to the operating system turned "remove
    // this shortcut" into "remove the chapter it points at".
    let target = guard.admit_literal(target)?;

    if fs::symlink_metadata(&target).is_err() {
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
///
/// This used to read `error.to_string().to_lowercase()` and look for
/// "read-only", "permission", "could not create". Those are English strings.
/// On a Chinese or Japanese Windows the same failure produced the same words
/// in another language, every `contains` missed, and the one refusal the
/// interface knows how to act on was reported as an ordinary I/O error — so
/// the author was offered nothing instead of "move it to the system trash".
/// The crate's error is an enum carrying an `io::Error` and an OS code; both
/// mean the same thing in every locale.
fn classify_trash_failure(target: &Path, error: &trash::Error) -> OpError {
    let volume_has_none = match error {
        #[cfg(all(
            unix,
            not(target_os = "macos"),
            not(target_os = "ios"),
            not(target_os = "android")
        ))]
        trash::Error::FileSystem { source, .. } => matches!(
            source.kind(),
            io::ErrorKind::PermissionDenied
                | io::ErrorKind::ReadOnlyFilesystem
                | io::ErrorKind::NotFound
        ),
        // EROFS 30, EACCES 13, EPERM 1 — the three ways a volume says the trash
        // directory cannot be created. Numeric on every platform and locale.
        trash::Error::Os { code, .. } => matches!(code, 1 | 13 | 30),
        _ => false,
    };

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
    let home = dirs_home().ok_or_else(|| OpError::Io {
        path: target.display().to_string(),
        reason: "no home directory to stage through".into(),
    })?;
    trash_via_home_at(guard, target, &home, |staged| {
        trash::delete(staged).map_err(|error| classify_trash_failure(staged, &error))
    })
}

/// The body of `trash_via_home`, with the staging volume and the system trash
/// supplied by the caller.
///
/// A sandbox has no working trash, so the one property that matters here — the
/// staged entry is the selected directory entry, never its referent — could
/// only be asserted against the host's real trash, which is to say not at all.
fn trash_via_home_at(
    guard: &Guard,
    target: &Path,
    home: &Path,
    send_to_trash: impl Fn(&Path) -> Result<(), OpError>,
) -> Result<PathBuf, OpError> {
    // Literal, for the same reason `trash` is: staging a shortcut must stage
    // the shortcut. Resolving here would move the chapter the link points at.
    let target = guard.admit_literal(target)?;

    if fs::symlink_metadata(&target).is_err() {
        return Err(OpError::Io {
            path: target.display().to_string(),
            reason: "does not exist".into(),
        });
    }

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

    // Crossing devices cannot be one atomic rename. Copy and compare every byte,
    // put that verified copy in the selected system trash, and only then remove
    // the original directory entry. At every failure point at least one complete
    // recoverable copy remains.
    if let Err(error) = fs::rename(&target, &staged) {
        if error.kind() != io::ErrorKind::CrossesDevices {
            return Err(io(&staged, error));
        }
        copy_tree(&target, &staged)?;
        verify_copy(&target, &staged)?;
        send_to_trash(&staged)?;
        remove_after_recovery(&target)?;
        return Ok(target);
    }

    // If the home volume turns out to have no trash either, put the file back
    // where the author left it rather than leaving it in a staging directory
    // they never chose.
    if let Err(error) = send_to_trash(&staged) {
        let _ = fs::rename(&staged, &target);
        return Err(error);
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

    /// The trash classification must not depend on the language of the error.
    ///
    /// It used to match English substrings — "read-only", "permission",
    /// "could not create". On a Chinese or Japanese Windows the same failure
    /// arrives with the same meaning in another language, every match missed,
    /// and "this volume has no trash" was reported as an ordinary I/O error.
    /// The interface keys its one useful offer off that distinction, so the
    /// author was left with nothing to do.
    #[test]
    fn the_trash_classification_reads_codes_rather_than_english() {
        let target = Path::new("/tmp/refrain-classify/01.md");

        // EROFS, EACCES, EPERM: the three ways a volume says the trash
        // directory cannot be created.
        for code in [1, 13, 30] {
            let error = trash::Error::Os {
                code,
                description: "ここには削除できません".into(),
            };
            assert!(
                matches!(
                    classify_trash_failure(target, &error),
                    OpError::NoTrashHere { .. }
                ),
                "os code {code} should read as a volume without a trash"
            );
        }

        // A different code is somebody else's problem and must stay an I/O
        // error, or the interface offers a workaround that cannot help.
        let unrelated = trash::Error::Os {
            code: 28,
            description: "no matter what this says".into(),
        };
        assert!(matches!(
            classify_trash_failure(target, &unrelated),
            OpError::Io { .. }
        ));

        // The English text that used to drive the decision now decides nothing.
        let english = trash::Error::Unknown {
            description: "could not create trash directory: read-only file system".into(),
        };
        assert!(
            matches!(classify_trash_failure(target, &english), OpError::Io { .. }),
            "prose must not classify, in any language"
        );
    }

    /// A rename that failed for a reason a copy cannot fix must not become one.
    ///
    /// The fallback used to hang off `Err(_)`: a full disk, a permission
    /// failure, a vanished parent — every one of them answered by copying and
    /// then trashing the source. A failure that had changed nothing became a
    /// move that put the manuscript somewhere the author had not asked for.
    ///
    /// The first version of this test pointed the destination at a path whose
    /// parent was a file. That proved nothing: `copy_tree` fails there too, so
    /// both branches returned `Io` and the assertion could not tell them
    /// apart — it passed with the guard deleted. The destination here is one a
    /// copy would happily succeed at, so the only way the source survives is
    /// the guard refusing before the fallback runs.
    #[test]
    fn a_move_that_fails_for_another_reason_leaves_the_source_alone() {
        let root = scratch("move-not-exdev");
        let from = root.join("01.md");
        fs::write(&from, "第一章").unwrap();

        // Make the source unreadable *after* the destination is known good.
        // `rename` fails with PermissionDenied on a locked parent, while a copy
        // to `moved.md` would otherwise be trivially possible.
        let locked = root.join("locked");
        fs::create_dir(&locked).unwrap();
        let inner = locked.join("01.md");
        fs::write(&inner, "第一章").unwrap();
        let mut perms = fs::metadata(&locked).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&locked, perms).unwrap();

        let guard = Guard::new([&root]);
        let outcome = move_to(&guard, &inner, &root.join("moved.md"), false);

        let mut perms = fs::metadata(&locked).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        fs::set_permissions(&locked, perms).unwrap();

        assert!(outcome.is_err(), "a locked parent cannot be renamed out of");
        assert!(
            inner.exists(),
            "the source must survive a failure that changed nothing"
        );
        assert!(
            !root.join("moved.md").exists(),
            "no copy may be left behind by a rename that was refused"
        );
    }

    /// The claim "the copy is verified" is now a check rather than a comment.
    ///
    /// `verify_copy` is what stands between a short write and a trashed
    /// original. Testing it directly is the honest thing available here: this
    /// sandbox has one volume, so the CrossesDevices path it guards cannot be
    /// reached from a real rename. That gap is the reason this test exists at
    /// the function rather than at `move_to`.
    #[test]
    fn a_copy_that_came_up_short_refuses_before_anything_is_removed() {
        let root = scratch("verify-copy");
        let from = root.join("01.md");
        let to = root.join("copy.md");
        fs::write(&from, "第一章的全文").unwrap();
        fs::write(&to, "第一章").unwrap();

        let error = verify_copy(&from, &to).unwrap_err();

        assert!(matches!(error, OpError::Io { .. }));
        assert!(from.exists(), "the original stays when the copy is short");

        let source_len = fs::metadata(&from).unwrap().len() as usize;
        fs::write(&to, vec![b'x'; source_len]).unwrap();
        assert!(
            verify_copy(&from, &to).is_err(),
            "same-length corruption must not pass byte verification"
        );
        assert!(from.exists(), "the original stays when copied bytes differ");

        fs::copy(&from, &to).unwrap();
        assert!(verify_copy(&from, &to).is_ok(), "a full copy verifies");
    }

    /// The via-home fallback crosses volumes, where rename cannot carry a link.
    /// Its copy must preserve the selected directory entry, not dereference it.
    #[cfg(unix)]
    #[test]
    fn a_cross_device_copy_preserves_a_symlink_entry() {
        let root = scratch("copy-symlink-entry");
        let chapter = root.join("03.md");
        fs::write(&chapter, "第三章").unwrap();
        let link = root.join("近道.md");
        std::os::unix::fs::symlink(&chapter, &link).unwrap();
        let staged = root.join("staged-link");

        copy_tree(&link, &staged).unwrap();
        verify_copy(&link, &staged).unwrap();

        assert!(fs::symlink_metadata(&staged)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_link(&staged).unwrap(), chapter);
    }

    /// Trashing a symlink must remove the link, not what it points at.
    ///
    /// `admit` resolves, and `trash` handed the resolved path to the operating
    /// system — so removing a shortcut to chapter three deleted chapter three.
    /// The file browser lists symlinks as entries of their own, which is how an
    /// author reaches this in one click.
    ///
    /// **This test cannot prove the fix on a volume without a trash.** `/tmp`
    /// here has none, so `trash::delete` refuses before it would remove
    /// anything, and the assertion below passes under both the fixed and the
    /// broken code. Injecting the old `admit` leaves it green — recorded here
    /// rather than left for the next reader to discover. What it does pin is
    /// the half that is checkable anywhere: `trash` must reach the delete with
    /// the link, and `symlink_metadata` rather than `exists` is what lets a
    /// broken link be removed at all.
    ///
    /// The real proof is `guard.admit_literal` returning the written path,
    /// which is asserted directly in guard.rs.
    #[cfg(unix)]
    #[test]
    fn trashing_a_symlink_keeps_what_it_points_at() {
        let root = scratch("trash-symlink");
        let chapter = root.join("03.md");
        fs::write(&chapter, "第三章的正文").unwrap();

        let link = root.join("近道.md");
        std::os::unix::fs::symlink(&chapter, &link).unwrap();

        let guard = Guard::new([&root]);
        let outcome = trash(&guard, &link);

        assert!(
            chapter.exists(),
            "the chapter the link pointed at must survive"
        );
        assert_eq!(fs::read_to_string(&chapter).unwrap(), "第三章的正文");

        match outcome {
            Ok(_) => assert!(
                fs::symlink_metadata(&link).is_err(),
                "the link itself is what goes to the trash"
            ),
            Err(OpError::NoTrashHere { .. }) => assert!(
                fs::symlink_metadata(&link).is_ok(),
                "a refused delete leaves the link in place"
            ),
            Err(other) => panic!("unexpected refusal: {other:?}"),
        }
    }

    /// A dangling symlink is still an entry the author can select and delete.
    ///
    /// `exists()` follows the link, so a link whose target had been moved away
    /// reported "does not exist" and could not be removed — the file browser
    /// listed it and nothing could clear it. `symlink_metadata` asks about the
    /// link itself.
    #[cfg(unix)]
    #[test]
    fn a_dangling_symlink_can_still_be_reached() {
        let root = scratch("trash-dangling");
        let gone = root.join("moved-away.md");
        fs::write(&gone, "x").unwrap();
        let link = root.join("近道.md");
        std::os::unix::fs::symlink(&gone, &link).unwrap();
        fs::remove_file(&gone).unwrap();

        let guard = Guard::new([&root]);

        // Whatever the volume answers, it must not be "does not exist".
        match trash(&guard, &link) {
            Ok(_) => {}
            Err(OpError::NoTrashHere { .. }) => {}
            Err(OpError::Io { reason, .. }) => {
                assert_ne!(reason, "does not exist", "a dangling link is still there")
            }
            Err(other) => panic!("unexpected refusal: {other:?}"),
        }
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

    /// Exercise the via-home path without asking the host for a working trash.
    /// The injected trash is a rename, so the selected entry stays recoverable.
    #[cfg(unix)]
    #[test]
    fn trashing_a_symlink_via_home_stages_the_link_not_its_referent() {
        let root = scratch("via-home-symlink");
        let chapter = root.join("03.md");
        fs::write(&chapter, "第三章的正文").unwrap();
        let link = root.join("近道.md");
        std::os::unix::fs::symlink(&chapter, &link).unwrap();
        let home = scratch("via-home-symlink-home");
        let fake_trash = home.join("recoverable-link");
        let guard = Guard::new([&root]);

        trash_via_home_at(&guard, &link, &home, |staged| {
            assert!(
                fs::symlink_metadata(staged)
                    .unwrap()
                    .file_type()
                    .is_symlink(),
                "the via-home staging entry must still be the selected link"
            );
            fs::rename(staged, &fake_trash).unwrap();
            Ok(())
        })
        .unwrap();

        assert!(fs::symlink_metadata(&link).is_err());
        assert!(fs::symlink_metadata(&fake_trash)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&chapter).unwrap(), "第三章的正文");
    }

    /// The via-home fallback exists to cross volumes. Exercise a real EXDEV
    /// boundary instead of only checking the same-volume rename path.
    #[cfg(target_os = "linux")]
    #[test]
    fn trashing_via_home_crosses_a_real_volume_and_keeps_a_recoverable_copy() {
        use std::cell::Cell;
        use std::os::unix::fs::MetadataExt;

        let root = PathBuf::from("/dev/shm").join(format!(
            "refrain-fs-via-home-cross-device-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir(&root).unwrap();
        let target = root.join("one.md");
        fs::write(&target, "跨卷正文").unwrap();
        let mut permissions = fs::metadata(&target).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&target, permissions).unwrap();
        let home = scratch("via-home-cross-device-home");
        assert_ne!(
            fs::metadata(&root).unwrap().dev(),
            fs::metadata(&home).unwrap().dev(),
            "the test must exercise a real cross-device boundary"
        );
        let fake_trash = home.join("recoverable.md");
        let called = Cell::new(false);
        let guard = Guard::new([&root]);

        let outcome = trash_via_home_at(&guard, &target, &home, |staged| {
            called.set(true);
            fs::rename(staged, &fake_trash).map_err(|error| io(staged, error))?;
            Ok(())
        });

        assert!(outcome.is_ok(), "cross-device via-home trash: {outcome:?}");
        assert!(
            called.get(),
            "the staged copy must reach the selected trash"
        );
        assert!(
            !target.exists(),
            "only a recoverable copy may let the source leave"
        );
        assert_eq!(fs::read_to_string(&fake_trash).unwrap(), "跨卷正文");
        fs::remove_dir_all(root).unwrap();
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
