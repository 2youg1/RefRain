//! The v0.1.6 legacy migration (SPEC 10.2, 10.3).
//!
//! One deep module over the existing primitives. The flow:
//!
//! 1. **Inventory** reads the old planes. The legacy Root is read-only: this
//!    module has no write path into it. The old `verdicts.db` is copied to a
//!    scratch file first, so even SQLite recovery never touches the original.
//! 2. **Shadow build** writes the new project into a shadow database and
//!    atomic file writes. A kill anywhere leaves no completion mark, and a
//!    rerun rebuilds the shadow from scratch.
//! 3. **Install** checkpoints the shadow database, renames it into the
//!    target's `.refrain`, preserves every old plane byte-for-byte under
//!    `.refrain/legacy`, writes the digest manifest, and writes the
//!    completion mark last. A rerun that finds the mark changes nothing.
//!
//! Judgment calls stop in the quarantine list; nothing is guessed. Migrated
//! rows mint fresh UUIDv7 ids and keep the old identity in `legacy_id`
//! (documents) or inside the entity JSON (tasks, runs). Verdict and proposal
//! rows keep their old string ids directly: those columns are text, and the
//! old values are unique by construction. Every database insert lands in one
//! transaction; the completion mark is the last write of all.
//!
//! Limits of this checkpoint: folder Roots only (a single-file legacy Root
//! has no plane layout to read), and the planned Harness Connections are
//! returned for the caller to upsert into the one Config — the app-level
//! Config directory is not this function's to know.

use refrain_core::{DocumentRole, Id, digest::content_hex};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::atomic;
use crate::config::{AdapterKind, HarnessConnection};
use crate::root;
use crate::schema::{Database, ProjectDb, StoreError};

const STATE_DIR: &str = ".refrain";
const SHADOW_DIR: &str = ".refrain-shadow";
const LEGACY_BACKUP_DIR: &str = "legacy";
const MANIFEST_FILE: &str = "manifest.json";
const COMPLETION_MARK: &str = "migration-complete.json";
const COMPLETION_MARK_VERSION: u32 = 1;
const PROJECT_DB: &str = "refrain.db";
const MIGRATION_NAME: &str = "legacy-v0.1.6";

/// The built-in L0 file-channel agent (SPEC 8.3a's first row). The constant
/// lives in the app crate, which this crate cannot name (SPEC 6.2 makes the
/// two siblings). Keep the value in step with `L0_FILE_CHANNEL_AGENT` in
/// `apps/desktop/src-tauri/src/lib.rs`.
const L0_FILE_CHANNEL_AGENT: &str = "00000000-0000-0000-0000-0000000000e0";

/// Directory names the old UI used for Material. A name is a migration-time
/// hint only (SPEC 10.2): files under one migrate as Material, any other
/// nested file migrates as a plain Document for the author to classify. The
/// legacy i18n wrote 资料 (U+8D44); the traditional spelling 資料 (U+8CC7)
/// appears in the wild and in this repo's own fixtures, so both hint.
const MATERIAL_DIR_NAMES: [&str; 4] = ["资料", "資料", "material", "Material"];

// ---- the report --------------------------------------------------------------

/// `QuarantinedItems` when anything stopped for a human; never a guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MigrationStatus {
    Completed,
    QuarantinedItems,
}

/// Found / imported / quarantined, per plane.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaneCount {
    pub found: u32,
    pub imported: u32,
    pub quarantined: u32,
}

/// Per-plane counts. `authorizations` is always zero: the old host kept its
/// grants in memory and never wrote them down.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaneCounts {
    pub documents: PlaneCount,
    pub agents: PlaneCount,
    pub tasks: PlaneCount,
    pub runs: PlaneCount,
    pub proposals: PlaneCount,
    pub verdicts: PlaneCount,
    pub kara_notes: PlaneCount,
    pub preserved_files: PlaneCount,
    pub authorizations: PlaneCount,
}

/// One item that stopped for a human decision (SPEC 10.3's 模糊停).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuarantineItem {
    pub plane: String,
    pub kind: String,
    pub subject: String,
    pub detail: String,
}

/// What became of one legacy agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "kind", content = "value")]
pub enum AgentOutcome {
    /// A planned Harness Connection. The caller upserts it into the Config.
    Connection(Id),
    /// The legacy file channel: the built-in L0 agent serves it.
    FileChannel,
    /// The command could not be read as executable + argv (SPEC 10.2).
    Unavailable(String),
}

/// One legacy agent and its mapping. The old `model` / `reasoningEffort`
/// values travel as `legacy_requested`: the new Connection parameters do not
/// carry them, and they are not guessed into anything else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentMapping {
    pub legacy_id: String,
    pub name: String,
    pub outcome: AgentOutcome,
    pub legacy_requested: Option<(String, String)>,
}

/// The migration's evidence: per-plane counts, the quarantine list, the
/// digest manifest's path, and the planned Harness Connections.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationReport {
    pub status: MigrationStatus,
    pub planes: PlaneCounts,
    pub quarantine: Vec<QuarantineItem>,
    pub manifest_path: PathBuf,
    pub connections: Vec<HarnessConnection>,
    pub agent_map: Vec<AgentMapping>,
    pub target_root: PathBuf,
}

/// Every way the migration can refuse. A quarantined item is not a failure:
/// the migration completes and reports it. These are the hard stops.
#[derive(Debug, thiserror::Error)]
pub enum MigrationFailure {
    #[error("the legacy Root does not exist: {0}")]
    LegacyMissing(PathBuf),
    #[error("the legacy Root and the target must be different directories")]
    SameRoot,
    #[error("the target holds files this migration did not write: {0}")]
    TargetOccupied(PathBuf),
    #[error("I/O at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

fn io_fail(path: &Path) -> impl FnOnce(io::Error) -> MigrationFailure + '_ {
    move |source| MigrationFailure::Io {
        path: path.to_path_buf(),
        source,
    }
}

// ---- the old planes, as the v0.1.6 writers spelled them ----------------------

/// `StoredAgent` (legacy `roster.ts`): one entry of `.refrain/agents.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyAgent {
    id: String,
    name: String,
    harness: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    reasoning_effort: Option<String>,
    #[serde(default)]
    template: Option<Vec<String>>,
}

/// `ReviewTask` (legacy `types.ts`). Fields this migration does not read
/// (`contextScope`, `editScopes`) ride along verbatim: the entity column
/// keeps the whole old fact.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyTask {
    id: String,
    #[serde(rename = "agentId")]
    agent_id: String,
    baseline: String,
    #[serde(default)]
    prompt: String,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

/// `StoredRun` (legacy `host-state.ts`): the task is embedded, not named.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyRun {
    id: String,
    state: String,
    task: LegacyTask,
    #[serde(default)]
    failure: Option<String>,
    #[serde(default)]
    proposals: Vec<LegacyProposal>,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

/// The proposal half of a completed legacy run (`review.ts`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyProposal {
    id: String,
    #[serde(rename = "runId")]
    run_id: String,
    baseline: String,
    scope: LegacyScope,
    before: String,
    after: Option<String>,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyScope {
    id: String,
    #[serde(default)]
    block_ids: Vec<String>,
}

/// The `host.json` envelope. `version`, `sequence`, and `drifted` are read
/// for validation only; the new world rebuilds its own counters.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyHost {
    version: u32,
    #[serde(default)]
    queue: Vec<LegacyTask>,
    #[serde(default)]
    runs: Vec<LegacyRun>,
}

/// One row of the old `verdicts` table (`ledger.ts`).
#[derive(Debug, Clone)]
struct LegacyVerdict {
    id: String,
    proposal_id: String,
    slice_id: Option<String>,
    kind: String,
    final_text: Option<String>,
    reason: Option<String>,
    baseline: String,
    decided_at: String,
}

/// A file the inventory found, with the bytes read lazily at build time.
#[derive(Debug, Clone)]
struct FoundFile {
    /// Root-relative, `/`-joined.
    relative: String,
    absolute: PathBuf,
}

/// The read-only view of the old project.
struct Inventory {
    agents: Option<Vec<LegacyAgent>>,
    agents_quarantine: Option<QuarantineItem>,
    host: Option<LegacyHost>,
    host_quarantine: Option<QuarantineItem>,
    verdicts: Option<Vec<LegacyVerdict>>,
    kara_notes_found: u32,
    verdicts_quarantine: Option<QuarantineItem>,
    manuscripts: Vec<FoundFile>,
    preserved: Vec<FoundFile>,
    run_dirs_on_disk: BTreeSet<String>,
    source_backup: SourceBackupState,
    source_backup_quarantine: Option<QuarantineItem>,
}

/// The legacy `.refrain-source` check: read-only, never regenerated (SPEC
/// 10.2). `Partial` is a quarantine stop; the bytes stay where they are.
#[derive(Debug, Clone, PartialEq, Eq)]
enum SourceBackupState {
    Complete { files: u32 },
    Partial { reason: String },
    Absent,
}

// ---- the plan ------------------------------------------------------------------

struct PlannedDocument {
    relative: String,
    absolute: PathBuf,
    role: DocumentRole,
    digest: String,
}

struct PlannedTask {
    id: String,
    baseline: String,
    progress_kind: String,
    entity: String,
}

struct PlannedRun {
    id: String,
    task_id: String,
    agent_id: String,
    progress_kind: String,
    entity: String,
}

struct PlannedProposal {
    id: String,
    run: String,
    baseline: String,
    document_path: String,
    scope: String,
    before_text: String,
    after_text: Option<String>,
}

struct PlannedVerdict {
    id: String,
    proposal_id: String,
    slice_id: Option<String>,
    kind: String,
    final_text: Option<String>,
    reason: Option<String>,
    decided_at: i64,
    legacy_baseline: String,
}

/// The verdicts plane, read out of the scratch copy: rows when the database
/// opened, the kara-note count either way, and the stop when it did not.
struct VerdictsPlane {
    rows: Option<Vec<LegacyVerdict>>,
    kara_notes_found: u32,
    quarantine: Option<QuarantineItem>,
}

struct Plan {
    documents: Vec<PlannedDocument>,
    /// Deduplicated by digest: (dropped legacy path, kept path, digest).
    deduped: Vec<(String, String, String)>,
    tasks: Vec<PlannedTask>,
    runs: Vec<PlannedRun>,
    proposals: Vec<PlannedProposal>,
    verdicts: Vec<PlannedVerdict>,
    preserved: Vec<FoundFile>,
    connections: Vec<HarnessConnection>,
    agent_map: Vec<AgentMapping>,
    quarantine: Vec<QuarantineItem>,
    counts: PlaneCounts,
    notes: Vec<String>,
}

// ---- entry point -------------------------------------------------------------

/// Migrate a v0.1.6 project at `legacy_root` into a new project at
/// `target_root`. The legacy Root is never written. Idempotent: a completed
/// migration (its completion mark, manifest, and database all present) makes
/// the second and later runs read the evidence back and write nothing.
pub fn migrate_legacy(
    legacy_root: &Path,
    target_root: &Path,
) -> Result<MigrationReport, MigrationFailure> {
    let legacy = fs::canonicalize(legacy_root)
        .map_err(|_| MigrationFailure::LegacyMissing(legacy_root.to_path_buf()))?;
    if !legacy.is_dir() {
        return Err(MigrationFailure::LegacyMissing(legacy_root.to_path_buf()));
    }
    if let Ok(target) = fs::canonicalize(target_root)
        && target == legacy
    {
        return Err(MigrationFailure::SameRoot);
    }

    let state_dir = target_root.join(STATE_DIR);
    let mark_path = state_dir.join(COMPLETION_MARK);
    let manifest_path = state_dir.join(LEGACY_BACKUP_DIR).join(MANIFEST_FILE);
    let db_path = state_dir.join(PROJECT_DB);

    // The idempotent path: mark + manifest + database all present, and the
    // manifest still hashes to what the mark recorded. Nothing is written.
    if mark_path.try_exists().map_err(io_fail(&mark_path))?
        && manifest_path
            .try_exists()
            .map_err(io_fail(&manifest_path))?
        && db_path.try_exists().map_err(io_fail(&db_path))?
    {
        let mark_bytes = fs::read(&mark_path).map_err(io_fail(&mark_path))?;
        let manifest_bytes = fs::read(&manifest_path).map_err(io_fail(&manifest_path))?;
        if let Ok(mark) = serde_json::from_slice::<CompletionMark>(&mark_bytes)
            && completion_mark_matches(&mark, &manifest_bytes)
        {
            let manifest: Manifest = serde_json::from_slice(&manifest_bytes).map_err(|error| {
                io_fail(&manifest_path)(io::Error::new(io::ErrorKind::InvalidData, error))
            })?;
            return Ok(report_from_manifest(manifest, target_root));
        }
        // A mark that does not match its manifest is not evidence: fall
        // through and rebuild, which is what a kill mid-install expects.
    }

    guard_target(target_root)?;

    let inventory = inventory(&legacy)?;
    let plan = plan(&inventory)?;
    build_and_install(&legacy, target_root, &plan)?;
    Ok(report_from_plan(plan, target_root))
}

/// The target must be empty, absent, or hold only this migration's own
/// artifacts. Anything else is a stranger's files: stop, do not merge. A
/// partial shadow, a preserved-planes directory, or a completion mark makes
/// the target ours; a real project has none of the three.
fn guard_target(target_root: &Path) -> Result<(), MigrationFailure> {
    if !target_root.try_exists().map_err(io_fail(target_root))? {
        return Ok(());
    }
    let state_dir = target_root.join(STATE_DIR);
    let ours = target_root
        .join(SHADOW_DIR)
        .try_exists()
        .map_err(io_fail(target_root))?
        || state_dir
            .join(LEGACY_BACKUP_DIR)
            .try_exists()
            .map_err(io_fail(&state_dir))?
        || state_dir
            .join(COMPLETION_MARK)
            .try_exists()
            .map_err(io_fail(&state_dir))?;
    if ours {
        return Ok(());
    }
    let mut entries = fs::read_dir(target_root).map_err(io_fail(target_root))?;
    if entries
        .next()
        .transpose()
        .map_err(io_fail(target_root))?
        .is_some()
    {
        return Err(MigrationFailure::TargetOccupied(target_root.to_path_buf()));
    }
    Ok(())
}

// ---- inventory: read every old plane, change nothing -------------------------

fn inventory(legacy: &Path) -> Result<Inventory, MigrationFailure> {
    let state = legacy.join(STATE_DIR);

    let (agents, agents_quarantine) =
        match read_json_plane::<Vec<LegacyAgent>>(&state.join("agents.json")) {
            Ok(parsed) => (parsed, None),
            Err(item) => (None, Some(item)),
        };
    let (host, host_quarantine) = match read_json_plane::<LegacyHost>(&state.join("host.json")) {
        Ok(Some(host)) if host.version != 2 => (
            None,
            Some(QuarantineItem {
                plane: "host.json".to_string(),
                kind: "plane-unparseable".to_string(),
                subject: state.join("host.json").display().to_string(),
                detail: format!(
                    "envelope version {} is not the v0.1.6 spelling (2)",
                    host.version
                ),
            }),
        ),
        Ok(parsed) => (parsed, None),
        Err(item) => (None, Some(item)),
    };
    let verdicts_plane = read_verdicts_plane(&state)?;

    let mut manuscripts = Vec::new();
    walk_files(legacy, legacy, &mut |absolute, relative| {
        if root::is_markdown_name(&relative) {
            manuscripts.push(FoundFile { relative, absolute });
        }
    })?;
    manuscripts.sort_by(|a, b| a.relative.cmp(&b.relative));

    let mut preserved = Vec::new();
    let mut run_dirs_on_disk = BTreeSet::new();
    if state.try_exists().map_err(io_fail(&state))? {
        walk_files(&state, &state, &mut |absolute, relative| {
            if let Some(run_dir) = relative.strip_prefix("runs/")
                && let Some(name) = run_dir.split('/').next()
            {
                run_dirs_on_disk.insert(name.to_string());
            }
            preserved.push(FoundFile { relative, absolute });
        })?;
        preserved.sort_by(|a, b| a.relative.cmp(&b.relative));
    }

    let (source_backup, source_backup_quarantine) = check_source_backup(legacy);
    Ok(Inventory {
        agents,
        agents_quarantine,
        host,
        host_quarantine,
        verdicts: verdicts_plane.rows,
        kara_notes_found: verdicts_plane.kara_notes_found,
        verdicts_quarantine: verdicts_plane.quarantine,
        manuscripts,
        preserved,
        run_dirs_on_disk,
        source_backup,
        source_backup_quarantine,
    })
}

/// A JSON plane that is absent is an empty plane; a JSON plane that does not
/// parse stops in the quarantine list and the rest of the migration goes on.
fn read_json_plane<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, QuarantineItem> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(QuarantineItem {
                plane: plane_name(path),
                kind: "plane-unreadable".to_string(),
                subject: path.display().to_string(),
                detail: "the file could not be read".to_string(),
            });
        }
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| QuarantineItem {
            plane: plane_name(path),
            kind: "plane-unparseable".to_string(),
            subject: path.display().to_string(),
            detail: error.to_string(),
        })
}

fn plane_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

/// Files under `base`, skipping every dot-entry at every level. `relative` is
/// `/`-joined and measured from `root`.
fn walk_files(
    base: &Path,
    root: &Path,
    visit: &mut impl FnMut(PathBuf, String),
) -> Result<(), MigrationFailure> {
    if !base.try_exists().map_err(io_fail(base))? {
        return Ok(());
    }
    for entry in fs::read_dir(base).map_err(io_fail(base))? {
        let entry = entry.map_err(io_fail(base))?;
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        let file_type = entry.file_type().map_err(io_fail(base))?;
        if file_type.is_dir() {
            walk_files(&path, root, visit)?;
        } else if file_type.is_file() {
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .components()
                .map(|component| component.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            visit(path, relative);
        }
    }
    Ok(())
}

/// The old verdicts database is copied to a scratch file first (db, then WAL
/// and SHM when present), so even SQLite's recovery never writes the
/// original. The copy is opened, read, and deleted.
fn read_verdicts_plane(state: &Path) -> Result<VerdictsPlane, MigrationFailure> {
    let db_path = state.join("verdicts.db");
    if !db_path.try_exists().map_err(io_fail(&db_path))? {
        return Ok(VerdictsPlane {
            rows: None,
            kara_notes_found: 0,
            quarantine: None,
        });
    }
    let scratch = std::env::temp_dir().join(format!("refrain-migrate-scratch-{}", Id::new()));
    fs::create_dir_all(&scratch).map_err(io_fail(&scratch))?;
    let result = read_verdicts_scratch(&db_path, &scratch);
    let _ = fs::remove_dir_all(&scratch);
    match result {
        Ok((rows, notes)) => Ok(VerdictsPlane {
            rows: Some(rows),
            kara_notes_found: notes,
            quarantine: None,
        }),
        Err(detail) => Ok(VerdictsPlane {
            rows: None,
            kara_notes_found: 0,
            quarantine: Some(QuarantineItem {
                plane: "verdicts.db".to_string(),
                kind: "plane-unreadable".to_string(),
                subject: db_path.display().to_string(),
                detail,
            }),
        }),
    }
}

fn read_verdicts_scratch(
    db_path: &Path,
    scratch: &Path,
) -> Result<(Vec<LegacyVerdict>, u32), String> {
    let copy = scratch.join("verdicts.db");
    fs::copy(db_path, &copy).map_err(|error| error.to_string())?;
    for sidecar in ["-wal", "-shm"] {
        let original = PathBuf::from(format!("{}{}", db_path.display(), sidecar));
        if original.try_exists().unwrap_or(false) {
            let target = scratch.join(format!("verdicts.db{sidecar}"));
            fs::copy(&original, &target).map_err(|error| error.to_string())?;
        }
    }
    let db = Connection::open(&copy).map_err(|error| error.to_string())?;
    let mut statement = db
        .prepare("SELECT id, proposal_id, slice_id, kind, final_text, reason, baseline, decided_at FROM verdicts")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(LegacyVerdict {
                id: row.get(0)?,
                proposal_id: row.get(1)?,
                slice_id: row.get(2)?,
                kind: row.get(3)?,
                final_text: row.get(4)?,
                reason: row.get(5)?,
                baseline: row.get(6)?,
                decided_at: row.get(7)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let kara_notes: u32 = db
        .query_row("SELECT count(*) FROM kara_notes", [], |row| row.get(0))
        .unwrap_or(0);
    Ok((rows, kara_notes))
}

/// The legacy backup check: the manifest is the completeness mark (a partial
/// copy never got one), and the file count must match it. Digests are the
/// health report's job; nothing here is regenerated or moved.
fn check_source_backup(legacy: &Path) -> (SourceBackupState, Option<QuarantineItem>) {
    let backup = legacy.join(root::SOURCE_BACKUP_DIR);
    let manifest = backup.join("taken.json");
    if !backup.try_exists().unwrap_or(false) {
        return (SourceBackupState::Absent, None);
    }
    #[derive(Deserialize)]
    struct Taken {
        files: u32,
    }
    let parsed = fs::read(&manifest)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Taken>(&bytes).ok());
    let Some(taken) = parsed else {
        let reason = "manifest taken.json missing or unreadable".to_string();
        return (
            SourceBackupState::Partial {
                reason: reason.clone(),
            },
            Some(QuarantineItem {
                plane: ".refrain-source".to_string(),
                kind: "partial-backup".to_string(),
                subject: backup.display().to_string(),
                detail: reason,
            }),
        );
    };
    let mut count: u32 = 0;
    let walked = walk_files(&backup, &backup, &mut |_, relative| {
        if relative != "taken.json" {
            count = count.saturating_add(1);
        }
    });
    if walked.is_err() || count != taken.files {
        let reason = format!("manifest lists {} files, {} found", taken.files, count);
        return (
            SourceBackupState::Partial {
                reason: reason.clone(),
            },
            Some(QuarantineItem {
                plane: ".refrain-source".to_string(),
                kind: "partial-backup".to_string(),
                subject: backup.display().to_string(),
                detail: reason,
            }),
        );
    }
    (SourceBackupState::Complete { files: taken.files }, None)
}

// ---- plan: every judgment is here, and every judgment call stops -------------

fn plan(inventory: &Inventory) -> Result<Plan, MigrationFailure> {
    let mut quarantine: Vec<QuarantineItem> = Vec::new();
    let mut counts = PlaneCounts::default();
    let mut notes: Vec<String> = Vec::new();
    for item in [
        &inventory.agents_quarantine,
        &inventory.host_quarantine,
        &inventory.verdicts_quarantine,
        &inventory.source_backup_quarantine,
    ]
    .into_iter()
    .flatten()
    {
        quarantine.push(item.clone());
    }
    match &inventory.source_backup {
        SourceBackupState::Complete { files } => {
            notes.push(format!("source backup: complete ({files} files)"));
        }
        SourceBackupState::Partial { reason } => {
            notes.push(format!("source backup: partial ({reason})"));
        }
        SourceBackupState::Absent => {
            notes.push("source backup: absent".to_string());
        }
    }
    notes.push("authorizations: the old host kept grants in memory; none to import".to_string());
    if inventory.kara_notes_found > 0 {
        notes.push(format!(
            "kara notes: {} row(s) preserved in legacy/verdicts.db; refrain.db has no table for them at schema v5",
            inventory.kara_notes_found
        ));
    }
    counts.kara_notes.found = inventory.kara_notes_found;
    counts.preserved_files.found = u32::try_from(inventory.preserved.len()).unwrap_or(u32::MAX);
    counts.preserved_files.imported = counts.preserved_files.found;

    // -- documents: walk order is sorted, so dedup keeps a stable winner.
    let mut documents = Vec::new();
    let mut deduped = Vec::new();
    let mut by_digest: BTreeMap<String, String> = BTreeMap::new();
    for file in &inventory.manuscripts {
        counts.documents.found += 1;
        if !file.relative.split('/').all(root::is_legal_segment) {
            counts.documents.quarantined += 1;
            quarantine.push(QuarantineItem {
                plane: "documents".to_string(),
                kind: "illegal-name".to_string(),
                subject: file.relative.clone(),
                detail: "a path segment is not a legal document name".to_string(),
            });
            continue;
        }
        let bytes = fs::read(&file.absolute).map_err(io_fail(&file.absolute))?;
        let digest = content_hex(&bytes);
        if let Some(kept) = by_digest.get(&digest) {
            deduped.push((file.relative.clone(), kept.clone(), digest));
            continue;
        }
        by_digest.insert(digest.clone(), file.relative.clone());
        documents.push(PlannedDocument {
            relative: file.relative.clone(),
            absolute: file.absolute.clone(),
            role: role_for(&file.relative),
            digest,
        });
        counts.documents.imported += 1;
    }

    // -- agents: file channel maps to L0, a command maps to a Connection when
    // its argv reads out, trust never crosses, model/effort stay requested.
    let mut connections = Vec::new();
    let mut agent_map = Vec::new();
    let mut agent_id_by_legacy: BTreeMap<String, String> = BTreeMap::new();
    if let Some(agents) = &inventory.agents {
        for agent in agents {
            counts.agents.found += 1;
            let legacy_requested = match (&agent.model, &agent.reasoning_effort) {
                (Some(model), Some(effort)) => Some((model.clone(), effort.clone())),
                (Some(model), None) => Some((model.clone(), String::new())),
                _ => None,
            };
            let outcome = map_agent(agent, &mut connections, &mut counts);
            if let AgentOutcome::Connection(id) = &outcome {
                agent_id_by_legacy.insert(agent.id.clone(), id.to_string());
            } else if matches!(outcome, AgentOutcome::FileChannel) {
                agent_id_by_legacy.insert(agent.id.clone(), L0_FILE_CHANNEL_AGENT.to_string());
            }
            agent_map.push(AgentMapping {
                legacy_id: agent.id.clone(),
                name: agent.name.clone(),
                outcome,
                legacy_requested,
            });
        }
    }

    // -- tasks and runs: queue first, then runs. A task with runs is open; a
    // queued task never dispatched stays a draft.
    let mut tasks: BTreeMap<String, PlannedTask> = BTreeMap::new();
    let mut conflicted_tasks: BTreeSet<String> = BTreeSet::new();
    if let Some(host) = &inventory.host {
        let mut seen_queue: BTreeMap<String, &LegacyTask> = BTreeMap::new();
        for task in &host.queue {
            counts.tasks.found += 1;
            if let Some(previous) = seen_queue.get(&task.id) {
                if *previous != task {
                    conflicted_tasks.insert(task.id.clone());
                }
                continue;
            }
            seen_queue.insert(task.id.clone(), task);
        }
        for task in seen_queue.values() {
            if conflicted_tasks.contains(&task.id) {
                counts.tasks.quarantined += 1;
                quarantine.push(QuarantineItem {
                    plane: "tasks".to_string(),
                    kind: "id-conflict".to_string(),
                    subject: task.id.clone(),
                    detail: "the same task id appears twice in the queue with different bodies; neither is chosen".to_string(),
                });
                continue;
            }
            let id = Id::new().to_string();
            tasks.insert(
                task.id.clone(),
                PlannedTask {
                    id: id.clone(),
                    baseline: task.baseline.clone(),
                    progress_kind: "draft".to_string(),
                    entity: entity_json("task", &task.id, task),
                },
            );
            counts.tasks.imported += 1;
        }

        // -- runs. The divergence stop (SPEC 10.2): wherever the same task id
        // shows two agent ids — queue against run, or run against run — the
        // later run stops. The first sighting of a task id pins its agent.
        let mut runs = Vec::new();
        let mut proposals = Vec::new();
        let mut task_agent_by_id: BTreeMap<String, String> = BTreeMap::new();
        for task in seen_queue.values() {
            if !conflicted_tasks.contains(&task.id) {
                task_agent_by_id.insert(task.id.clone(), task.agent_id.clone());
            }
        }
        let mut proposal_ids: BTreeMap<String, ()> = BTreeMap::new();
        let mut conflicted_proposals: BTreeSet<String> = BTreeSet::new();
        for run in &host.runs {
            counts.runs.found += 1;
            let reject = |kind: &str, detail: String, counts: &mut PlaneCounts| {
                counts.runs.quarantined += 1;
                counts.proposals.found += run.proposals.len() as u32;
                counts.proposals.quarantined += run.proposals.len() as u32;
                QuarantineItem {
                    plane: "runs".to_string(),
                    kind: kind.to_string(),
                    subject: run.id.clone(),
                    detail,
                }
            };
            if !matches!(
                run.state.as_str(),
                "dispatched" | "completed" | "failed" | "cancelled"
            ) {
                quarantine.push(reject(
                    "unknown-state",
                    format!("state {:?} is not a legacy run state", run.state),
                    &mut counts,
                ));
                continue;
            }
            if conflicted_tasks.contains(&run.task.id) {
                quarantine.push(reject(
                    "task-id-conflict",
                    format!("task {} is id-conflicted", run.task.id),
                    &mut counts,
                ));
                continue;
            }
            match task_agent_by_id.get(&run.task.id) {
                Some(pinned) if *pinned != run.task.agent_id => {
                    quarantine.push(reject(
                        "agent-divergence",
                        format!(
                            "task {} was first seen with agent {}, this run embeds agent {}",
                            run.task.id, pinned, run.task.agent_id
                        ),
                        &mut counts,
                    ));
                    continue;
                }
                Some(_) => {}
                None => {
                    task_agent_by_id.insert(run.task.id.clone(), run.task.agent_id.clone());
                }
            }
            // The task imports on its own merits: it is a fact the run rode
            // on, and only the run can fail its agent mapping.
            let task_row = tasks.entry(run.task.id.clone()).or_insert_with(|| {
                counts.tasks.found += 1;
                counts.tasks.imported += 1;
                PlannedTask {
                    id: Id::new().to_string(),
                    baseline: run.task.baseline.clone(),
                    progress_kind: "open".to_string(),
                    entity: entity_json("task", &run.task.id, &run.task),
                }
            });
            if task_row.progress_kind == "draft" {
                task_row.progress_kind = "open".to_string();
            }
            let task_row_id = task_row.id.clone();
            let Some(agent_id) = agent_id_by_legacy.get(&run.task.agent_id) else {
                quarantine.push(reject(
                    "unknown-agent",
                    format!("agent {} is not in the readable roster", run.task.agent_id),
                    &mut counts,
                ));
                continue;
            };
            let run_id = Id::new().to_string();
            runs.push(PlannedRun {
                id: run_id.clone(),
                task_id: task_row_id,
                agent_id: agent_id.clone(),
                progress_kind: run.state.clone(),
                entity: entity_json("run", &run.id, run),
            });
            counts.runs.imported += 1;

            for proposal in &run.proposals {
                counts.proposals.found += 1;
                if proposal_ids.insert(proposal.id.clone(), ()).is_some() {
                    conflicted_proposals.insert(proposal.id.clone());
                    continue;
                }
                let Some(block) = proposal.scope.block_ids.first() else {
                    counts.proposals.quarantined += 1;
                    quarantine.push(QuarantineItem {
                        plane: "proposals".to_string(),
                        kind: "scope-without-blocks".to_string(),
                        subject: proposal.id.clone(),
                        detail: "no block id to name the document".to_string(),
                    });
                    continue;
                };
                let document_path = block.split(':').next().unwrap_or_default().to_string();
                proposals.push(PlannedProposal {
                    id: proposal.id.clone(),
                    run: run_id.clone(),
                    baseline: proposal.baseline.clone(),
                    document_path,
                    scope: proposal.scope.id.clone(),
                    before_text: proposal.before.clone(),
                    after_text: proposal.after.clone(),
                });
                counts.proposals.imported += 1;
            }
        }
        // An id seen twice is a conflict: every row in the group is isolated,
        // never the one that looks newer (SPEC 10.2).
        for proposal_id in &conflicted_proposals {
            let before = proposals.len();
            proposals.retain(|planned| &planned.id != proposal_id);
            let removed = before - proposals.len();
            counts.proposals.imported -= removed as u32;
            counts.proposals.quarantined += removed as u32 + 1;
            quarantine.push(QuarantineItem {
                plane: "proposals".to_string(),
                kind: "id-conflict".to_string(),
                subject: proposal_id.clone(),
                detail: "the same proposal id appears more than once; every instance is isolated"
                    .to_string(),
            });
        }

        // -- orphaned run directories: on disk, in no record. The bytes are
        // preserved under .refrain/legacy either way; this is the report.
        let recorded_runs: BTreeSet<String> = host.runs.iter().map(|run| run.id.clone()).collect();
        for dir in inventory.run_dirs_on_disk.difference(&recorded_runs) {
            quarantine.push(QuarantineItem {
                plane: "runs".to_string(),
                kind: "orphaned-legacy-artifact".to_string(),
                subject: format!("runs/{dir}"),
                detail:
                    "a run directory on disk with no host.json record; bytes preserved with digests"
                        .to_string(),
            });
        }

        return Ok(Plan {
            documents,
            deduped,
            tasks: tasks.into_values().collect(),
            runs,
            proposals,
            verdicts: plan_verdicts(inventory, &mut counts, &mut quarantine),
            preserved: inventory.preserved.clone(),
            connections,
            agent_map,
            quarantine,
            counts,
            notes,
        });
    }

    // No readable host plane: tasks, runs, and proposals stay empty; the
    // quarantine entry from the inventory already says why.
    Ok(Plan {
        documents,
        deduped,
        tasks: tasks.into_values().collect(),
        runs: Vec::new(),
        proposals: Vec::new(),
        verdicts: plan_verdicts(inventory, &mut counts, &mut quarantine),
        preserved: inventory.preserved.clone(),
        connections,
        agent_map,
        quarantine,
        counts,
        notes,
    })
}

/// The migration-time role hint (SPEC 10.2): top level is a chapter, a
/// Material-named directory is Material, anything else nested is a plain
/// Document for the author to classify.
fn role_for(relative: &str) -> DocumentRole {
    let mut parts = relative.split('/');
    match (parts.next(), parts.next()) {
        (_, None) => DocumentRole::Chapter,
        (Some(first), Some(_)) if MATERIAL_DIR_NAMES.contains(&first) => DocumentRole::Material,
        _ => DocumentRole::Document,
    }
}

/// One legacy agent to its outcome. A command harness keeps its argv
/// verbatim; the adapter kind is identified from the executable's name, and a
/// name that identifies nothing records `unavailable` — never a guess.
fn map_agent(
    agent: &LegacyAgent,
    connections: &mut Vec<HarnessConnection>,
    counts: &mut PlaneCounts,
) -> AgentOutcome {
    if agent.harness == "file" {
        counts.agents.imported += 1;
        return AgentOutcome::FileChannel;
    }
    if !agent.harness.starts_with("command:") {
        return AgentOutcome::Unavailable(format!(
            "harness {:?} is neither file nor command",
            agent.harness
        ));
    }
    let template = agent.template.clone().unwrap_or_default();
    let Some(executable) = template.first() else {
        return AgentOutcome::Unavailable("a command harness without an argv template".to_string());
    };
    let Some(adapter) = adapter_for(executable) else {
        return AgentOutcome::Unavailable(format!(
            "no adapter kind identifies with {executable:?}"
        ));
    };
    let connection = HarnessConnection {
        id: Id::new(),
        adapter,
        executable: PathBuf::from(executable),
        argv: template[1..].to_vec(),
        env_allow: Vec::new(),
    };
    let id = connection.id;
    connections.push(connection);
    counts.agents.imported += 1;
    AgentOutcome::Connection(id)
}

/// Identify the adapter kind from the executable's file stem. Identification
/// by name, not by guess: no match, no connection.
fn adapter_for(executable: &str) -> Option<AdapterKind> {
    let stem = Path::new(executable)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    if stem.contains("claude") {
        Some(AdapterKind::ClaudeCode)
    } else if stem.contains("codex") {
        Some(AdapterKind::Codex)
    } else if stem.contains("kimi") {
        Some(AdapterKind::KimiCode)
    } else if stem.contains("hermes") {
        Some(AdapterKind::Hermes)
    } else if stem.contains("pi") {
        Some(AdapterKind::Pi)
    } else {
        None
    }
}

/// Verdict rows: bad rows are isolated one by one; the rest import. The old
/// ISO time parses or the row stops. An accept-modified without its final
/// text is corruption (legacy `decision-batch.ts` made the pair inseparable).
fn plan_verdicts(
    inventory: &Inventory,
    counts: &mut PlaneCounts,
    quarantine: &mut Vec<QuarantineItem>,
) -> Vec<PlannedVerdict> {
    let mut planned = Vec::new();
    let mut seen: BTreeMap<String, ()> = BTreeMap::new();
    let mut conflicted: BTreeSet<String> = BTreeSet::new();
    let Some(rows) = &inventory.verdicts else {
        return planned;
    };
    for row in rows {
        counts.verdicts.found += 1;
        if seen.insert(row.id.clone(), ()).is_some() {
            conflicted.insert(row.id.clone());
            continue;
        }
        let reject = |kind: &str, detail: String, counts: &mut PlaneCounts| {
            counts.verdicts.quarantined += 1;
            QuarantineItem {
                plane: "verdicts".to_string(),
                kind: kind.to_string(),
                subject: row.id.clone(),
                detail,
            }
        };
        if row.id.is_empty() {
            quarantine.push(reject(
                "empty-id",
                "an empty verdict id".to_string(),
                counts,
            ));
            continue;
        }
        if !matches!(
            row.kind.as_str(),
            "accept" | "accept-modified" | "reject" | "comment-only"
        ) {
            quarantine.push(reject(
                "unknown-kind",
                format!("kind {:?} is not a verdict kind", row.kind),
                counts,
            ));
            continue;
        }
        if row.kind == "accept-modified" && row.final_text.is_none() {
            quarantine.push(reject(
                "missing-final-text",
                "accept-modified without its final text".to_string(),
                counts,
            ));
            continue;
        }
        if row.slice_id.is_none() {
            quarantine.push(reject(
                "missing-slice-id",
                "the new ledger cannot name a verdict without a slice".to_string(),
                counts,
            ));
            continue;
        }
        let Some(decided_at) = parse_iso_utc_millis(&row.decided_at) else {
            quarantine.push(reject(
                "bad-time",
                format!("decided_at {:?} is not an ISO-UTC stamp", row.decided_at),
                counts,
            ));
            continue;
        };
        planned.push(PlannedVerdict {
            id: row.id.clone(),
            proposal_id: row.proposal_id.clone(),
            slice_id: row.slice_id.clone(),
            kind: row.kind.clone(),
            final_text: row.final_text.clone(),
            reason: row.reason.clone(),
            decided_at,
            legacy_baseline: row.baseline.clone(),
        });
        counts.verdicts.imported += 1;
    }
    for id in &conflicted {
        let before = planned.len();
        planned.retain(|verdict| &verdict.id != id);
        let removed = before - planned.len();
        counts.verdicts.imported -= removed as u32;
        counts.verdicts.quarantined += removed as u32 + 1;
        quarantine.push(QuarantineItem {
            plane: "verdicts".to_string(),
            kind: "id-conflict".to_string(),
            subject: id.clone(),
            detail: "the same verdict id appears more than once; every instance is isolated"
                .to_string(),
        });
    }
    planned
}

/// The entity column: the whole old fact verbatim, plus its old identity.
fn entity_json<T: Serialize>(kind: &str, legacy_id: &str, value: &T) -> String {
    serde_json::json!({
        "migratedFrom": "v0.1.6",
        "kind": kind,
        "legacyId": legacy_id,
        "entity": value,
    })
    .to_string()
}

// ---- build and install: shadow first, the completion mark last ---------------

fn build_and_install(
    legacy: &Path,
    target_root: &Path,
    plan: &Plan,
) -> Result<(), MigrationFailure> {
    let shadow = target_root.join(SHADOW_DIR);
    if shadow.try_exists().map_err(io_fail(&shadow))? {
        // A kill mid-build left the partial shadow. It is never resumed:
        // rebuilding is deterministic, and partial is not a base to trust.
        fs::remove_dir_all(&shadow).map_err(io_fail(&shadow))?;
    }
    fs::create_dir_all(&shadow).map_err(io_fail(&shadow))?;

    // Manuscripts land through the atomic writer: per-file atomic, and a
    // rerun rewrites the same bytes.
    for document in &plan.documents {
        let bytes = fs::read(&document.absolute).map_err(io_fail(&document.absolute))?;
        atomic::replace_file_atomically(&target_root.join(&document.relative), &bytes, |_| Ok(()))
            .map_err(io_fail(&document.absolute))?;
    }

    // The shadow database: schema ladder first, then one transaction for
    // every imported row, migration_log included.
    let shadow_db = shadow.join(PROJECT_DB);
    let mut db = Connection::open(&shadow_db)?;
    ProjectDb::migrate(&mut db)?;
    {
        let tx = db.transaction()?;
        for document in &plan.documents {
            tx.execute(
                "INSERT INTO documents (id, path, role, digest, legacy_id) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    Id::new().to_string(),
                    document.relative,
                    document.role.as_str(),
                    document.digest,
                    document.relative,
                ],
            )?;
        }
        for task in &plan.tasks {
            tx.execute(
                "INSERT INTO tasks (id, baseline, progress_kind, entity) VALUES (?1, ?2, ?3, ?4)",
                params![task.id, task.baseline, task.progress_kind, task.entity],
            )?;
        }
        for run in &plan.runs {
            tx.execute(
                "INSERT INTO runs (id, task_id, agent_id, progress_kind, retry_of, entity)
                 VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
                params![
                    run.id,
                    run.task_id,
                    run.agent_id,
                    run.progress_kind,
                    run.entity
                ],
            )?;
        }
        for proposal in &plan.proposals {
            // The old host recorded no time for a proposal; zero is the
            // honest stamp, and it keeps a rebuild deterministic.
            tx.execute(
                "INSERT INTO proposals (id, run, baseline, document_path, scope, before_text, after_text, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
                params![
                    proposal.id,
                    proposal.run,
                    proposal.baseline,
                    proposal.document_path,
                    proposal.scope,
                    proposal.before_text,
                    proposal.after_text,
                ],
            )?;
        }
        for verdict in &plan.verdicts {
            tx.execute(
                "INSERT INTO verdicts (id, proposal_id, slice_id, kind, final_text, reason, decided_at, legacy_baseline)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    verdict.id,
                    verdict.proposal_id,
                    verdict.slice_id,
                    verdict.kind,
                    verdict.final_text,
                    verdict.reason,
                    verdict.decided_at,
                    verdict.legacy_baseline,
                ],
            )?;
        }
        tx.execute(
            "INSERT INTO migration_log (id, applied_at, name) VALUES (?1, ?2, ?3)",
            params![
                Id::new().to_string(),
                format_iso_utc(now_millis()),
                MIGRATION_NAME
            ],
        )?;
        tx.commit()?;
    }

    // Shadow verification (SPEC 10.3): the row counts must equal the plan.
    verify_counts(&db, plan)?;
    // Fold the WAL back into one self-contained file, then install.
    db.pragma_update(None, "journal_mode", "DELETE")?;
    drop(db);

    let state_dir = target_root.join(STATE_DIR);
    let backup_dir = state_dir.join(LEGACY_BACKUP_DIR);
    // The legacy directory comes first: from here on the target always
    // carries one of our markers, so a kill stays rerunnable.
    fs::create_dir_all(&backup_dir).map_err(io_fail(&backup_dir))?;
    let db_target = state_dir.join(PROJECT_DB);
    for residue in [
        db_target.clone(),
        state_dir.join(format!("{PROJECT_DB}-wal")),
        state_dir.join(format!("{PROJECT_DB}-shm")),
    ] {
        if residue.try_exists().map_err(io_fail(&residue))? {
            fs::remove_file(&residue).map_err(io_fail(&residue))?;
        }
    }
    fs::rename(&shadow_db, &db_target).map_err(io_fail(&shadow_db))?;
    fs::remove_dir_all(&shadow).map_err(io_fail(&shadow))?;

    // The v1 backup: every old plane byte-for-byte, then the digest manifest,
    // then the completion mark — last of all, always.
    let mut preserved_entries: Vec<ManifestFile> = Vec::new();
    for file in &plan.preserved {
        let bytes = fs::read(&file.absolute).map_err(io_fail(&file.absolute))?;
        preserved_entries.push(ManifestFile {
            path: file.relative.clone(),
            digest: content_hex(&bytes),
            bytes: bytes.len() as u64,
        });
        atomic::replace_file_atomically(&backup_dir.join(&file.relative), &bytes, |_| Ok(()))
            .map_err(io_fail(&file.absolute))?;
    }

    let manifest = build_manifest(legacy, plan, preserved_entries);
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|error| {
        io_fail(&backup_dir.join(MANIFEST_FILE))(io::Error::new(io::ErrorKind::InvalidData, error))
    })?;
    atomic::replace_file_atomically(&backup_dir.join(MANIFEST_FILE), &manifest_bytes, |_| Ok(()))
        .map_err(io_fail(&backup_dir.join(MANIFEST_FILE)))?;

    let mark = CompletionMark {
        version: COMPLETION_MARK_VERSION,
        finished_at_ms: now_millis(),
        manifest_digest: content_hex(&manifest_bytes),
    };
    let mark_bytes = serde_json::to_vec_pretty(&mark).map_err(|error| {
        io_fail(&state_dir.join(COMPLETION_MARK))(io::Error::new(io::ErrorKind::InvalidData, error))
    })?;
    atomic::replace_file_atomically(&state_dir.join(COMPLETION_MARK), &mark_bytes, |_| Ok(()))
        .map_err(io_fail(&state_dir.join(COMPLETION_MARK)))?;
    Ok(())
}

fn verify_counts(db: &Connection, plan: &Plan) -> Result<(), MigrationFailure> {
    let count = |table: &str| -> Result<u32, MigrationFailure> {
        Ok(
            db.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })?,
        )
    };
    let expect = [
        ("documents", plan.counts.documents.imported),
        ("tasks", plan.counts.tasks.imported),
        ("runs", plan.counts.runs.imported),
        ("proposals", plan.counts.proposals.imported),
        ("verdicts", plan.counts.verdicts.imported),
        ("migration_log", 1),
    ];
    for (table, wanted) in expect {
        let found = count(table)?;
        if found != wanted {
            return Err(MigrationFailure::Store(StoreError::Sqlite(
                rusqlite::Error::StatementChangedRows(0),
            )));
        }
    }
    Ok(())
}

// ---- the manifest and the report ----------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestFile {
    path: String,
    digest: String,
    bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestDocument {
    path: String,
    role: String,
    digest: String,
    legacy_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestDedup {
    dropped: String,
    kept: String,
    digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Manifest {
    version: u32,
    migrated_from: String,
    legacy_root: String,
    status: MigrationStatus,
    counts: PlaneCounts,
    quarantine: Vec<QuarantineItem>,
    agent_map: Vec<AgentMapping>,
    connections: Vec<HarnessConnection>,
    documents: Vec<ManifestDocument>,
    deduped: Vec<ManifestDedup>,
    preserved_files: Vec<ManifestFile>,
    notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CompletionMark {
    version: u32,
    finished_at_ms: u64,
    manifest_digest: String,
}

fn completion_mark_matches(mark: &CompletionMark, manifest: &[u8]) -> bool {
    mark.version == COMPLETION_MARK_VERSION && mark.manifest_digest == content_hex(manifest)
}

fn status_of(plan: &Plan) -> MigrationStatus {
    if plan.quarantine.is_empty() {
        MigrationStatus::Completed
    } else {
        MigrationStatus::QuarantinedItems
    }
}

fn build_manifest(legacy: &Path, plan: &Plan, preserved: Vec<ManifestFile>) -> Manifest {
    Manifest {
        version: 1,
        migrated_from: MIGRATION_NAME.to_string(),
        legacy_root: legacy.display().to_string(),
        status: status_of(plan),
        counts: plan.counts.clone(),
        quarantine: plan.quarantine.clone(),
        agent_map: plan.agent_map.clone(),
        connections: plan.connections.clone(),
        documents: plan
            .documents
            .iter()
            .map(|document| ManifestDocument {
                path: document.relative.clone(),
                role: document.role.as_str().to_string(),
                digest: document.digest.clone(),
                legacy_path: document.relative.clone(),
            })
            .collect(),
        deduped: plan
            .deduped
            .iter()
            .map(|(dropped, kept, digest)| ManifestDedup {
                dropped: dropped.clone(),
                kept: kept.clone(),
                digest: digest.clone(),
            })
            .collect(),
        preserved_files: preserved,
        notes: plan.notes.clone(),
    }
}

fn report_from_plan(plan: Plan, target_root: &Path) -> MigrationReport {
    MigrationReport {
        status: status_of(&plan),
        planes: plan.counts,
        quarantine: plan.quarantine,
        manifest_path: target_root
            .join(STATE_DIR)
            .join(LEGACY_BACKUP_DIR)
            .join(MANIFEST_FILE),
        connections: plan.connections,
        agent_map: plan.agent_map,
        target_root: target_root.to_path_buf(),
    }
}

/// A rerun with the mark in place rebuilds the report from the stored
/// manifest and writes nothing.
fn report_from_manifest(manifest: Manifest, target_root: &Path) -> MigrationReport {
    MigrationReport {
        status: manifest.status,
        planes: manifest.counts,
        quarantine: manifest.quarantine,
        manifest_path: target_root
            .join(STATE_DIR)
            .join(LEGACY_BACKUP_DIR)
            .join(MANIFEST_FILE),
        connections: manifest.connections,
        agent_map: manifest.agent_map,
        target_root: target_root.to_path_buf(),
    }
}

// ---- time, in the one spelling the old world wrote ----------------------------

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

/// `new Date().toISOString()` is the only shape the old ledger wrote:
/// `YYYY-MM-DDTHH:MM:SS(.sss)?Z`. Anything else is not a legacy stamp.
fn parse_iso_utc_millis(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() != 20 && bytes.len() != 24 {
        return None;
    }
    if bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
        || bytes.last() != Some(&b'Z')
    {
        return None;
    }
    if bytes.len() == 24 && bytes.get(19) != Some(&b'.') {
        return None;
    }
    let year: i64 = text.get(0..4)?.parse().ok()?;
    let month: i64 = text.get(5..7)?.parse().ok()?;
    let day: i64 = text.get(8..10)?.parse().ok()?;
    let hour: i64 = text.get(11..13)?.parse().ok()?;
    let minute: i64 = text.get(14..16)?.parse().ok()?;
    let second: i64 = text.get(17..19)?.parse().ok()?;
    let millis: i64 = if bytes.len() == 24 {
        text.get(20..23)?.parse().ok()?
    } else {
        0
    };
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some((((days * 24 + hour) * 60 + minute) * 60 + second) * 1000 + millis)
}

/// Days since the Unix epoch (Howard Hinnant's civil calendar algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// The inverse of `days_from_civil`, for the migration_log stamp.
fn format_iso_utc(millis: u64) -> String {
    let days = (millis / 86_400_000) as i64;
    let within = millis % 86_400_000;
    let hour = within / 3_600_000;
    let minute = (within % 3_600_000) / 60_000;
    let second = (within % 60_000) / 1000;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.000Z")
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let doe = days - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod completion_mark_tests {
    use super::*;

    #[test]
    fn completion_marks_use_blake3_and_unknown_versions_refuse() {
        let manifest = b"current manifest";
        let current = CompletionMark {
            version: COMPLETION_MARK_VERSION,
            finished_at_ms: 0,
            manifest_digest: content_hex(manifest),
        };
        let unknown = CompletionMark {
            version: COMPLETION_MARK_VERSION + 1,
            ..current.clone()
        };

        assert!(completion_mark_matches(&current, manifest));
        assert!(!completion_mark_matches(&unknown, manifest));
    }
}
