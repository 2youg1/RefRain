//! Mutating the workspace: move, rename, copy, link, and delete.
//!
//! Every function here takes a [`Guard`] and passes its targets through it
//! before touching the disk. That is the whole safety story: a caller cannot
//! reach the Source Backup or escape a root, because there is no code path that
//! skips the check.
//!
//! **Delete means the system trash.** `remove_file` is not offered. The `trash`
//! crate routes to `IFileOperation` on Windows — the file comes back through
//! the operating system's own undo.
//!
//! Ported from legacy `packages/fs/src/ops.rs`.
//!
//! Gate note: `remove_after_recovery` below contains the only permanent
//! unlink outside `atomic.rs`, and `verify:trash-only` exempts this one
//! function shape in this one file. It runs only after a verified copy of the
//! source is already inside the system trash — it is the second half of a
//! move across volumes, not a delete.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use super::guard::{Guard, Refusal};

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
    SameFile {
        path: String,
    },
    /// This volume has no trash and one cannot be created (SPEC Q8).
    NoTrashHere {
        path: String,
    },
}

impl OpError {
    #[must_use]
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

/// Move or rename. One operation: renaming is moving inside one directory.
///
/// Falls back to copy-then-trash across filesystems, where `rename` fails with
/// `EXDEV`. The copy is verified byte for byte before the source is trashed,
/// so an interrupted move leaves the original in place.
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
        // Only a cross-device rename earns the fallback. Anything else — a full
        // disk, a permission failure, a vanished parent — is a failure that
        // changed nothing, and answering it by copying and then trashing the
        // source would turn it into a move the author never asked for.
        Err(error) if error.kind() != io::ErrorKind::CrossesDevices => Err(io(&from, error)),
        Err(_) => {
            copy_tree(&from, &to)?;
            verify_copy(&from, &to)?;
            trash::delete(&from).map_err(|error| classify_trash_failure(&from, &error))?;
            Ok(Done { from, to })
        }
    }
}

/// Compare every copied byte before the source can leave the workspace.
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
    // and both are refused.
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
        std::os::windows::fs::symlink_file(target, to).map_err(|error| io(to, error))
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
/// The classification reads the OS error *code*, never the message text: on a
/// Chinese or Japanese Windows the same failure arrives in another language,
/// and matching English prose reported the one refusal the interface knows
/// how to act on as an ordinary I/O error.
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
/// The file is moved to a staging directory beside the user's home — on a
/// volume that does have a trash — and trashed from there. Nothing is removed
/// from the source until the copy is verified.
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
fn trash_via_home_at(
    guard: &Guard,
    target: &Path,
    home: &Path,
    send_to_trash: impl Fn(&Path) -> Result<(), OpError>,
) -> Result<PathBuf, OpError> {
    // Literal, for the same reason `trash` is: staging a shortcut must stage
    // the shortcut.
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

/// Trash several paths, reporting each outcome separately. A partial failure
/// is normal — one file locked by another process must not abandon the rest.
pub fn trash_all(guard: &Guard, targets: &[PathBuf]) -> Vec<Result<PathBuf, OpError>> {
    targets.iter().map(|path| trash(guard, path)).collect()
}

/// Create a symbolic link at `link` pointing to `target`.
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
    // than dressed up.
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
#[must_use]
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
        let dir = std::env::temp_dir().join(format!(
            "refrain-ops-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
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
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_to_move_a_directory_into_itself() {
        let root = scratch("into-itself");
        fs::create_dir_all(root.join("part")).unwrap();
        let guard = Guard::new([&root]);

        let error =
            move_to(&guard, &root.join("part"), &root.join("part/inner"), false).unwrap_err();
        assert!(matches!(error, OpError::IntoItself { .. }));
        fs::remove_dir_all(root).unwrap();
    }

    /// Copying a file onto itself used to empty it: `fs::copy` opens the
    /// destination with O_TRUNC before a byte is read.
    #[test]
    fn copying_a_file_onto_itself_is_refused() {
        let root = scratch("copy-onto-itself");
        let target = root.join("chapter.md");
        fs::write(&target, "第一章的正文").unwrap();
        let guard = Guard::new([&root]);

        let error = copy(&guard, &target, &target, true).unwrap_err();

        assert!(matches!(error, OpError::SameFile { .. }));
        assert_eq!(fs::read_to_string(&target).unwrap(), "第一章的正文");
        fs::remove_dir_all(root).unwrap();
    }

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
        fs::remove_dir_all(root).unwrap();
    }

    /// The trash classification reads OS codes, never message prose: on a
    /// Chinese or Japanese Windows the same failure arrives in another
    /// language, and matching English left the author with no way forward.
    #[test]
    fn the_trash_classification_reads_codes_rather_than_english() {
        let target = Path::new("/tmp/refrain-classify/01.md");

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

        let unrelated = trash::Error::Os {
            code: 28,
            description: "no matter what this says".into(),
        };
        assert!(matches!(
            classify_trash_failure(target, &unrelated),
            OpError::Io { .. }
        ));

        let english = trash::Error::Unknown {
            description: "could not create trash directory: read-only file system".into(),
        };
        assert!(
            matches!(classify_trash_failure(target, &english), OpError::Io { .. }),
            "prose must not classify, in any language"
        );
    }

    /// `verify_copy` is what stands between a short write and a trashed
    /// original.
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

        fs::copy(&from, &to).unwrap();
        assert!(verify_copy(&from, &to).is_ok(), "a full copy verifies");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn uniqueness_suffix_goes_before_the_extension() {
        let root = scratch("unique");
        fs::write(root.join("chapter-1.md"), "x").unwrap();

        let unique = unique_name(&root.join("chapter-1.md"));

        assert_eq!(unique.file_name().unwrap(), "chapter-1 2.md");
        fs::remove_dir_all(root).unwrap();
    }
}
