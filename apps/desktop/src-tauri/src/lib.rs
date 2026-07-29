//! Composition layer.
//!
//! Every command here is a one-line mapping onto a named use case. No business
//! state lives in this crate, and no domain rule is decided here (SPEC 6.2).
//! The session map holds live handles — open stores and manuscripts — which
//! are runtime objects, not a second copy of business state.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use refrain_core::{
    DocumentRole, EditorAction, EditorChange, ErrorCode, Id, Insertion, KaraAutoEntry, KaraEvent,
    KaraMachine, KaraPolicy, KaraTransition, Lineage, Manuscript, RefrainError, Replacement,
    SourceSnapshot, TextCommand,
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
    kara: Mutex<KaraMachine>,
    config: Option<refrain_store::config::ConfigStore>,
    config_notice: Mutex<Option<String>>,
    data_dir: PathBuf,
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
        let (config, config_notice) = match refrain_store::config::ConfigStore::load(app_data_dir) {
            Ok((store, _snapshot)) => (Some(store), None),
            Err(failure) => {
                // A damaged or newer Config must never be overwritten with
                // defaults; the KARA policy falls back to the SPEC default
                // and the Settings surface shows the refusal (SPEC 10.1).
                (None, Some(failure.to_string()))
            }
        };
        Ok(Self {
            app_db: Mutex::new(app_db),
            projects: Mutex::new(HashMap::new()),
            kara: Mutex::new(KaraMachine::new()),
            config,
            config_notice: Mutex::new(config_notice),
            data_dir: app_data_dir.to_path_buf(),
        })
    }

    fn kara_policy(&self) -> KaraPolicy {
        KaraPolicy {
            auto_enter_on_first_manuscript: self
                .config
                .as_ref()
                .and_then(|store| store.snapshot().ok())
                .map(|snapshot| snapshot.config.kara.auto_enter_on_first_manuscript)
                .unwrap_or(true),
        }
    }

    fn kara_step(&self, event: KaraEvent) -> Result<KaraTransition, RefrainError> {
        let mut kara = self.kara.lock().map_err(|_| {
            RefrainError::new(ErrorCode::StateUnavailable, "lock the KARA machine", "kara")
        })?;
        let transition = kara.step(event, self.kara_policy());
        *kara = transition.machine.clone();
        Ok(transition)
    }

    fn with_project<T>(
        &self,
        root_id: &str,
        use_entry: impl FnOnce(&AppState, &mut ProjectEntry) -> Result<T, RefrainError>,
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
        use_entry(self, entry)
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
        // A project becoming active starts a work session (D18): the one
        // automatic entry re-arms. It fires only when a manuscript opens.
        {
            let mut kara = self.kara.lock().map_err(|_| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "lock the KARA machine",
                    "adopt",
                )
            })?;
            kara.auto_entry = KaraAutoEntry::Pending;
        }
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
    /// The KARA transition this open caused, if any (D18).
    pub kara: Option<KaraTransition>,
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
    state.with_project(&root_id, |state, entry| {
        let opened = entry.store.open_document(&path).map_err(into_domain)?;
        open_in_entry(state, entry, &path, opened)
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
    state.with_project(&root_id, |state, entry| {
        let created = entry
            .store
            .create(&refrain_store::project::CreateDocument {
                title: title.clone(),
                role,
            })
            .map_err(into_domain)?;
        let path = created.row.path.clone();
        open_in_entry(state, entry, &path, created)
    })
}

/// The shared tail of open/create: build or resume the manuscript and replay
/// the journal.
fn open_in_entry(
    state: &AppState,
    entry: &mut ProjectEntry,
    path: &str,
    opened: refrain_store::project::OpenDocument,
) -> Result<OpenDocumentDto, RefrainError> {
    // D18: opening a manuscript may consume the work session's one automatic
    // entry. Materials and management surfaces never fire this.
    let kara = if matches!(
        opened.row.role,
        DocumentRole::Document | DocumentRole::Chapter
    ) {
        let auto_entry = state
            .kara
            .lock()
            .map_err(|_| {
                RefrainError::new(ErrorCode::StateUnavailable, "lock the KARA machine", path)
            })?
            .auto_entry;
        Some(state.kara_step(KaraEvent::FirstManuscriptOpened(auto_entry))?)
    } else {
        None
    };
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
        kara,
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
    state.with_project(&root_id, |_state, entry| {
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
    state.with_project(&root_id, |_state, entry| {
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
    state.with_project(&root_id, |_state, entry| {
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

/// One KARA event in, one transition out (SPEC 9.3). The machine is the only
/// state owner; the renderer projects the transition it gets back.
#[tauri::command]
#[specta::specta]
fn kara_event(
    state: tauri::State<'_, AppState>,
    event: KaraEvent,
) -> Result<KaraTransition, RefrainError> {
    state.kara_step(event)
}

/// The current machine, for surfaces that mount mid-session.
#[tauri::command]
#[specta::specta]
fn kara_state(state: tauri::State<'_, AppState>) -> Result<KaraMachine, RefrainError> {
    let kara = state.kara.lock().map_err(|_| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "lock the KARA machine",
            "kara_state",
        )
    })?;
    Ok(kara.clone())
}

/// The themes the generator emitted, embedded once (INV-16): the picker and
/// the validator read the same list; a hand copy would drift.
const THEMES_JSON: &str = include_str!("../themes.gen.json");

fn theme_slugs() -> Vec<String> {
    serde_json::from_str::<Vec<serde_json::Value>>(THEMES_JSON)
        .map(|list| {
            list.iter()
                .filter_map(|entry| entry["slug"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// One theme as the picker shows it.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThemeInfoDto {
    pub slug: String,
    pub cn: String,
    pub mode: String,
}

/// The generated theme list, for the Settings picker.
#[tauri::command]
#[specta::specta]
fn list_themes() -> Vec<ThemeInfoDto> {
    serde_json::from_str::<Vec<ThemeInfoDto>>(THEMES_JSON).unwrap_or_default()
}

/// The assets directory for icons (SPEC 6.3).
fn icon_assets_dir(state: &AppState) -> PathBuf {
    state.data_dir.join("assets").join("universal-button")
}

/// Pick an icon for the Universal Button. The pipeline judges by content
/// (SPEC 9.8); the digest is all the Config ever stores.
#[tauri::command]
#[specta::specta]
fn set_universal_icon(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    bytes: Vec<u8>,
) -> Result<String, RefrainError> {
    let asset = refrain_store::icons::import_icon(&icon_assets_dir(&state), &bytes)?;
    let store = state.config.as_ref().ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "write a damaged Config",
            "icon",
        )
    })?;
    store
        .apply(refrain_store::config::ConfigChange::SetIconDigest(Some(
            asset.digest.clone(),
        )))
        .map_err(|failure| {
            RefrainError::new(ErrorCode::Io, "write the Config", failure.to_string())
        })?;
    use tauri::Emitter;
    let _ = app.emit("config-changed", &asset.digest);
    Ok(asset.digest)
}

/// The stored icon, for the data-URL projection. Absent is a value, not an
/// empty string (INV-3's discipline).
#[tauri::command]
#[specta::specta]
fn universal_icon(state: tauri::State<'_, AppState>) -> Option<Vec<u8>> {
    let store = state.config.as_ref()?;
    let digest = store.snapshot().ok()?.config.appearance.icon_digest?;
    refrain_store::icons::read_icon(&icon_assets_dir(&state), &digest).ok()
}

/// The preferences the Settings surface may change (SPEC 6.5). Connection
/// management is its own command pair; this is the author's choices.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum PreferencesChangeDto {
    KaraAutoEnter(bool),
    SetTheme(String),
    SetFontFamily {
        slot: refrain_store::config::FontSlot,
        family: String,
    },
    SetFontPriority([refrain_store::config::FontSlot; 3]),
}

#[tauri::command]
#[specta::specta]
fn update_preferences(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    change: PreferencesChangeDto,
) -> Result<refrain_store::config::ConfigSnapshot, RefrainError> {
    let change = match change {
        PreferencesChangeDto::KaraAutoEnter(value) => {
            refrain_store::config::ConfigChange::KaraAutoEnter(value)
        }
        PreferencesChangeDto::SetTheme(theme) => {
            if !theme_slugs().contains(&theme) {
                return Err(RefrainError::new(
                    ErrorCode::IllegalName,
                    "choose a theme",
                    theme,
                ));
            }
            refrain_store::config::ConfigChange::SetTheme(theme)
        }
        PreferencesChangeDto::SetFontFamily { slot, family } => {
            refrain_store::config::ConfigChange::SetFontFamily { slot, family }
        }
        PreferencesChangeDto::SetFontPriority(priority) => {
            refrain_store::config::ConfigChange::SetFontPriority(priority)
        }
    };
    let store = state.config.as_ref().ok_or_else(|| {
        let notice = state.config_notice.lock().ok().and_then(|n| n.clone());
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "write a damaged Config",
            notice.unwrap_or_default(),
        )
    })?;
    let snapshot = store.apply(change).map_err(|failure| {
        RefrainError::new(ErrorCode::Io, "write the Config", failure.to_string())
    })?;
    // One broadcast per accepted change: the Settings surface that wrote it
    // is not the only listener (INV-10/15: the fact has one owner and every
    // projection hears it from there, not from a sibling surface).
    use tauri::Emitter;
    let _ = app.emit("config-changed", &snapshot.config.appearance.theme);
    Ok(snapshot)
}

/// The effective Config, or the refusal the Settings surface must show.
#[tauri::command]
#[specta::specta]
fn read_config(
    state: tauri::State<'_, AppState>,
) -> Result<refrain_store::config::ConfigSnapshot, RefrainError> {
    let notice = state.config_notice.lock().ok().and_then(|n| n.clone());
    if let Some(notice) = notice {
        return Err(RefrainError::new(
            ErrorCode::StateUnavailable,
            "read a damaged Config",
            notice,
        ));
    }
    let store = state.config.as_ref().ok_or_else(|| {
        RefrainError::new(ErrorCode::StateUnavailable, "read the Config", "no store")
    })?;
    store.snapshot().map_err(|failure| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "read the Config",
            failure.to_string(),
        )
    })
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
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
        kara_event,
        kara_state,
        read_config,
        update_preferences,
        list_themes,
        set_universal_icon,
        universal_icon,
        inject_fixture_proposal,
        list_proposals,
        record_verdict,
        set_review_batch,
        review_state,
        commit_decision_batch,
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
            let mut app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("resolve the application data directory: {error}"))?;
            // Test seam: e2e runs point the data dir at a fixture so they
            // never touch the author's real Config or app.db.
            if let Ok(fixture) = std::env::var("REFRAIN_DATA_DIR") {
                app_data_dir = PathBuf::from(fixture);
            }
            app.manage(AppState::open(&app_data_dir)?);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running RefRain");
}
// The review loop commands: fixture injection (debug only), proposal
// listing, write-through verdicts, batch staging, and the one commit path.

use refrain_core::{DecisionBatch, EditScope, Proposal, ReviewSliceId, Verdict, VerdictKind};
use refrain_store::ledger::{VerdictKindName, VerdictRecord};

/// One sentence for the surface.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSliceDto {
    /// "<proposal>:<ordinal>" — the exact key the commit path parses back.
    pub id: String,
    pub kind: String,
    pub text: String,
    pub lead: String,
    pub trail: String,
}

/// A frozen candidate for the surface.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProposalDto {
    pub id: String,
    pub run: String,
    pub baseline: String,
    pub before: String,
    pub after: Option<String>,
    pub change_class: String,
    pub slices: Vec<ReviewSliceDto>,
}

/// One fixture replacement (debug builds only; SPEC R3: the fixture command
/// is excluded from release).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FixtureReplacementDto {
    pub blocks: Vec<String>,
    pub after: Option<String>,
}

/// The recovered review session (SPEC 9.7's five things: cursor, verdicts,
/// reasons, final texts, batch — all here).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewStateDto {
    pub proposals: Vec<ProposalDto>,
    pub verdicts: Vec<refrain_store::ledger::VerdictRecord>,
    pub cursor: u32,
    pub batch: Vec<String>,
}

fn slice_dto(proposal: &Proposal, slice: &refrain_core::ReviewSlice) -> ReviewSliceDto {
    ReviewSliceDto {
        id: format!("{}:{}", proposal.id(), slice.id().ordinal()),
        kind: match slice.kind() {
            refrain_core::SliceKind::Same => "same".to_string(),
            refrain_core::SliceKind::Delete => "delete".to_string(),
            refrain_core::SliceKind::Insert => "insert".to_string(),
        },
        text: slice.text().to_string(),
        lead: slice.lead().to_string(),
        trail: slice.trail().to_string(),
    }
}

fn proposal_dto(proposal: &Proposal) -> ProposalDto {
    ProposalDto {
        id: proposal.id().to_string(),
        run: proposal.run().to_string(),
        baseline: proposal.baseline().to_string(),
        before: proposal.before().to_string(),
        after: proposal.after().map(str::to_string),
        change_class: match proposal.change_class() {
            refrain_core::ChangeClass::Formatting => "formatting".to_string(),
            refrain_core::ChangeClass::Semantic => "semantic".to_string(),
        },
        slices: proposal
            .slices()
            .iter()
            .map(|slice| slice_dto(proposal, slice))
            .collect(),
    }
}

/// Rebuild a persisted candidate exactly (deterministic slices, stable id).
fn rebuild_proposal(row: &refrain_store::project::ProposalRow) -> Result<Proposal, RefrainError> {
    let scope_ids: Vec<Id> = serde_json::from_str(&row.scope).map_err(|error| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "read a proposal scope",
            row.id.clone(),
        )
        .with_detail(error.to_string())
    })?;
    let scope = EditScope::new(scope_ids).map_err(|error| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "read a proposal scope",
            row.id.clone(),
        )
        .with_detail(error.to_string())
    })?;
    Ok(Proposal::with_id(
        parse_id(&row.id, "proposal")?,
        parse_id(&row.run, "run")?,
        parse_id(&row.baseline, "baseline")?,
        scope,
        row.before_text.clone(),
        row.after_text.clone(),
    ))
}

/// Inject fixture candidates (debug builds only). The candidates freeze
/// against the document's current head, exactly like a real Run's output
/// will in C10.
#[tauri::command]
#[specta::specta]
fn inject_fixture_proposal(
    state: tauri::State<'_, AppState>,
    root_id: String,
    path: String,
    replacements: Vec<FixtureReplacementDto>,
) -> Result<Vec<ProposalDto>, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        let manuscript = entry.manuscripts.get(&path).ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "inject into a document that is not open",
                path.clone(),
            )
        })?;
        let baseline = manuscript.head().id();
        let head_blocks: HashMap<Id, &str> = manuscript
            .head()
            .blocks()
            .iter()
            .map(|block| (block.id(), block.text()))
            .collect();

        let run = Id::new();
        let mut out = Vec::new();
        for replacement in replacements {
            let block_ids: Vec<Id> = replacement
                .blocks
                .iter()
                .map(|raw| parse_id(raw, "fixture block"))
                .collect::<Result<_, _>>()?;
            let before = block_ids
                .iter()
                .map(|id| {
                    head_blocks.get(id).copied().ok_or_else(|| {
                        RefrainError::new(ErrorCode::Io, "name a fixture block", id.to_string())
                    })
                })
                .collect::<Result<Vec<_>, _>>()?
                .join("\n\n");
            let scope = EditScope::new(block_ids.clone()).map_err(|error| {
                RefrainError::new(ErrorCode::Io, "build a fixture scope", path.clone())
                    .with_detail(error.to_string())
            })?;
            let proposal = Proposal::new(
                run,
                baseline,
                scope,
                before.clone(),
                replacement.after.clone(),
            );
            entry
                .store
                .proposal_insert(&refrain_store::project::ProposalRow {
                    id: proposal.id().to_string(),
                    run: run.to_string(),
                    baseline: baseline.to_string(),
                    document_path: path.clone(),
                    scope: serde_json::to_string(&block_ids).map_err(|error| {
                        RefrainError::new(ErrorCode::Io, "serialise a scope", path.clone())
                            .with_detail(error.to_string())
                    })?,
                    before_text: before,
                    after_text: replacement.after,
                    created_at: now_millis(),
                })
                .map_err(into_domain)?;
            out.push(proposal_dto(&proposal));
        }
        Ok(out)
    })
}

/// Every candidate for a document, newest last, for the review surface.
#[tauri::command]
#[specta::specta]
fn list_proposals(
    state: tauri::State<'_, AppState>,
    root_id: String,
    path: String,
) -> Result<Vec<ProposalDto>, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        entry
            .store
            .proposals_for(&path)
            .map_err(into_domain)?
            .iter()
            .map(|row| rebuild_proposal(row).map(|p| proposal_dto(&p)))
            .collect()
    })
}

/// Record one judgment. It lands in the ledger the moment it is made (SPEC
/// 9.7: 判即写穿 staging).
#[tauri::command]
#[specta::specta]
fn record_verdict(
    state: tauri::State<'_, AppState>,
    root_id: String,
    proposal_id: String,
    slice_id: String,
    kind: String,
    reason: Option<String>,
    final_text: Option<String>,
) -> Result<refrain_store::ledger::VerdictRecord, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        let kind_name = match kind.as_str() {
            "accept" => VerdictKindName::Accept,
            "accept-modified" => VerdictKindName::AcceptModified,
            "reject" => VerdictKindName::Reject,
            "comment-only" => VerdictKindName::CommentOnly,
            other => {
                return Err(RefrainError::new(
                    ErrorCode::IllegalName,
                    "name a verdict kind",
                    other,
                ));
            }
        };
        let record = VerdictRecord {
            id: Id::new().to_string(),
            proposal_id,
            slice_id,
            kind: kind_name,
            final_text,
            reason,
            decided_at: now_millis(),
            legacy_baseline: None,
        };
        entry
            .store
            .ledger()
            .record(&record)
            .map_err(into_domain_store)?;
        Ok(record)
    })
}

fn into_domain_store(failure: refrain_store::schema::StoreError) -> RefrainError {
    RefrainError::new(
        ErrorCode::StateUnavailable,
        "write the verdict ledger",
        failure.to_string(),
    )
}

/// Stage the batch and the cursor (SPEC 9.7: cursor and batch persist with
/// every change, not at commit time).
#[tauri::command]
#[specta::specta]
fn set_review_batch(
    state: tauri::State<'_, AppState>,
    root_id: String,
    path: String,
    cursor: u32,
    batch: Vec<String>,
) -> Result<(), RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        let batch_json = serde_json::to_string(&batch).map_err(|error| {
            RefrainError::new(ErrorCode::Io, "serialise a batch", path.clone())
                .with_detail(error.to_string())
        })?;
        entry
            .store
            .review_session_set(&path, cursor, &batch_json)
            .map_err(into_domain)
    })
}

/// The recovered review session: candidates, judgments so far, cursor, batch.
#[tauri::command]
#[specta::specta]
fn review_state(
    state: tauri::State<'_, AppState>,
    root_id: String,
    path: String,
) -> Result<ReviewStateDto, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        let proposals = entry
            .store
            .proposals_for(&path)
            .map_err(into_domain)?
            .iter()
            .map(|row| rebuild_proposal(row).map(|p| proposal_dto(&p)))
            .collect::<Result<Vec<_>, _>>()?;
        let proposal_ids: HashSet<String> = proposals.iter().map(|p| p.id.clone()).collect();
        let verdicts = entry
            .store
            .ledger()
            .all()
            .map_err(into_domain_store)?
            .into_iter()
            .filter(|row| proposal_ids.contains(&row.proposal_id))
            .collect();
        let (cursor, batch) = match entry.store.review_session_get(&path).map_err(into_domain)? {
            Some((cursor, batch_json)) => {
                let batch: Vec<String> = serde_json::from_str(&batch_json).unwrap_or_default();
                (cursor, batch)
            }
            None => (0, Vec::new()),
        };
        Ok(ReviewStateDto {
            proposals,
            verdicts,
            cursor,
            batch,
        })
    })
}

/// The one commit path: staged judgments become one Text Action (SPEC 7.4).
/// The batch and cursor clear; candidates stay for the audit.
#[tauri::command]
#[specta::specta]
fn commit_decision_batch(
    state: tauri::State<'_, AppState>,
    root_id: String,
    path: String,
) -> Result<TextTransitionDto, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        let (_cursor, batch_json) = entry
            .store
            .review_session_get(&path)
            .map_err(into_domain)?
            .ok_or_else(|| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "commit an empty batch",
                    path.clone(),
                )
            })?;
        let batch_ids: Vec<String> = serde_json::from_str(&batch_json).map_err(|error| {
            RefrainError::new(ErrorCode::StateUnavailable, "read a batch", path.clone())
                .with_detail(error.to_string())
        })?;
        if batch_ids.is_empty() {
            return Err(RefrainError::new(
                ErrorCode::StateUnavailable,
                "commit an empty batch",
                path.clone(),
            ));
        }
        let rows = entry
            .store
            .ledger()
            .find_many(&batch_ids)
            .map_err(into_domain_store)?;
        let proposals = entry
            .store
            .proposals_for(&path)
            .map_err(into_domain)?
            .iter()
            .map(rebuild_proposal)
            .collect::<Result<Vec<_>, _>>()?;
        let proposal_at: HashMap<Id, &Proposal> = proposals.iter().map(|p| (p.id(), p)).collect();

        let mut verdicts = Vec::with_capacity(rows.len());
        for row in &rows {
            let proposal_id = parse_id(&row.proposal_id, "verdict proposal")?;
            let proposal = proposal_at.get(&proposal_id).ok_or_else(|| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "judge a candidate that is not here",
                    row.proposal_id.clone(),
                )
            })?;
            let (proposal_uuid, ordinal) = row.slice_id.rsplit_once(':').ok_or_else(|| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "read a slice id",
                    row.slice_id.clone(),
                )
            })?;
            let slice = ReviewSliceId::new(
                parse_id(proposal_uuid, "slice proposal")?,
                ordinal.parse::<u32>().map_err(|error| {
                    RefrainError::new(
                        ErrorCode::StateUnavailable,
                        "read a slice ordinal",
                        &row.slice_id,
                    )
                    .with_detail(error.to_string())
                })?,
            );
            let kind = match row.kind {
                VerdictKindName::Accept => VerdictKind::Accept,
                VerdictKindName::AcceptModified => {
                    VerdictKind::AcceptModified(row.final_text.clone().ok_or_else(|| {
                        RefrainError::new(
                            ErrorCode::StateUnavailable,
                            "apply a modified verdict without its final text",
                            row.id.clone(),
                        )
                    })?)
                }
                VerdictKindName::Reject => VerdictKind::Reject,
                VerdictKindName::CommentOnly => VerdictKind::CommentOnly,
            };
            verdicts.push(
                Verdict::new(proposal, slice, kind, row.reason.clone()).map_err(|error| {
                    RefrainError::new(
                        ErrorCode::StateUnavailable,
                        "rebuild a verdict",
                        row.id.clone(),
                    )
                    .with_detail(error.to_string())
                })?,
            );
        }

        let manuscript = entry.manuscripts.get_mut(&path).ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "commit against a document that is not open",
                path.clone(),
            )
        })?;
        let base = manuscript.head().id();
        let transition = manuscript
            .execute(TextCommand::CommitDecisionBatch(DecisionBatch::new(
                base, proposals, verdicts,
            )))
            .map_err(|error| {
                RefrainError::new(ErrorCode::Io, "commit a decision batch", path.clone())
                    .with_detail(error.to_string())
            })?;

        entry
            .store
            .review_session_set(&path, 0, "[]")
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
    })
}
