// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! Atomic file replacement: a partial destination is never exposed.
//!
//! Ported behaviour (legacy `atomic-file.ts`, owned here since C3):
//!
//! - The temporary file lives beside the target so rename stays on one
//!   filesystem. Its name is `{target}.writing`.
//! - Before a new write opens, residue of an interrupted write is recovered:
//!   a residue byte-identical to the canonical target is redundant and removed;
//!   a divergent residue is preserved beside the target under a timestamped
//!   second name and its path returned as evidence.
//! - Preservation links a second name before unlinking the first, so a crash
//!   on either side of the unlink leaves at least one durable name for the
//!   candidate rather than a copy gap that could lose both.
//! - Every fsync uses a handle opened for writing: Windows refuses
//!   `FlushFileBuffers` on a read-only descriptor, and Unix tolerance of that
//!   mistake is exactly why it once shipped to the release platform unseen.
//! - An owner marker (`{target}.writing.refrain-owner`) distinguishes our
//!   residue from a foreign file that merely shares the suffix.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Observable crash boundaries, in reach order. Tests stop the writer at each
/// one and assert the old-or-new guarantee still holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Checkpoint {
    RecoveryLinked,
    RecoveryDirectorySynced,
    RecoveryUnlinked,
    Written,
    FileSynced,
    Renamed,
    DirectorySynced,
}

/// What a replacement left behind worth reporting.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AtomicOutcome {
    /// A divergent interrupted candidate preserved before the write proceeded.
    pub recovery_evidence: Option<PathBuf>,
}

/// The write failed after a divergent residue was preserved; the evidence
/// path travels with the error because some writers have no other channel.
#[derive(Debug)]
pub struct AtomicWriteFailure {
    pub source: io::Error,
    pub recovery_evidence: PathBuf,
}

impl std::fmt::Display for AtomicWriteFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}; interrupted-write evidence is preserved at {}",
            self.source,
            self.recovery_evidence.display()
        )
    }
}

impl std::error::Error for AtomicWriteFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

const OWNER: &[u8] = b"refrain-atomic-write-v1\n";

fn temporary_path(path: &Path) -> PathBuf {
    with_suffix(path, ".writing")
}

fn marker_path(path: &Path) -> PathBuf {
    with_suffix(path, ".writing.refrain-owner")
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Whether the residue beside `path` carries our owner marker.
pub fn owns_interrupted_write(path: &Path) -> bool {
    fs::read(marker_path(path)).is_ok_and(|bytes| bytes == OWNER)
}

/// Directory durability is a Unix concern; Windows has no user-space directory
/// handle to flush, and the legacy writer already treated this as a no-op there.
fn sync_directory(_path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    std::fs::File::open(_path)?.sync_all()?;
    Ok(())
}

/// Windows refuses to flush a handle without write access, so even a file that
/// will never be written again is opened read-write for its own fsync.
fn sync_file(path: &Path) -> io::Result<()> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?
        .sync_all()
}

fn remove_marker(path: &Path, parent: &Path) -> io::Result<()> {
    let marker = marker_path(path);
    if marker.try_exists()? {
        fs::remove_file(&marker)?;
        sync_directory(parent)?;
    }
    Ok(())
}

fn mark_temporary(path: &Path, parent: &Path) -> io::Result<()> {
    fs::write(marker_path(path), OWNER)?;
    sync_file(&marker_path(path))?;
    sync_directory(parent)
}

/// Give a divergent candidate a durable second name before removing the first.
fn preserve_temporary(
    temporary: &Path,
    parent: &Path,
    observer: &mut dyn FnMut(Checkpoint) -> io::Result<()>,
) -> io::Result<PathBuf> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis());
    for sequence in 0_u32.. {
        let evidence = with_suffix(temporary, &format!(".{millis}.{sequence}"));
        match fs::hard_link(temporary, &evidence) {
            Ok(()) => {
                let result = (|| {
                    observer(Checkpoint::RecoveryLinked)?;
                    sync_file(&evidence)?;
                    sync_directory(parent)?;
                    observer(Checkpoint::RecoveryDirectorySynced)?;
                    fs::remove_file(temporary)?;
                    observer(Checkpoint::RecoveryUnlinked)?;
                    sync_directory(parent)
                })();
                return match result {
                    Ok(()) => Ok(evidence),
                    Err(source) => Err(io::Error::other(AtomicWriteFailure {
                        recovery_evidence: evidence,
                        source,
                    })),
                };
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    unreachable!("the sequence counter is unbounded")
}

fn recover_temporary(
    path: &Path,
    temporary: &Path,
    parent: &Path,
    observer: &mut dyn FnMut(Checkpoint) -> io::Result<()>,
) -> io::Result<Option<PathBuf>> {
    if !temporary.try_exists()? {
        return Ok(None);
    }
    if path.try_exists()? && fs::read(temporary)? == fs::read(path)? {
        fs::remove_file(temporary)?;
        sync_directory(parent)?;
        return Ok(None);
    }
    preserve_temporary(temporary, parent, observer).map(Some)
}

/// Resolve the residue of one interrupted replacement without starting a new
/// write. Startup runs this before any writer can hide the evidence by
/// opening the same target again.
pub fn recover_interrupted_write(path: &Path) -> io::Result<AtomicOutcome> {
    recover_interrupted_write_observed(path, |_| Ok(()))
}

/// The same recovery with crash boundaries exposed, for boundary tests.
pub fn recover_interrupted_write_observed(
    path: &Path,
    mut observer: impl FnMut(Checkpoint) -> io::Result<()>,
) -> io::Result<AtomicOutcome> {
    let parent = path.parent().unwrap_or(Path::new("."));
    let evidence = recover_temporary(path, &temporary_path(path), parent, &mut observer)?;
    remove_marker(path, parent)?;
    Ok(AtomicOutcome {
        recovery_evidence: evidence,
    })
}

/// Replace `path` without ever exposing a partial destination.
pub fn replace_file_atomically(
    path: &Path,
    content: &[u8],
    observer: impl FnMut(Checkpoint) -> io::Result<()>,
) -> io::Result<AtomicOutcome> {
    replace_atomically(path, content, observer, false)
}

/// State files have no user-facing return channel for recovery evidence, so a
/// divergent residue stops the write instead of being silently superseded.
/// The failure carries the evidence path; a retry writes normally.
pub fn replace_state_file_atomically(path: &Path, content: &[u8]) -> io::Result<AtomicOutcome> {
    replace_atomically(path, content, |_| Ok(()), true)
}

fn replace_atomically(
    path: &Path,
    content: &[u8],
    mut observer: impl FnMut(Checkpoint) -> io::Result<()>,
    stop_after_recovery: bool,
) -> io::Result<AtomicOutcome> {
    let parent = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    let temporary = temporary_path(path);

    let recovery_evidence = recover_temporary(path, &temporary, parent, &mut observer)?;
    if stop_after_recovery && let Some(evidence) = &recovery_evidence {
        return Err(io::Error::other(AtomicWriteFailure {
            source: io::Error::other(
                "state write stopped after recovering an interrupted candidate",
            ),
            recovery_evidence: evidence.clone(),
        }));
    }
    remove_marker(path, parent)?;
    mark_temporary(path, parent)?;

    let write_result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            let mode = fs::metadata(path).map_or(0o666, |meta| meta.permissions().mode());
            options.mode(mode);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(content)?;
        observer(Checkpoint::Written)?;
        file.sync_all()?;
        observer(Checkpoint::FileSynced)?;
        drop(file);

        fs::rename(&temporary, path)?;
        observer(Checkpoint::Renamed)?;
        sync_directory(parent)?;
        observer(Checkpoint::DirectorySynced)?;
        remove_marker(path, parent)
    })();

    match write_result {
        Ok(()) => Ok(AtomicOutcome { recovery_evidence }),
        Err(source) => match recovery_evidence {
            Some(evidence) => Err(io::Error::other(AtomicWriteFailure {
                recovery_evidence: evidence,
                source,
            })),
            None => Err(source),
        },
    }
}
