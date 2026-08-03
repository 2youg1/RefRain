//! Application-level project use case.
//!
//! One exhaustive input owns project acquisition, catalog reads, search,
//! disclosure, and deletion. Platform code supplies only a chooser. Selected
//! paths enter Rust and never cross the Native or TypeScript boundary.

use crate::journal::into_domain;
use refrain_core::chinese_index::Precision;
use refrain_core::material_listing::Disclosure;
use refrain_core::{ErrorCode, Manuscript, RefrainError};
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
}

impl Application {
    pub fn open(data_dir: &Path) -> Result<Self, RefrainError> {
        Ok(Self {
            store: Mutex::new(ApplicationStore::open(data_dir).map_err(application_store_failure)?),
            projects: Mutex::new(HashMap::new()),
        })
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
