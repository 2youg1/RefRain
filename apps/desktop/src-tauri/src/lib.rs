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
/// The command is a thin wrapper; composition-layer use cases share the body.
fn persist_in_entry(
    entry: &mut ProjectEntry,
    path: &str,
    expected: Option<FileStamp>,
) -> Result<SaveOutcomeDto, RefrainError> {
    let (bytes, lineage, head) = {
        let manuscript = entry.manuscripts.get(path).ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "save a document that is not open",
                path.to_string(),
            )
        })?;
        let bytes = manuscript.materialize().map_err(|error| {
            RefrainError::new(ErrorCode::Io, "materialise a manuscript", path.to_string())
                .with_detail(error.to_string())
        })?;
        (bytes, manuscript.lineage_ids(), manuscript.head().id())
    };

    let committed = match entry.store.commit(&DocumentCommit {
        path: path.to_string(),
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
            path,
            &head.to_string(),
            &serde_json::to_string(&lineage).map_err(|error| {
                RefrainError::new(ErrorCode::Io, "serialise a lineage", path.to_string())
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
}

#[tauri::command]
#[specta::specta]
fn persist_revision(
    state: tauri::State<'_, AppState>,
    root_id: String,
    path: String,
    expected: Option<FileStamp>,
) -> Result<SaveOutcomeDto, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        persist_in_entry(entry, &path, expected)
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
    SetPaper(refrain_store::config::PaperMode),
    SetTextSize(u16),
    SetLineHeight(u16),
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
        PreferencesChangeDto::SetPaper(mode) => refrain_store::config::ConfigChange::SetPaper(mode),
        PreferencesChangeDto::SetTextSize(px) => {
            refrain_store::config::ConfigChange::SetTextSize(px)
        }
        PreferencesChangeDto::SetLineHeight(pct) => {
            refrain_store::config::ConfigChange::SetLineHeight(pct)
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
        draft_review_task,
        preview_dispatch,
        l0_file_channel_agent,
        list_harnesses,
        authorize_dispatch,
        launch_run,
        harness_dispatch,
        host_state,
        cancel_run,
        retry_run,
        collect_attempt,
        list_material_drafts,
        commit_material_action,
        agent_reading_ledger,
        upsert_harness_connection,
        remove_harness_connection,
        probe_connection,
        import_material,
        import_manuscript,
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

// ── C10: the host bridge — the dispatch ticket and the L0 file channel ──────
//
// The commands below map one-to-one onto SPEC 6.5's host use cases. The
// journal lives in refrain.db through StoreJournal; the frozen context lives
// in .refrain/ through DirectoryContext. Nothing here decides a domain rule:
// the host's state machine does.

use refrain_core::agent_protocol::{self, ArtifactContract};
use refrain_core::context_compiler::{
    self, BeforeScope, ChangeEntry, ChangeKind, ContractMode, DispatchInput, DispatchPackage,
    ManifestEntry,
};
use refrain_host::host::{
    AgentHost, DispatchAuthorization, HostCommand, HostJournal, HostRefusal, HostState, ReviewTask,
    Run, RunProgress, TaskProgress,
};
use refrain_host::staging::DirectoryContext;
use refrain_store::orchestration::{AuthorizationRow, RunRow, TaskRow};
use sha2::Digest;

/// The built-in L0 agent: a file channel, including copy-paste into a web
/// chat (SPEC 8.3a). Real harness connections arrive with C11; this id names
/// the one producer that always exists.
const L0_FILE_CHANNEL_AGENT: &str = "00000000-0000-0000-0000-0000000000e0";

/// One dispatch's byte ceiling for the artifact body (shown in the contract).
const ARTIFACT_MAX_BYTES: u64 = 64 * 1024;

fn into_domain_host(refusal: HostRefusal) -> RefrainError {
    RefrainError::new(
        ErrorCode::StateUnavailable,
        "orchestrate a dispatch",
        refusal.to_string(),
    )
}

fn json_of<T: Serialize>(value: &T, what: &str) -> Result<String, RefrainError> {
    serde_json::to_string(value).map_err(|error| {
        RefrainError::new(ErrorCode::Io, "serialise orchestration state", what)
            .with_detail(error.to_string())
    })
}

fn entity_of<T: serde::de::DeserializeOwned>(raw: &str, what: &str) -> Result<T, RefrainError> {
    serde_json::from_str(raw).map_err(|error| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "read orchestration state",
            what,
        )
        .with_detail(error.to_string())
    })
}

fn task_kind(progress: &TaskProgress) -> &'static str {
    match progress {
        TaskProgress::Draft => "draft",
        TaskProgress::Open { .. } => "open",
        TaskProgress::Closed { .. } => "closed",
    }
}

fn run_kind(progress: &RunProgress) -> &'static str {
    match progress {
        RunProgress::Queued => "queued",
        RunProgress::Authorized { .. } => "authorized",
        RunProgress::Launching { .. } => "launching",
        RunProgress::Dispatched { .. } => "dispatched",
        RunProgress::Completed { .. } => "completed",
        RunProgress::Failed { .. } => "failed",
        RunProgress::Cancelled => "cancelled",
    }
}

fn task_row(task: &ReviewTask) -> Result<TaskRow, RefrainError> {
    Ok(TaskRow {
        id: task.id.to_string(),
        baseline: task.baseline.to_string(),
        progress_kind: task_kind(&task.progress).to_string(),
        entity: json_of(task, "task")?,
    })
}

fn run_row(run: &Run) -> Result<RunRow, RefrainError> {
    Ok(RunRow {
        id: run.id.to_string(),
        task_id: run.task_id.to_string(),
        agent_id: run.agent_id.to_string(),
        progress_kind: run_kind(&run.progress).to_string(),
        retry_of: run.retry_of.map(|id| id.to_string()),
        entity: json_of(run, "run")?,
    })
}

fn authorization_row(
    authorization: &DispatchAuthorization,
) -> Result<AuthorizationRow, RefrainError> {
    Ok(AuthorizationRow {
        id: authorization.id.to_string(),
        manifest_digest: authorization.manifest_digest.clone(),
        authorized_at: i64::try_from(authorization.authorized_at).unwrap_or(i64::MAX),
        entity: json_of(authorization, "authorization")?,
    })
}

/// The journal seam over refrain.db. New and re-authorized runs reach the
/// store pre-split by existence: the store refuses an overwriting insert and
/// a missing update, so the split must be honest.
struct StoreJournal<'a> {
    store: &'a mut ProjectStore,
}

impl HostJournal for StoreJournal<'_> {
    type Error = RefrainError;

    fn load(&self) -> Result<HostState, RefrainError> {
        let rows = self.store.host_rows().map_err(into_domain)?;
        Ok(HostState {
            tasks: rows
                .tasks
                .iter()
                .map(|row| entity_of(&row.entity, "task"))
                .collect::<Result<Vec<_>, _>>()?,
            runs: rows
                .runs
                .iter()
                .map(|row| entity_of(&row.entity, "run"))
                .collect::<Result<Vec<_>, _>>()?,
            authorizations: rows
                .authorizations
                .iter()
                .map(|row| entity_of(&row.entity, "authorization"))
                .collect::<Result<Vec<_>, _>>()?,
        })
    }

    fn append_task(&mut self, task: &ReviewTask) -> Result<(), RefrainError> {
        self.store
            .host_task_append(&task_row(task)?)
            .map_err(into_domain)
    }

    fn record_authorization(
        &mut self,
        task: &ReviewTask,
        runs: &[Run],
        authorization: &DispatchAuthorization,
    ) -> Result<(), RefrainError> {
        let mut new_runs = Vec::new();
        let mut reauthorized = Vec::new();
        for run in runs {
            if self
                .store
                .host_run_known(&run.id.to_string())
                .map_err(into_domain)?
            {
                reauthorized.push(run_row(run)?);
            } else {
                new_runs.push(run_row(run)?);
            }
        }
        self.store
            .host_authorization_record(
                &task_row(task)?,
                &new_runs,
                &reauthorized,
                &authorization_row(authorization)?,
            )
            .map_err(into_domain)
    }

    fn update_task(&mut self, task: &ReviewTask) -> Result<(), RefrainError> {
        self.store
            .host_task_update(&task_row(task)?)
            .map_err(into_domain)
    }

    fn update_run(&mut self, run: &Run) -> Result<(), RefrainError> {
        self.store
            .host_run_update(&run_row(run)?)
            .map_err(into_domain)
    }

    fn append_run(&mut self, run: &Run) -> Result<(), RefrainError> {
        self.store
            .host_run_append(&run_row(run)?)
            .map_err(into_domain)
    }
}

fn open_host(
    store: &mut ProjectStore,
) -> Result<AgentHost<StoreJournal<'_>, DirectoryContext>, RefrainError> {
    let context = DirectoryContext::new(store.layout().state_dir.clone());
    let journal = StoreJournal { store };
    AgentHost::open(journal, context).map_err(into_domain_host)
}

/// The scope id's doc part: the file stem, so `ch01.md` reads as `ch01`.
fn doc_slug(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "document".to_string())
}

/// Compile the package the ticket shows and the click authorizes. Called at
/// preview AND again at authorize: any drift between the two compilations —
/// an edited block, a changed prompt — changes the digest and kills the
/// authorization (INV-14).
/// The verdict window carried into `<changes>`: the document's most recent
/// judgments, capped so the stream stays a summary, not a database dump.
const CHANGES_WINDOW: usize = 20;

/// The carry tier the author picks on the ticket (KL9's context tiers):
/// what rides besides the scope and the prompt. Materials always travel
/// separately and are never part of a tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum CarryMode {
    /// The verdict stream; a round with no history falls back to the whole
    /// text, or the agent has nothing to stand on (KL9: never trade output
    /// quality for tokens).
    Diff,
    /// The verdict stream plus the whole manuscript, every round.
    Full,
    /// Neither verdicts nor manuscript — scope and prompt only.
    None,
}

/// The contract tier for this dispatch (KL9's contract injection): L0's
/// channel has no session, so the short contract rides every request; a
/// harness gets the full protocol document on its first round in this
/// project and a pointer line afterwards.
fn contract_mode(store: &mut ProjectStore, agent_id: &str) -> Result<ContractMode, RefrainError> {
    if agent_id == l0_file_channel_agent() {
        return Ok(ContractMode::Short);
    }
    let agent = parse_id(agent_id, "agent")?;
    let host = open_host(store)?;
    Ok(if host.runs().iter().any(|run| run.agent_id == agent) {
        ContractMode::Pointer
    } else {
        ContractMode::Full
    })
}

#[allow(clippy::too_many_arguments)]
fn compile_package(
    store: &mut ProjectStore,
    manuscript: &Manuscript,
    path: &str,
    block_ids: &[Id],
    material_paths: &[String],
    prompt: &str,
    carry: CarryMode,
    contract: ContractMode,
) -> Result<DispatchPackage, RefrainError> {
    let blocks = manuscript.head().blocks();
    let mut selected: Vec<(usize, &str)> = Vec::with_capacity(block_ids.len());
    for (index, block) in blocks.iter().enumerate() {
        if block_ids.contains(&block.id()) {
            selected.push((index, block.text()));
        }
    }
    if selected.len() != block_ids.len() {
        return Err(RefrainError::new(
            ErrorCode::Io,
            "name every scope block",
            format!(
                "{} of {} blocks found in {path}",
                selected.len(),
                block_ids.len()
            ),
        ));
    }
    let slug = doc_slug(path);
    let scope = match (selected.first(), selected.last()) {
        (Some((first, _)), Some((last, _))) if first == last => format!("{slug}:b{}", first + 1),
        (Some((first, _)), Some((last, _))) => format!("{slug}:b{}-b{}", first + 1, last + 1),
        _ => {
            return Err(RefrainError::new(
                ErrorCode::Io,
                "select at least one block",
                path.to_string(),
            ));
        }
    };
    let text = selected
        .iter()
        .map(|(_, text)| *text)
        .collect::<Vec<_>>()
        .join("\n\n");
    // The `<changes>` stream (SPEC 8.5): this document's recent verdicts,
    // capped at the window. The carry tier decides what rides (KL9): Diff is
    // the default — verdicts, plus the whole text when no history exists;
    // Full adds the manuscript every round; None carries neither.
    let verdicts = store.ledger().for_document(path).map_err(|error| {
        RefrainError::new(ErrorCode::StateUnavailable, "read the verdict ledger", path)
            .with_detail(error.to_string())
    })?;
    let full_text = |manuscript: &Manuscript| {
        manuscript
            .head()
            .blocks()
            .iter()
            .map(|block| block.text())
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    let changes: Vec<ChangeEntry> = verdicts
        .iter()
        .rev()
        .take(CHANGES_WINDOW)
        .rev()
        .map(|verdict| ChangeEntry {
            reference: verdict.slice_id.clone(),
            kind: match verdict.kind {
                VerdictKindName::Accept => ChangeKind::Accept,
                VerdictKindName::AcceptModified => ChangeKind::AcceptModified,
                VerdictKindName::Reject => ChangeKind::Reject,
                VerdictKindName::CommentOnly => ChangeKind::CommentOnly,
            },
            reason: verdict.reason.clone(),
            final_text: verdict.final_text.clone(),
        })
        .collect();
    let (manuscript_text, changes) = match carry {
        CarryMode::None => (None, Vec::new()),
        CarryMode::Full => (Some(full_text(manuscript)), changes),
        CarryMode::Diff => (
            if verdicts.is_empty() {
                Some(full_text(manuscript))
            } else {
                None
            },
            changes,
        ),
    };
    // Ticked materials ride as context sections, read from disk truth at
    // compile time (SPEC 8.5: the manifest shows each one's bytes).
    let mut materials: Vec<(String, String)> = Vec::with_capacity(material_paths.len());
    for material_path in material_paths {
        let opened = store.open_document(material_path).map_err(into_domain)?;
        let name = doc_slug(material_path);
        materials.push((name, String::from_utf8_lossy(&opened.bytes).into_owned()));
    }
    let input = DispatchInput {
        persona: None,
        manuscript: manuscript_text,
        changes,
        materials,
        request: prompt.to_string(),
        scopes: vec![BeforeScope { scope, text }],
        result_path: format!(
            "runs/{0}/attempts/{0}/result.md",
            refrain_host::host::RUN_ID_PLACEHOLDER
        ),
        max_bytes: ARTIFACT_MAX_BYTES,
        contract_mode: contract,
    };
    Ok(context_compiler::compile(&input))
}

/// Parse the frozen request's `# Before` section back into (scope id, text)
/// pairs. The promoted request is the authority at collect time: it is the
/// bytes the producer answered.
fn before_sections(request: &str) -> Vec<(String, String)> {
    let Some(after_heading) = request.split("# Before").nth(1) else {
        return vec![];
    };
    let section = after_heading.split("\n# ").next().unwrap_or(after_heading);
    let mut out = Vec::new();
    for chunk in section.split("<!-- scope ").skip(1) {
        let Some((id, rest)) = chunk.split_once(" -->") else {
            continue;
        };
        let text = rest
            .strip_prefix('\n')
            .unwrap_or(rest)
            .trim_end_matches('\n')
            .to_string();
        out.push((id.trim().to_string(), text));
    }
    out
}

/// Find the block range whose joined text is exactly the frozen before-text.
/// Byte-exact: a scope the author has since edited is not found, and the run
/// fails honestly instead of proposing against text it never saw.
fn find_scope_blocks(manuscript: &Manuscript, before: &str) -> Option<Vec<Id>> {
    let blocks = manuscript.head().blocks();
    for start in 0..blocks.len() {
        let mut text = String::new();
        for block in &blocks[start..] {
            if !text.is_empty() {
                text.push_str("\n\n");
            }
            text.push_str(block.text());
            if text == before {
                let end = start + text.matches("\n\n").count();
                return Some(blocks[start..=end].iter().map(|block| block.id()).collect());
            }
            if text.len() > before.len() {
                break;
            }
        }
    }
    None
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskDto {
    pub id: String,
    pub baseline: String,
    pub document: String,
    pub prompt: String,
    pub progress: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunDto {
    pub id: String,
    pub task_id: String,
    pub agent_id: String,
    pub workspace: String,
    pub progress: String,
    pub failure: Option<String>,
    pub retry_of: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HostStateDto {
    pub tasks: Vec<TaskDto>,
    pub runs: Vec<RunDto>,
    pub recovery_required: Vec<String>,
    pub awaiting_launch: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DispatchPreviewDto {
    pub manifest: Vec<ManifestEntry>,
    pub digest: String,
    pub request_md: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case", tag = "kind", content = "value")]
pub enum CollectOutcomeDto {
    /// No result yet; nothing moved.
    Waiting,
    Completed {
        proposals: u32,
        memos: u32,
        drafts: u32,
    },
    Failed {
        code: String,
        detail: String,
    },
}

fn task_dto(task: &ReviewTask) -> TaskDto {
    TaskDto {
        id: task.id.to_string(),
        baseline: task.baseline.to_string(),
        document: task.document.clone(),
        prompt: task.prompt.clone(),
        progress: task_kind(&task.progress).to_string(),
    }
}

fn run_dto(run: &Run) -> RunDto {
    RunDto {
        id: run.id.to_string(),
        task_id: run.task_id.to_string(),
        agent_id: run.agent_id.to_string(),
        workspace: run.workspace.clone(),
        progress: run_kind(&run.progress).to_string(),
        failure: match &run.progress {
            RunProgress::Failed { failure } => Some(failure.clone()),
            _ => None,
        },
        retry_of: run.retry_of.map(|id| id.to_string()),
    }
}

fn parse_ids(raw: &[String], what: &str) -> Result<Vec<Id>, RefrainError> {
    raw.iter().map(|one| parse_id(one, what)).collect()
}

/// Draft the collaboration: prompt, document, and the head it pins (Q27).
#[tauri::command]
#[specta::specta]
fn draft_review_task(
    state: tauri::State<'_, AppState>,
    root_id: String,
    path: String,
    prompt: String,
) -> Result<TaskDto, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        // Q27: Rust pins the baseline from the current Text Head at enqueue.
        // A renderer-authored revision is not accepted (SPEC 6.2: nothing the
        // renderer says authorizes).
        let baseline = entry
            .manuscripts
            .get(&path)
            .ok_or_else(|| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "draft a task for a document that is not open",
                    path.clone(),
                )
            })?
            .head()
            .id();
        let mut host = open_host(&mut entry.store)?;
        host.execute(HostCommand::DraftTask {
            baseline,
            document: path,
            prompt,
            context_digest: String::new(),
        })
        .map_err(into_domain_host)?;
        Ok(task_dto(&host.tasks()[host.tasks().len() - 1]))
    })
}

/// The manifest the author reads before the click (SPEC 9.6: 逐块字节清单).
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
fn preview_dispatch(
    state: tauri::State<'_, AppState>,
    root_id: String,
    path: String,
    block_ids: Vec<String>,
    material_paths: Vec<String>,
    prompt: String,
    agent_id: String,
    carry: CarryMode,
) -> Result<DispatchPreviewDto, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        let manuscript = entry.manuscripts.get(&path).ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "preview a dispatch for a document that is not open",
                path.clone(),
            )
        })?;
        let mode = contract_mode(&mut entry.store, &agent_id)?;
        let package = compile_package(
            &mut entry.store,
            manuscript,
            &path,
            &parse_ids(&block_ids, "scope block")?,
            &material_paths,
            &prompt,
            carry,
            mode,
        )?;
        Ok(DispatchPreviewDto {
            manifest: package.manifest.clone(),
            digest: package.digest.clone(),
            request_md: package.request_md,
        })
    })
}

/// The click. Re-compiles from the same inputs; INV-14 refuses a drifted
/// digest before any Run exists. One command, two shapes: the first
/// authorization mints the runs; a retry's authorization names queued runs.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizeDispatchRequest {
    pub root_id: String,
    pub task_id: String,
    pub path: String,
    pub block_ids: Vec<String>,
    pub material_paths: Vec<String>,
    pub prompt: String,
    pub clicked_digest: String,
    pub new_agents: Vec<String>,
    pub retry_run_ids: Vec<String>,
    /// The ticket's picked agent, for the contract tier. Retry mints no new
    /// agents, so this cannot be derived from `new_agents`.
    pub agent_id: String,
    pub carry: CarryMode,
}

/// The built-in agent the ticket always offers (SPEC 8.3a's first row).
#[tauri::command]
#[specta::specta]
fn l0_file_channel_agent() -> String {
    L0_FILE_CHANNEL_AGENT.to_string()
}

#[tauri::command]
#[specta::specta]
fn authorize_dispatch(
    state: tauri::State<'_, AppState>,
    request: AuthorizeDispatchRequest,
) -> Result<Vec<RunDto>, RefrainError> {
    let AuthorizeDispatchRequest {
        root_id,
        task_id,
        path,
        block_ids,
        material_paths,
        prompt,
        clicked_digest,
        new_agents,
        retry_run_ids,
        agent_id,
        carry,
    } = request;
    state.with_project(&root_id, |_state, entry| {
        let manuscript = entry.manuscripts.get(&path).ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "authorize a dispatch for a document that is not open",
                path.clone(),
            )
        })?;
        let mode = contract_mode(&mut entry.store, &agent_id)?;
        let package = compile_package(
            &mut entry.store,
            manuscript,
            &path,
            &parse_ids(&block_ids, "scope block")?,
            &material_paths,
            &prompt,
            carry,
            mode,
        )?;
        let task_id = parse_id(&task_id, "task")?;
        let mut host = open_host(&mut entry.store)?;
        host.execute(HostCommand::AuthorizeDispatch {
            task_id,
            new_agents: parse_ids(&new_agents, "agent")?,
            retry_runs: parse_ids(&retry_run_ids, "run")?,
            package,
            clicked_digest,
            authorized_at: now_millis(),
        })
        .map_err(into_domain_host)?;
        let covered: Vec<Id> = host
            .authorizations()
            .last()
            .map(|authorization| authorization.run_ids.clone())
            .unwrap_or_default();
        Ok(host
            .runs()
            .iter()
            .filter(|run| covered.contains(&run.id))
            .map(run_dto)
            .collect())
    })
}

/// Launch one authorized run. L0's dispatch is the file becoming visible;
/// the receipt says so. Real adapters take this seam over in C11.
#[tauri::command]
#[specta::specta]
fn launch_run(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    root_id: String,
    run_id: String,
) -> Result<RunDto, RefrainError> {
    let run_id = parse_id(&run_id, "run")?;
    // The run's agent picks the channel: the file channel promotes and is
    // done; a harness agent launches its argv producer and observes in the
    // background.
    let agent = state.with_project(&root_id, |_state, entry| {
        let host = open_host(&mut entry.store)?;
        let run = host
            .runs()
            .iter()
            .find(|run| run.id == run_id)
            .ok_or_else(|| into_domain_host(HostRefusal::UnknownRun(run_id)))?;
        Ok(run.agent_id.to_string())
    })?;
    if agent == KIMI_PRINT_AGENT || kimi_connection_named(&state, &agent) {
        return harness_dispatch_inner(&app, &state, &root_id, &agent, run_id);
    }
    state.with_project(&root_id, |_state, entry| {
        let mut host = open_host(&mut entry.store)?;
        let workspace = format!("runs/{run_id}");
        host.execute(HostCommand::LaunchRun {
            run_id,
            workspace: workspace.clone(),
        })
        .map_err(into_domain_host)?;
        host.execute(HostCommand::CompleteDispatch {
            run_id,
            receipt: format!("l0:request-visible@{workspace}"),
        })
        .map_err(into_domain_host)?;
        Ok(run_dto(&host.runs()[host.runs().len() - 1]))
    })
}

/// The orchestration world as the surface renders it.
#[tauri::command]
#[specta::specta]
fn host_state(
    state: tauri::State<'_, AppState>,
    root_id: String,
) -> Result<HostStateDto, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        let host = open_host(&mut entry.store)?;
        Ok(HostStateDto {
            tasks: host.tasks().iter().map(task_dto).collect(),
            runs: host.runs().iter().map(run_dto).collect(),
            recovery_required: host
                .runs_requiring_recovery()
                .iter()
                .map(Id::to_string)
                .collect(),
            awaiting_launch: host
                .runs_awaiting_launch()
                .iter()
                .map(Id::to_string)
                .collect(),
        })
    })
}

// ── C12: the agent reading ledger — what each agent read at which baseline,
// and whether the manuscript has moved since (rebuilt from the journal) ──

/// One agent's reading of one document: rounds read, the baseline it last
/// stood on, and whether the current head has left that baseline behind.
/// A lag count needs the pinned-revision chain (SPEC 10.1), which does not
/// exist yet — the honest shape today is a stale flag, not a number.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentReadingDto {
    pub agent_id: String,
    pub document: String,
    pub rounds: u32,
    pub last_baseline: String,
    #[serde(with = "refrain_store::project::u64_string")]
    #[specta(type = String)]
    pub last_at: u64,
    pub current_head: Option<String>,
    pub stale: bool,
}

#[tauri::command]
#[specta::specta]
fn agent_reading_ledger(
    state: tauri::State<'_, AppState>,
    root_id: String,
) -> Result<Vec<AgentReadingDto>, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        // Heads come out before the host opens: the journal holds the store
        // for the rest of the closure.
        let heads: HashMap<String, Option<String>> = entry
            .store
            .documents()?
            .into_iter()
            .map(|row| {
                (
                    row.path,
                    row.current_head.as_ref().map(|head| head.to_string()),
                )
            })
            .collect();
        let host = open_host(&mut entry.store)?;
        let mut read_at: HashMap<Id, u64> = HashMap::new();
        for authorization in host.authorizations() {
            for run_id in &authorization.run_ids {
                read_at.insert(*run_id, authorization.authorized_at);
            }
        }
        let mut ledger: HashMap<(Id, String), AgentReadingDto> = HashMap::new();
        for run in host.runs() {
            let Some(task) = host.tasks().iter().find(|task| task.id == run.task_id) else {
                continue;
            };
            let at = read_at.get(&run.id).copied().unwrap_or(0);
            let slot = ledger
                .entry((run.agent_id, task.document.clone()))
                .or_insert_with(|| AgentReadingDto {
                    agent_id: run.agent_id.to_string(),
                    document: task.document.clone(),
                    rounds: 0,
                    last_baseline: String::new(),
                    last_at: 0,
                    current_head: None,
                    stale: false,
                });
            slot.rounds += 1;
            if at >= slot.last_at {
                slot.last_at = at;
                slot.last_baseline = task.baseline.to_string();
            }
        }
        let mut readings: Vec<AgentReadingDto> = ledger.into_values().collect();
        for reading in &mut readings {
            reading.current_head = heads.get(&reading.document).cloned().flatten();
            reading.stale = reading.current_head.as_deref() != Some(reading.last_baseline.as_str());
        }
        readings.sort_by(|a, b| (&a.agent_id, &a.document).cmp(&(&b.agent_id, &b.document)));
        Ok(readings)
    })
}

/// Cancel a run that has not reached a terminal state.
#[tauri::command]
#[specta::specta]
fn cancel_run(
    state: tauri::State<'_, AppState>,
    root_id: String,
    run_id: String,
) -> Result<RunDto, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        let run_id = parse_id(&run_id, "run")?;
        let mut host = open_host(&mut entry.store)?;
        host.execute(HostCommand::CancelRun {
            run_id,
            at: now_millis(),
        })
        .map_err(into_domain_host)?;
        let index = host
            .runs()
            .iter()
            .position(|run| run.id == run_id)
            .ok_or_else(|| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "find a cancelled run",
                    run_id.to_string(),
                )
            })?;
        Ok(run_dto(&host.runs()[index]))
    })
}

/// Retry is a new Run, queued, pointing at the old one (§8.4b). Its
/// authorization is a fresh click through `authorize_dispatch`.
#[tauri::command]
#[specta::specta]
fn retry_run(
    state: tauri::State<'_, AppState>,
    root_id: String,
    run_id: String,
) -> Result<RunDto, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        let run_id = parse_id(&run_id, "run")?;
        let mut host = open_host(&mut entry.store)?;
        host.execute(HostCommand::RetryRun { run_id })
            .map_err(into_domain_host)?;
        Ok(run_dto(&host.runs()[host.runs().len() - 1]))
    })
}

/// Collect a dispatched run's result: validate against the frozen contract,
/// complete the run, and freeze the proposals the artifact carries.
#[tauri::command]
#[specta::specta]
fn collect_attempt(
    state: tauri::State<'_, AppState>,
    root_id: String,
    run_id: String,
) -> Result<CollectOutcomeDto, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        let run_id = parse_id(&run_id, "run")?;
        let context = DirectoryContext::new(entry.store.layout().state_dir.clone());
        // Basis evidence for the contract is gathered before the host opens:
        // the journal holds the store for the rest of the closure.
        let basis: Vec<String> = entry
            .store
            .documents()?
            .iter()
            .filter_map(|row| {
                row.current_head
                    .as_ref()
                    .map(|head| format!("{}@{}", row.path, head))
            })
            .collect();
        let mut host = open_host(&mut entry.store)?;
        let index = host
            .runs()
            .iter()
            .position(|run| run.id == run_id)
            .ok_or_else(|| into_domain_host(HostRefusal::UnknownRun(run_id)))?;
        let run = host.runs()[index].clone();

        let Some(bytes) = context
            .read_result(&run.workspace, run_id)
            .map_err(|error| {
                RefrainError::new(
                    ErrorCode::Io,
                    "read the run's result",
                    run.workspace.clone(),
                )
                .with_detail(error.to_string())
            })?
        else {
            return Ok(CollectOutcomeDto::Waiting);
        };
        let request = context
            .read_workspace_request(&run.workspace)
            .map_err(|error| {
                RefrainError::new(
                    ErrorCode::Io,
                    "read the frozen request",
                    run.workspace.clone(),
                )
                .with_detail(error.to_string())
            })?
            .ok_or_else(|| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "read the frozen request",
                    "the promoted request is missing",
                )
            })?;

        // The contract comes from the frozen bytes the producer answered,
        // never from the artifact's own claims (SPEC 8.4).
        let scopes = before_sections(&request);
        let scope_ids: Vec<String> = scopes.iter().map(|(id, _)| id.clone()).collect();
        let contract = ArtifactContract {
            scopes: &scope_ids,
            basis: &basis,
        };

        let fail = |host: &mut AgentHost<StoreJournal<'_>, DirectoryContext>,
                    code: &str,
                    detail: &str|
         -> Result<CollectOutcomeDto, RefrainError> {
            host.execute(HostCommand::FailRun {
                run_id,
                failure: code.to_string(),
                at: now_millis(),
            })
            .map_err(into_domain_host)?;
            Ok(CollectOutcomeDto::Failed {
                code: code.to_string(),
                detail: detail.to_string(),
            })
        };

        let artifact = match agent_protocol::parse(&bytes, &contract) {
            Ok(artifact) => artifact,
            Err(error) => return fail(&mut host, error.code.as_str(), &error.detail),
        };

        let task = host
            .tasks()
            .iter()
            .find(|task| task.id == run.task_id)
            .ok_or_else(|| into_domain_host(HostRefusal::UnknownTask(run.task_id)))?
            .clone();
        let manuscript = entry.manuscripts.get(&task.document).ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "collect into a document that is not open",
                task.document.clone(),
            )
        })?;

        let before_by_scope: HashMap<String, String> = scopes.into_iter().collect();
        let mut proposals: Vec<(Proposal, Vec<Id>)> = Vec::new();
        for replacement in &artifact.replacements {
            let Some(before) = before_by_scope.get(&replacement.scope) else {
                return fail(&mut host, "unknown-scope", &replacement.scope);
            };
            let Some(blocks) = find_scope_blocks(manuscript, before) else {
                // The author edited the scope under the dispatch. The artifact
                // stays on disk; the run fails with the reason, not a guess.
                return fail(&mut host, "scope-text-moved", &replacement.scope);
            };
            let scope = EditScope::new(blocks.clone()).map_err(|error| {
                RefrainError::new(
                    ErrorCode::Io,
                    "build a proposal scope",
                    task.document.clone(),
                )
                .with_detail(error.to_string())
            })?;
            proposals.push((
                Proposal::new(
                    run_id,
                    task.baseline,
                    scope,
                    before.clone(),
                    replacement.text.clone(),
                ),
                blocks,
            ));
        }

        // §8.4b: validated first, Completed second, proposals frozen third.
        let artifact_digest = format!("{:x}", sha2::Sha256::digest(&bytes));
        host.execute(HostCommand::CollectAttempt {
            run_id,
            artifact_digest,
            at: now_millis(),
        })
        .map_err(into_domain_host)?;
        let count = proposals.len() as u32;
        for (proposal, blocks) in &proposals {
            entry
                .store
                .proposal_insert(&refrain_store::project::ProposalRow {
                    id: proposal.id().to_string(),
                    run: run_id.to_string(),
                    baseline: proposal.baseline().to_string(),
                    document_path: task.document.clone(),
                    scope: json_of(blocks, "proposal scope")?,
                    before_text: proposal.before().to_string(),
                    after_text: proposal.after().map(str::to_string),
                    created_at: now_millis(),
                })
                .map_err(into_domain)?;
        }
        // Material drafts join the world as drafts and nothing more (SPEC
        // 8.7): only a Human Material Action makes one a Material.
        for draft in &artifact.material_drafts {
            entry
                .store
                .material_draft_insert(&refrain_store::materials::MaterialDraftRow {
                    id: Id::new().to_string(),
                    run_id: run_id.to_string(),
                    document: task.document.clone(),
                    kind: draft.kind.clone(),
                    title: draft.title.clone(),
                    basis: json_of(&draft.basis, "material basis")?,
                    body: draft.body.clone(),
                    created_at: now_millis(),
                })
                .map_err(into_domain)?;
        }
        Ok(CollectOutcomeDto::Completed {
            proposals: count,
            memos: artifact.memos.len() as u32,
            drafts: artifact.material_drafts.len() as u32,
        })
    })
}

// ── C11: real harness dispatch (argv adapters over the same frozen protocol) ──

use refrain_host::adapters::{self, HarnessAdapter, HarnessProbe, KimiPrint};
use tauri::Emitter as _;

/// The agent id that names Kimi Code print mode until the Connections
/// registry lands (C11 后段）.
const KIMI_PRINT_AGENT: &str = "00000000-0000-0000-0000-0000000000e1";

/// One dispatchable harness as the ticket offers it.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessDto {
    pub agent_id: String,
    pub label: String,
    pub version: String,
    pub tier: String,
    pub probe: HarnessProbe,
}

/// What the app emits when a backgrounded producer settles.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunSettledDto {
    pub root_id: String,
    pub run_id: String,
    /// "landed" | "failed:<reason>" — the run's own journal has the truth.
    pub outcome: String,
}

/// Every harness the app can dispatch to right now: detection only, no model
/// call (SPEC: 测试连接只跑版本/能力探针）. Config-declared kimi connections
/// win over PATH detection — the author's declaration is the authority.
#[tauri::command]
#[specta::specta]
fn list_harnesses(state: tauri::State<'_, AppState>) -> Vec<HarnessDto> {
    let mut out = Vec::new();
    let kimi_connections: Vec<refrain_store::config::HarnessConnection> = state
        .config
        .as_ref()
        .and_then(|store| store.snapshot().ok())
        .map(|snapshot| {
            snapshot
                .config
                .harness_connections
                .into_iter()
                .filter(|connection| {
                    connection.adapter == refrain_store::config::AdapterKind::KimiCode
                })
                .collect()
        })
        .unwrap_or_default();
    if kimi_connections.is_empty() {
        if let Some(kimi) = KimiPrint::detect() {
            out.push(HarnessDto {
                agent_id: KIMI_PRINT_AGENT.to_string(),
                label: "Kimi Code · print".to_string(),
                version: kimi.version().to_string(),
                tier: "l1".to_string(),
                probe: kimi.probe().unwrap_or(HarnessProbe {
                    id: "kimi-print".to_string(),
                    program: kimi.program().clone(),
                    version: kimi.version().to_string(),
                    tier: refrain_host::Tier::L1,
                }),
            });
        }
        return out;
    }
    for connection in kimi_connections {
        if let Some(kimi) = KimiPrint::at(connection.executable.clone()) {
            let stem = connection
                .executable
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_else(|| "kimi".to_string());
            out.push(HarnessDto {
                agent_id: connection.id.to_string(),
                label: format!("Kimi Code · {stem}"),
                version: kimi.version().to_string(),
                tier: "l1".to_string(),
                probe: kimi.probe().unwrap_or(HarnessProbe {
                    id: "kimi-print".to_string(),
                    program: kimi.program().clone(),
                    version: kimi.version().to_string(),
                    tier: refrain_host::Tier::L1,
                }),
            });
        }
    }
    out
}

/// Register a harness connection in the one Config (SPEC 6.5). The exact
/// executable answers `--version` before it is stored — a connection that
/// cannot be probed is not registered. The C12 surface registers kimi only;
/// other adapter kinds land with their adapters.
#[tauri::command]
#[specta::specta]
fn upsert_harness_connection(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    executable: String,
) -> Result<refrain_store::config::ConfigSnapshot, RefrainError> {
    let program = PathBuf::from(&executable);
    let exists = program.try_exists().map_err(|error| {
        RefrainError::new(
            ErrorCode::Io,
            "check a connection executable",
            executable.clone(),
        )
        .with_detail(error.to_string())
    })?;
    if !exists {
        return Err(
            RefrainError::new(ErrorCode::Io, "register a connection", executable)
                .with_detail("the executable does not exist"),
        );
    }
    KimiPrint::at(program.clone()).ok_or_else(|| {
        RefrainError::new(
            ErrorCode::Io,
            "probe a connection before registering",
            executable.clone(),
        )
    })?;
    let store = state.config.as_ref().ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "write a damaged Config",
            "connections",
        )
    })?;
    let snapshot = store
        .apply(
            refrain_store::config::ConfigChange::UpsertHarnessConnection(
                refrain_store::config::HarnessConnection {
                    id: Id::new(),
                    adapter: refrain_store::config::AdapterKind::KimiCode,
                    executable: program,
                    argv: Vec::new(),
                    env_allow: Vec::new(),
                },
            ),
        )
        .map_err(|failure| {
            RefrainError::new(ErrorCode::Io, "write the Config", failure.to_string())
        })?;
    let _ = app.emit("config-changed", &snapshot.config.appearance.theme);
    Ok(snapshot)
}

/// Remove a connection by id (SPEC 6.5). Trust evidence in app.db is not the
/// author's parameter and is not touched here (Q24).
#[tauri::command]
#[specta::specta]
fn remove_harness_connection(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<refrain_store::config::ConfigSnapshot, RefrainError> {
    let id = parse_id(&id, "connection")?;
    let store = state.config.as_ref().ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "write a damaged Config",
            "connections",
        )
    })?;
    let snapshot = store
        .apply(refrain_store::config::ConfigChange::RemoveHarnessConnection(id))
        .map_err(|failure| {
            RefrainError::new(ErrorCode::Io, "write the Config", failure.to_string())
        })?;
    let _ = app.emit("config-changed", &snapshot.config.appearance.theme);
    Ok(snapshot)
}

/// The Connections page's probe: argv-exact `--version`, nothing else (SPEC:
/// 测试连接只跑版本/能力探针，不调模型）.
#[tauri::command]
#[specta::specta]
fn probe_connection(executable: String) -> Result<String, RefrainError> {
    let outcome = refrain_host::process::launch(&refrain_host::process::LaunchSpec {
        program: PathBuf::from(&executable),
        args: vec!["--version".to_string()],
        env: vec![],
        cwd: std::env::temp_dir(),
        stdin_piped: false,
    })
    .and_then(refrain_host::process::ProcessHandle::wait)
    .map_err(|error| {
        RefrainError::new(ErrorCode::Io, "probe a connection", executable.clone())
            .with_detail(error.to_string())
    })?;
    if outcome.code != Some(0) {
        return Err(
            RefrainError::new(ErrorCode::Io, "probe a connection", executable).with_detail(
                format!("exit {:?}: {}", outcome.code, outcome.stderr.trim()),
            ),
        );
    }
    Ok(outcome.stdout.trim().to_string())
}

/// The Kimi Print channel for one run's agent: the built-in detected entry,
/// or the exact executable of the Config connection naming it (C12 roster).
fn kimi_for_agent(state: &AppState, agent: &str) -> Result<KimiPrint, RefrainError> {
    if agent == KIMI_PRINT_AGENT {
        return KimiPrint::detect().ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "dispatch to Kimi Code",
                "kimi CLI not on PATH",
            )
        });
    }
    let store = state.config.as_ref().ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "read the Config for a connection",
            agent,
        )
    })?;
    let snapshot = store.snapshot().map_err(|failure| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "read the Config for a connection",
            failure.to_string(),
        )
    })?;
    let connection = snapshot
        .config
        .harness_connections
        .iter()
        .find(|connection| {
            connection.id.to_string() == agent
                && connection.adapter == refrain_store::config::AdapterKind::KimiCode
        })
        .ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "dispatch over a connection",
                "no such kimi connection",
            )
        })?;
    KimiPrint::at(connection.executable.clone()).ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "probe a declared connection",
            connection.executable.display().to_string(),
        )
    })
}

/// Whether the agent id names a Config-declared kimi connection.
fn kimi_connection_named(state: &AppState, agent: &str) -> bool {
    state
        .config
        .as_ref()
        .and_then(|store| store.snapshot().ok())
        .is_some_and(|snapshot| {
            snapshot
                .config
                .harness_connections
                .iter()
                .any(|connection| {
                    connection.id.to_string() == agent
                        && connection.adapter == refrain_store::config::AdapterKind::KimiCode
                })
        })
}

/// Launch one authorized run on a real harness: promote the frozen request,
/// argv-dispatch, then observe in the background — the result lands as a
/// file and the UI hears `run-settled`. Launch failures land as Failed with
/// the reason; nothing rolls back (SPEC 8.2-3/4).
fn harness_dispatch_inner(
    app: &tauri::AppHandle,
    state: &AppState,
    root_id: &str,
    agent: &str,
    run_id: Id,
) -> Result<RunDto, RefrainError> {
    let kimi = kimi_for_agent(state, agent)?;
    let (workspace, workspace_abs, request_md) = state.with_project(root_id, |_state, entry| {
        let context = DirectoryContext::new(entry.store.layout().state_dir.clone());
        let mut host = open_host(&mut entry.store)?;
        let workspace = format!("runs/{run_id}");
        host.execute(HostCommand::LaunchRun {
            run_id,
            workspace: workspace.clone(),
        })
        .map_err(into_domain_host)?;
        let request = context
            .read_workspace_request(&workspace)
            .map_err(|error| {
                RefrainError::new(
                    ErrorCode::Io,
                    "read the promoted request",
                    workspace.clone(),
                )
                .with_detail(error.to_string())
            })?
            .ok_or_else(|| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "read the promoted request",
                    "the request did not land in the workspace",
                )
            })?;
        Ok((
            workspace.clone(),
            entry.store.layout().state_dir.join(&workspace),
            request,
        ))
    })?;

    let receipt = match kimi.dispatch(&adapters::DispatchSpec {
        run_id,
        workspace: workspace_abs,
        request_md,
    }) {
        Ok(receipt) => receipt,
        Err(error) => {
            state.with_project(root_id, |_state, entry| {
                let mut host = open_host(&mut entry.store)?;
                host.execute(HostCommand::FailRun {
                    run_id,
                    failure: format!("launch-failed: {error}"),
                    at: now_millis(),
                })
                .map_err(into_domain_host)
            })?;
            return Err(
                RefrainError::new(ErrorCode::Io, "launch the harness", "kimi -p")
                    .with_detail(error.to_string()),
            );
        }
    };
    let receipt_text = receipt.receipt.clone();

    let dto = state.with_project(root_id, |_state, entry| {
        let mut host = open_host(&mut entry.store)?;
        host.execute(HostCommand::CompleteDispatch {
            run_id,
            receipt: receipt_text,
        })
        .map_err(into_domain_host)?;
        let index = host
            .runs()
            .iter()
            .position(|run| run.id == run_id)
            .ok_or_else(|| into_domain_host(HostRefusal::UnknownRun(run_id)))?;
        Ok(run_dto(&host.runs()[index]))
    })?;

    // Observe in the background: the turn may run for minutes. On settle, the
    // reply lands atomically as the attempt's result; an empty reply fails
    // the run with the reason, not a guess.
    let root_for_thread = root_id.to_string();
    let app = app.clone();
    std::thread::spawn(move || {
        let outcome = kimi.observe(receipt);
        let state = app.state::<AppState>();
        let settled = state.with_project(&root_for_thread, |_state, entry| {
            let context = DirectoryContext::new(entry.store.layout().state_dir.clone());
            let mut host = open_host(&mut entry.store)?;
            match outcome {
                Ok(produced) if !produced.reply_text.trim().is_empty() => {
                    context
                        .land_result(&workspace, run_id, produced.reply_text.as_bytes())
                        .map_err(|error| {
                            RefrainError::new(
                                ErrorCode::Io,
                                "land the producer's reply",
                                workspace.clone(),
                            )
                            .with_detail(error.to_string())
                        })?;
                    Ok("landed".to_string())
                }
                Ok(produced) => {
                    host.execute(HostCommand::FailRun {
                        run_id,
                        failure: format!("empty-reply: exit {:?}", produced.exit_code),
                        at: now_millis(),
                    })
                    .map_err(into_domain_host)?;
                    Ok(format!("failed:empty-reply:{:?}", produced.exit_code))
                }
                Err(error) => {
                    host.execute(HostCommand::FailRun {
                        run_id,
                        failure: format!("producer-io: {error}"),
                        at: now_millis(),
                    })
                    .map_err(into_domain_host)?;
                    Ok(format!("failed:producer-io:{error}"))
                }
            }
        });
        let outcome = match settled {
            Ok(text) => text,
            Err(error) => format!("failed:{error}"),
        };
        let _ = app.emit(
            "run-settled",
            RunSettledDto {
                root_id: root_for_thread,
                run_id: run_id.to_string(),
                outcome,
            },
        );
    });

    Ok(dto)
}

/// The command form for the UI's harness dispatch (launch_run branches here
/// for harness agents; this stays a command for the e2e seam).
#[tauri::command]
#[specta::specta]
fn harness_dispatch(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    root_id: String,
    run_id: String,
) -> Result<RunDto, RefrainError> {
    let run_id = parse_id(&run_id, "run")?;
    let agent = state.with_project(&root_id, |_state, entry| {
        let host = open_host(&mut entry.store)?;
        host.runs()
            .iter()
            .find(|run| run.id == run_id)
            .map(|run| run.agent_id.to_string())
            .ok_or_else(|| into_domain_host(HostRefusal::UnknownRun(run_id)))
    })?;
    harness_dispatch_inner(&app, &state, &root_id, &agent, run_id)
}

// ── C12: materials — drafts review and the Human Material Action (SPEC 8.7) ──

/// Every unresolved material draft, for the ticket's materials panel.
#[tauri::command]
#[specta::specta]
fn list_material_drafts(
    state: tauri::State<'_, AppState>,
    root_id: String,
) -> Result<Vec<refrain_store::materials::MaterialDraftRow>, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        entry.store.material_drafts().map_err(into_domain)
    })
}

/// The shared Human Material Action body (SPEC 8.7): create the document,
/// write its body through the same journaled text path the editor uses,
/// persist. Used by draft resolution, by source import (C12.3), and by
/// drag-drop manuscript import (C12.6).
fn create_material_with_body(
    state: &AppState,
    entry: &mut ProjectEntry,
    title: &str,
    body: &str,
    role: DocumentRole,
) -> Result<DocumentRow, RefrainError> {
    let created = entry
        .store
        .create(&refrain_store::project::CreateDocument {
            title: title.to_string(),
            role,
        })
        .map_err(into_domain)?;
    let opened = entry
        .store
        .open_document(&created.row.path)
        .map_err(into_domain)?;
    open_in_entry(state, entry, &created.row.path, opened)?;

    let paragraphs: Vec<String> = body
        .split("\n\n")
        .map(str::trim)
        .filter(|paragraph| !paragraph.is_empty())
        .map(str::to_string)
        .collect();
    if !paragraphs.is_empty() {
        let base = entry
            .manuscripts
            .get(&created.row.path)
            .map(|manuscript| manuscript.head().id().to_string())
            .ok_or_else(|| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "write a material that is not open",
                    created.row.path.clone(),
                )
            })?;
        let action_dto = EditorActionDto {
            base,
            changes: vec![EditorChangeDto::Insert {
                before: None,
                texts: paragraphs.clone(),
            }],
        };
        let action_json = serde_json::to_string(&action_dto).map_err(|error| {
            RefrainError::new(
                ErrorCode::Io,
                "serialise the material body",
                created.row.path.clone(),
            )
            .with_detail(error.to_string())
        })?;
        let journal_id = entry
            .store
            .journal_append(&created.row.path, &action_json)
            .map_err(into_domain)?;
        // The executed action is the journaled one, through the same
        // conversion the replay path uses — one construction, no drift.
        let domain_action = to_domain_action(action_dto)?;
        let outcome = {
            let manuscript = entry
                .manuscripts
                .get_mut(&created.row.path)
                .ok_or_else(|| {
                    RefrainError::new(
                        ErrorCode::StateUnavailable,
                        "write a material that is not open",
                        created.row.path.clone(),
                    )
                })?;
            manuscript.execute(TextCommand::Editor(domain_action))
        };
        match outcome {
            Ok(_transition) => {
                entry
                    .store
                    .journal_remove(journal_id)
                    .map_err(into_domain)?;
            }
            Err(refusal) => {
                return Err(RefrainError::new(
                    ErrorCode::Io,
                    "write the material body",
                    created.row.path.clone(),
                )
                .with_detail(refusal.to_string()));
            }
        }
    }
    match persist_in_entry(entry, &created.row.path, None)? {
        SaveOutcomeDto::Saved { .. } => Ok(created.row),
        SaveOutcomeDto::ChangedUnderneath { .. } => Err(RefrainError::new(
            ErrorCode::Io,
            "confirm a new material",
            "the file moved underneath",
        )),
    }
}

/// The only way a draft becomes a Material (SPEC 8.7: a Human Material
/// Action). Save writes the body through the same text path as the editor —
/// create, insert, confirm — never a direct file write. Dismiss keeps the
/// artifact on disk in the run workspace and removes only the draft row.
#[tauri::command]
#[specta::specta]
fn commit_material_action(
    state: tauri::State<'_, AppState>,
    root_id: String,
    draft_id: String,
    edited_body: Option<String>,
    dismiss: bool,
) -> Result<Option<DocumentRow>, RefrainError> {
    state.with_project(&root_id, |state, entry| {
        let draft = entry
            .store
            .material_drafts()
            .map_err(into_domain)?
            .into_iter()
            .find(|row| row.id == draft_id)
            .ok_or_else(|| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "resolve a draft",
                    "no such draft",
                )
            })?;
        if dismiss {
            entry
                .store
                .material_draft_take(&draft_id)
                .map_err(into_domain)?;
            return Ok(None);
        }

        let body = edited_body.unwrap_or_else(|| draft.body.clone());
        let row =
            create_material_with_body(state, entry, &draft.title, &body, DocumentRole::Material)?;
        entry
            .store
            .material_draft_take(&draft_id)
            .map_err(into_domain)?;
        Ok(Some(row))
    })
}

// ── C12.3: source import — six reference formats become Materials ──────────

/// Import one source file (PDF / EPUB / HTML / DOCX / PPTX / XLSX) as a
/// Material (Plan C12.3). Extraction is local — no cloud conversion; the
/// material opens with a provenance header pinning the source bytes, then
/// the projected text. The manuscript editor stays Markdown-only.
#[tauri::command]
#[specta::specta]
fn import_material(
    state: tauri::State<'_, AppState>,
    root_id: String,
    source_path: String,
) -> Result<DocumentRow, RefrainError> {
    state.with_project(&root_id, |state, entry| {
        let ingested = refrain_store::ingest::ingest(std::path::Path::new(&source_path))?;
        // KL9: the source never moves. The original bytes join the project's
        // read-only zone before the projected material exists — every later
        // edit happens only on the project's own material document.
        let clone = entry
            .store
            .clone_material_source(&ingested.source_path, &ingested.source_digest)
            .map_err(into_domain)?;
        let clone_display = clone
            .strip_prefix(
                entry
                    .store
                    .layout()
                    .source_backup_dir
                    .parent()
                    .unwrap_or(std::path::Path::new("")),
            )
            .unwrap_or(&clone)
            .display();
        let header = format!(
            "> 来源：{}（{} · sha256 {}）；原件克隆：{}",
            ingested.source_path.display(),
            ingested.format.as_str(),
            &ingested.source_digest[..12],
            clone_display
        );
        let body = format!("{header}\n\n{}", ingested.text);
        create_material_with_body(state, entry, &ingested.title, &body, DocumentRole::Material)
    })
}

// ── C12.6: drag-drop import — text becomes a chapter, the rest a Material ──

/// Import one dropped text file (.md / .markdown / .txt) as a manuscript
/// chapter. The source is only read — it never moves (KL9: 源文件永远不动);
/// the chapter's own bytes are what the project edits from now on.
#[tauri::command]
#[specta::specta]
fn import_manuscript(
    state: tauri::State<'_, AppState>,
    root_id: String,
    source_path: String,
) -> Result<DocumentRow, RefrainError> {
    let path = std::path::Path::new(&source_path);
    let bytes = std::fs::read(path).map_err(|error| {
        RefrainError::new(ErrorCode::Io, "read the dropped file", source_path.clone())
            .with_detail(error.to_string())
    })?;
    let text_bytes = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &bytes[3..]
    } else {
        &bytes[..]
    };
    let text = String::from_utf8(text_bytes.to_vec()).map_err(|_| {
        RefrainError::new(
            ErrorCode::UnsupportedFormat,
            "read the dropped file",
            "not UTF-8 text",
        )
    })?;
    let title = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .unwrap_or("拖入")
        .to_string();
    state.with_project(&root_id, |state, entry| {
        create_material_with_body(state, entry, &title, &text, DocumentRole::Chapter)
    })
}
