//! Composition layer.
//!
//! Every command here is a one-line mapping onto a named use case. No business
//! state lives in this crate, and no domain rule is decided here (SPEC 6.2).
//! The session map holds live handles — open stores and manuscripts — which
//! are runtime objects, not a second copy of business state.

mod display;
mod fonts;
mod harnesses;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use refrain_core::{
    DocumentFormat, DocumentRole, EditorAction, EditorChange, ErrorCode, Id, Insertion,
    KaraAutoEntry, KaraEvent, KaraMachine, KaraPolicy, KaraTransition, Lineage, Manuscript,
    RecoveryStep, RefrainError, Replacement, SourceSnapshot, TextCommand, TextRefusal,
    TextTransition,
};
use refrain_store::history::{ActionSummary, HYDRATION_DEPTH, MAX_TEXT_ACTION_LIST};
use refrain_store::mailbox::{MailboxBoxName, MailboxStanding};
use refrain_store::project::{
    BackupStatus, BlockHit, DocumentCommit, DocumentPage, DocumentPageQuery, DocumentRow,
    FileStamp, MAX_DOCUMENT_PAGE_SIZE, MAX_DOCUMENT_SEARCH_RESULTS, ProjectFailure, ProjectStore,
    RootLocator,
};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::Manager;
use tauri_specta::{Builder, collect_commands};

use display::display_profile;
use fonts::{FontCatalog, FontFamilyDto};

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

/// One live producer and the journal fact a concurrent observer must respect.
/// The per-Run lock is held across process termination and the Cancelled write,
/// so the observer cannot race that write with a terminal failure.
struct ActiveRun {
    cancel: refrain_host::process::ProcessCancel,
    cancelled: bool,
}

type ActiveRunHandle = Arc<Mutex<ActiveRun>>;

/// Session state. `app.db` is the machine-level authority; projects are
/// opened through it.
pub struct AppState {
    app_db: Mutex<Connection>,
    projects: Mutex<HashMap<String, ProjectEntry>>,
    kara: Mutex<KaraMachine>,
    config: Option<refrain_store::config::ConfigStore>,
    config_notice: Mutex<Option<String>>,
    fonts: Arc<FontCatalog>,
    active_runs: Mutex<HashMap<(String, Id), ActiveRunHandle>>,
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
            fonts: Arc::new(FontCatalog::default()),
            active_runs: Mutex::new(HashMap::new()),
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
    ) -> Result<(String, BackupStatus, DocumentPage), RefrainError> {
        let mut app_db = self
            .app_db
            .lock()
            .map_err(|_| RefrainError::new(ErrorCode::StateUnavailable, "lock app.db", "adopt"))?;
        let (mut store, backup) = ProjectStore::adopt(&mut app_db, locator).map_err(into_domain)?;
        let root_id = store.permit().root_id.to_string();
        let page = store
            .refresh_document_page(DocumentPageQuery {
                after: None,
                limit: MAX_DOCUMENT_PAGE_SIZE,
            })
            .map_err(into_domain)?;
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
        Ok((root_id, backup, page))
    }
}

/// A Root as the interface names it.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOpenedDto {
    pub root_id: String,
    pub backup: BackupStatus,
    pub documents: Vec<DocumentRow>,
    pub document_total: u32,
    pub document_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPageDto {
    pub documents: Vec<DocumentRow>,
    pub total: u32,
    pub next: Option<String>,
}

impl From<DocumentPage> for DocumentPageDto {
    fn from(page: DocumentPage) -> Self {
        Self {
            documents: page.documents,
            total: page.total,
            next: page.next,
        }
    }
}

/// A document ready for the editor: blocks with stable ids, the revision the
/// editor's actions will be based on, and the stamp a later save needs.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenDocumentDto {
    pub document: DocumentRow,
    /// What the bytes are: Markdown prose, or the plain-text format the
    /// extension names. The editor reads it to pick its mode and its grammar.
    pub format: DocumentFormat,
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
    /// Display-width equivalents: CJK and full-width punctuation count two.
    /// Wrapping follows display width, not code point count, and in CJK prose
    /// the two differ by nearly a factor of two.
    pub width_units: u32,
    /// Line breaks the author typed. A block occupies at least this many plus one.
    pub hard_lines: u32,
    /// The widest single line: a narrow block does not wrap just because it is long.
    pub max_line_units: u32,
    /// A fence keeps the author's lines instead of wrapping.
    pub is_fence: bool,
}

impl BlockDto {
    /// Carry a block across the bridge together with its shape.
    ///
    /// The viewport needs the shape to estimate this block's height before it
    /// has laid anything out, and the shape is read from the same text that is
    /// already being sent — so sending it costs one branch-free width scan and
    /// saves the viewport from guessing this block's height from other blocks.
    ///
    /// The width scan is format-agnostic arithmetic. The kind classification
    /// is Markdown's: under the plain scan a line that starts with a fence
    /// marker is still just a line, so `is_fence` is always false.
    fn of(block: &refrain_core::manuscript::Block, scan: refrain_core::BlockScan) -> Self {
        let text = block.text();
        let shape = refrain_core::block_shape::BlockShape::of(text);
        let is_fence = match scan {
            refrain_core::BlockScan::Markdown => {
                shape.kind == refrain_core::block_shape::BlockKind::Fence
            }
            refrain_core::BlockScan::Plain => false,
        };
        Self {
            id: block.id().to_string(),
            text: text.to_owned(),
            width_units: shape.width_units,
            hard_lines: shape.hard_lines,
            max_line_units: shape.max_line_units,
            is_fence,
        }
    }
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AnnotationAnchorState {
    Anchored,
    Drifted,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationDto {
    pub id: String,
    pub document: String,
    pub block_id: String,
    pub start: u32,
    pub end: u32,
    pub quote: String,
    pub kind: refrain_store::annotations::AnnotationKind,
    pub body: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub anchor_state: AnnotationAnchorState,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpsertAnnotationRequest {
    pub root_id: String,
    pub id: Option<String>,
    pub document: String,
    pub block_id: String,
    pub start: u32,
    pub end: u32,
    pub quote: String,
    pub kind: refrain_store::annotations::AnnotationKind,
    pub body: Option<String>,
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

// host 实体 ↔ store 行 的翻译，连同 StoreJournal 接缝与两个错误转换，已搬进
// refrain-app::journal。它们既不属于 host（host 不认识数据库）也不属于 store
// （store 不认识 ReviewTask），住在桥上时只能连着一个 Tauri 窗口一起验证。
// 检验方案见 crates/refrain-app/tests/journal.rs：内存 store 走完整轮回，断言
// 实体逐字段还原、且索引列与实体内部的值一致。

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

/// Adopt a path that already passed a Rust-owned chooser or the debug-only
/// e2e seam. No release command accepts this path from the renderer.
fn adopt_root_at(
    state: tauri::State<'_, AppState>,
    path: PathBuf,
    kind: RootKind,
) -> Result<ProjectOpenedDto, RefrainError> {
    let locator = RootLocator { path, kind };
    let (root_id, backup, page) = state.adopt(&locator)?;
    Ok(ProjectOpenedDto {
        root_id,
        backup,
        documents: page.documents,
        document_total: page.total,
        document_cursor: page.next,
    })
}

/// Let the author choose the Root and consume that choice in this command.
#[tauri::command]
#[specta::specta]
async fn choose_and_adopt_root(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    kind: RootKind,
) -> Result<Option<ProjectOpenedDto>, RefrainError> {
    use tauri_plugin_dialog::DialogExt as _;
    let dialog = app.dialog().file().set_title(match kind {
        RootKind::Folder => "选择项目文件夹",
        RootKind::File => "选择一份手稿",
    });
    let selected = match kind {
        RootKind::Folder => dialog.blocking_pick_folder(),
        RootKind::File => dialog
            .add_filter("Manuscript", &DocumentFormat::extensions())
            .blocking_pick_file(),
    };
    selected
        .map(|selected| {
            let path = selected.into_path().map_err(|error| {
                RefrainError::new(ErrorCode::Io, "use a chosen Root", error.to_string())
            })?;
            adopt_root_at(state, path, kind)
        })
        .transpose()
}

/// Create a project beneath a parent that already passed a Rust-owned chooser.
fn create_project_at(
    state: tauri::State<'_, AppState>,
    parent: PathBuf,
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
    adopt_root_at(state, path, RootKind::Folder)
}

/// Let the author choose the parent and consume it while creating the project.
#[tauri::command]
#[specta::specta]
async fn choose_and_create_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<Option<ProjectOpenedDto>, RefrainError> {
    use tauri_plugin_dialog::DialogExt as _;
    app.dialog()
        .file()
        .set_title("选择项目的父目录")
        .blocking_pick_folder()
        .map(|selected| {
            let parent = selected.into_path().map_err(|error| {
                RefrainError::new(
                    ErrorCode::Io,
                    "use a chosen project parent",
                    error.to_string(),
                )
            })?;
            create_project_at(state, parent, name)
        })
        .transpose()
}

/// Return one bounded page from an already reconciled project index.
#[tauri::command(async)]
#[specta::specta]
fn document_page(
    state: tauri::State<'_, AppState>,
    root_id: String,
    after: Option<String>,
) -> Result<DocumentPageDto, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        entry
            .store
            .document_page(DocumentPageQuery {
                after,
                limit: MAX_DOCUMENT_PAGE_SIZE,
            })
            .map(DocumentPageDto::from)
    })
}

/// How literal a search is: every query part must appear, or any part may.
#[derive(Debug, Clone, Copy, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum SearchPrecision {
    Exact,
    Loose,
}

/// Search the complete project index. Request ordering belongs to the caller.
#[tauri::command(async)]
#[specta::specta]
fn document_search(
    state: tauri::State<'_, AppState>,
    root_id: String,
    query: String,
    precision: SearchPrecision,
) -> Result<Vec<DocumentRow>, RefrainError> {
    let precision = match precision {
        SearchPrecision::Exact => refrain_core::chinese_index::Precision::Exact,
        SearchPrecision::Loose => refrain_core::chinese_index::Precision::Loose,
    };
    state.with_project(&root_id, |_state, entry| {
        entry
            .store
            .search_documents_with(&query, precision, MAX_DOCUMENT_SEARCH_RESULTS)
    })
}

/// Search and keep the blocks, so the result panel can show what matched.
///
/// `document_search` answers "which files"; this answers "which passages, and
/// what do they say". A path cannot be highlighted — the query words are not
/// in it — so showing the author where their words are needs the text.
#[tauri::command(async)]
#[specta::specta]
fn block_search(
    state: tauri::State<'_, AppState>,
    root_id: String,
    query: String,
    precision: SearchPrecision,
) -> Result<Vec<BlockHit>, RefrainError> {
    let precision = match precision {
        SearchPrecision::Exact => refrain_core::chinese_index::Precision::Exact,
        SearchPrecision::Loose => refrain_core::chinese_index::Precision::Loose,
    };
    state.with_project(&root_id, |_state, entry| {
        entry
            .store
            .search_blocks_with(&query, precision, MAX_DOCUMENT_SEARCH_RESULTS)
    })
}

/// Open a document: bytes from disk, blocks from the byte-authoritative
/// layout, the persisted revision chain resumed, and any journaled actions
/// replayed through the same validation (SPEC 7.2).
#[tauri::command(async)]
#[specta::specta]
fn open_document(
    state: tauri::State<'_, AppState>,
    root_id: String,
    path: String,
) -> Result<OpenDocumentDto, RefrainError> {
    state.with_project(&root_id, |state, entry| {
        let opened = entry
            .store
            .open_registered_document(&path)
            .map_err(into_domain)?;
        open_in_entry(state, entry, &path, opened)
    })
}

/// Create a document in the Root and open it (SPEC 9.5).
#[tauri::command(async)]
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

/// Delete a document or a material: the file goes to the system recycle bin
/// (INV-6) and nowhere else. The catalog row and the search index follow the
/// file; the audit — proposals, verdicts, annotations — stays. An imported
/// Material's source clone stays too: the Source Backup is never written,
/// and a delete is not an exception. Returns the row that was deleted.
#[tauri::command(async)]
#[specta::specta]
fn delete_document(
    state: tauri::State<'_, AppState>,
    root_id: String,
    path: String,
) -> Result<DocumentRow, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        let row = entry.store.delete_document(&path).map_err(into_domain)?;
        entry.manuscripts.remove(&path);
        Ok(row)
    })
}

/// Write what the author permits for one material (范围). The next dispatch's
/// material listing carries it — the permission lives on the document's row,
/// not in the ticket's memory.
#[tauri::command(async)]
#[specta::specta]
fn set_disclosure(
    state: tauri::State<'_, AppState>,
    root_id: String,
    path: String,
    disclosure: Disclosure,
) -> Result<DocumentRow, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        entry
            .store
            .set_disclosure(&path, disclosure)
            .map_err(into_domain)
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
    // A file the catalogue lists by extension may still not be UTF-8 (GBK
    // manuscripts are common). Refuse it as a fact the author can act on;
    // `SourceSnapshot::read` would panic the whole process instead.
    //
    // The path decides how the bytes divide into blocks: Markdown structure
    // for prose, one line per block for every plain-text format.
    let scan = DocumentFormat::of_path(path).block_scan();
    let snapshot =
        SourceSnapshot::read_checked_with(opened.bytes.clone(), scan).map_err(|error| {
            RefrainError::new(ErrorCode::UnsupportedFormat, "open a document", path)
                .with_detail(format!("not UTF-8 text: {error}"))
        })?;
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

    // The persisted undo chain hydrates only when continuity resumes: the
    // rows chain to the persisted head, and a fresh lineage makes them
    // unreachable by construction.
    let history = match &continuity {
        Some((head, _)) => entry
            .store
            .action_history()
            .chain(path, *head, HYDRATION_DEPTH)
            .map_err(into_domain_store)?,
        None => Vec::new(),
    };

    let (mut manuscript, continuity_ok) = match continuity {
        Some((head, lineage)) => (
            Manuscript::open_at(snapshot, lineage, head, history).map_err(|error| {
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
        match to_domain_action(dto, scan) {
            Ok(action) => match manuscript.execute(TextCommand::Editor(action)) {
                Ok(transition) => {
                    record_text_action(&entry.store, path, &transition)?;
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
        .map(|block| BlockDto::of(block, scan))
        .collect();
    entry.manuscripts.insert(path.to_string(), manuscript);

    Ok(OpenDocumentDto {
        document: opened.row,
        format: DocumentFormat::of_path(path),
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

#[tauri::command(async)]
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
                .map(|block| BlockDto::of(block, manuscript.scan()))
                .collect(),
        })
    })
}

/// The one manuscript write path (INV-2): journaled first, executed through
/// the domain, cleared on confirmation. A kill between journal and execute
/// replays on the next open.
#[tauri::command(async)]
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

        let domain_action = to_domain_action(action, DocumentFormat::of_path(&path).block_scan())?;
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
                record_text_action(&entry.store, &path, &transition)?;
                entry
                    .store
                    .journal_remove(journal_id)
                    .map_err(into_domain)?;
                Ok(transition_dto(&transition))
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

/// Undo the session's last Text Action (INV-2 in reverse, through the same
/// domain). Nothing is journaled and no history row is marked: undo moves
/// session memory only, so on a crash the disk's continuity simply resumes
/// the pre-undo chain — exactly as if the undo had not happened yet. The
/// row's `undone_at` is written by the save that makes the undo durable.
#[tauri::command(async)]
#[specta::specta]
fn undo_editor_action(
    state: tauri::State<'_, AppState>,
    root_id: String,
    path: String,
) -> Result<TextTransitionDto, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        let transition = entry
            .manuscripts
            .get_mut(&path)
            .ok_or_else(|| not_open("undo in a document that is not open", &path))?
            .undo_last()
            .map_err(|refusal| text_refusal("undo the last action", &path, refusal))?;
        Ok(transition_dto(&transition))
    })
}

fn not_open(action: &'static str, path: &str) -> RefrainError {
    RefrainError::new(ErrorCode::StateUnavailable, action, path.to_string())
}

fn text_refusal(action: &'static str, path: &str, refusal: TextRefusal) -> RefrainError {
    RefrainError::new(ErrorCode::Io, action, path.to_string()).with_detail(refusal.to_string())
}

/// The confirmed outcome of one applied action, as every write-path command
/// reports it. One constructor so the three commands cannot drift apart on
/// what "confirmed" means.
fn transition_dto(transition: &TextTransition) -> TextTransitionDto {
    TextTransitionDto {
        revision: transition.head().id().to_string(),
        action_id: transition.action().id().to_string(),
        touched_blocks: transition
            .action()
            .touched_blocks()
            .iter()
            .map(Id::to_string)
            .collect(),
    }
}

/// Record an executed Text Action in the persisted history. Written after the
/// execute lands and before the journal clears: a kill between the two leaves
/// the row and the journal entry behind, and the next open's replay writes the
/// same content under fresh ids — the orphaned row never chains from a saved
/// head, so the hydration walk never reaches it.
fn record_text_action(
    store: &ProjectStore,
    path: &str,
    transition: &TextTransition,
) -> Result<(), RefrainError> {
    store
        .action_history()
        .record(path, transition.action(), transition.head().id())
        .map_err(into_domain_store)
}

/// One row of the persisted undo history, as the history panel lists it.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextActionSummaryDto {
    pub id: String,
    pub ordinal: u32,
    pub cause: String,
    /// Milliseconds since the Unix epoch, as a decimal string.
    pub created_at: String,
    pub undone: bool,
}

impl From<ActionSummary> for TextActionSummaryDto {
    fn from(row: ActionSummary) -> Self {
        Self {
            id: row.id.to_string(),
            ordinal: row.ordinal,
            cause: row.cause,
            created_at: row.created_at.to_string(),
            undone: row.undone,
        }
    }
}

/// The recent persisted history of one document, newest first. Read from the
/// store alone: rows are written at execute, so nothing the session did is
/// missing from the list.
#[tauri::command(async)]
#[specta::specta]
fn list_text_actions(
    state: tauri::State<'_, AppState>,
    root_id: String,
    path: String,
) -> Result<Vec<TextActionSummaryDto>, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        entry
            .store
            .action_history()
            .list_recent(&path, MAX_TEXT_ACTION_LIST)
            .map_err(into_domain_store)
            .map(|rows| rows.into_iter().map(TextActionSummaryDto::from).collect())
    })
}

/// What a revert became: the transitions it walked (last one carries the head
/// it landed on, so the editor can restore the caret where text changed) and
/// the actions it undid. An empty `transitions` means the target was the tip.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RevertOutcomeDto {
    pub revision: String,
    pub transitions: Vec<TextTransitionDto>,
    pub undone: Vec<String>,
}

/// Revert to just after one action: undo everything above it. The walk is the
/// domain's `revert_to`, which checks before it moves — a verdict-carrying
/// action in the way refuses the whole revert and nothing moves. Undone rows
/// keep their `undone_at` unwritten until the save that makes this durable.
#[tauri::command(async)]
#[specta::specta]
fn revert_to_action(
    state: tauri::State<'_, AppState>,
    root_id: String,
    path: String,
    action_id: String,
) -> Result<RevertOutcomeDto, RefrainError> {
    let target = parse_id(&action_id, "text action")?;
    state.with_project(&root_id, |_state, entry| {
        let manuscript = entry
            .manuscripts
            .get_mut(&path)
            .ok_or_else(|| not_open("revert in a document that is not open", &path))?;
        let undone: Vec<String> = match manuscript
            .actions()
            .iter()
            .position(|action| action.id() == target)
        {
            Some(position) => manuscript.actions()[position + 1..]
                .iter()
                .map(|action| action.id().to_string())
                .collect(),
            None => Vec::new(),
        };
        let transitions = manuscript
            .revert_to(target)
            .map_err(|refusal| text_refusal("revert to an action", &path, refusal))?;
        Ok(RevertOutcomeDto {
            revision: manuscript.head().id().to_string(),
            transitions: transitions.iter().map(transition_dto).collect(),
            undone,
        })
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
    let (bytes, lineage, head, live) = {
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
        let live: Vec<Id> = manuscript
            .actions()
            .iter()
            .map(refrain_core::TextAction::id)
            .collect();
        (
            bytes,
            manuscript.lineage_ids(),
            manuscript.head().id(),
            live,
        )
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

    // The save is what makes the session's chain durable, so this is where
    // undone and orphaned rows get their mark — never at undo time.
    entry
        .store
        .action_history()
        .sync_chain(path, &live)
        .map_err(into_domain_store)?;

    Ok(SaveOutcomeDto::Saved {
        stamp: committed.stamp,
        recovery_evidence: committed
            .recovery_evidence
            .map(|path| path.display().to_string()),
    })
}

#[tauri::command(async)]
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

fn to_domain_action(
    dto: EditorActionDto,
    scan: refrain_core::BlockScan,
) -> Result<EditorAction, RefrainError> {
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
                Insertion::new(before, texts, scan)
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
#[tauri::command(async)]
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
#[tauri::command(async)]
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
#[tauri::command(async)]
#[specta::specta]
fn universal_icon(state: tauri::State<'_, AppState>) -> Option<Vec<u8>> {
    let store = state.config.as_ref()?;
    let digest = store.snapshot().ok()?.config.appearance.icon_digest?;
    refrain_store::icons::read_icon(&icon_assets_dir(&state), &digest).ok()
}

/// The immutable clone of an imported source, for reading its original pages.
///
/// A Material carries the projected text; this returns the bytes the file was
/// imported from. The two are different things and the difference matters: for
/// a PDF the projection is text with no page, no column and no figure, so an
/// author checking a quotation against the original needs the original.
///
/// **Read only.** RefRain never writes back into a source (owner's ruling) and
/// never writes into the backup directory after import.
///
/// Absent is a value: a Material imported before clones were kept, or one whose
/// clone was removed, answers `None` rather than an error. The caller shows the
/// text it already has.
#[tauri::command(async)]
#[specta::specta]
fn imported_source_bytes(
    state: tauri::State<'_, AppState>,
    root_id: String,
    digest: String,
    format: String,
) -> Option<Vec<u8>> {
    let clone_dir = state
        .with_project(&root_id, |_state, entry| {
            Ok(entry.store.layout().source_backup_dir.join("materials"))
        })
        .ok()?;
    refrain_store::materials::read_material_clone(&clone_dir, &digest, &format).ok()
}

/// Installed families and the weights the machine can actually draw. The
/// catalog is scanned once per application session and never launches a shell.
#[tauri::command]
#[specta::specta]
async fn list_fonts(state: tauri::State<'_, AppState>) -> Result<Vec<FontFamilyDto>, RefrainError> {
    let catalog = Arc::clone(&state.fonts);
    tauri::async_runtime::spawn_blocking(move || catalog.list())
        .await
        .map_err(|error| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "scan installed fonts",
                "system font catalog",
            )
            .with_detail(error.to_string())
            .with_recovery(vec![RecoveryStep::Retry, RecoveryStep::ReportDefect])
        })
}

#[tauri::command]
#[specta::specta]
fn list_builtin_typography_presets() -> Vec<refrain_store::config::BuiltinTypographyPreset> {
    refrain_store::config::builtin_typography_presets()
}

/// The preferences the Settings surface may change (SPEC 6.5). Connection
/// management is its own command pair; this is the author's choices.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum PreferencesChangeDto {
    KaraAutoEnter(bool),
    SetTheme(String),
    SetPaper(refrain_store::config::PaperMode),
    SetPanelSide(refrain_store::config::PanelSide),
    SetPanelMaterial(refrain_store::config::PanelMaterial),
    SetNightLamp(refrain_store::config::NightLamp),
    SetPanelWidth(refrain_store::config::PanelWidth),
    /// The dragged free-form width; None returns the panel to its preset.
    SetPanelWidthPx(Option<u16>),
    SetRailWidth(refrain_store::config::RailWidth),
    SetCodeTheme(Option<String>),
    SetPanelAnimation(bool),
    SetTypography(refrain_store::config::TypographyConfig),
    SaveTypographyPreset(String),
    RemoveTypographyPreset(Id),
    ResetVisual,
    ResetTypography,
    RestoreAppearance(refrain_store::config::AppearanceConfig),
}

impl PreferencesChangeDto {
    /// Translate one interface intent into one domain change.
    ///
    /// This is the whole of the mapping, so it lives with the DTO rather than
    /// inside the command: a new preference is one arm here, and the command
    /// body stays the three steps that are actually its own — find the store,
    /// apply, broadcast.
    fn into_change(self) -> Result<refrain_store::config::ConfigChange, RefrainError> {
        use refrain_store::config::ConfigChange;
        Ok(match self {
            Self::KaraAutoEnter(value) => ConfigChange::KaraAutoEnter(value),
            Self::SetTheme(theme) => {
                if !theme_slugs().contains(&theme) {
                    return Err(RefrainError::new(
                        ErrorCode::IllegalName,
                        "choose a theme",
                        theme,
                    ));
                }
                ConfigChange::SetTheme(theme)
            }
            Self::SetPaper(mode) => ConfigChange::SetPaper(mode),
            Self::SetPanelSide(side) => ConfigChange::SetPanelSide(side),
            Self::SetPanelMaterial(material) => ConfigChange::SetPanelMaterial(material),
            Self::SetNightLamp(lamp) => ConfigChange::SetNightLamp(lamp),
            Self::SetPanelWidth(width) => ConfigChange::SetPanelWidth(width),
            Self::SetPanelWidthPx(width_px) => ConfigChange::SetPanelWidthPx(width_px),
            Self::SetRailWidth(width) => ConfigChange::SetRailWidth(width),
            Self::SetCodeTheme(theme) => ConfigChange::SetCodeTheme(theme),
            Self::SetPanelAnimation(animated) => ConfigChange::SetPanelAnimation(animated),
            Self::SetTypography(typography) => ConfigChange::SetTypography(typography),
            Self::SaveTypographyPreset(name) => ConfigChange::SaveTypographyPreset(name),
            Self::RemoveTypographyPreset(id) => ConfigChange::RemoveTypographyPreset(id),
            Self::ResetVisual => ConfigChange::ResetVisual,
            Self::ResetTypography => ConfigChange::ResetTypography,
            Self::RestoreAppearance(appearance) => ConfigChange::RestoreAppearance(appearance),
        })
    }
}

#[tauri::command(async)]
#[specta::specta]
fn update_preferences(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    change: PreferencesChangeDto,
) -> Result<refrain_store::config::ConfigSnapshot, RefrainError> {
    let change = change.into_change()?;
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
#[tauri::command(async)]
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

fn utf16_quote(text: &str, start: u32, end: u32) -> Option<String> {
    let units = text.encode_utf16().collect::<Vec<_>>();
    let range = start as usize..end as usize;
    if range.start >= range.end || range.end > units.len() {
        return None;
    }
    String::from_utf16(&units[range]).ok()
}

#[cfg(test)]
mod annotation_offset_tests {
    use super::utf16_quote;

    #[test]
    fn offsets_follow_the_browser_utf16_contract() {
        assert_eq!(utf16_quote("甲😀乙", 1, 3).as_deref(), Some("😀"));
        assert_eq!(utf16_quote("甲😀乙", 1, 2), None);
        assert_eq!(utf16_quote("甲😀乙", 3, 4).as_deref(), Some("乙"));
        assert_eq!(utf16_quote("甲😀乙", 4, 5), None);
    }
}

fn annotation_anchor_state(
    manuscript: &Manuscript,
    row: &refrain_store::annotations::AnnotationRow,
) -> AnnotationAnchorState {
    let text = manuscript
        .head()
        .blocks()
        .iter()
        .find(|block| block.id().to_string() == row.block_id)
        .map(|block| block.text());
    let Some(text) = text else {
        return AnnotationAnchorState::Drifted;
    };
    match utf16_quote(text, row.start, row.end) {
        Some(quote) if quote == row.quote => AnnotationAnchorState::Anchored,
        _ => AnnotationAnchorState::Drifted,
    }
}

fn annotation_dto(
    manuscript: &Manuscript,
    row: refrain_store::annotations::AnnotationRow,
) -> AnnotationDto {
    let anchor_state = annotation_anchor_state(manuscript, &row);
    AnnotationDto {
        id: row.id,
        document: row.document,
        block_id: row.block_id,
        start: row.start,
        end: row.end,
        quote: row.quote,
        kind: row.kind,
        body: row.body,
        created_at: row.created_at.to_string(),
        updated_at: row.updated_at.to_string(),
        anchor_state,
    }
}

#[tauri::command(async)]
#[specta::specta]
fn list_annotations(
    state: tauri::State<'_, AppState>,
    root_id: String,
    document: String,
) -> Result<Vec<AnnotationDto>, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        let manuscript = entry.manuscripts.get(&document).ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "list annotations for a document that is not open",
                document.clone(),
            )
        })?;
        entry
            .store
            .annotations(&document)
            .map_err(into_domain)
            .map(|rows| {
                rows.into_iter()
                    .map(|row| annotation_dto(manuscript, row))
                    .collect()
            })
    })
}

#[tauri::command(async)]
#[specta::specta]
fn upsert_annotation(
    state: tauri::State<'_, AppState>,
    request: UpsertAnnotationRequest,
) -> Result<AnnotationDto, RefrainError> {
    state.with_project(&request.root_id, |_state, entry| {
        let manuscript = entry.manuscripts.get(&request.document).ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "annotate a document that is not open",
                request.document.clone(),
            )
        })?;
        let block = manuscript
            .head()
            .blocks()
            .iter()
            .find(|block| block.id().to_string() == request.block_id)
            .ok_or_else(|| {
                RefrainError::new(
                    ErrorCode::Io,
                    "anchor an annotation to a missing block",
                    request.block_id.clone(),
                )
            })?;
        let quote = utf16_quote(block.text(), request.start, request.end);
        if quote.as_deref() != Some(request.quote.as_str()) {
            return Err(RefrainError::new(
                ErrorCode::Io,
                "anchor an annotation after the source changed",
                request.block_id,
            ));
        }
        let body = match request.kind {
            refrain_store::annotations::AnnotationKind::Highlight => None,
            refrain_store::annotations::AnnotationKind::Comment => {
                let body = request.body.as_deref().map(str::trim).unwrap_or("");
                if body.is_empty() {
                    return Err(RefrainError::new(
                        ErrorCode::Io,
                        "save an empty comment",
                        request.document,
                    ));
                }
                Some(body.to_string())
            }
        };
        let id = match request.id {
            Some(id) => parse_id(&id, "annotation")?.to_string(),
            None => Id::new().to_string(),
        };
        let now = now_millis() as i64;
        let row = refrain_store::annotations::AnnotationRow {
            id: id.clone(),
            document: request.document.clone(),
            block_id: block.id().to_string(),
            start: request.start,
            end: request.end,
            quote: request.quote,
            kind: request.kind,
            body,
            created_at: now,
            updated_at: now,
        };
        entry.store.annotation_upsert(&row).map_err(into_domain)?;
        let persisted = entry
            .store
            .annotations(&request.document)
            .map_err(into_domain)?
            .into_iter()
            .find(|candidate| candidate.id == id)
            .ok_or_else(|| {
                RefrainError::new(ErrorCode::StateUnavailable, "reload an annotation", id)
            })?;
        Ok(annotation_dto(manuscript, persisted))
    })
}

#[tauri::command(async)]
#[specta::specta]
fn delete_annotation(
    state: tauri::State<'_, AppState>,
    root_id: String,
    id: String,
) -> Result<bool, RefrainError> {
    let id = parse_id(&id, "annotation")?.to_string();
    state.with_project(&root_id, |_state, entry| {
        entry.store.annotation_delete(&id).map_err(into_domain)
    })
}

// ── 信箱的安排（SPEC 9.6）─────────────────────────────────────────────
//
// 次序、Pin、弃置都是作者做出的判断，所以都落在项目库里，而不是某个面板
// 的内存。弃置只写下时刻：提案行与账本一行不动（INV-4）。

/// The author's standing arrangement: order, pins, and what was discarded.
#[tauri::command(async)]
#[specta::specta]
fn mailbox_standings(
    state: tauri::State<'_, AppState>,
    root_id: String,
) -> Result<Vec<MailboxStanding>, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        entry.store.mailbox().all().map_err(into_domain_store)
    })
}

/// Write one box's order. The whole box arrives at once: rank is a position
/// within a list, and writing them one at a time would let two callers
/// interleave into an order neither asked for.
#[tauri::command(async)]
#[specta::specta]
fn set_mailbox_order(
    state: tauri::State<'_, AppState>,
    root_id: String,
    box_name: String,
    entry_ids: Vec<String>,
) -> Result<(), RefrainError> {
    let box_name = mailbox_box(&box_name)?;
    state.with_project(&root_id, |_state, entry| {
        let mailbox = entry.store.mailbox();
        let now = now_millis();
        for (index, entry_id) in entry_ids.iter().enumerate() {
            mailbox
                .set_rank(entry_id, box_name, index as u32, now)
                .map_err(into_domain_store)?;
        }
        Ok(())
    })
}

/// Pin or unpin. Both directions are the author speaking, so both persist.
#[tauri::command(async)]
#[specta::specta]
fn set_mailbox_pinned(
    state: tauri::State<'_, AppState>,
    root_id: String,
    box_name: String,
    entry_id: String,
    pinned: bool,
) -> Result<(), RefrainError> {
    let box_name = mailbox_box(&box_name)?;
    state.with_project(&root_id, |_state, entry| {
        entry
            .store
            .mailbox()
            .set_pinned(&entry_id, box_name, pinned, now_millis())
            .map_err(into_domain_store)
    })
}

/// Discard tickets. This is a soft delete and the only delete there is: the
/// proposals stay, the ledger stays, and `restore_mailbox_entry` brings the
/// entry back. Nothing on disk is touched.
#[tauri::command(async)]
#[specta::specta]
fn discard_mailbox_entries(
    state: tauri::State<'_, AppState>,
    root_id: String,
    box_name: String,
    entry_ids: Vec<String>,
) -> Result<(), RefrainError> {
    let box_name = mailbox_box(&box_name)?;
    state.with_project(&root_id, |_state, entry| {
        let mailbox = entry.store.mailbox();
        let now = now_millis();
        for entry_id in &entry_ids {
            mailbox
                .discard(entry_id, box_name, now)
                .map_err(into_domain_store)?;
        }
        Ok(())
    })
}

/// Bring a discarded ticket back. Returns false when it was never discarded.
#[tauri::command(async)]
#[specta::specta]
fn restore_mailbox_entry(
    state: tauri::State<'_, AppState>,
    root_id: String,
    entry_id: String,
) -> Result<bool, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        entry
            .store
            .mailbox()
            .restore(&entry_id, now_millis())
            .map(|restored| restored > 0)
            .map_err(into_domain_store)
    })
}

/// The wire carries a box as text; this is where it becomes the enum. An
/// unknown name is refused by name rather than defaulting to a box the author
/// never meant.
fn mailbox_box(value: &str) -> Result<MailboxBoxName, RefrainError> {
    MailboxBoxName::from_wire(value).ok_or_else(|| {
        RefrainError::new(
            ErrorCode::IllegalName,
            "name a mailbox box",
            value.to_owned(),
        )
    })
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

/// The production registry has one source. Debug builds may splice in the
/// fixture command; release and generated bindings never receive it.
/// The single command registry.
macro_rules! refrain_commands {
    ($($debug_command:ident),* $(,)?) => {
        collect_commands![
        display_profile,
        health,
        choose_and_adopt_root,
        choose_and_create_project,
        document_page,
        document_search,
        open_document,
        create_document,
        delete_document,
        set_disclosure,
        current_document,
        apply_editor_action,
        undo_editor_action,
        list_text_actions,
        revert_to_action,
        list_annotations,
        upsert_annotation,
        delete_annotation,
        persist_revision,
        kara_event,
        kara_state,
        read_config,
        update_preferences,
        list_themes,
        list_fonts,
        list_builtin_typography_presets,
        set_universal_icon,
        universal_icon,
        imported_source_bytes,
        block_search,
        $($debug_command,)*
        list_proposals,
        record_verdict,
        set_review_batch,
        revert_verdicts,
        review_state,
        commit_decision_batch,
        countermand_proposals,
        mailbox_standings,
        set_mailbox_order,
        set_mailbox_pinned,
        discard_mailbox_entries,
        restore_mailbox_entry,
        draft_review_task,
        preview_dispatch,
        l0_file_channel_agent,
        list_harnesses,
        authorize_dispatch,
        launch_run,
        host_state,
        cancel_run,
        retry_run,
        collect_attempt,
        list_material_drafts,
        commit_material_action,
        agent_reading_ledger,
        upsert_harness_connection,
        remove_harness_connection,
        install_skill,
        probe_connection,
        choose_and_import_material,
        list_agents,
        upsert_agent,
        update_agent,
        remove_agent,
        ]
    };
}

#[cfg(all(debug_assertions, not(feature = "generate-bindings")))]
pub fn builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(refrain_commands![
        inject_fixture_proposal,
        debug_adopt_root,
        debug_create_project,
        debug_import_material,
        debug_import_manuscript,
    ])
}

#[cfg(any(not(debug_assertions), feature = "generate-bindings"))]
pub fn builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(refrain_commands![])
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

use refrain_core::Proposal;
// Only the debug-only fixture command builds a scope, so the import carries the
// same condition it does. Without this, a release build warns that it is unused
// and a debug build fails to compile without it.
#[cfg(all(debug_assertions, not(feature = "generate-bindings")))]
use refrain_core::EditScope;
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
#[cfg(all(debug_assertions, not(feature = "generate-bindings")))]
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

/// Inject fixture candidates (debug builds only). The candidates freeze
/// against the document's current head, exactly like a real Run's output
/// will in C10.
#[cfg(all(debug_assertions, not(feature = "generate-bindings")))]
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
#[tauri::command(async)]
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
#[tauri::command(async)]
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

/// Stage the batch and the cursor (SPEC 9.7: cursor and batch persist with
/// every change, not at commit time).
#[tauri::command(async)]
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

/// Recall staged verdicts to unread （发送信箱的回溯）. Only verdicts still in
/// the batch pass — anything already merged into the text stays history.
#[tauri::command(async)]
#[specta::specta]
fn revert_verdicts(
    state: tauri::State<'_, AppState>,
    root_id: String,
    path: String,
    verdict_ids: Vec<String>,
) -> Result<u32, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        let forgotten =
            refrain_app::decide::revert_verdicts(&mut entry.store, &path, &verdict_ids)?;
        #[allow(clippy::cast_possible_truncation)]
        Ok(forgotten as u32)
    })
}

/// The recovered review session: candidates, judgments so far, cursor, batch.
#[tauri::command(async)]
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
#[tauri::command(async)]
#[specta::specta]
fn commit_decision_batch(
    state: tauri::State<'_, AppState>,
    root_id: String,
    path: String,
) -> Result<TextTransitionDto, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        // 分别借用两个字段：提交要改 store，也要改打开着的稿子。
        let ProjectEntry {
            store, manuscripts, ..
        } = entry;
        let manuscript = manuscripts.get_mut(&path).ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "commit against a document that is not open",
                path.clone(),
            )
        })?;
        let transition = refrain_app::commit_decision_batch(store, manuscript, &path)?;
        record_text_action(store, &path, &transition)?;
        Ok(transition_dto(&transition))
    })
}

/// The countermanding verdict (逆向裁决): reverse already-merged proposals —
/// the ledger appends one countermanding record per proposal, and the text
/// returns to the pre-merge bytes, in ONE Text Action so one undo restores
/// all of them. A proposal whose merged bytes no longer match the current
/// text refuses the whole batch; nothing moves, nothing is recorded.
#[tauri::command(async)]
#[specta::specta]
fn countermand_proposals(
    state: tauri::State<'_, AppState>,
    root_id: String,
    path: String,
    proposal_ids: Vec<String>,
) -> Result<TextTransitionDto, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        let ProjectEntry {
            store, manuscripts, ..
        } = entry;
        let manuscript = manuscripts
            .get_mut(&path)
            .ok_or_else(|| not_open("countermand in a document that is not open", &path))?;
        let transition = refrain_app::countermand_proposals(
            store,
            manuscript,
            &path,
            &proposal_ids,
            now_millis(),
        )?;
        // It is a text action like any other: same record path, same history
        // panel, undoable by the same undo.
        record_text_action(store, &path, &transition)?;
        Ok(transition_dto(&transition))
    })
}

// ── C10: the host bridge — the dispatch ticket and the L0 file channel ──────
//
// The commands below map one-to-one onto SPEC 6.5's host use cases. The
// journal lives in refrain.db through StoreJournal; the frozen context lives
// in .refrain/ through DirectoryContext. Nothing here decides a domain rule:
// the host's state machine does.

use refrain_app::cancel::{cancel_and_read_back, progress_of, refuse_cancel_without_handle};
use refrain_app::journal::{
    StoreJournal, into_domain, into_domain_host, into_domain_store, parse_id, run_kind, task_kind,
};
use refrain_app::rebuild_proposal;
use refrain_core::context_compiler::{
    self, BeforeScope, ChangeEntry, ChangeKind, ContractMode, DispatchInput, DispatchPackage,
    InstalledSkill, ManifestEntry, SkillStatus,
};
use refrain_core::material_listing::{Disclosure, MaterialListing};
use refrain_host::host::{AgentHost, HostCommand, HostRefusal, ReviewTask, Run, RunProgress};
use refrain_host::run_edge::RunEdge;
use refrain_host::staging::DirectoryContext;

/// The built-in L0 agent: a file channel, including copy-paste into a web
/// chat (SPEC 8.3a). Real harness connections arrive with C11; this id names
/// the one producer that always exists.
const L0_FILE_CHANNEL_AGENT: &str = "00000000-0000-0000-0000-0000000000e0";

/// One dispatch's byte ceiling for the artifact body (shown in the contract).
const ARTIFACT_MAX_BYTES: u64 = 64 * 1024;

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

/// The carry tier the author picks on the ticket:
/// what rides besides the scope and the prompt. Materials always travel
/// separately and are never part of a tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum CarryMode {
    /// The verdict stream; a round with no history falls back to the whole
    /// text, or the agent has nothing to stand on.
    Diff,
    /// The verdict stream plus the whole manuscript, every round.
    Full,
    /// Neither verdicts nor manuscript — scope and prompt only.
    None,
}

/// The contract tier for this dispatch: L0's
/// channel has no session, so the short contract rides every request; the
/// full protocol document goes out on the first dispatch in this project and
/// a pointer line afterwards.
///
/// The tier is a property of **the project**, not of an agent. It used to ask
/// whether *this agent* had run before, which quietly broke the hard
/// constraint in `Stage6-Plan.md` §4.4: dispatch two agents in one Task — the
/// whole point of `Alternates` — and the one that had run got `Pointer` while
/// the newcomer got `Full`. Two Runs of one Task then carried different tool
/// contracts, which is the shape Manus measured as cache-destroying and
/// hallucination-inducing.
///
/// Asking the project instead makes the tier the same for every Run of every
/// Task in that project, at every moment. `verify:contract-tier-per-task`
/// keeps it that way.
///
/// What one round carries beyond the author's words. The tier is the
/// project-wide fact above; the other two are read from disk at compile time
/// — a preview and its click answer the same way, and a change between the
/// two (a memo appearing, an install landing) is exactly the drift INV-14
/// refuses.
struct ContractPlan {
    mode: ContractMode,
    /// The installed protocol copy this round's connection holds, if any.
    /// Only the Full tier reads it (协议装载的首轮省 token).
    installed_skill: Option<InstalledSkill>,
    /// The agent's workspace already holds its Memo.md: this round resumes.
    resumed: bool,
}

fn contract_mode(
    state: &AppState,
    store: &mut ProjectStore,
    agent_id: &str,
) -> Result<ContractPlan, RefrainError> {
    let resumed = agent_memo_present(store, agent_id);
    if agent_id == l0_file_channel_agent() {
        return Ok(ContractPlan {
            mode: ContractMode::Short,
            installed_skill: None,
            resumed,
        });
    }
    let host = open_host(store)?;
    let mode = if host.runs().is_empty() {
        ContractMode::Full
    } else {
        ContractMode::Pointer
    };
    Ok(ContractPlan {
        mode,
        installed_skill: installed_skill_of(state, agent_id),
        resumed,
    })
}

/// The installed protocol pointer for the round's connection, when there is
/// one: the path the harness reads, and whether the copy is still current.
/// `None` is not "stale" — it is "nothing installed", and the Full tier then
/// carries the whole text as it always has.
fn installed_skill_of(state: &AppState, agent_id: &str) -> Option<InstalledSkill> {
    let connection = connection_for_agent(state, agent_id).ok()??;
    let home = harnesses::home_dir()?;
    let path = harnesses::skill_path(&home, connection.adapter)?;
    let status = harnesses::skill_status(&home, connection.adapter);
    if status == SkillStatus::None {
        return None;
    }
    Some(InstalledSkill {
        path: path.display().to_string(),
        status,
    })
}

/// Whether the agent's workspace already holds its Memo.md — the fact a
/// resumed round is marked from. An unparseable id names no workspace, and
/// no workspace honestly means "not a resumption".
fn agent_memo_present(store: &ProjectStore, agent_id: &str) -> bool {
    let Ok(agent) = parse_id(agent_id, "agent") else {
        return false;
    };
    DirectoryContext::new(store.layout().state_dir.clone()).has_agent_memo(agent)
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
    plan: &ContractPlan,
    persona: Option<String>,
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
    // capped at the window. The carry tier decides what rides: Diff is
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
                // 冲销对 Agent 的意义与拒绝相同：这段文字现在不在正文里。
                // 流里接受与冲销成对出现，净效果就是「没有采纳」——更早的那条
                // 接受记录仍是事实，这条告诉它结局。
                VerdictKindName::Countermanded => ChangeKind::Reject,
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
    // Ticked materials ride as *listings*, not as their texts.
    //
    // This used to read each material whole — `String::from_utf8_lossy` over
    // the entire file — so three 100KB references entered the request as
    // roughly 153,600 tokens by this project's own estimate. The cost was not
    // only the tokens: recall degrades as a context fills, so pasting
    // everything made the agent worse at the work as well as more expensive.
    //
    // What travels now is the author's own headings, an excerpt of the
    // opening bytes, the size, the digest, and what the author permits. The
    // agent fetches the blocks it decides it needs — it runs on this
    // machine and can open the file, and `material_access` ranks blocks
    // across materials when it does not yet know where to look.
    //
    // Nothing here is generated: there is no model in this process to
    // summarise with, and a summary would be a second authority on what the
    // material says that goes stale the moment the author edits it.
    let mut materials: Vec<MaterialListing> = Vec::with_capacity(material_paths.len());
    for material_path in material_paths {
        let opened = store.open_document(material_path).map_err(into_domain)?;
        let text = String::from_utf8_lossy(&opened.bytes);
        materials.push(MaterialListing::describe(
            material_path,
            &doc_slug(material_path),
            DocumentRole::Material,
            &refrain_core::digest::content_hex(&opened.bytes),
            &text,
            // The author's own setting; "never asked" is the enum's default.
            opened.row.disclosure.unwrap_or_default(),
        ));
    }
    let input = DispatchInput {
        persona,
        installed_skill: plan.installed_skill.clone(),
        resumed: plan.resumed,
        manuscript: manuscript_text,
        changes,
        materials,
        upstream: Vec::new(),
        request: prompt.to_string(),
        scopes: vec![BeforeScope { scope, text }],
        result_path: format!(
            "agents/{1}/runs/{0}/attempts/{0}/result.md",
            refrain_host::host::RUN_ID_PLACEHOLDER,
            refrain_host::host::AGENT_ID_PLACEHOLDER
        ),
        max_bytes: ARTIFACT_MAX_BYTES,
        contract_mode: plan.mode,
    };
    Ok(context_compiler::compile(&input))
}

// `before_sections` 与 `find_scope_blocks` 已搬进 refrain-app::scope：它们只读文本，
// 不碰数据库也不认识 host，放在桥上就无法单独验证。搬迁时顺带把后者从「每个起点
// 重新拼接一遍」改成一次线性扫描（4000 块实测 12.8ms → 0.06ms），等价性由
// crates/refrain-app/tests/scope.rs 穷举全部连续区间对照旧实现证明。

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
#[tauri::command(async)]
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
#[tauri::command(async)]
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
        let plan = contract_mode(_state, &mut entry.store, &agent_id)?;
        let package = compile_package(
            &mut entry.store,
            manuscript,
            &path,
            &parse_ids(&block_ids, "scope block")?,
            &material_paths,
            &prompt,
            carry,
            &plan,
            persona_of(_state, &agent_id),
        )?;
        Ok(DispatchPreviewDto {
            manifest: package.manifest.clone(),
            digest: package.digest.clone(),
            request_md: package.request_md,
        })
    })
}

/// How one run relates to another in the same round, as the front end names
/// it: a kind and the position it points at.
///
/// A position rather than a run id because the runs do not exist yet — the
/// first authorization mints them. The author picks agents in an order, and
/// that order is what the edges refer to.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunEdgeDto {
    pub kind: RunEdgeKindDto,
    /// Which agent in `new_agents` this edge points at, counting from zero.
    pub target: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum RunEdgeKindDto {
    /// Runs after the target and reads its artifact.
    Follows,
    /// Reads the target's artifact and may only comment on it.
    Verifies,
    /// Answers the same question as the target, without seeing it.
    Alternates,
}

impl From<RunEdgeDto> for RunEdge {
    fn from(dto: RunEdgeDto) -> Self {
        let target = dto.target as usize;
        // No catch-all: a new edge kind must force a decision here rather
        // than silently becoming whichever arm happened to be last.
        match dto.kind {
            RunEdgeKindDto::Follows => Self::Follows { upstream: target },
            RunEdgeKindDto::Verifies => Self::Verifies { subject: target },
            RunEdgeKindDto::Alternates => Self::Alternates { peer: target },
        }
    }
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
    /// How the minted runs relate to each other, one entry per `new_agents`
    /// position. Empty means the ordinary star: every run answers the
    /// author's question independently.
    #[serde(default)]
    pub edges: Vec<Option<RunEdgeDto>>,
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

#[tauri::command(async)]
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
        edges,
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
        let plan = contract_mode(_state, &mut entry.store, &agent_id)?;
        let package = compile_package(
            &mut entry.store,
            manuscript,
            &path,
            &parse_ids(&block_ids, "scope block")?,
            &material_paths,
            &prompt,
            carry,
            &plan,
            persona_of(_state, &agent_id),
        )?;
        let task_id = parse_id(&task_id, "task")?;
        let mut host = open_host(&mut entry.store)?;
        host.execute(HostCommand::AuthorizeDispatch {
            task_id,
            new_agents: parse_ids(&new_agents, "agent")?,
            retry_runs: parse_ids(&retry_run_ids, "run")?,
            edges: edges.into_iter().map(|edge| edge.map(Into::into)).collect(),
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
/// A run looked up by id: the last entry is only the newest run, not
/// necessarily the one asked for (a task may hold several runs).
fn find_run(runs: &[Run], run_id: Id) -> Result<&Run, RefrainError> {
    runs.iter()
        .find(|run| run.id == run_id)
        .ok_or_else(|| into_domain_host(HostRefusal::UnknownRun(run_id)))
}

/// Prepare the agent's persistent half of the workspace (Task B) and answer
/// its id: the `agents/<agent-id>/` directory with a current AGENTS.md, so a
/// harness CLI that walks up from the run directory finds the identity with
/// zero request bytes. Content-compared, so a launch with no persona change
/// writes nothing.
fn ensure_agent_workspace(
    state: &AppState,
    state_dir: &Path,
    agent: &str,
) -> Result<Id, RefrainError> {
    let agent_id = parse_id(agent, "agent")?;
    DirectoryContext::new(state_dir.to_path_buf())
        .ensure_agent_files(agent_id, persona_of(state, agent).as_deref())
        .map_err(|error| {
            RefrainError::new(
                ErrorCode::Io,
                "write the agent workspace",
                agent.to_string(),
            )
            .with_detail(error.to_string())
        })?;
    Ok(agent_id)
}

#[tauri::command(async)]
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
        Ok(find_run(host.runs(), run_id)?.agent_id.to_string())
    })?;
    if connection_for_agent(&state, &agent)?.is_some() {
        return harness_dispatch_inner(&app, &state, &root_id, &agent, run_id);
    }
    state.with_project(&root_id, |_state, entry| {
        let agent_id = ensure_agent_workspace(_state, &entry.store.layout().state_dir, &agent)?;
        let workspace = refrain_host::staging::run_workspace(agent_id, run_id);
        {
            let mut host = open_host(&mut entry.store)?;
            host.execute(HostCommand::LaunchRun {
                run_id,
                workspace: workspace.clone(),
            })
            .map_err(into_domain_host)?;
        }
        refrain_app::upstream::feed_upstream(&mut entry.store, run_id)?;
        let mut host = open_host(&mut entry.store)?;
        host.execute(HostCommand::CompleteDispatch {
            run_id,
            receipt: format!("l0:request-visible@{workspace}"),
        })
        .map_err(into_domain_host)?;
        let launched = find_run(host.runs(), run_id)?;
        Ok(run_dto(launched))
    })
}

/// The orchestration world as the surface renders it.
#[tauri::command(async)]
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

#[tauri::command(async)]
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

/// Cancel a run that has not reached a terminal state. A live producer must
/// exit first; only then may the journal say `Cancelled`.
#[tauri::command(async)]
#[specta::specta]
fn cancel_run(
    state: tauri::State<'_, AppState>,
    root_id: String,
    run_id: String,
) -> Result<RunDto, RefrainError> {
    let run_id = parse_id(&run_id, "run")?;
    let key = (root_id.clone(), run_id);
    let active = state
        .active_runs
        .lock()
        .map_err(|_| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "lock the active Run table",
                run_id.to_string(),
            )
        })?
        .get(&key)
        .cloned();
    if let Some(active) = active {
        // Hold this Run's lock from the tree signal through the journal write.
        // The observer owns the same Arc and therefore cannot classify the
        // resulting non-zero exit as a failure before Cancelled is durable.
        let mut active = active.lock().map_err(|_| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "lock the live Run",
                run_id.to_string(),
            )
        })?;
        active.cancel.cancel_tree().map_err(|error| {
            RefrainError::new(ErrorCode::Io, "cancel the producer", run_id.to_string())
                .with_detail(error.to_string())
        })?;
        let dto = state.with_project(&root_id, |_state, entry| {
            let mut host = open_host(&mut entry.store)?;
            Ok(run_dto(&cancel_and_read_back(
                &mut host,
                run_id,
                now_millis(),
            )?))
        })?;
        active.cancelled = true;
        drop(active);
        if let Ok(mut runs) = state.active_runs.lock() {
            runs.remove(&key);
        }
        return Ok(dto);
    }

    state.with_project(&root_id, |_state, entry| {
        let mut host = open_host(&mut entry.store)?;
        refuse_cancel_without_handle(&progress_of(&host, run_id)?)?;
        Ok(run_dto(&cancel_and_read_back(
            &mut host,
            run_id,
            now_millis(),
        )?))
    })
}

/// Retry is a new Run, queued, pointing at the old one (§8.4b). Its
/// authorization is a fresh click through `authorize_dispatch`.
#[tauri::command(async)]
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
#[tauri::command(async)]
#[specta::specta]
fn collect_attempt(
    state: tauri::State<'_, AppState>,
    root_id: String,
    run_id: String,
) -> Result<CollectOutcomeDto, RefrainError> {
    state.with_project(&root_id, |_state, entry| {
        let run_id = parse_id(&run_id, "run")?;
        // 分别借用两个字段：收取要改 store，同时要读打开着的稿子。
        let ProjectEntry {
            store, manuscripts, ..
        } = entry;
        let collected = refrain_app::collect_attempt(store, manuscripts, run_id, now_millis())?;
        Ok(match collected {
            refrain_app::Collected::Waiting => CollectOutcomeDto::Waiting,
            refrain_app::Collected::Completed {
                proposals,
                memos,
                drafts,
            } => CollectOutcomeDto::Completed {
                proposals,
                memos,
                drafts,
            },
            refrain_app::Collected::Failed { code, detail } => {
                CollectOutcomeDto::Failed { code, detail }
            }
        })
    })
}

// ── C11: local Harness connections over the frozen protocol ────────────────

use harnesses::{
    CLAUDE_CODE_CANDIDATE, ConnectionResolution, KIMI_CODE_CANDIDATE, LocalHarness,
    SUPPORTED_CANDIDATES, candidate_for_adapter, connection_from_detected,
};
use refrain_host::adapters::{self, HarnessAdapter};
use tauri::Emitter as _;

/// The probe answer for one row of the connections surface.
///
/// `NeedsAttention` is no longer "re-link it": it names a stored connection
/// whose binary answered before and does not answer now. The row keeps the
/// stored identity, and `last_known_version` carries what last worked — so
/// nothing is marked Connected that is not, and nothing asks for a re-link
/// while the identity is intact.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum HarnessStatus {
    Connected,
    Available,
    Missing,
    NeedsAttention,
}

/// One supported local Agent tool. Executable paths never cross the bridge.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessDto {
    pub candidate_id: String,
    pub connection_id: Option<String>,
    pub label: String,
    /// What the binary answers now; `None` when nothing answered this probe.
    pub version: Option<String>,
    pub tier: String,
    pub status: HarnessStatus,
    /// Set exactly when `status` is `NeedsAttention`: the version the last
    /// successful probe recorded. The "previously worked" half of the state —
    /// `version` alone could not say it, because a dead binary answers nothing.
    pub last_known_version: Option<String>,
    /// The installed protocol's state on this machine: none / current /
    /// stale, read from the file itself each time. The badge never claims
    /// "installed" from the Config record alone — the file is the fact.
    pub skill_status: SkillStatus,
}

/// What the app emits when a backgrounded producer settles.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunSettledDto {
    pub root_id: String,
    pub run_id: String,
    /// "landed" | "cancelled" | "failed:<reason>" — the run's own journal has the truth.
    pub outcome: String,
}

fn tier_label(tier: refrain_host::Tier) -> &'static str {
    match tier {
        refrain_host::Tier::L0 => "手动往返",
        refrain_host::Tier::L1 => "可直接派发",
        refrain_host::Tier::L2 => "可直接派发并回报运行详情",
    }
}

/// List the two adapter implementations this build can really dispatch.
/// Discovery runs fixed, version-only probes for known program names. The
/// renderer cannot add another name or path to this search space.
#[tauri::command(async)]
#[specta::specta]
fn list_harnesses(state: tauri::State<'_, AppState>) -> Result<Vec<HarnessDto>, RefrainError> {
    let store = state.config.as_ref().ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "read a damaged Config",
            "connections",
        )
    })?;
    let snapshot = store.snapshot().map_err(|failure| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "read the Config",
            failure.to_string(),
        )
    })?;
    let mut out = Vec::new();
    let mut connected_candidates = HashSet::new();
    for connection in &snapshot.config.harness_connections {
        let Some(candidate_id) = candidate_for_adapter(connection.adapter) else {
            continue;
        };
        connected_candidates.insert(candidate_id);
        // A stored identity is probed, never trusted: a live answer is
        // Connected, an install that moved heals through the Config
        // authority under the same id, and a silent one is NeedsAttention
        // with the last-known metadata retained — never a fake Connected,
        // never a forced re-link while the identity is intact.
        // `last_known_version` keeps "previously worked" visible there;
        // `version` alone cannot say it — a dead binary answers nothing.
        let live = match harnesses::resolve_connection(connection) {
            ConnectionResolution::Live(harness) => {
                heal_connection(store, connection, &harness)?;
                Some(harness)
            }
            ConnectionResolution::Moved(harness) => {
                heal_connection(store, connection, &harness)?;
                Some(harness)
            }
            ConnectionResolution::Unreachable => None,
        };
        out.push(stored_harness_dto(candidate_id, connection, live.as_ref()));
    }
    for (candidate_id, label) in SUPPORTED_CANDIDATES {
        if connected_candidates.contains(candidate_id) {
            continue;
        }
        let live = LocalHarness::detect(candidate_id);
        out.push(HarnessDto {
            candidate_id: candidate_id.to_string(),
            connection_id: None,
            label: label.to_string(),
            version: live.as_ref().map(|harness| harness.version().to_string()),
            tier: live
                .as_ref()
                .map_or("可直接派发", |harness| tier_label(harness.tier()))
                .to_string(),
            status: if live.is_some() {
                HarnessStatus::Available
            } else {
                HarnessStatus::Missing
            },
            last_known_version: None,
            skill_status: skill_status_of(connection_kind(candidate_id)),
        });
    }
    Ok(out)
}

/// The adapter kind a fixed candidate stands for. The candidates and the
/// kinds are two spellings of one list; the join lives here, once.
fn connection_kind(candidate_id: &str) -> Option<refrain_store::config::AdapterKind> {
    if candidate_id == CLAUDE_CODE_CANDIDATE {
        Some(refrain_store::config::AdapterKind::ClaudeCode)
    } else if candidate_id == KIMI_CODE_CANDIDATE {
        Some(refrain_store::config::AdapterKind::KimiCode)
    } else {
        None
    }
}

/// Read the installed protocol's state for a connection's kind. No home
/// directory resolved is not an error — the badge simply says "none".
fn skill_status_of(kind: Option<refrain_store::config::AdapterKind>) -> SkillStatus {
    match (harnesses::home_dir(), kind) {
        (Some(home), Some(kind)) => harnesses::skill_status(&home, kind),
        _ => SkillStatus::None,
    }
}

/// One stored connection as the surface lists it: live facts from the probe,
/// or NeedsAttention with the last-known version retained.
fn stored_harness_dto(
    candidate_id: &str,
    connection: &refrain_store::config::HarnessConnection,
    live: Option<&LocalHarness>,
) -> HarnessDto {
    HarnessDto {
        candidate_id: candidate_id.to_string(),
        connection_id: Some(connection.id.to_string()),
        label: SUPPORTED_CANDIDATES
            .iter()
            .find_map(|(id, label)| (*id == candidate_id).then_some(*label))
            .unwrap_or(candidate_id)
            .to_string(),
        version: live.map(|harness| harness.version().to_string()),
        tier: live
            .map_or("可直接派发", |harness| tier_label(harness.tier()))
            .to_string(),
        status: if live.is_some() {
            HarnessStatus::Connected
        } else {
            HarnessStatus::NeedsAttention
        },
        last_known_version: if live.is_none() {
            connection.version.clone()
        } else {
            None
        },
        skill_status: skill_status_of(Some(connection.adapter)),
    }
}

/// Re-anchor a stored connection onto the binary that answered, keeping its
/// id and its argv/env choices: only the executable and the last-successful
/// version move. Called when the probe succeeded but the stored facts drifted
/// (an upgrade changed the path or the version) — and skipped when they did
/// not, so listing a healthy connection writes nothing.
fn heal_connection(
    store: &refrain_store::config::ConfigStore,
    connection: &refrain_store::config::HarnessConnection,
    harness: &LocalHarness,
) -> Result<(), RefrainError> {
    let drifted = connection.executable != *harness.program()
        || connection.version.as_deref() != Some(harness.version());
    if !drifted {
        return Ok(());
    }
    store
        .apply(
            refrain_store::config::ConfigChange::UpsertHarnessConnection(
                refrain_store::config::HarnessConnection {
                    executable: harness.program().to_path_buf(),
                    version: Some(harness.version().to_string()),
                    ..connection.clone()
                },
            ),
        )
        .map_err(|failure| {
            RefrainError::new(ErrorCode::Io, "write the Config", failure.to_string())
        })?;
    Ok(())
}

/// Register one fixed PATH candidate. The renderer supplies a stable ID, not
/// a program or path; Rust discovers, verifies, and canonicalizes it again.
#[tauri::command(async)]
#[specta::specta]
fn upsert_harness_connection(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    candidate_id: String,
) -> Result<refrain_store::config::ConfigSnapshot, RefrainError> {
    let harness = LocalHarness::detect(&candidate_id).ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "connect a local Agent tool",
            candidate_id.clone(),
        )
        .with_detail("not found on PATH or the program identity check failed")
    })?;
    let store = state.config.as_ref().ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "write a damaged Config",
            "connections",
        )
    })?;
    let current = store.snapshot().map_err(|failure| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "read the Config",
            failure.to_string(),
        )
    })?;
    let id = current
        .config
        .harness_connections
        .iter()
        .find(|connection| connection.adapter == harness.adapter_kind())
        .map_or_else(Id::new, |connection| connection.id);
    let snapshot = store
        .apply(
            refrain_store::config::ConfigChange::UpsertHarnessConnection(
                refrain_store::config::HarnessConnection {
                    skill_digest: prior_skill_digest(&current.config, id),
                    ..connection_from_detected(id, &harness)
                },
            ),
        )
        .map_err(|failure| {
            RefrainError::new(ErrorCode::Io, "write the Config", failure.to_string())
        })?;
    let _ = app.emit("config-changed", &snapshot.config.appearance.theme);
    Ok(snapshot)
}

/// The install record a re-detection must keep: re-linking is not
/// re-installing, so the protocol digest rides across under the same id.
fn prior_skill_digest(config: &refrain_store::config::Config, id: Id) -> Option<String> {
    config
        .harness_connections
        .iter()
        .find(|connection| connection.id == id)
        .and_then(|connection| connection.skill_digest.clone())
}

/// Remove a connection by id (SPEC 6.5). Trust evidence in app.db is not the
/// author's parameter and is not touched here (Q24).
#[tauri::command(async)]
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

/// What one protocol install reports: where the file landed and the digest
/// the Config recorded as provenance.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallDto {
    pub path: String,
    pub digest: String,
}

/// Install the RefRain protocol into a connection's harness skill directory
/// （协议装载：安装即注册 — the CLI auto-loads its skills directory, so the
/// file's presence is the registration).
///
/// This is the application's only write outside the Root, which is exactly
/// why it is a command and never a side effect of dispatch: nothing crosses
/// that boundary without the author's click.
#[tauri::command(async)]
#[specta::specta]
fn install_skill(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<SkillInstallDto, RefrainError> {
    let (snapshot, installed) = install_skill_inner(&state, &connection_id)?;
    let _ = app.emit("config-changed", &snapshot.config.appearance.theme);
    Ok(installed)
}

/// The install body: write the file (the fact), then record its digest in
/// the Config (the provenance) — in that order, so a failed record never
/// hides an installed file; the status badge reads the file either way.
fn install_skill_inner(
    state: &AppState,
    connection_id: &str,
) -> Result<(refrain_store::config::ConfigSnapshot, SkillInstallDto), RefrainError> {
    let id = parse_id(connection_id, "connection")?;
    let store = state.config.as_ref().ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "write a damaged Config",
            "connections",
        )
    })?;
    let snapshot = store.snapshot().map_err(|failure| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "read the Config",
            failure.to_string(),
        )
    })?;
    let connection = snapshot
        .config
        .harness_connections
        .iter()
        .find(|connection| connection.id == id)
        .ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "install the protocol for a connection",
                "no such connection",
            )
        })?;
    let home = harnesses::home_dir().ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "install the protocol without a home directory",
            "HOME",
        )
    })?;
    let (path, digest) = harnesses::install_skill(&home, connection.adapter)
        .ok_or_else(|| {
            RefrainError::new(
                ErrorCode::UnsupportedFormat,
                "install the protocol for a harness without a skill directory",
                candidate_for_adapter(connection.adapter).unwrap_or("unsupported adapter"),
            )
        })?
        .map_err(|error| {
            RefrainError::new(ErrorCode::Io, "install the protocol", "skill file")
                .with_detail(error.to_string())
        })?;
    let snapshot = store
        .apply(
            refrain_store::config::ConfigChange::UpsertHarnessConnection(
                refrain_store::config::HarnessConnection {
                    skill_digest: Some(digest.clone()),
                    ..connection.clone()
                },
            ),
        )
        .map_err(|failure| {
            RefrainError::new(ErrorCode::Io, "write the Config", failure.to_string())
        })?;
    Ok((
        snapshot,
        SkillInstallDto {
            path: path.display().to_string(),
            digest,
        },
    ))
}

/// Re-check an existing Config connection. No path crosses the bridge.
#[tauri::command(async)]
#[specta::specta]
fn probe_connection(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<String, RefrainError> {
    let id = parse_id(&connection_id, "connection")?;
    let store = state.config.as_ref().ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "read a damaged Config",
            "connections",
        )
    })?;
    let snapshot = store.snapshot().map_err(|failure| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "read the Config",
            failure.to_string(),
        )
    })?;
    let connection = snapshot
        .config
        .harness_connections
        .iter()
        .find(|connection| connection.id == id)
        .ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "check a connection",
                "no such connection",
            )
        })?;
    LocalHarness::from_connection(connection)
        .map(|harness| harness.version().to_string())
        .ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "check a connection",
                candidate_for_adapter(connection.adapter).unwrap_or("unsupported adapter"),
            )
            .with_detail("the saved program is missing or failed its identity check")
        })
}

fn connection_for_agent(
    state: &AppState,
    agent: &str,
) -> Result<Option<refrain_store::config::HarnessConnection>, RefrainError> {
    if agent == L0_FILE_CHANNEL_AGENT {
        return Ok(None);
    }
    let store = state.config.as_ref().ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "read the Config for a connection",
            agent.to_string(),
        )
    })?;
    let snapshot = store.snapshot().map_err(|failure| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "read the Config for a connection",
            failure.to_string(),
        )
    })?;
    let connection_id = if let Some(profile) = snapshot
        .config
        .agents
        .iter()
        .find(|profile| profile.id.to_string() == agent)
    {
        let Some(id) = profile.connection_id else {
            return Ok(None);
        };
        id
    } else {
        parse_id(agent, "agent or connection")?
    };
    snapshot
        .config
        .harness_connections
        .iter()
        .find(|connection| connection.id == connection_id)
        .cloned()
        .map(Some)
        .ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "dispatch over a connection",
                "the Agent's connection no longer exists",
            )
        })
}

// ── Agents: a name, a channel, and an optional persona ─────────────────────

/// The persona an AgentProfile carries for this agent id, if any. Injected
/// into the request right where the compiler renders it: the Context section,
/// after the contract.
fn persona_of(state: &AppState, agent_id: &str) -> Option<String> {
    state
        .config
        .as_ref()
        .and_then(|store| store.snapshot().ok())
        .and_then(|snapshot| {
            snapshot
                .config
                .agents
                .iter()
                .find(|profile| profile.id.to_string() == agent_id)
                .and_then(|profile| profile.persona.clone())
        })
}

/// The extra argv an AgentProfile carries for this agent id, if any. Read at
/// launch and merged by the adapter — validation already happened at upsert,
/// so a stored profile is trusted here the way a persona is.
fn agent_argv_of(state: &AppState, agent_id: &str) -> Vec<String> {
    state
        .config
        .as_ref()
        .and_then(|store| store.snapshot().ok())
        .and_then(|snapshot| {
            snapshot
                .config
                .agents
                .iter()
                .find(|profile| profile.id.to_string() == agent_id)
                .map(|profile| profile.argv.clone())
        })
        .unwrap_or_default()
}

/// One Agent as the surface lists it: the profile plus its channel's facts.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentDto {
    pub id: String,
    pub name: String,
    pub connection_id: Option<String>,
    pub has_persona: bool,
    /// The persona text itself, so the edit form can prefill. `None` when the
    /// profile carries none — the same state `has_persona` reports.
    pub persona: Option<String>,
    /// The agent's extra argv (model, effort — argv by nature), so the edit
    /// form can show what launches with this agent. Empty by default.
    pub argv: Vec<String>,
    pub channel: String,
    pub version: String,
}

/// The version string one connected harness reports, or the refusal the
/// surface shows when the executable no longer answers.
fn harness_version(live: Option<LocalHarness>) -> String {
    live.map(|harness| harness.version().to_string())
        .unwrap_or_else(|| "需要重新连接".to_string())
}

#[tauri::command(async)]
#[specta::specta]
fn list_agents(state: tauri::State<'_, AppState>) -> Vec<AgentDto> {
    let Some(store) = state.config.as_ref() else {
        return Vec::new();
    };
    let Ok(snapshot) = store.snapshot() else {
        return Vec::new();
    };
    snapshot
        .config
        .agents
        .iter()
        .map(|profile| match profile.connection_id {
            None => AgentDto {
                id: profile.id.to_string(),
                name: profile.name.clone(),
                connection_id: None,
                has_persona: profile.persona.is_some(),
                persona: profile.persona.clone(),
                argv: profile.argv.clone(),
                channel: "手动往返".to_string(),
                version: "—".to_string(),
            },
            Some(connection_id) => {
                let connection = snapshot
                    .config
                    .harness_connections
                    .iter()
                    .find(|entry| entry.id == connection_id);
                let (channel, version) = connection
                    .map(|entry| {
                        let candidate = candidate_for_adapter(entry.adapter);
                        let live = LocalHarness::from_connection(entry);
                        let label = candidate
                            .and_then(|id| {
                                SUPPORTED_CANDIDATES.iter().find_map(|(candidate, label)| {
                                    (*candidate == id).then_some(*label)
                                })
                            })
                            .unwrap_or("暂不支持的连接");
                        let version = harness_version(live);
                        (label.to_string(), version)
                    })
                    .unwrap_or_else(|| ("连接已删".to_string(), "—".to_string()));
                AgentDto {
                    id: profile.id.to_string(),
                    name: profile.name.clone(),
                    connection_id: Some(connection_id.to_string()),
                    has_persona: profile.persona.is_some(),
                    persona: profile.persona.clone(),
                    argv: profile.argv.clone(),
                    channel,
                    version,
                }
            }
        })
        .collect()
}

/// Create one Agent (SPEC 6.5: typed changes only). A connection reference
/// must name an existing connection; `None` is the L0 channel. Edits go
/// through `update_agent`: a create must never reuse an id it was handed,
/// and a generated bridge signature cannot carry an optional argument.
#[tauri::command(async)]
#[specta::specta]
fn upsert_agent(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    name: String,
    connection_id: Option<String>,
    persona: Option<String>,
    argv: Vec<String>,
) -> Result<refrain_store::config::ConfigSnapshot, RefrainError> {
    if name.trim().is_empty() {
        return Err(RefrainError::new(
            ErrorCode::IllegalName,
            "name an agent",
            "empty name",
        ));
    }
    refrain_host::adapters::check_agent_argv(&argv).map_err(argv_refusal)?;
    let store = state.config.as_ref().ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "write a damaged Config",
            "agents",
        )
    })?;
    let connection_id = match connection_id {
        None => None,
        Some(raw) => {
            let id = parse_id(&raw, "connection")?;
            let snapshot = store.snapshot().map_err(|failure| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "read the Config",
                    failure.to_string(),
                )
            })?;
            if !snapshot
                .config
                .harness_connections
                .iter()
                .any(|entry| entry.id == id)
            {
                return Err(RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "attach an agent to a connection",
                    "no such connection",
                ));
            }
            Some(id)
        }
    };
    let snapshot = store
        .apply(refrain_store::config::ConfigChange::UpsertAgent(
            refrain_store::config::AgentProfile {
                id: Id::new(),
                name: name.trim().to_string(),
                connection_id,
                persona: persona.filter(|text| !text.trim().is_empty()),
                argv,
            },
        ))
        .map_err(|failure| {
            RefrainError::new(ErrorCode::Io, "write the Config", failure.to_string())
        })?;
    let _ = app.emit("config-changed", &snapshot.config.appearance.theme);
    Ok(snapshot)
}

/// The argv denylist refusal, translated into the bridge's error shape: the
/// item that may not ride and why, said while the author is still editing.
fn argv_refusal(failure: refrain_host::adapters::ArgvRefusal) -> RefrainError {
    RefrainError::new(
        ErrorCode::IllegalName,
        "register agent argv",
        failure.to_string(),
    )
}

/// The shared validation behind the Agent commands: a non-empty name and a
/// connection that exists. `None` for the id mints fresh (create); a given
/// id edits in place. `upsert_agent` predates this helper and keeps its own
/// inline copy — the command-depth ratchet freezes its body.
fn agent_profile(
    state: &AppState,
    id: Option<&str>,
    name: String,
    connection_id: Option<String>,
    persona: Option<String>,
    argv: Vec<String>,
) -> Result<refrain_store::config::AgentProfile, RefrainError> {
    if name.trim().is_empty() {
        return Err(RefrainError::new(
            ErrorCode::IllegalName,
            "name an agent",
            "empty name",
        ));
    }
    refrain_host::adapters::check_agent_argv(&argv).map_err(argv_refusal)?;
    let id = match id {
        Some(raw) => parse_id(raw, "agent")?,
        None => Id::new(),
    };
    let store = state.config.as_ref().ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "write a damaged Config",
            "agents",
        )
    })?;
    let connection_id = match connection_id {
        None => None,
        Some(raw) => {
            let id = parse_id(&raw, "connection")?;
            let snapshot = store.snapshot().map_err(|failure| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "read the Config",
                    failure.to_string(),
                )
            })?;
            let connections = &snapshot.config.harness_connections;
            if !connections.iter().any(|entry| entry.id == id) {
                return Err(RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "attach an agent to a connection",
                    "no such connection",
                ));
            }
            Some(id)
        }
    };
    Ok(refrain_store::config::AgentProfile {
        id,
        name: name.trim().to_string(),
        connection_id,
        persona: persona.filter(|text| !text.trim().is_empty()),
        argv,
    })
}

/// Edit one Agent in place (SPEC 6.5: typed changes only). The id comes from
/// `list_agents`; naming an id that does not exist is a typed refusal — an
/// edit that silently creates is how agents multiplied in the first place.
#[tauri::command(async)]
#[specta::specta]
fn update_agent(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    name: String,
    connection_id: Option<String>,
    persona: Option<String>,
    argv: Vec<String>,
) -> Result<refrain_store::config::ConfigSnapshot, RefrainError> {
    let profile = agent_profile(&state, Some(&id), name, connection_id, persona, argv)?;
    let snapshot = apply_existing_agent(&state, profile)?;
    let _ = app.emit("config-changed", &snapshot.config.appearance.theme);
    Ok(snapshot)
}

/// Apply the profile after proving its id names an Agent that exists.
fn apply_existing_agent(
    state: &AppState,
    profile: refrain_store::config::AgentProfile,
) -> Result<refrain_store::config::ConfigSnapshot, RefrainError> {
    let store = state.config.as_ref().ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "write a damaged Config",
            "agents",
        )
    })?;
    let known = store
        .snapshot()
        .map_err(|failure| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "read the Config",
                failure.to_string(),
            )
        })?
        .config
        .agents
        .iter()
        .any(|existing| existing.id == profile.id);
    if !known {
        return Err(RefrainError::new(
            ErrorCode::StateUnavailable,
            "edit an agent",
            "no such agent",
        ));
    }
    store
        .apply(refrain_store::config::ConfigChange::UpsertAgent(profile))
        .map_err(|failure| {
            RefrainError::new(ErrorCode::Io, "write the Config", failure.to_string())
        })
}

#[tauri::command(async)]
#[specta::specta]
fn remove_agent(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<refrain_store::config::ConfigSnapshot, RefrainError> {
    let id = parse_id(&id, "agent")?;
    let store = state.config.as_ref().ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "write a damaged Config",
            "agents",
        )
    })?;
    let snapshot = store
        .apply(refrain_store::config::ConfigChange::RemoveAgent(id))
        .map_err(|failure| {
            RefrainError::new(ErrorCode::Io, "write the Config", failure.to_string())
        })?;
    let _ = app.emit("config-changed", &snapshot.config.appearance.theme);
    Ok(snapshot)
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
    let connection = connection_for_agent(state, agent)?.ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "dispatch to a local Agent tool",
            "the selected Agent uses manual return",
        )
    })?;
    let harness = LocalHarness::from_connection(&connection).ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "dispatch to a local Agent tool",
            candidate_for_adapter(connection.adapter).unwrap_or("unsupported adapter"),
        )
        .with_detail("the saved program is missing or failed its identity check")
    })?;
    let (workspace, workspace_abs, request_md) = state.with_project(root_id, |_state, entry| {
        let agent_id = ensure_agent_workspace(_state, &entry.store.layout().state_dir, agent)?;
        let context = DirectoryContext::new(entry.store.layout().state_dir.clone());
        let mut host = open_host(&mut entry.store)?;
        let workspace = refrain_host::staging::run_workspace(agent_id, run_id);
        host.execute(HostCommand::LaunchRun {
            run_id,
            workspace: workspace.clone(),
        })
        .map_err(into_domain_host)?;
        // Follows/Verifies 的另一半：下游的请求里真的有上游写下的全部字节。
        refrain_app::upstream::feed_upstream(&mut entry.store, run_id)?;
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

    let receipt = match harness.dispatch(&adapters::DispatchSpec {
        run_id,
        workspace: workspace_abs,
        request_md,
        connection_argv: connection.argv.clone(),
        agent_argv: agent_argv_of(state, agent),
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
            return Err(RefrainError::new(
                ErrorCode::Io,
                "launch the local Agent tool",
                harness.label(),
            )
            .with_detail(error.to_string()));
        }
    };
    let receipt_text = receipt.receipt.clone();
    let active_run = Arc::new(Mutex::new(ActiveRun {
        cancel: receipt.handle.cancel_token(),
        cancelled: false,
    }));
    let active_key = (root_id.to_string(), run_id);
    let previous = state
        .active_runs
        .lock()
        .map_err(|_| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "lock the active Run table",
                run_id.to_string(),
            )
        })?
        .insert(active_key.clone(), Arc::clone(&active_run));
    if previous.is_some() {
        if let Ok(active) = active_run.lock() {
            let _ = active.cancel.cancel_tree();
        }
        return Err(RefrainError::new(
            ErrorCode::StateUnavailable,
            "register a live producer",
            "the Run already has a process handle",
        ));
    }

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
    });
    let dto = match dto {
        Ok(dto) => dto,
        Err(error) => {
            state
                .active_runs
                .lock()
                .map_err(|_| {
                    RefrainError::new(
                        ErrorCode::StateUnavailable,
                        "lock the active Run table",
                        run_id.to_string(),
                    )
                })?
                .remove(&active_key);
            if let Ok(active) = active_run.lock() {
                let _ = active.cancel.cancel_tree();
            }
            return Err(error);
        }
    };

    // Observe in the background: the turn may run for minutes. On settle, the
    // reply lands atomically as the attempt's result; an empty reply fails
    // the run with the reason, not a guess.
    let root_for_thread = root_id.to_string();
    let app = app.clone();
    std::thread::spawn(move || {
        let outcome = harness.observe(receipt);
        let cancellation_confirmed = active_run
            .lock()
            .map(|active| active.cancelled)
            .unwrap_or(false);
        let state = app.state::<AppState>();
        if let Ok(mut active) = state.active_runs.lock() {
            active.remove(&(root_for_thread.clone(), run_id));
        }
        let settled = state.with_project(&root_for_thread, |_state, entry| {
            let context = DirectoryContext::new(entry.store.layout().state_dir.clone());
            let mut host = open_host(&mut entry.store)?;
            let cancelled = cancellation_confirmed
                || host
                    .runs()
                    .iter()
                    .find(|run| run.id == run_id)
                    .is_some_and(|run| matches!(run.progress, RunProgress::Cancelled));
            if cancelled {
                if let Ok(produced) = &outcome
                    && !produced.reply_text.trim().is_empty()
                {
                    context
                        .land_result(&workspace, run_id, produced.reply_text.as_bytes())
                        .map_err(|error| {
                            RefrainError::new(
                                ErrorCode::Io,
                                "preserve a cancelled producer's partial reply",
                                workspace.clone(),
                            )
                            .with_detail(error.to_string())
                        })?;
                }
                return Ok("cancelled".to_string());
            }
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

// ── C12: materials — drafts review and the Human Material Action (SPEC 8.7) ──

/// Every unresolved material draft, for the ticket's materials panel.
#[tauri::command(async)]
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
/// Where a Material's bytes came from, when it was imported rather than
/// authored.
///
/// A struct rather than two `Option<String>` parameters: the digest and the
/// format are both optional strings, so as arguments they can be swapped
/// without the compiler noticing, and the failure would surface much later as
/// a clone that cannot be found.
struct ImportedFrom<'a> {
    digest: &'a str,
    format: &'a str,
}

fn create_material_with_body(
    state: &AppState,
    entry: &mut ProjectEntry,
    title: &str,
    body: &str,
    role: DocumentRole,
    imported_from: Option<ImportedFrom<'_>>,
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
        let domain_action = to_domain_action(
            action_dto,
            DocumentFormat::of_path(&created.row.path).block_scan(),
        )?;
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
        SaveOutcomeDto::Saved { .. } => {
            let Some(source) = imported_from else {
                return Ok(created.row);
            };
            // Record which file this came from, now that the document exists.
            // The body already names the source in a sentence a reader can
            // see; these columns are what the reader's PDF pane resolves, so
            // that showing the original never depends on parsing prose the
            // author is free to rewrite.
            let row = DocumentRow {
                source_digest: Some(source.digest.to_string()),
                source_format: Some(source.format.to_string()),
                ..created.row
            };
            entry
                .store
                .record_imported_source(&row.path, source.digest, source.format)
                .map_err(into_domain)?;
            Ok(row)
        }
        SaveOutcomeDto::ChangedUnderneath { .. } => Err(RefrainError::new(
            ErrorCode::Io,
            "confirm a new material",
            "the file moved underneath",
        )),
    }
}

/// One unresolved draft by id.
///
/// Its own function because "no such draft" is a distinct outcome with a
/// distinct message, and reading it inline put two concerns — finding the
/// draft, and acting on it — in one body.
fn draft_by_id(
    entry: &mut ProjectEntry,
    draft_id: &str,
) -> Result<refrain_store::materials::MaterialDraftRow, RefrainError> {
    entry
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
        })
}

/// The only way a draft becomes a Material (SPEC 8.7: a Human Material
/// Action). Save writes the body through the same text path as the editor —
/// create, insert, confirm — never a direct file write. Dismiss keeps the
/// artifact on disk in the run workspace and removes only the draft row.
#[tauri::command(async)]
#[specta::specta]
fn commit_material_action(
    state: tauri::State<'_, AppState>,
    root_id: String,
    draft_id: String,
    edited_body: Option<String>,
    dismiss: bool,
) -> Result<Option<DocumentRow>, RefrainError> {
    state.with_project(&root_id, |state, entry| {
        let draft = draft_by_id(entry, &draft_id)?;
        if dismiss {
            entry
                .store
                .material_draft_take(&draft_id)
                .map_err(into_domain)?;
            return Ok(None);
        }

        let body = edited_body.unwrap_or_else(|| draft.body.clone());
        // `None`: an agent's draft has no imported file behind it.
        let material = DocumentRole::Material;
        let row = create_material_with_body(state, entry, &draft.title, &body, material, None)?;
        entry
            .store
            .material_draft_take(&draft_id)
            .map_err(into_domain)?;
        Ok(Some(row))
    })
}

// ── C12.3: source import — six reference formats become Materials ──────────

fn chosen_file(path: PathBuf) -> Result<PathBuf, RefrainError> {
    let canonical = path.canonicalize().map_err(|error| {
        RefrainError::new(
            ErrorCode::Io,
            "use a chosen source",
            path.display().to_string(),
        )
        .with_detail(error.to_string())
    })?;
    if !canonical.is_file() {
        return Err(RefrainError::new(
            ErrorCode::UnsupportedFormat,
            "use a chosen source",
            canonical.display().to_string(),
        ));
    }
    Ok(canonical)
}

/// The native chooser and the import are one authority boundary: release IPC
/// never receives a source path from the renderer.
#[tauri::command]
#[specta::specta]
async fn choose_and_import_material(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    root_id: String,
) -> Result<Option<DocumentRow>, RefrainError> {
    use tauri_plugin_dialog::DialogExt as _;
    let selected = app
        .dialog()
        .file()
        .set_title("选择资料")
        .add_filter(
            "Reference",
            &["pdf", "epub", "html", "htm", "docx", "pptx", "xlsx"],
        )
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|error| {
        RefrainError::new(ErrorCode::Io, "use a chosen source", error.to_string())
    })?;
    import_material_at(state, root_id, path).await.map(Some)
}

/// Import one previously authorised source file as a Material. Expensive source
/// work runs without the project lock; only the final journaled creation enters
/// the live session.
async fn import_material_at(
    state: tauri::State<'_, AppState>,
    root_id: String,
    source_path: PathBuf,
) -> Result<DocumentRow, RefrainError> {
    let source_path = chosen_file(source_path)?;
    let clone_dir = state.with_project(&root_id, |_state, entry| {
        Ok(entry.store.layout().source_backup_dir.join("materials"))
    })?;
    let clone_base = clone_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        refrain_store::materials::prepare_material_source(&source_path, &clone_dir)
    })
    .await
    .map_err(|error| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "prepare a material source",
            "worker",
        )
        .with_detail(error.to_string())
    })?
    .map_err(into_domain)?;

    let ingested = prepared.material;
    let clone_display = prepared
        .clone
        .strip_prefix(&clone_base)
        .unwrap_or(&prepared.clone)
        .display();
    let header = format!(
        "> 来源：{}（{} · blake3 {}）；原件克隆：{}",
        ingested.source_path.display(),
        ingested.format.as_str(),
        &ingested.source_digest[..12],
        clone_display
    );
    let body = format!("{header}\n\n{}", ingested.text);
    state.with_project(&root_id, |state, entry| {
        create_material_with_body(
            state,
            entry,
            &ingested.title,
            &body,
            DocumentRole::Material,
            Some(ImportedFrom {
                digest: &ingested.source_digest,
                format: ingested.format.as_str(),
            }),
        )
    })
}

// ── C12.6: drag-drop import — text becomes a chapter, the rest a Material ──

/// Import one previously authorised UTF-8 text file as a chapter.
async fn import_manuscript_at(
    state: tauri::State<'_, AppState>,
    root_id: String,
    source_path: PathBuf,
) -> Result<DocumentRow, RefrainError> {
    let source_path = chosen_file(source_path)?;
    let (title, text) = tauri::async_runtime::spawn_blocking(move || {
        let bytes = refrain_store::ingest::read_source(&source_path)?;
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
        let title = source_path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .filter(|stem| !stem.is_empty())
            .unwrap_or("拖入")
            .to_string();
        Ok::<_, RefrainError>((title, text))
    })
    .await
    .map_err(|error| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "prepare a manuscript source",
            "worker",
        )
        .with_detail(error.to_string())
    })??;
    state.with_project(&root_id, |state, entry| {
        // Dropped UTF-8 text becomes a chapter: the text *is* the manuscript,
        // so there is no separate original to read alongside it.
        create_material_with_body(state, entry, &title, &text, DocumentRole::Chapter, None)
    })
}

#[cfg(all(debug_assertions, not(feature = "generate-bindings")))]
#[tauri::command]
#[specta::specta]
fn debug_adopt_root(
    state: tauri::State<'_, AppState>,
    path: String,
    kind: RootKind,
) -> Result<ProjectOpenedDto, RefrainError> {
    adopt_root_at(state, PathBuf::from(path), kind)
}

#[cfg(all(debug_assertions, not(feature = "generate-bindings")))]
#[tauri::command]
#[specta::specta]
fn debug_create_project(
    state: tauri::State<'_, AppState>,
    parent: String,
    name: String,
) -> Result<ProjectOpenedDto, RefrainError> {
    create_project_at(state, PathBuf::from(parent), name)
}

#[cfg(all(debug_assertions, not(feature = "generate-bindings")))]
#[tauri::command]
#[specta::specta]
async fn debug_import_material(
    state: tauri::State<'_, AppState>,
    root_id: String,
    source_path: String,
) -> Result<DocumentRow, RefrainError> {
    import_material_at(state, root_id, PathBuf::from(source_path)).await
}

#[cfg(all(debug_assertions, not(feature = "generate-bindings")))]
#[tauri::command]
#[specta::specta]
async fn debug_import_manuscript(
    state: tauri::State<'_, AppState>,
    root_id: String,
    source_path: String,
) -> Result<DocumentRow, RefrainError> {
    import_manuscript_at(state, root_id, PathBuf::from(source_path)).await
}
