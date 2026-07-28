//! Root layout, the Source Backup, and the path guards every manuscript write
//! passes through.
//!
//! Ported behaviour (legacy `root-storage.ts`, `source-backup.ts`, and the
//! guard half of `project.ts`, owned here since C3):
//!
//! - A folder Root keeps mutable state in `.refrain` and its immutable
//!   original in `.refrain-source`. A single-file Root keeps both in an
//!   adjacent `.<name>.refrain` companion it must own — an unowned directory
//!   or a symlink is refused, never adopted (Q22).
//! - The Source Backup is taken once, when a Root is first adopted, and never
//!   again: a second copy would record the application's own edits as if they
//!   were the author's. The manifest is written last, so an interrupted copy
//!   leaves no manifest and the next open retries rather than trusting a
//!   partial original.
//! - No write path leads into the Source Backup, even when it is opened
//!   directly as a project or reached through a symlink (INV-4).

use refrain_core::{DocumentRole, ErrorCode, RefrainError};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

/// Markdown is what this application edits, so Markdown is what it preserves.
const MARKDOWN_EXTENSIONS: [&str; 4] = ["md", "markdown", "mdown", "txt"];

/// The one directory name every layer recognises as the immutable original.
pub const SOURCE_BACKUP_DIR: &str = ".refrain-source";
const STATE_DIR: &str = ".refrain";
const COMPANION_LAYOUT_FILE: &str = "root.json";
const COMPANION_SIGNATURE: &str = r#"{
  "layout": "refrain-file-root",
  "version": 1
}
"#;

/// What a Root is: a folder whose Markdown was adopted, or a single file
/// opened on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootKind {
    Folder,
    File,
}

impl RootKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Folder => "folder",
            Self::File => "file",
        }
    }

    #[must_use]
    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "folder" => Some(Self::Folder),
            "file" => Some(Self::File),
            _ => None,
        }
    }
}

/// Where a Root's two authorities live. Nothing outside these two directories
/// is RefRain's to write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootLayout {
    /// State RefRain may rewrite.
    pub state_dir: PathBuf,
    /// The immutable original, outside every ordinary state writer.
    pub source_backup_dir: PathBuf,
    /// Present only for a single-file Root.
    pub companion_dir: Option<PathBuf>,
}

#[must_use]
pub fn layout_for(root: &Path, kind: RootKind) -> RootLayout {
    match kind {
        RootKind::Folder => RootLayout {
            state_dir: root.join(STATE_DIR),
            source_backup_dir: root.join(SOURCE_BACKUP_DIR),
            companion_dir: None,
        },
        RootKind::File => {
            let name = root.file_name().unwrap_or_default();
            let companion = root
                .parent()
                .unwrap_or(Path::new("."))
                .join(format!(".{}.refrain", name.to_string_lossy()));
            RootLayout {
                state_dir: companion.join(STATE_DIR),
                source_backup_dir: companion.join(SOURCE_BACKUP_DIR),
                companion_dir: Some(companion),
            }
        }
    }
}

/// Claim or verify a single-file companion before any writer enters it. An
/// existing ordinary directory or symlink is not ours; refusing it avoids
/// turning a name collision into writes outside the Root's authority.
pub fn claim_root_storage(layout: &RootLayout) -> io::Result<()> {
    let Some(companion) = &layout.companion_dir else {
        return Ok(());
    };
    let marker = companion.join(COMPANION_LAYOUT_FILE);
    if !companion.try_exists()? {
        fs::create_dir(companion)?;
        fs::write(&marker, COMPANION_SIGNATURE)?;
        return Ok(());
    }
    if fs::symlink_metadata(companion)?.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "single-file Root companion is a symlink: {}",
                companion.display()
            ),
        ));
    }
    let found = fs::read_to_string(&marker).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "single-file Root companion is not owned by RefRain: {}",
                companion.display()
            ),
        )
    })?;
    if found.trim() != COMPANION_SIGNATURE.trim() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "single-file Root companion is not owned by RefRain: {}",
                companion.display()
            ),
        ));
    }
    Ok(())
}

/// The outcome of a Source Backup attempt. `Refused` carries a reason in the
/// author's terms; by Q23 it never locks the Root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackupOutcome {
    Taken { files: u32 },
    AlreadyPresent,
    NothingToCopy,
    Refused { reason: String },
}

const BACKUP_MANIFEST: &str = "taken.json";
const EMPTY_ADOPTION_FILE: &str = "source-backup.json";

#[must_use]
pub fn is_markdown_name(name: &str) -> bool {
    Path::new(name).extension().is_some_and(|extension| {
        MARKDOWN_EXTENSIONS
            .iter()
            .any(|known| extension.eq_ignore_ascii_case(known))
    })
}

/// Markdown files under a directory, skipping every dot-entry — most
/// importantly the application's own state and the backup itself, which the
/// backup must never copy into itself.
fn manuscripts_under(dir: &Path, into: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            manuscripts_under(&path, into)?;
        } else if entry.file_type()?.is_file() && is_markdown_name(&name.to_string_lossy()) {
            into.push(path);
        }
    }
    Ok(())
}

/// Take the backup if this Root has never had one. The manifest is written
/// last and is what `AlreadyPresent` tests for.
pub fn take_source_backup(root: &Path, kind: RootKind, layout: &RootLayout) -> BackupOutcome {
    if let Err(error) = claim_root_storage(layout) {
        return BackupOutcome::Refused {
            reason: format!("无法建立项目存储:{error}"),
        };
    }

    let backup = &layout.source_backup_dir;
    let empty_adoption = layout.state_dir.join(EMPTY_ADOPTION_FILE);
    if backup.join(BACKUP_MANIFEST).try_exists().unwrap_or(false)
        || empty_adoption.try_exists().unwrap_or(false)
    {
        return BackupOutcome::AlreadyPresent;
    }

    let manuscripts = match kind {
        RootKind::File => vec![root.to_path_buf()],
        RootKind::Folder => {
            let mut found = Vec::new();
            match manuscripts_under(root, &mut found) {
                Ok(()) => found,
                Err(error) => {
                    return BackupOutcome::Refused {
                        reason: format!("无法读取项目内容:{error}"),
                    };
                }
            }
        }
    };

    if manuscripts.is_empty() {
        let staged = empty_adoption.with_extension("writing");
        let record = || -> io::Result<()> {
            if let Some(parent) = empty_adoption.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&staged, b"{ \"source\": \"nothing-to-copy\" }\n")?;
            fs::rename(&staged, &empty_adoption)
        };
        return match record() {
            Ok(()) => BackupOutcome::NothingToCopy,
            Err(error) => BackupOutcome::Refused {
                reason: format!("无法记录项目初始状态:{error}"),
            },
        };
    }

    let copy = || -> io::Result<u32> {
        fs::create_dir_all(backup)?;
        for source in &manuscripts {
            let relative = match kind {
                RootKind::File => source.file_name().unwrap_or_default().into(),
                RootKind::Folder => source.strip_prefix(root).unwrap_or(source).to_path_buf(),
            };
            let target = backup.join(relative);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(source, target)?;
        }
        let count = u32::try_from(manuscripts.len()).unwrap_or(u32::MAX);
        fs::write(
            backup.join(BACKUP_MANIFEST),
            format!("{{ \"files\": {count} }}\n"),
        )?;
        Ok(count)
    };
    match copy() {
        Ok(files) => BackupOutcome::Taken { files },
        Err(error) => BackupOutcome::Refused {
            reason: format!("无法写入原件副本:{error}"),
        },
    }
}

/// Whether any component of `path` names the Source Backup.
#[must_use]
pub fn names_source_backup(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(component, Component::Normal(name) if name.to_string_lossy().eq_ignore_ascii_case(SOURCE_BACKUP_DIR))
    })
}

/// INV-4: the Source Backup has no write path, even when opened directly or
/// reached through a symlink.
pub fn assert_mutable_path(path: &Path) -> Result<(), RefrainError> {
    let resolved_parent = path
        .parent()
        .and_then(|parent| fs::canonicalize(parent).ok());
    if names_source_backup(path) || resolved_parent.as_deref().is_some_and(names_source_backup) {
        return Err(RefrainError::new(
            ErrorCode::SourceBackup,
            "write to the Source Backup",
            path.display().to_string(),
        ));
    }
    Ok(())
}

/// Whether `candidate` sits inside `canonical_root` after both are resolved.
fn is_within(canonical_root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(canonical_root)
}

/// Resolve every existing component so a directory symlink cannot move a
/// write outside its Root.
pub fn assert_inside_root(
    canonical_root: &Path,
    kind: RootKind,
    path: &Path,
) -> Result<(), RefrainError> {
    let outside = || {
        RefrainError::new(
            ErrorCode::OutsideRoot,
            "write outside its Root",
            path.display().to_string(),
        )
    };
    if kind == RootKind::File {
        let resolved = fs::canonicalize(path).map_err(|_| outside())?;
        return if resolved == canonical_root {
            Ok(())
        } else {
            Err(outside())
        };
    }

    // The nearest existing ancestor resolves the part of the path that exists;
    // anything below it cannot yet contain a symlink.
    let mut ancestor: &Path = path.parent().unwrap_or(Path::new("."));
    while !ancestor.try_exists().unwrap_or(false) {
        match ancestor.parent() {
            Some(parent) if parent != ancestor => ancestor = parent,
            _ => break,
        }
    }
    let resolved_ancestor = fs::canonicalize(ancestor).map_err(|_| outside())?;
    if !is_within(canonical_root, &resolved_ancestor) {
        return Err(outside());
    }
    if path.try_exists().unwrap_or(false) {
        let resolved = fs::canonicalize(path).map_err(|_| outside())?;
        if !is_within(canonical_root, &resolved) {
            return Err(outside());
        }
    }
    Ok(())
}

/// Windows device names are illegal as file names regardless of extension.
const WINDOWS_DEVICE: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// One path segment of a new document title. The checks are per segment
/// because a title may be several segments (`资料/年表`): the separator is
/// structure, not an illegal character.
#[must_use]
pub fn is_legal_segment(segment: &str) -> bool {
    if segment.is_empty()
        || segment.contains('\0')
        || segment.ends_with('.')
        || segment.ends_with(' ')
    {
        return false;
    }
    if segment
        .chars()
        .any(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
    {
        return false;
    }
    let stem = segment.split('.').next().unwrap_or(segment);
    !WINDOWS_DEVICE
        .iter()
        .any(|device| stem.eq_ignore_ascii_case(device))
}

/// Where a new document goes. `..` fails `is_legal_segment` by ending in a
/// dot, which is what keeps a nested title from climbing out of the root.
pub fn path_for_new_document(
    canonical_root: &Path,
    title: &str,
    role: DocumentRole,
) -> Result<PathBuf, RefrainError> {
    let illegal = || {
        RefrainError::new(
            ErrorCode::IllegalName,
            "create a document named",
            title.to_string(),
        )
    };
    let mut relative = PathBuf::new();
    if role == DocumentRole::Material {
        relative.push("material");
    }
    for segment in title.split(['/', '\\']) {
        if !is_legal_segment(segment) {
            return Err(illegal());
        }
        relative.push(segment);
    }
    relative.set_extension("md");
    Ok(canonical_root.join(relative))
}
