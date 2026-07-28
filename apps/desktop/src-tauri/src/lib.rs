//! Composition layer.
//!
//! Every command here is a one-line mapping onto a named use case. No business
//! state lives in this crate, and no domain rule is decided here (SPEC 6.2).
//! The session map holds live handles — open stores and manuscripts — which
//! are runtime objects, not a second copy of business state.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use refrain_core::{
    DocumentRole, EditorAction, EditorChange, ErrorCode, Id, Insertion, Lineage, Manuscript,
    RefrainError, Replacement, SourceSnapshot, TextCommand,
};
use refrain_store::project::{
    BackupStatus, DocumentCommit, DocumentRow, FileStamp, ProjectFailure, ProjectStore, RootLocator,
};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::Manager;
use tauri_specta::{Builder, collect_commands};

/// The commit this build was made from. Set by CI; absent in a local build,
/// and absent is reported as absent rather than as an empty string (INV-3's
/// discipline applied to identity: unknown is a value, not a blank).
const COMMIT: Option<&str> = option_env!("REFRAIN_COMMIT");

/// Live handles for one adopted Root: its store and the manuscripts opened
/// in this session.
struct ProjectEntry {
    store: ProjectStore,
    manuscripts: HashMap<String, Manuscript>,
}

/// Session state. `app.db` is the machine-level authority; projects are
/// opened through it.
pub struct AppState {
    app_db: Mutex<Connection>,
    projects: Mutex<HashMap<String, ProjectEntry>>,
}

impl AppState {
    fn open(app_data_dir: &Path) -> Result<Self, RefrainError> {
        std::fs::create_dir_all(app_data_dir).map_err(|error| {
            RefrainError::new(
                ErrorCode::Io,
                "create the application data directory",
                app_data_dir.display().to_string(),
            )
            .with_detail(error.to_string())
        })?;
        let mut app_db = Connection::open(app_data_dir.join("app.db")).map_err(|error| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "open app.db",
                app_data_dir.display().to_string(),
            )
            .with_detail(error.to_string())
        })?;
        AppDb::migrate(&mut app_db).map_err(|error| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "migrate app.db",
                app_data_dir.display().to_string(),
            )
            .with_detail(error.to_string())
        })?;
        Ok(Self {
            app_db: Mutex::new(app_db),
            projects: Mutex::new(HashMap::new()),
        })
    }

    fn with_project<T>(
        &self,
        root_id: &str,
        use_entry: impl FnOnce(&mut ProjectEntry) -> Result<T, RefrainError>,
    ) -> Result<T, RefrainError> {
        let mut projects = self.projects.lock().map_err(|_| {
            RefrainError::new(ErrorCode::StateUnavailable, "lock the project map", root_id)
        })?;
        let entry = projects.get_mut(root_id).ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "use a Root that is not open",
                root_id,
            )
        })?;
        use_entry(entry)
    }

    fn adopt(
        &self,
        locator: &RootLocator,
    ) -> Result<(String, BackupStatus, Vec<DocumentRow>), RefrainError> {
        let mut app_db = self
            .app_db
            .lock()
            .map_err(|_| RefrainError::new(ErrorCode::StateUnavailable, "lock app.db", "adopt"))?;
        let (mut store, backup) = ProjectStore::adopt(&mut app_db, locator).map_err(into_domain)?;
        let root_id = store.permit().root_id.to_string();
        let documents = store.refresh_documents().map_err(into_domain)?;
        let entry = ProjectEntry {
            store,
            manuscripts: HashMap::new(),
        };
        self.projects
            .lock()
            .map_err(|_| {
                RefrainError::new(ErrorCode::StateUnavailable, "lock the project map", "adopt")
            })?
            .insert(root_id.clone(), entry);
        Ok((root_id, backup, documents))
    }
}

/// A Root as the interface names it.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOpenedDto {
    pub root_id: String,
    pub backup: BackupStatus,
    pub documents: Vec<DocumentRow>,
}

/// A document ready for the editor: blocks with stable ids, the revision the
/// editor's actions will be based on, and the stamp a later save needs.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenDocumentDto {
    pub document: DocumentRow,
    pub revision: String,
    pub blocks: Vec<BlockDto>,
    pub stamp: FileStamp,
    /// Journaled actions replayed on open (crash survivors), for the status line.
    pub replayed: u32,
    /// Journaled actions that could not be validated on open: Safety content.
    pub stale_journal: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BlockDto {
    pub id: String,
    pub text: String,
}

/// The editor's settled input, as it crosses the bridge.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EditorActionDto {
    pub base: String,
    pub changes: Vec<EditorChangeDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum EditorChangeDto {
    Replace {
        blocks: Vec<String>,
        text: Option<String>,
    },
    Insert {
        before: Option<String>,
        texts: Vec<String>,
    },
}

/// The confirmed outcome of one applied action.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextTransitionDto {
    pub revision: String,
    pub action_id: String,
    pub touched_blocks: Vec<String>,
}

/// What a save became. `ChangedUnderneath` is a Safety surface, not an error.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum SaveOutcomeDto {
    Saved {
        stamp: FileStamp,
        #[serde(rename = "recoveryEvidence")]
        recovery_evidence: Option<String>,
    },
    ChangedUnderneath {
        #[serde(rename = "onDisk")]
        on_disk: String,
        stamp: FileStamp,
    },
}

fn parse_id(raw: &str, what: &str) -> Result<Id, RefrainError> {
    raw.parse::<uuid::Uuid>()
        .map(Id::from_uuid)
        .map_err(|error| {
            RefrainError::new(ErrorCode::Io, "parse an id", raw)
                .with_detail(format!("{what}: {error}"))
        })
}

/// Project failures become typed bridge errors. A changed-underneath conflict
/// is save data (SaveOutcomeDto) and never reaches here.
fn into_domain(failure: ProjectFailure) -> RefrainError {
    match failure {
        ProjectFailure::Domain(error) => error,
        ProjectFailure::RootMissing(path) => RefrainError::new(
            ErrorCode::NotADirectory,
            "adopt a Root",
            path.display().to_string(),
        ),
        ProjectFailure::IdentityChanged {
            path,
            stored,
            found,
        } => RefrainError::new(
            ErrorCode::StateUnavailable,
            "adopt a Root whose identity moved",
            path.display().to_string(),
        )
        .with_detail(format!("stored {stored}, found {found}")),
        ProjectFailure::ChangedUnderneath(_) => RefrainError::new(
            ErrorCode::StateUnavailable,
            "report a conflict as an error (a defect: conflicts are data)",
            "save",
        ),
        ProjectFailure::NotADocument(path) => RefrainError::new(
            ErrorCode::UnsupportedFormat,
            "open as a document",
            path.display().to_string(),
        ),
        ProjectFailure::Io { path, source } => {
            RefrainError::new(ErrorCode::Io, "file I/O", path.display().to_string())
                .with_detail(source.to_string())
        }
        ProjectFailure::Store(error) => RefrainError::new(
            ErrorCode::StateUnavailable,
            "project database",
            "refrain.db",
        )
        .with_detail(error.to_string()),
    }
}

/// Proves the whole chain: a Rust type, a generated binding, a real window.
#[tauri::command]
#[specta::specta]
fn health(echo: String) -> refrain_core::HealthReport {
    let report = refrain_core::health(echo, env!("CARGO_PKG_VERSION"), COMMIT);

    if let Ok(path) = std::env::var("REFRAIN_PROBE_EVIDENCE")
        && let Ok(json) = serde_json::to_string_pretty(&report)
    {
        let _ = std::fs::write(path, json);
    }

    report
}

/// Adopt an existing folder or single file as a Root (SPEC 9.5).
#[tauri::command]
#[specta::specta]
fn adopt_root(
    state: tauri::State<'_, AppState>,
    path: String,
    kind: RootKind,
) -> Result<ProjectOpenedDto, RefrainError> {
    let locator = RootLocator {
        path: PathBuf::from(&path),
        kind,
    };
    let (root_id, backup, documents) = state.adopt(&locator)?;
    Ok(ProjectOpenedDto {
        root_id,
        backup,
        documents,
    })
}

/// Create a project: the author picks a parent directory and names the
/// project; Rust creates the subdirectory and adopts it (SPEC 9.5).
#[tauri::command]
#[specta::specta]
fn create_project(
    state: tauri::State<'_, AppState>,
    parent: String,
    name: String,
) -> Result<ProjectOpenedDto, RefrainError> {
    if !refrain_store::root::is_legal_segment(&name) {
        return Err(RefrainError::new(
            ErrorCode::IllegalName,
            "create a project named",
            name,
        ));
    }
    let path = PathBuf::from(&parent).join(&name);
    if path.try_exists().map_err(|error| {
        RefrainError::new(
            ErrorCode::Io,
            "check a project path",
            path.display().to_string(),
        )
        .with_detail(error.to_string())
    })? {
        return Err(RefrainError::new(
            ErrorCode::Occupied,
            "create a project at",
            path.display().to_string(),
        ));
    }
    std::fs::create_dir_all(&path).map_err(|error| {
        RefrainError::new(
            ErrorCode::Io,
            "create a project directory",
            path.display().to_string(),
        )
        .with_detail(error.to_string())
    })?;
    adopt_root(state, path.to_string_lossy().into_owned(), RootKind::Folder)
}

/// Open a document: bytes from disk, blocks from the byte-authoritative
/// layout, the persisted revision chain resumed, and any journaled actions
/// replayed through the same validation (SPEC 7.2).
#[tauri::command]
#[specta::specta]
fn open_document(
    state: tauri::State<'_, AppState>,
    root_id: String,
    path: String,
) -> Result<OpenDocumentDto, RefrainError> {
    state.with_project(&root_id, |entry| {
        let opened = entry.store.open_document(&path).map_err(into_domain)?;
        open_in_entry(entry, &path, opened)
    })
}

/// Create a document in the Root and open it (SPEC 9.5).
#[tauri::command]
#[specta::specta]
fn create_document(
    state: tauri::State<'_, AppState>,
    root_id: String,
    title: String,
    role: DocumentRole,
) -> Result<OpenDocumentDto, RefrainError> {
    state.with_project(&root_id, |entry| {
        let created = entry
            .store
            .create(&refrain_store::project::CreateDocument {
                title: title.clone(),
                role,
            })
            .map_err(into_domain)?;
        let path = created.row.path.clone();
        open_in_entry(entry, &path, created)
    })
}

/// The shared tail of open/create: build or resume the manuscript and replay
/// the journal.
fn open_in_entry(
    entry: &mut ProjectEntry,
    path: &str,
    opened: refrain_store::project::OpenDocument,
) -> Result<OpenDocumentDto, RefrainError> {
    let snapshot = SourceSnapshot::read(opened.bytes.clone());
    let block_count = snapshot.block_count();

    // Resume the persisted chain only when the digest on disk is the one the
    // continuity belongs to; anything else is a fresh lineage, and journaled
    // actions from the old chain are stale evidence, not text.
    let continuity = match (
        &opened.row.current_head,
        &opened.row.head_block_ids,
        &opened.row.digest,
    ) {
        (Some(head), Some(ids), Some(digest)) if digest == &opened.stamp.digest => {
            let ids: Vec<Id> = serde_json::from_str(ids).unwrap_or_default();
            if ids.len() == block_count {
                parse_id(head, "current head")
                    .ok()
                    .map(|head| (head, Lineage::from_ids(ids)))
            } else {
                None
            }
        }
        _ => None,
    };

    let (mut manuscript, continuity_ok) = match continuity {
        Some((head, lineage)) => (
            Manuscript::open_at(snapshot, lineage, head).map_err(|error| {
                RefrainError::new(ErrorCode::Io, "resume a manuscript", path)
                    .with_detail(error.to_string())
            })?,
            true,
        ),
        None => (
            Manuscript::open(snapshot, Lineage::fresh(block_count)).map_err(|error| {
                RefrainError::new(ErrorCode::Io, "open a manuscript", path)
                    .with_detail(error.to_string())
            })?,
            false,
        ),
    };

    let mut replayed = 0_u32;
    let mut stale_journal: Vec<String> = Vec::new();
    for (journal_id, action_json) in entry.store.journal_take(path).map_err(into_domain)? {
        if !continuity_ok {
            stale_journal.push(action_json);
            continue;
        }
        let dto: EditorActionDto = match serde_json::from_str(&action_json) {
            Ok(dto) => dto,
            Err(_) => {
                stale_journal.push(action_json);
                continue;
            }
        };
        match to_domain_action(dto) {
            Ok(action) => match manuscript.execute(TextCommand::Editor(action)) {
                Ok(_) => {
                    entry
                        .store
                        .journal_remove(journal_id)
                        .map_err(into_domain)?;
                    replayed += 1;
                }
                Err(_) => stale_journal.push(action_json),
            },
            Err(_) => stale_journal.push(action_json),
        }
    }

    let revision = manuscript.head().id().to_string();
    let blocks = manuscript
        .head()
        .blocks()
        .iter()
        .map(|block| BlockDto {
            id: block.id().to_string(),
            text: block.text().to_owned(),
        })
        .collect();
    entry.manuscripts.insert(path.to_string(), manuscript);

    Ok(OpenDocumentDto {
        document: opened.row,
        revision,
        blocks,
        stamp: opened.stamp,
        replayed,
        stale_journal,
    })
}

/// The session's current view of an open document: the confirmed head, no
/// disk read, no journal replay. The editor re-syncs its projection from
/// here after a structural change, where the domain minted new block ids.
/// No stamp: the CAS a save needs comes only from disk truth (SPEC 7.2).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionDocumentDto {
    pub revision: String,
    pub blocks: Vec<BlockDto>,
}

#[tauri::command]
#[specta::specta]
fn current_document(
    state: tauri::State<'_, AppState>,
    root_id: String,
    path: String,
) -> Result<SessionDocumentDto, RefrainError> {
    state.with_project(&root_id, |entry| {
        let manuscript = entry.manuscripts.get(&path).ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "read a document that is not open",
                path.clone(),
            )
        })?;
        Ok(SessionDocumentDto {
            revision: manuscript.head().id().to_string(),
            blocks: manuscript
                .head()
                .blocks()
                .iter()
                .map(|block| BlockDto {
                    id: block.id().to_string(),
                    text: block.text().to_owned(),
                })
                .collect(),
        })
    })
}

/// The one manuscript write path (INV-2): journaled first, executed through
/// the domain, cleared on confirmation. A kill between journal and execute
/// replays on the next open.
#[tauri::command]
#[specta::specta]
fn apply_editor_action(
    state: tauri::State<'_, AppState>,
    root_id: String,
    path: String,
    action: EditorActionDto,
) -> Result<TextTransitionDto, RefrainError> {
    state.with_project(&root_id, |entry| {
        let action_json = serde_json::to_string(&action).map_err(|error| {
            RefrainError::new(ErrorCode::Io, "serialise an editor action", &path)
                .with_detail(error.to_string())
        })?;
        let journal_id = entry
            .store
            .journal_append(&path, &action_json)
            .map_err(into_domain)?;

        let domain_action = to_domain_action(action)?;
        let result = {
            let manuscript = entry.manuscripts.get_mut(&path).ok_or_else(|| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "edit a document that is not open",
                    path.clone(),
                )
            })?;
            manuscript.execute(TextCommand::Editor(domain_action))
        };
        match result {
            Ok(transition) => {
                entry
                    .store
                    .journal_remove(journal_id)
                    .map_err(into_domain)?;
                Ok(TextTransitionDto {
                    revision: transition.head().id().to_string(),
                    action_id: transition.action().id().to_string(),
                    touched_blocks: transition
                        .action()
                        .touched_blocks()
                        .iter()
                        .map(Id::to_string)
                        .collect(),
                })
            }
            Err(refusal) => {
                Err(
                    RefrainError::new(ErrorCode::Io, "apply an editor action", path.clone())
                        .with_detail(refusal.to_string()),
                )
            }
        }
    })
}

/// Save: materialise the confirmed manuscript and commit it compare-and-swap
/// on the author's stamp. The DOM snapshot never writes the file (SPEC 7.2).
#[tauri::command]
#[specta::specta]
fn persist_revision(
    state: tauri::State<'_, AppState>,
    root_id: String,
    path: String,
    expected: Option<FileStamp>,
) -> Result<SaveOutcomeDto, RefrainError> {
    state.with_project(&root_id, |entry| {
        let (bytes, lineage, head) = {
            let manuscript = entry.manuscripts.get(&path).ok_or_else(|| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "save a document that is not open",
                    path.clone(),
                )
            })?;
            let bytes = manuscript.materialize().map_err(|error| {
                RefrainError::new(ErrorCode::Io, "materialise a manuscript", path.clone())
                    .with_detail(error.to_string())
            })?;
            (bytes, manuscript.lineage_ids(), manuscript.head().id())
        };

        let committed = match entry.store.commit(&DocumentCommit {
            path: path.clone(),
            bytes,
            expected,
        }) {
            Ok(outcome) => outcome,
            Err(ProjectFailure::ChangedUnderneath(conflict)) => {
                return Ok(SaveOutcomeDto::ChangedUnderneath {
                    on_disk: String::from_utf8_lossy(&conflict.on_disk).into_owned(),
                    stamp: conflict.stamp.clone(),
                });
            }
            Err(other) => return Err(into_domain(other)),
        };

        entry
            .store
            .save_continuity(
                &path,
                &head.to_string(),
                &serde_json::to_string(&lineage).map_err(|error| {
                    RefrainError::new(ErrorCode::Io, "serialise a lineage", path.clone())
                        .with_detail(error.to_string())
                })?,
            )
            .map_err(into_domain)?;

        Ok(SaveOutcomeDto::Saved {
            stamp: committed.stamp,
            recovery_evidence: committed
                .recovery_evidence
                .map(|path| path.display().to_string()),
        })
    })
}

fn to_domain_action(dto: EditorActionDto) -> Result<EditorAction, RefrainError> {
    let base = parse_id(&dto.base, "action base")?;
    let changes = dto
        .changes
        .into_iter()
        .map(|change| match change {
            EditorChangeDto::Replace { blocks, text } => {
                let blocks = blocks
                    .iter()
                    .map(|raw| parse_id(raw, "replacement block"))
                    .collect::<Result<Vec<_>, _>>()?;
                Replacement::new(blocks, text)
                    .map(EditorChange::Replace)
                    .map_err(|error| {
                        RefrainError::new(ErrorCode::Io, "build a replacement", "")
                            .with_detail(error.to_string())
                    })
            }
            EditorChangeDto::Insert { before, texts } => {
                let before = before
                    .as_deref()
                    .map(|raw| parse_id(raw, "insertion boundary"))
                    .transpose()?;
                Insertion::new(before, texts)
                    .map(EditorChange::Insert)
                    .map_err(|error| {
                        RefrainError::new(ErrorCode::Io, "build an insertion", "")
                            .with_detail(error.to_string())
                    })
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(EditorAction::new(base, changes, "author edit"))
}

/// The single command registry. Generation and the runtime read the same list,
/// so a command cannot exist in one and be missing from the other.
pub fn builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(collect_commands![
        health,
        adopt_root,
        create_project,
        open_document,
        create_document,
        current_document,
        apply_editor_action,
        persist_revision,
    ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = builder();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("resolve the application data directory: {error}"))?;
            app.manage(AppState::open(&app_data_dir)?);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running RefRain");
}
