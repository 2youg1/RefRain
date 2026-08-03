//! Application-level project use case.
//!
//! One exhaustive input owns project acquisition, catalog reads, search,
//! disclosure, and deletion. Platform code supplies only a chooser. Selected
//! paths enter Rust and never cross the Native or TypeScript boundary.

use crate::document::{ImportedFrom, OpenDocumentDto, create_with_body, open_in_entry};
use crate::journal::into_domain;
use refrain_core::chinese_index::Precision;
use refrain_core::material_listing::Disclosure;
use refrain_core::{
    DocumentRole, ErrorCode, KaraAutoEntry, KaraEvent, KaraMachine, KaraPolicy, KaraTransition,
    Manuscript, RefrainError,
};
use refrain_store::application::{ApplicationStore, ApplicationStoreError};
use refrain_store::project::{
    BackupStatus, BlockHit, DocumentPage, DocumentPageQuery, DocumentRow, MAX_DOCUMENT_PAGE_SIZE,
    MAX_DOCUMENT_SEARCH_RESULTS, ProjectStore, RootLocator,
};
pub use refrain_store::root::RootKind;
use refrain_store::root::is_legal_segment;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub trait ProjectPlatform {
    fn choose_root(&self, kind: RootKind) -> Result<Option<PathBuf>, RefrainError>;
    fn choose_project_parent(&self) -> Result<Option<PathBuf>, RefrainError>;
    fn choose_import(&self, kind: ProjectImport) -> Result<Option<PathBuf>, RefrainError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectImport {
    Material,
    Manuscript,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum SearchPrecision {
    Exact,
    Loose,
}

impl From<SearchPrecision> for Precision {
    fn from(value: SearchPrecision) -> Self {
        match value {
            SearchPrecision::Exact => Self::Exact,
            SearchPrecision::Loose => Self::Loose,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind",
    content = "value"
)]
pub enum ProjectInput {
    ChooseAndAdoptRoot {
        kind: RootKind,
    },
    ChooseAndCreateProject {
        name: String,
    },
    OpenDocument {
        root_id: String,
        path: String,
    },
    CreateDocument {
        root_id: String,
        title: String,
        role: DocumentRole,
    },
    ChooseAndImportMaterial {
        root_id: String,
    },
    ChooseAndImportManuscript {
        root_id: String,
    },
    DocumentPage {
        root_id: String,
        after: Option<String>,
    },
    DocumentSearch {
        root_id: String,
        query: String,
        precision: SearchPrecision,
    },
    BlockSearch {
        root_id: String,
        query: String,
        precision: SearchPrecision,
    },
    DeleteDocument {
        root_id: String,
        path: String,
    },
    SetDisclosure {
        root_id: String,
        path: String,
        disclosure: Disclosure,
    },
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOpened {
    pub root_id: String,
    pub backup: BackupStatus,
    pub documents: Vec<DocumentRow>,
    pub document_total: u32,
    pub document_cursor: Option<String>,
    pub opened_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPage {
    pub documents: Vec<DocumentRow>,
    pub total: u32,
    pub next: Option<String>,
}

impl From<DocumentPage> for ProjectPage {
    fn from(page: DocumentPage) -> Self {
        Self {
            documents: page.documents,
            total: page.total,
            next: page.next,
        }
    }
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDocuments {
    pub documents: Vec<DocumentRow>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBlocks {
    pub blocks: Vec<BlockHit>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum ProjectOutput {
    Cancelled,
    Opened(ProjectOpened),
    DocumentOpened(Box<OpenDocumentDto>),
    Imported(DocumentRow),
    Page(ProjectPage),
    Documents(ProjectDocuments),
    Blocks(ProjectBlocks),
    Deleted(DocumentRow),
    DisclosureSet(DocumentRow),
}

/// Live handles for one adopted Root. The fields are temporarily visible to
/// the remaining legacy command groups. Each group removes its access when it
/// migrates; the adapter disappears after the seventh group.
pub struct ProjectEntry {
    pub store: ProjectStore,
    pub manuscripts: HashMap<String, Manuscript>,
}

pub struct Application {
    store: Mutex<ApplicationStore>,
    projects: Mutex<HashMap<String, Arc<Mutex<ProjectEntry>>>>,
    kara: Mutex<KaraMachine>,
    kara_policy: Mutex<KaraPolicy>,
}

impl Application {
    pub fn open(data_dir: &Path) -> Result<Self, RefrainError> {
        Ok(Self {
            store: Mutex::new(ApplicationStore::open(data_dir).map_err(application_store_failure)?),
            projects: Mutex::new(HashMap::new()),
            kara: Mutex::new(KaraMachine::new()),
            kara_policy: Mutex::new(KaraPolicy {
                auto_enter_on_first_manuscript: true,
            }),
        })
    }

    pub fn set_kara_policy(&self, policy: KaraPolicy) -> Result<(), RefrainError> {
        *self.kara_policy.lock().map_err(|_| {
            RefrainError::new(ErrorCode::StateUnavailable, "lock the KARA policy", "kara")
        })? = policy;
        Ok(())
    }

    pub fn kara_step(&self, event: KaraEvent) -> Result<KaraTransition, RefrainError> {
        let policy = *self.kara_policy.lock().map_err(|_| {
            RefrainError::new(ErrorCode::StateUnavailable, "lock the KARA policy", "kara")
        })?;
        let mut kara = self.kara.lock().map_err(|_| {
            RefrainError::new(ErrorCode::StateUnavailable, "lock the KARA machine", "kara")
        })?;
        let transition = kara.step(event, policy);
        *kara = transition.machine.clone();
        Ok(transition)
    }

    pub fn kara_state(&self) -> Result<KaraMachine, RefrainError> {
        self.kara.lock().map(|kara| kara.clone()).map_err(|_| {
            RefrainError::new(ErrorCode::StateUnavailable, "lock the KARA machine", "kara")
        })
    }

    fn rearm_kara(&self) -> Result<(), RefrainError> {
        self.kara
            .lock()
            .map_err(|_| {
                RefrainError::new(ErrorCode::StateUnavailable, "lock the KARA machine", "kara")
            })?
            .auto_entry = KaraAutoEntry::Pending;
        Ok(())
    }

    pub fn project(
        &self,
        platform: &impl ProjectPlatform,
        input: ProjectInput,
    ) -> Result<ProjectOutput, RefrainError> {
        match input {
            ProjectInput::ChooseAndAdoptRoot { kind } => {
                let Some(path) = platform.choose_root(kind).map_err(|error| {
                    selected_path_failure(error, "choose a Root", "selected Root")
                })?
                else {
                    return Ok(ProjectOutput::Cancelled);
                };
                self.adopt(RootLocator { path, kind })
                    .map_err(|error| selected_path_failure(error, "adopt a Root", "selected Root"))
                    .map(ProjectOutput::Opened)
            }
            ProjectInput::ChooseAndCreateProject { name } => {
                if !is_legal_segment(&name) {
                    return Err(RefrainError::new(
                        ErrorCode::IllegalName,
                        "create a project",
                        name,
                    ));
                }
                let Some(parent) = platform.choose_project_parent().map_err(|error| {
                    selected_path_failure(error, "choose a project location", name.clone())
                })?
                else {
                    return Ok(ProjectOutput::Cancelled);
                };
                let path = parent.join(&name);
                let opened = (|| -> Result<ProjectOpened, RefrainError> {
                    if path.try_exists().map_err(|error| {
                        RefrainError::new(
                            ErrorCode::Io,
                            "check the project directory",
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
                    fs::create_dir(&path).map_err(|error| {
                        RefrainError::new(
                            ErrorCode::Io,
                            "create the project directory",
                            path.display().to_string(),
                        )
                        .with_detail(error.to_string())
                    })?;
                    self.adopt(RootLocator {
                        path,
                        kind: RootKind::Folder,
                    })
                })()
                .map_err(|error| selected_path_failure(error, "create a project", name.clone()))?;
                Ok(ProjectOutput::Opened(opened))
            }
            ProjectInput::OpenDocument { root_id, path } => self
                .open_document(&root_id, &path)
                .map(Box::new)
                .map(ProjectOutput::DocumentOpened),
            ProjectInput::CreateDocument {
                root_id,
                title,
                role,
            } => self
                .create_document(&root_id, &title, role)
                .map(Box::new)
                .map(ProjectOutput::DocumentOpened),
            ProjectInput::ChooseAndImportMaterial { root_id } => {
                let Some(path) =
                    platform
                        .choose_import(ProjectImport::Material)
                        .map_err(|error| {
                            selected_path_failure(error, "choose a material", "selected material")
                        })?
                else {
                    return Ok(ProjectOutput::Cancelled);
                };
                self.import_material(&root_id, path)
                    .map(ProjectOutput::Imported)
            }
            ProjectInput::ChooseAndImportManuscript { root_id } => {
                let Some(path) =
                    platform
                        .choose_import(ProjectImport::Manuscript)
                        .map_err(|error| {
                            selected_path_failure(
                                error,
                                "choose a manuscript",
                                "selected manuscript",
                            )
                        })?
                else {
                    return Ok(ProjectOutput::Cancelled);
                };
                self.import_manuscript(&root_id, path)
                    .map(ProjectOutput::Imported)
            }
            ProjectInput::DocumentPage { root_id, after } => self
                .with_project(&root_id, |entry| {
                    entry
                        .store
                        .refresh_document_page(DocumentPageQuery {
                            after,
                            limit: MAX_DOCUMENT_PAGE_SIZE,
                        })
                        .map_err(into_domain)
                })
                .map(ProjectPage::from)
                .map(ProjectOutput::Page),
            ProjectInput::DocumentSearch {
                root_id,
                query,
                precision,
            } => self
                .with_project(&root_id, |entry| {
                    entry.store.search_documents_with(
                        &query,
                        precision.into(),
                        MAX_DOCUMENT_SEARCH_RESULTS,
                    )
                })
                .map(|documents| {
                    ProjectOutput::Documents(ProjectDocuments {
                        documents,
                        truncated: false,
                    })
                }),
            ProjectInput::BlockSearch {
                root_id,
                query,
                precision,
            } => self
                .with_project(&root_id, |entry| {
                    entry.store.search_blocks_with(
                        &query,
                        precision.into(),
                        MAX_DOCUMENT_SEARCH_RESULTS,
                    )
                })
                .map(|blocks| {
                    ProjectOutput::Blocks(ProjectBlocks {
                        blocks,
                        truncated: false,
                    })
                }),
            ProjectInput::DeleteDocument { root_id, path } => self
                .with_project(&root_id, |entry| {
                    let row = entry.store.delete_document(&path).map_err(into_domain)?;
                    entry.manuscripts.remove(&path);
                    Ok(row)
                })
                .map(ProjectOutput::Deleted),
            ProjectInput::SetDisclosure {
                root_id,
                path,
                disclosure,
            } => self
                .with_project(&root_id, |entry| {
                    entry
                        .store
                        .set_disclosure(&path, disclosure)
                        .map_err(into_domain)
                })
                .map(ProjectOutput::DisclosureSet),
        }
    }

    fn open_document(&self, root_id: &str, path: &str) -> Result<OpenDocumentDto, RefrainError> {
        self.with_project(root_id, |entry| {
            let opened = entry
                .store
                .open_registered_document(path)
                .map_err(into_domain)?;
            entry.store.remember_landing(path).map_err(into_domain)?;
            let kara = self.manuscript_opened(opened.row.role, path)?;
            open_in_entry(entry, path, opened, kara)
        })
    }

    fn create_document(
        &self,
        root_id: &str,
        title: &str,
        role: DocumentRole,
    ) -> Result<OpenDocumentDto, RefrainError> {
        self.with_project(root_id, |entry| {
            let created = entry
                .store
                .create(&refrain_store::project::CreateDocument {
                    title: title.to_string(),
                    role,
                })
                .map_err(into_domain)?;
            let path = created.row.path.clone();
            let kara = self.manuscript_opened(role, &path)?;
            open_in_entry(entry, &path, created, kara)
        })
    }

    fn import_material(
        &self,
        root_id: &str,
        selected: PathBuf,
    ) -> Result<DocumentRow, RefrainError> {
        let source = chosen_file(selected).map_err(|error| {
            selected_path_failure(error, "import a material", "selected material")
        })?;
        let clone_dir = self.with_project(root_id, |entry| {
            Ok(entry.store.layout().source_backup_dir.join("materials"))
        })?;
        let clone_base = clone_dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default();
        let prepared = refrain_store::materials::prepare_material_source(&source, &clone_dir)
            .map_err(into_domain)
            .map_err(|error| {
                selected_path_failure(error, "prepare a material", "selected material")
            })?;
        let ingested = prepared.material;
        let source_name = source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("source");
        let clone_display = prepared
            .clone
            .strip_prefix(&clone_base)
            .unwrap_or(&prepared.clone)
            .display();
        let header = format!(
            "> 来源：{source_name}（{} · blake3 {}）；原件克隆：{clone_display}",
            ingested.format.as_str(),
            &ingested.source_digest[..12],
        );
        let body = format!("{header}\n\n{}", ingested.text);
        self.with_project(root_id, |entry| {
            let (row, _opened) = create_with_body(
                entry,
                &ingested.title,
                &body,
                DocumentRole::Material,
                Some(ImportedFrom {
                    digest: &ingested.source_digest,
                    format: ingested.format.as_str(),
                }),
                None,
            )?;
            Ok(row)
        })
    }

    fn import_manuscript(
        &self,
        root_id: &str,
        selected: PathBuf,
    ) -> Result<DocumentRow, RefrainError> {
        let source = chosen_file(selected).map_err(|error| {
            selected_path_failure(error, "import a manuscript", "selected manuscript")
        })?;
        let bytes = refrain_store::ingest::read_source(&source).map_err(|error| {
            selected_path_failure(error, "read an imported manuscript", "selected manuscript")
        })?;
        let text_bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
        let text = String::from_utf8(text_bytes.to_vec()).map_err(|_| {
            RefrainError::new(
                ErrorCode::UnsupportedFormat,
                "read an imported manuscript",
                "not UTF-8 text",
            )
        })?;
        let title = source
            .file_stem()
            .and_then(|stem| stem.to_str())
            .filter(|stem| !stem.is_empty())
            .unwrap_or("拖入")
            .to_string();
        self.with_project(root_id, |entry| {
            let kara = self.manuscript_opened(DocumentRole::Chapter, &title)?;
            let (row, _opened) =
                create_with_body(entry, &title, &text, DocumentRole::Chapter, None, kara)?;
            Ok(row)
        })
    }

    pub fn commit_material_action(
        &self,
        root_id: &str,
        draft_id: &str,
        edited_body: Option<String>,
        dismiss: bool,
    ) -> Result<Option<DocumentRow>, RefrainError> {
        self.with_project(root_id, |entry| {
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
                    .material_draft_take(draft_id)
                    .map_err(into_domain)?;
                return Ok(None);
            }

            let body = edited_body.unwrap_or_else(|| draft.body.clone());
            let (row, _opened) = create_with_body(
                entry,
                &draft.title,
                &body,
                DocumentRole::Material,
                None,
                None,
            )?;
            entry
                .store
                .material_draft_take(draft_id)
                .map_err(into_domain)?;
            Ok(Some(row))
        })
    }

    fn manuscript_opened(
        &self,
        role: DocumentRole,
        subject: &str,
    ) -> Result<Option<KaraTransition>, RefrainError> {
        if !matches!(role, DocumentRole::Document | DocumentRole::Chapter) {
            return Ok(None);
        }
        let auto_entry = self.kara_state()?.auto_entry;
        self.kara_step(KaraEvent::FirstManuscriptOpened(auto_entry))
            .map(Some)
            .map_err(|mut error| {
                error.subject = subject.to_string();
                error
            })
    }

    pub fn with_project<T>(
        &self,
        root_id: &str,
        use_entry: impl FnOnce(&mut ProjectEntry) -> Result<T, RefrainError>,
    ) -> Result<T, RefrainError> {
        let entry = {
            let projects = self.projects.lock().map_err(|_| {
                RefrainError::new(ErrorCode::StateUnavailable, "lock the project map", root_id)
            })?;
            Arc::clone(projects.get(root_id).ok_or_else(|| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "use a Root that is not open",
                    root_id,
                )
            })?)
        };
        let mut entry = entry.lock().map_err(|_| {
            RefrainError::new(ErrorCode::StateUnavailable, "lock the project", root_id)
        })?;
        use_entry(&mut entry)
    }

    fn adopt(&self, locator: RootLocator) -> Result<ProjectOpened, RefrainError> {
        let (mut store, backup) = self
            .store
            .lock()
            .map_err(|_| RefrainError::new(ErrorCode::StateUnavailable, "lock app.db", "adopt"))?
            .adopt(&locator)
            .map_err(application_store_failure)?;
        let root_id = store.permit().root_id.to_string();
        let page = store
            .refresh_document_page(DocumentPageQuery {
                after: None,
                limit: MAX_DOCUMENT_PAGE_SIZE,
            })
            .map_err(into_domain)?;
        let opened_path = store.landing_document().map_err(into_domain)?;
        self.projects
            .lock()
            .map_err(|_| {
                RefrainError::new(ErrorCode::StateUnavailable, "lock the project map", "adopt")
            })?
            .insert(
                root_id.clone(),
                Arc::new(Mutex::new(ProjectEntry {
                    store,
                    manuscripts: HashMap::new(),
                })),
            );
        self.rearm_kara()?;
        Ok(ProjectOpened {
            root_id,
            backup,
            documents: page.documents,
            document_total: page.total,
            document_cursor: page.next,
            opened_path,
        })
    }
}

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

fn selected_path_failure(
    mut error: RefrainError,
    action: &'static str,
    safe_subject: impl Into<String>,
) -> RefrainError {
    error.action = action.to_string();
    error.subject = safe_subject.into();
    error.detail = None;
    error
}

fn application_store_failure(failure: ApplicationStoreError) -> RefrainError {
    match failure {
        ApplicationStoreError::Project(failure) => into_domain(failure),
        ApplicationStoreError::Io { path, source } => RefrainError::new(
            ErrorCode::Io,
            "open application storage",
            path.display().to_string(),
        )
        .with_detail(source.to_string()),
        ApplicationStoreError::Store(error) => RefrainError::new(
            ErrorCode::StateUnavailable,
            "open app.db",
            "application storage",
        )
        .with_detail(error.to_string()),
    }
}
