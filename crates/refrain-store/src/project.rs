//! The Project store: adopt, open, create, commit (M5).
//!
//! One Root permit, one project database, and the only path by which a
//! manuscript reaches disk. Ported behaviour (legacy `project.ts`, owned here
//! since C3):
//!
//! - A FileStamp is `{ modified_ms, bytes, BLAKE3 digest }`. The digest
//!   decides identity: an editor can preserve mtime and size while replacing
//!   every byte, so neither is ever consulted for equality.
//! - Commit is compare-and-swap against the stamp the author last agreed
//!   with. A file edited underneath is refused and the refusal carries the
//!   disk's current bytes, so Safety can show both. A file that has since
//!   vanished is not a conflict: the author asked for it to exist again.
//! - Adopt is two independent phases (Q23): the permit and file-system
//!   identity persist first; the Source Backup is attempted second, and its
//!   failure degrades to a status the interface reports — never a locked Root.
//! - Root identity is canonical path + file-system identity + nonce (Q25). A
//!   folder re-adopted through a symlink or a trailing slash is one Root, not
//!   two; the same path on a different volume is an identity change, which is
//!   a Safety surface, not a new project.

use refrain_core::{DocumentRole, ErrorCode, Id, RefrainError, digest::content_hex};
use rusqlite::{Connection, OptionalExtension, params};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::atomic;
use crate::root::{
    self, BackupOutcome, RootKind, RootLayout, assert_inside_root, assert_mutable_path,
};
use crate::schema::{Database, ProjectDb};

mod catalog;
pub mod search;
pub use catalog::{
    DocumentPage, DocumentPageQuery, DocumentRow, MAX_DOCUMENT_PAGE_SIZE,
    MAX_DOCUMENT_SEARCH_RESULTS,
};

/// Where the project database lives inside the Root's state directory.
const PROJECT_DB_NAME: &str = "refrain.db";

/// A Root as the author pointed at it.
#[derive(Debug, Clone)]
pub struct RootLocator {
    pub path: PathBuf,
    pub kind: RootKind,
}

/// A persisted Root permit (SPEC 10.1 `root_permits`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootPermit {
    pub root_id: Id,
    pub canonical_path: PathBuf,
    pub kind: RootKind,
    /// File-system identity: volume and file index on Windows, device and
    /// inode elsewhere.
    pub identity: String,
    pub nonce: String,
}

/// What the Source Backup attempt produced, in the author's terms. `Failed`
/// is a degradation the interface reports and offers to retry — the Root
/// stays editable (Q23).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum BackupStatus {
    Taken { files: u32 },
    AlreadyPresent,
    NothingToCopy,
    Failed { reason: String },
}

impl From<BackupOutcome> for BackupStatus {
    fn from(outcome: BackupOutcome) -> Self {
        match outcome {
            BackupOutcome::Taken { files } => Self::Taken { files },
            BackupOutcome::AlreadyPresent => Self::AlreadyPresent,
            BackupOutcome::NothingToCopy => Self::NothingToCopy,
            BackupOutcome::Refused { reason } => Self::Failed { reason },
        }
    }
}

/// `u64` on the bridge, without the precision loss Specta forbids: the wire
/// carries these as decimal strings, and both halves of the encoding live in
/// one place so they cannot drift.
pub mod u64_string {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        value.to_string().serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let text = String::deserialize(deserializer)?;
        text.parse::<u64>().map_err(serde::de::Error::custom)
    }
}

/// The same encoding for an optional instant. Absence stays absence: a
/// discarded-at that never happened is `None`, not the string "0".
pub mod u64_string_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(value: &Option<u64>, serializer: S) -> Result<S::Ok, S::Error> {
        value.map(|inner| inner.to_string()).serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<u64>, D::Error> {
        let text = Option::<String>::deserialize(deserializer)?;
        text.map(|inner| inner.parse::<u64>())
            .transpose()
            .map_err(serde::de::Error::custom)
    }
}

/// What a file looked like when this application last agreed with it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileStamp {
    #[serde(with = "u64_string")]
    #[specta(type = String)]
    pub modified_ms: u64,
    #[serde(with = "u64_string")]
    #[specta(type = String)]
    pub bytes: u64,
    pub digest: String,
}

impl FileStamp {
    fn of(path: &Path, bytes: &[u8]) -> io::Result<Self> {
        let metadata = fs::metadata(path)?;
        let modified_ms = metadata
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_millis() as u64);
        Ok(Self {
            modified_ms,
            bytes: bytes.len() as u64,
            digest: content_hex(bytes),
        })
    }
}

/// A frozen candidate row (SPEC 9.7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProposalRow {
    pub id: String,
    pub run: String,
    pub baseline: String,
    pub document_path: String,
    pub scope: String,
    pub before_text: String,
    pub after_text: Option<String>,
    pub created_at: u64,
}

/// An opened document: raw bytes plus the stamp a later commit needs.
#[derive(Debug, Clone)]
pub struct OpenDocument {
    pub row: DocumentRow,
    pub bytes: Vec<u8>,
    pub stamp: FileStamp,
}

/// A creation request. The role is data; the landing directory follows from
/// it (`material/` for Material, the Root top level otherwise).
#[derive(Debug, Clone)]
pub struct CreateDocument {
    pub title: String,
    pub role: DocumentRole,
}

/// One atomic save: canonical bytes, the stamp the author last agreed with,
/// and nothing else. Byte materialisation from a Text Head is the domain's
/// job (`Manuscript::materialize`); this layer never re-serialises.
#[derive(Debug, Clone)]
pub struct DocumentCommit {
    pub path: String,
    pub bytes: Vec<u8>,
    pub expected: Option<FileStamp>,
}

/// The disk moved on since the author's stamp: a refusal, not an exception.
#[derive(Debug, Clone)]
pub struct ChangedUnderneath {
    pub on_disk: Vec<u8>,
    pub stamp: FileStamp,
}

/// What a commit left behind.
#[derive(Debug, Clone)]
pub struct CommitOutcome {
    pub stamp: FileStamp,
    pub recovery_evidence: Option<PathBuf>,
}

/// Every way adopt/open/create/commit can fail. Guard refusals are typed
/// domain errors; I/O and database failures stay in their own lanes.
#[derive(Debug, thiserror::Error)]
pub enum ProjectFailure {
    #[error(transparent)]
    Domain(#[from] RefrainError),
    #[error("the Root path does not exist: {0}")]
    RootMissing(PathBuf),
    #[error("the Root changed identity: {path} (stored {stored}, found {found})")]
    IdentityChanged {
        path: PathBuf,
        stored: String,
        found: String,
    },
    #[error("the file moved on")]
    ChangedUnderneath(Box<ChangedUnderneath>),
    #[error("the path is a directory, not a document: {0}")]
    NotADocument(PathBuf),
    #[error("I/O at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error(transparent)]
    Store(#[from] crate::schema::StoreError),
}

impl ProjectFailure {
    fn io(path: &Path) -> impl FnOnce(io::Error) -> Self + '_ {
        move |source| Self::Io {
            path: path.to_path_buf(),
            source,
        }
    }
}

/// The file-system identity of a path. Unix has device and inode; stable
/// Rust on Windows exposes no volume/file-index without unsafe Win32, so the
/// Windows identity is the creation stamp — the one attribute a replacement
/// of the folder at the same path cannot keep (Q25's "same path, different
/// file system" is exactly a replacement). Reaching GetFileInformationByHandle
/// without unsafe is logged as SPEC §14-N9.
fn file_system_identity(path: &Path) -> io::Result<String> {
    let metadata = fs::metadata(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        Ok(format!("born:{}", metadata.creation_time()))
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(format!("{}:{}", metadata.dev(), metadata.ino()))
    }
    #[cfg(not(any(windows, unix)))]
    Ok(String::from("unsupported-platform"))
}

/// One adopted Root: its permit, its layout, and its database.
#[derive(Debug)]
pub struct ProjectStore {
    permit: RootPermit,
    layout: RootLayout,
    pub(crate) db: Connection,
    /// The paths and roles from the last successful catalog reconciliation.
    pub(crate) reconciled: Option<[u8; 32]>,
    /// Whether the search index reflects what is on disk right now.
    ///
    /// Kept apart from `reconciled` because the two answer different questions
    /// at different costs. Reconciliation asks "which files are in this
    /// project" and runs on every refresh; indexing asks "what do they say"
    /// and reads every one of them. Sharing one trigger made a directory
    /// refresh cost 2.1 million file reads on the 100,000-document fixture and
    /// put 104ms of bigramming on the path that opens a 10 MiB manuscript.
    ///
    /// A boolean rather than a second fingerprint: freshness must be *claimed*
    /// by a successful build. Comparing two `Option`s reported "current" when
    /// neither existed, so a store that had never reconciled searched an empty
    /// index and said the manuscript contained nothing.
    pub(crate) index_is_fresh: bool,
}

impl ProjectStore {
    /// Adopts a Root, or re-opens an already adopted one. Phase one persists
    /// or re-verifies the permit and file-system identity; phase two attempts
    /// the Source Backup and only ever degrades to a status (Q23).
    pub fn adopt(
        app_db: &mut Connection,
        locator: &RootLocator,
    ) -> Result<(Self, BackupStatus), ProjectFailure> {
        let canonical = fs::canonicalize(&locator.path)
            .map_err(|_| ProjectFailure::RootMissing(locator.path.clone()))?;
        if locator.kind == RootKind::Folder && !canonical.is_dir() {
            return Err(ProjectFailure::RootMissing(locator.path.clone()));
        }
        if locator.kind == RootKind::File && !canonical.is_file() {
            return Err(ProjectFailure::NotADocument(canonical));
        }
        let layout = root::layout_for(&canonical, locator.kind);
        root::claim_root_storage(&layout).map_err(ProjectFailure::io(&canonical))?;

        let identity = file_system_identity(&canonical).map_err(ProjectFailure::io(&canonical))?;
        let permit = Self::permit_for(app_db, &canonical, locator.kind, &identity)?;

        let db_path = layout.state_dir.join(PROJECT_DB_NAME);
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent).map_err(ProjectFailure::io(&canonical))?;
        }
        let mut db = Connection::open(&db_path).map_err(crate::schema::StoreError::from)?;
        ProjectDb::migrate(&mut db)?;

        let store = Self {
            permit,
            layout,
            db,
            reconciled: None,
            index_is_fresh: false,
        };
        let backup = root::take_source_backup(&canonical, locator.kind, &store.layout).into();
        Ok((store, backup))
    }

    fn permit_for(
        app_db: &mut Connection,
        canonical: &Path,
        kind: RootKind,
        identity: &str,
    ) -> Result<RootPermit, ProjectFailure> {
        let path_text = canonical.to_string_lossy().into_owned();
        let existing = app_db
            .query_row(
                "SELECT root_id, kind, identity, nonce FROM root_permits WHERE canonical_path = ?1",
                params![path_text],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(crate::schema::StoreError::from)?;

        if let Some((root_id, kind_text, stored_identity, nonce)) = existing {
            if stored_identity != identity {
                return Err(ProjectFailure::IdentityChanged {
                    path: canonical.to_path_buf(),
                    stored: stored_identity,
                    found: identity.to_string(),
                });
            }
            let id = root_id
                .parse::<uuid::Uuid>()
                .map(Id::from_uuid)
                .map_err(|error| {
                    ProjectFailure::Domain(RefrainError::new(
                        ErrorCode::StateUnavailable,
                        "read a Root permit",
                        format!("{path_text}: {error}"),
                    ))
                })?;
            return Ok(RootPermit {
                root_id: id,
                canonical_path: canonical.to_path_buf(),
                kind: RootKind::from_wire(&kind_text).unwrap_or(kind),
                identity: identity.to_string(),
                nonce,
            });
        }

        let permit = RootPermit {
            root_id: Id::new(),
            canonical_path: canonical.to_path_buf(),
            kind,
            identity: identity.to_string(),
            nonce: Id::new().to_string(),
        };
        app_db
            .execute(
                "INSERT INTO root_permits (root_id, canonical_path, kind, identity, nonce, adopted_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    permit.root_id.to_string(),
                    path_text,
                    kind.as_str(),
                    permit.identity,
                    permit.nonce,
                    now_millis() as i64,
                ],
            )
            .map_err(crate::schema::StoreError::from)?;
        Ok(permit)
    }

    #[must_use]
    pub fn permit(&self) -> &RootPermit {
        &self.permit
    }

    /// The on-disk layout: the host's staging and Run workspaces root at
    /// `state_dir` (SPEC 6.3).
    pub fn layout(&self) -> &RootLayout {
        &self.layout
    }

    /// A frozen candidate (SPEC 9.7). `after_text` NULL is a deletion.
    pub fn proposal_insert(&mut self, row: &ProposalRow) -> Result<(), ProjectFailure> {
        self.db
            .execute(
                "INSERT OR IGNORE INTO proposals
                     (id, run, baseline, document_path, scope, before_text, after_text, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    row.id,
                    row.run,
                    row.baseline,
                    row.document_path,
                    row.scope,
                    row.before_text,
                    row.after_text,
                    row.created_at as i64,
                ],
            )
            .map_err(crate::schema::StoreError::from)?;
        Ok(())
    }

    pub fn proposals_for(&self, path: &str) -> Result<Vec<ProposalRow>, ProjectFailure> {
        let mut statement = self
            .db
            .prepare(
                "SELECT id, run, baseline, document_path, scope, before_text, after_text, created_at
                 FROM proposals WHERE document_path = ?1 ORDER BY created_at, rowid",
            )
            .map_err(crate::schema::StoreError::from)?;
        let rows = statement
            .query_map(params![path], |row| {
                Ok(ProposalRow {
                    id: row.get(0)?,
                    run: row.get(1)?,
                    baseline: row.get(2)?,
                    document_path: row.get(3)?,
                    scope: row.get(4)?,
                    before_text: row.get(5)?,
                    after_text: row.get(6)?,
                    created_at: row.get::<_, i64>(7)? as u64,
                })
            })
            .map_err(crate::schema::StoreError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(crate::schema::StoreError::from)?;
        Ok(rows)
    }

    /// The per-document review session: cursor and batch are staging (SPEC
    /// 9.7). Both write through immediately; a kill loses nothing but time.
    pub fn review_session_set(
        &mut self,
        path: &str,
        cursor: u32,
        batch_json: &str,
    ) -> Result<(), ProjectFailure> {
        self.db
            .execute(
                "INSERT INTO review_sessions (document_path, cursor, batch, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(document_path) DO UPDATE SET
                     cursor = excluded.cursor,
                     batch = excluded.batch,
                     updated_at = excluded.updated_at",
                params![path, cursor as i64, batch_json, now_millis() as i64],
            )
            .map_err(crate::schema::StoreError::from)?;
        Ok(())
    }

    pub fn review_session_get(&self, path: &str) -> Result<Option<(u32, String)>, ProjectFailure> {
        self.db
            .query_row(
                "SELECT cursor, batch FROM review_sessions WHERE document_path = ?1",
                params![path],
                |row| Ok((row.get::<_, i64>(0)? as u32, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(crate::schema::StoreError::from)
            .map_err(ProjectFailure::from)
    }

    /// The schema version this project's database is at, for migration tests.
    pub fn schema_version(&self) -> Result<u32, crate::schema::StoreError> {
        let version: u32 = self
            .db
            .query_row("PRAGMA user_version", [], |row| row.get(0))?;
        Ok(version)
    }

    /// The Verdict Ledger over this project's database (SPEC 1.2).
    #[must_use]
    pub fn ledger(&self) -> crate::ledger::VerdictLedger<'_> {
        crate::ledger::VerdictLedger::new(&self.db)
    }

    /// The author's standing arrangement of the mailbox (SPEC 9.6).
    #[must_use]
    pub fn mailbox(&self) -> crate::mailbox::MailboxStandings<'_> {
        crate::mailbox::MailboxStandings::new(&self.db)
    }

    /// The absolute path of a document inside this Root, containment-checked.
    /// Reads go through here: the Source Backup is readable — it is the
    /// author's original. Writes go through [`resolve_mutable`], which adds
    /// the INV-4 guard.
    fn resolve(&self, relative: &str) -> Result<PathBuf, ProjectFailure> {
        let path = match self.permit.kind {
            RootKind::Folder => self.permit.canonical_path.join(relative),
            RootKind::File => self.permit.canonical_path.clone(),
        };
        assert_inside_root(&self.permit.canonical_path, self.permit.kind, &path)?;
        Ok(path)
    }

    fn resolve_mutable(&self, relative: &str) -> Result<PathBuf, ProjectFailure> {
        let path = self.resolve(relative)?;
        assert_mutable_path(&path)?;
        Ok(path)
    }

    /// Reads one document and registers (or refreshes) its row. The digest in
    /// the database follows the bytes on disk — restart recovery recomputes
    /// from canonical bytes rather than trusting a stored value.
    ///
    /// Opening does not index. The author is waiting to see their words, and
    /// a 10 MiB manuscript costs 104ms to bigram and write — measured, and it
    /// pushed open-to-bridge p95 from 117ms to 221ms, past the seven-frame
    /// budget. Indexing is what a *search* needs, so the index is marked stale
    /// here and rebuilt on the next read of it (`ensure_indexed`). An author
    /// who opens twenty chapters and searches once pays once, at the search.
    pub fn open_document(&mut self, relative: &str) -> Result<OpenDocument, ProjectFailure> {
        let path = self.resolve(relative)?;
        if path.is_dir() {
            return Err(ProjectFailure::NotADocument(path));
        }
        let bytes = fs::read(&path).map_err(ProjectFailure::io(&path))?;
        let stamp = FileStamp::of(&path, &bytes).map_err(ProjectFailure::io(&path))?;
        let row = self.register(relative, &stamp)?;
        self.invalidate_index_if_stale(relative, &stamp.digest);
        Ok(OpenDocument { row, bytes, stamp })
    }

    /// Mark the index stale when this document's bytes are not what it holds.
    ///
    /// One cheap lookup, no bigramming and no writes. Opening an unchanged
    /// chapter — the common case — leaves the index alone and costs one
    /// indexed read.
    fn invalidate_index_if_stale(&mut self, relative: &str, digest: &str) {
        if !self.index_is_current(relative, digest) {
            self.index_is_fresh = false;
        }
    }

    /// Renderer-facing reads must name a row produced by Root indexing or by
    /// document creation. Containment alone does not authorise an arbitrary
    /// file inside the Root.
    pub fn open_registered_document(
        &mut self,
        relative: &str,
    ) -> Result<OpenDocument, ProjectFailure> {
        if self.find_document(relative)?.is_none() {
            return Err(ProjectFailure::NotADocument(self.resolve(relative)?));
        }
        self.open_document(relative)
    }

    /// Creates a document on disk and in the database. `Occupied` is a
    /// refusal, not an overwrite.
    pub fn create(&mut self, command: &CreateDocument) -> Result<OpenDocument, ProjectFailure> {
        let path =
            root::path_for_new_document(&self.permit.canonical_path, &command.title, command.role)?;
        assert_mutable_path(&path)?;
        assert_inside_root(&self.permit.canonical_path, self.permit.kind, &path)?;
        if path.try_exists().map_err(ProjectFailure::io(&path))? {
            return Err(ProjectFailure::Domain(RefrainError::new(
                ErrorCode::Occupied,
                "create a document at",
                path.display().to_string(),
            )));
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(ProjectFailure::io(&path))?;
        }
        atomic::replace_file_atomically(&path, b"", |_| Ok(()))
            .map_err(ProjectFailure::io(&path))?;

        let relative = self.relative_path(&path)?;
        let stamp = FileStamp::of(&path, b"").map_err(ProjectFailure::io(&path))?;
        let row = DocumentRow {
            id: Id::new(),
            path: relative,
            role: command.role,
            digest: Some(stamp.digest.clone()),
            current_head: None,
            head_block_ids: None,
            // Authored in RefRain, not imported from anywhere.
            source_digest: None,
            source_format: None,
        };
        self.upsert_document(&row)?;
        Ok(OpenDocument {
            row,
            bytes: Vec::new(),
            stamp,
        })
    }

    /// Commits canonical bytes, compare-and-swap on the author's stamp.
    pub fn commit(&mut self, commit: &DocumentCommit) -> Result<CommitOutcome, ProjectFailure> {
        let path = self.resolve_mutable(&commit.path)?;

        if let Some(expected) = &commit.expected {
            match read_existing(&path).map_err(ProjectFailure::io(&path))? {
                // A file the author deleted or moved is not a conflict: they
                // asked for it to exist again by saving.
                None => {}
                Some((bytes, stamp)) if stamp.digest != expected.digest => {
                    return Err(ProjectFailure::ChangedUnderneath(Box::new(
                        ChangedUnderneath {
                            on_disk: bytes,
                            stamp,
                        },
                    )));
                }
                Some(_) => {}
            }
        } else if path.is_dir() {
            return Err(ProjectFailure::NotADocument(path));
        }

        let outcome = atomic::replace_file_atomically(&path, &commit.bytes, |_| Ok(()))
            .map_err(ProjectFailure::io(&path))?;
        let stamp = FileStamp::of(&path, &commit.bytes).map_err(ProjectFailure::io(&path))?;

        // The digest row follows the bytes just written. Recovery after a
        // crash between the two recomputes from canonical bytes on the next
        // open rather than trusting either side (SPEC: restart by digest).
        self.register(&commit.path, &stamp)?;
        // Saving does not index either: the author is waiting for the save to
        // land, not for search to be current. Same reasoning as open_document.
        self.invalidate_index_if_stale(&commit.path, &stamp.digest);

        Ok(CommitOutcome {
            stamp,
            recovery_evidence: outcome.recovery_evidence,
        })
    }

    fn relative_path(&self, path: &Path) -> Result<String, ProjectFailure> {
        match self.permit.kind {
            RootKind::Folder => Ok(path
                .strip_prefix(&self.permit.canonical_path)
                .map_err(|_| {
                    ProjectFailure::Domain(RefrainError::new(
                        ErrorCode::OutsideRoot,
                        "name a document outside its Root",
                        path.display().to_string(),
                    ))
                })?
                .components()
                .map(|component| component.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/")),
            RootKind::File => Ok(self
                .permit
                .canonical_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()),
        }
    }

    /// Whether the index already reflects these exact bytes.
    fn index_is_current(&self, relative: &str, digest: &str) -> bool {
        search::index_is_current(&self.db, relative, digest)
    }

    /// Query the inverted index directly, without the catalog join.
    ///
    /// `search_documents` answers what the author should see, and drops any
    /// path the catalog no longer has a row for. That filter is right for a
    /// reader and wrong for anyone asking whether the index itself is in
    /// step — it hides a leaked entry rather than reporting one. This is the
    /// view that shows the index as it actually is.
    ///
    /// Takes `&mut self` for the same reason `search_documents` does: the
    /// first read after the catalog changed builds the index. A read-only
    /// variant would answer "empty" on a freshly adopted project, which is
    /// true of the index and false of the manuscript.
    pub fn indexed_paths(&mut self, query: &str, limit: u32) -> Result<Vec<String>, RefrainError> {
        self.ensure_indexed()?;
        Ok(search::search(&self.db, query, limit)?
            .into_iter()
            .map(|hit| hit.path)
            .collect())
    }

    /// Registers a seen document, keeping the role it already has when the
    /// row exists and inferring one from position when it does not: a
    /// single-file Root's file is a Document, a top-level file is a Chapter,
    /// anything nested starts as Material (a promotion, never the default).
    fn register(
        &mut self,
        relative: &str,
        stamp: &FileStamp,
    ) -> Result<DocumentRow, ProjectFailure> {
        if let Some(row) = self.find_document(relative)? {
            self.db
                .execute(
                    "UPDATE documents SET digest = ?1 WHERE id = ?2",
                    params![stamp.digest, row.id.to_string()],
                )
                .map_err(crate::schema::StoreError::from)?;
            return Ok(DocumentRow {
                digest: Some(stamp.digest.clone()),
                ..row
            });
        }
        let role = infer_role(self.permit.kind, relative);
        let row = DocumentRow {
            id: Id::new(),
            path: relative.to_string(),
            role,
            digest: Some(stamp.digest.clone()),
            current_head: None,
            head_block_ids: None,
            // Reconciliation found a file on disk; no import recorded it.
            source_digest: None,
            source_format: None,
        };
        self.upsert_document(&row)?;
        Ok(row)
    }

    fn find_document(&self, relative: &str) -> Result<Option<DocumentRow>, ProjectFailure> {
        self.db
            .query_row(
                "SELECT id, path, role, digest, current_head, head_block_ids,
                        source_digest, source_format
                 FROM documents WHERE path = ?1",
                params![relative],
                // The same columns and the same decode as every other document
                // read. This carried its own copy of the tuple and the id/role
                // parsing, so schema v10 had to add a column in two places and
                // the second one is exactly the kind that gets missed.
                catalog::stored_document,
            )
            .optional()
            .map_err(crate::schema::StoreError::from)?
            .map(|stored| catalog::decode_document(stored).map_err(ProjectFailure::Domain))
            .transpose()
    }

    /// Persists the confirmed revision and its lineage with the digest, so a
    /// later open resumes the revision chain instead of minting a fresh one
    /// (SPEC 7.2 crash recovery).
    pub fn save_continuity(
        &mut self,
        relative: &str,
        current_head: &str,
        head_block_ids: &str,
    ) -> Result<(), ProjectFailure> {
        self.db
            .execute(
                "UPDATE documents SET current_head = ?1, head_block_ids = ?2 WHERE path = ?3",
                params![current_head, head_block_ids, relative],
            )
            .map_err(crate::schema::StoreError::from)?;
        Ok(())
    }

    /// Journals a pending EditorAction before it executes. The row is cleared
    /// on confirmation; a survivor replays on the next open through the same
    /// validation, never by writing files directly (SPEC 7.2).
    pub fn journal_append(
        &mut self,
        relative: &str,
        action_json: &str,
    ) -> Result<Id, ProjectFailure> {
        let id = Id::new();
        self.db
            .execute(
                "INSERT INTO pending_actions (id, path, action, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![id.to_string(), relative, action_json, now_millis() as i64],
            )
            .map_err(crate::schema::StoreError::from)?;
        Ok(id)
    }

    /// Every journaled action for a document, in the order they were taken.
    pub fn journal_take(&self, relative: &str) -> Result<Vec<(Id, String)>, ProjectFailure> {
        let mut statement = self
            .db
            .prepare(
                "SELECT id, action FROM pending_actions WHERE path = ?1 ORDER BY created_at, rowid",
            )
            .map_err(crate::schema::StoreError::from)?;
        let rows = statement
            .query_map(params![relative], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(crate::schema::StoreError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(crate::schema::StoreError::from)?;
        rows.into_iter()
            .map(|(id, action)| {
                id.parse::<uuid::Uuid>()
                    .map(Id::from_uuid)
                    .map(|id| (id, action))
                    .map_err(|error| {
                        ProjectFailure::Domain(RefrainError::new(
                            ErrorCode::StateUnavailable,
                            "read a pending action",
                            error.to_string(),
                        ))
                    })
            })
            .collect()
    }

    pub fn journal_remove(&mut self, id: Id) -> Result<(), ProjectFailure> {
        self.db
            .execute(
                "DELETE FROM pending_actions WHERE id = ?1",
                params![id.to_string()],
            )
            .map_err(crate::schema::StoreError::from)?;
        Ok(())
    }

    /// Record which file a Material was imported from.
    ///
    /// Only import calls this. Creation and reconciliation go through
    /// `upsert_document`, which coalesces these columns rather than setting
    /// them — they have no source to record and must not clear one.
    pub fn record_imported_source(
        &mut self,
        path: &str,
        digest: &str,
        format: &str,
    ) -> Result<(), ProjectFailure> {
        self.db
            .execute(
                "UPDATE documents SET source_digest = ?1, source_format = ?2 WHERE path = ?3",
                params![digest, format, path],
            )
            .map_err(crate::schema::StoreError::from)?;
        Ok(())
    }

    fn upsert_document(&mut self, row: &DocumentRow) -> Result<(), ProjectFailure> {
        self.db
            .execute(
                // The source columns are deliberately absent here. Both
                // callers create a document — nothing arrives with a source to
                // write, so listing the columns would only add a NULL that
                // could overwrite a real one later. `record_imported_source`
                // is the single writer, and reconciliation's own insert uses
                // `ON CONFLICT DO NOTHING`, so an existing row keeps what it
                // has. Measured: a COALESCE here could not be made to fail —
                // removing it changed no test, because no caller ever reaches
                // this statement with a source in hand.
                "INSERT INTO documents (id, path, role, digest) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(path) DO UPDATE SET digest = excluded.digest",
                params![row.id.to_string(), row.path, row.role.as_str(), row.digest],
            )
            .map_err(crate::schema::StoreError::from)?;
        Ok(())
    }
}

/// Reads a file that may not exist, distinguishing the two. A read error is
/// not a missing document: mistaking one for the other is how a conflict
/// check writes over a file it failed to read.
fn read_existing(path: &Path) -> io::Result<Option<(Vec<u8>, FileStamp)>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(
            FileStamp::of(path, &bytes).map(|stamp| (bytes, stamp))?,
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn infer_role(kind: RootKind, relative: &str) -> DocumentRole {
    if kind == RootKind::File {
        return DocumentRole::Document;
    }
    if relative.contains('/') {
        DocumentRole::Material
    } else {
        DocumentRole::Chapter
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}
