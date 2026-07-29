//! The host-private staging directory and the Run workspaces (SPEC 8.2, 6.3).
//!
//! `refrain-host` writes exactly two places (§6.2-3): its private staging and
//! the Run workspace. Both live under the project's `.refrain/`:
//!
//! ```text
//! .refrain/
//! ├─ dispatch/staging/
//! │  ├─ manifests/<digest>.json   # the immutable snapshot the author read
//! │  └─ requests/<run-id>.md      # one frozen request per Run
//! └─ runs/<run-id>/
//!    ├─ request.md                # promoted at launch, producer-visible
//!    └─ context-manifest.json     # the snapshot, promoted with it
//! ```
//!
//! Staging writes are plain write+fsync: a crash mid-stage leaves a partial
//! file whose hash fails `staged_request_matches`, which blocks the launch
//! (§8.2-5) — the producer never sees staging either way. The promotion
//! itself is a rename inside one volume, atomic on every target OS. The
//! fsync idioms mirror refrain-store's atomic writer (directory flushes are
//! a Unix no-op here for the same reason); the crate boundary forbids
//! sharing the code, so the ten lines are re-stated, not imported.

use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use refrain_core::Id;
use refrain_core::context_compiler::{DispatchPackage, ManifestEntry};
use serde::Serialize;
use sha2::Digest;

use crate::host::{FrozenContext, StagedDispatch};

/// The snapshot as it lands on disk: what the author read, plus the
/// canonical request with its run-id placeholder intact.
#[derive(Serialize)]
struct ManifestSnapshot<'a> {
    digest: &'a str,
    manifest: &'a [ManifestEntry],
    request: &'a str,
}

/// A `FrozenContext` over real directories. Construct with the project's
/// state directory (`.refrain/`); every path it touches stays underneath.
pub struct DirectoryContext {
    state_dir: PathBuf,
}

impl DirectoryContext {
    pub fn new(state_dir: PathBuf) -> Self {
        Self { state_dir }
    }

    fn manifests_dir(&self) -> PathBuf {
        self.state_dir
            .join("dispatch")
            .join("staging")
            .join("manifests")
    }

    fn requests_dir(&self) -> PathBuf {
        self.state_dir
            .join("dispatch")
            .join("staging")
            .join("requests")
    }

    fn staged_request(&self, run_id: Id) -> PathBuf {
        self.requests_dir().join(format!("{run_id}.md"))
    }

    /// The promoted request as the producer sees it (L0 collect reads the
    /// scope ids back out of it: the frozen bytes are the authority, not
    /// anyone's memory of the dispatch).
    pub fn read_workspace_request(&self, workspace: &str) -> io::Result<Option<String>> {
        match fs::read_to_string(self.state_dir.join(workspace).join("request.md")) {
            Ok(text) => Ok(Some(text)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// A result the producer left in this Run's attempt directory, if any.
    /// One attempt per Run in v0.2: a retry is a new Run with a new attempt.
    pub fn read_result(&self, workspace: &str, run_id: Id) -> io::Result<Option<Vec<u8>>> {
        let path = self
            .state_dir
            .join(workspace)
            .join("attempts")
            .join(run_id.to_string())
            .join("result.md");
        match fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }
}

impl FrozenContext for DirectoryContext {
    type Error = io::Error;

    fn stage(
        &mut self,
        package: &DispatchPackage,
        requests: &[(Id, String)],
    ) -> Result<StagedDispatch, io::Error> {
        let manifests = self.manifests_dir();
        let requests_dir = self.requests_dir();
        fs::create_dir_all(&manifests)?;
        fs::create_dir_all(&requests_dir)?;

        let snapshot = serde_json::to_string_pretty(&ManifestSnapshot {
            digest: &package.digest,
            manifest: &package.manifest,
            request: &package.request_md,
        })
        .map_err(io::Error::other)?;
        let manifest_file = manifests.join(format!("{}.json", package.digest));
        fs::write(&manifest_file, &snapshot)?;
        sync_file(&manifest_file)?;

        let mut digests = Vec::with_capacity(requests.len());
        for (run_id, request) in requests {
            let file = self.staged_request(*run_id);
            fs::write(&file, request)?;
            sync_file(&file)?;
            digests.push((
                *run_id,
                format!("{:x}", sha2::Sha256::digest(request.as_bytes())),
            ));
        }
        sync_directory(&requests_dir)?;

        Ok(StagedDispatch {
            manifest_path: format!("dispatch/staging/manifests/{}.json", package.digest),
            request_digests: digests,
        })
    }

    fn promote_request(
        &mut self,
        run_id: Id,
        workspace: &str,
        manifest_digest: &str,
    ) -> Result<(), io::Error> {
        let staged = self.staged_request(run_id);
        let workspace_dir = self.state_dir.join(workspace);
        fs::create_dir_all(&workspace_dir)?;
        // The attempt directory exists before the producer is told the path:
        // writing a result must never mean inventing directory structure.
        fs::create_dir_all(workspace_dir.join("attempts").join(run_id.to_string()))?;

        // The target never exists in-protocol: Launching persists before the
        // promotion, and a crash beside it is recovered as recovery-required,
        // not by re-promoting. If it does exist, the rename's error is the
        // honest answer (Windows refuses to replace, and so do we).
        let request = workspace_dir.join("request.md");
        fs::rename(&staged, &request)?;

        let manifest = workspace_dir.join("context-manifest.json");
        fs::copy(
            self.manifests_dir().join(format!("{manifest_digest}.json")),
            &manifest,
        )?;
        sync_file(&manifest)?;
        sync_file(&request)?;
        sync_directory(&workspace_dir)
    }

    fn staged_request_matches(&self, run_id: Id, digest: &str) -> Result<bool, io::Error> {
        match fs::read(self.staged_request(run_id)) {
            Ok(bytes) => Ok(format!("{:x}", sha2::Sha256::digest(&bytes)) == digest),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }
}

/// Directory durability is a Unix concern; Windows has no user-space
/// directory handle to flush.
fn sync_directory(_path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    fs::File::open(_path)?.sync_all()?;
    Ok(())
}

/// Windows refuses to flush a handle without write access, so even a file
/// that will never be written again is opened read-write for its own fsync.
fn sync_file(path: &Path) -> io::Result<()> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?
        .sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use refrain_core::context_compiler::Tokens;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("refrain-staging-{}", Id::new()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn package() -> DispatchPackage {
        let request_md =
            "# Request\n改克制。\n\n# Reply format\n写进 runs/<run-id>/result.md。\n".to_string();
        DispatchPackage {
            digest: format!("{:x}", sha2::Sha256::digest(request_md.as_bytes())),
            request_md,
            manifest: vec![ManifestEntry {
                section: "Request".to_string(),
                source: "author".to_string(),
                digest: "d".to_string(),
                bytes: 6,
                tokens: Tokens::Estimated(10),
            }],
        }
    }

    #[test]
    fn a_staged_request_verifies_and_a_tampered_one_does_not() {
        let dir = scratch();
        let mut context = DirectoryContext::new(dir.clone());
        let run_id = Id::new();
        let staged = context
            .stage(&package(), &[(run_id, "frozen request".to_string())])
            .unwrap();
        let digest = &staged.request_digests[0].1;
        assert!(context.staged_request_matches(run_id, digest).unwrap());

        fs::write(
            dir.join("dispatch/staging/requests")
                .join(format!("{run_id}.md")),
            "tampered",
        )
        .unwrap();
        assert!(!context.staged_request_matches(run_id, digest).unwrap());

        // Simulated loss without a permanent delete (INV-6 scans tests too):
        // renaming away is the same absence from the verifier's chair.
        fs::rename(
            dir.join("dispatch/staging/requests")
                .join(format!("{run_id}.md")),
            dir.join("dispatch/staging/requests")
                .join(format!("{run_id}.md.gone")),
        )
        .unwrap();
        assert!(!context.staged_request_matches(run_id, digest).unwrap());
    }

    #[test]
    fn promotion_moves_request_and_manifest_into_the_workspace() {
        let dir = scratch();
        let mut context = DirectoryContext::new(dir.clone());
        let package = package();
        let run_id = Id::new();
        let staged = context
            .stage(&package, &[(run_id, "frozen request".to_string())])
            .unwrap();
        assert_eq!(
            staged.manifest_path,
            format!("dispatch/staging/manifests/{}.json", package.digest)
        );

        context
            .promote_request(run_id, &format!("runs/{run_id}"), &package.digest)
            .unwrap();
        let workspace = dir.join("runs").join(run_id.to_string());
        assert_eq!(
            fs::read_to_string(workspace.join("request.md")).unwrap(),
            "frozen request"
        );
        let manifest = fs::read_to_string(workspace.join("context-manifest.json")).unwrap();
        assert!(manifest.contains(&package.digest));
        // The staged copy is gone: promotion is a move, not a leak.
        assert!(
            !dir.join("dispatch/staging/requests")
                .join(format!("{run_id}.md"))
                .exists()
        );
    }
}
