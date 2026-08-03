use refrain_app::{
    Application, ProjectImport, ProjectInput, ProjectOutput, ProjectPlatform, SearchPrecision,
};
use refrain_core::material_listing::Disclosure;
use refrain_core::{DocumentRole, KaraAutoEntry};
use refrain_store::materials::MaterialDraftRow;
use refrain_store::root::RootKind;
use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

static SEQUENCE: AtomicU32 = AtomicU32::new(0);

fn scratch(label: &str) -> PathBuf {
    let unique = format!(
        "refrain-app-project-{label}-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos()),
        SEQUENCE.fetch_add(1, Ordering::Relaxed),
    );
    let path = std::env::temp_dir().join(unique);
    fs::create_dir_all(&path).unwrap();
    path
}

struct ChosenPaths {
    paths: Mutex<VecDeque<Option<PathBuf>>>,
}

impl ChosenPaths {
    fn new(paths: impl IntoIterator<Item = Option<PathBuf>>) -> Self {
        Self {
            paths: Mutex::new(paths.into_iter().collect()),
        }
    }

    fn next(&self) -> Result<Option<PathBuf>, refrain_core::RefrainError> {
        self.paths.lock().unwrap().pop_front().ok_or_else(|| {
            refrain_core::RefrainError::new(
                refrain_core::ErrorCode::StateUnavailable,
                "choose a project path",
                "test queue exhausted",
            )
        })
    }
}

impl ProjectPlatform for ChosenPaths {
    fn choose_root(&self, _kind: RootKind) -> Result<Option<PathBuf>, refrain_core::RefrainError> {
        self.next()
    }

    fn choose_project_parent(&self) -> Result<Option<PathBuf>, refrain_core::RefrainError> {
        self.next()
    }

    fn choose_import(
        &self,
        _kind: ProjectImport,
    ) -> Result<Option<PathBuf>, refrain_core::RefrainError> {
        self.next()
    }
}

struct FailingChooser {
    selected: PathBuf,
}

impl ProjectPlatform for FailingChooser {
    fn choose_root(&self, _kind: RootKind) -> Result<Option<PathBuf>, refrain_core::RefrainError> {
        Err(refrain_core::RefrainError::new(
            refrain_core::ErrorCode::Io,
            "open the chooser result",
            self.selected.display().to_string(),
        )
        .with_detail(format!("cannot read {}", self.selected.display()))
        .with_recovery(vec![refrain_core::RecoveryStep::Retry]))
    }

    fn choose_project_parent(&self) -> Result<Option<PathBuf>, refrain_core::RefrainError> {
        self.choose_root(RootKind::Folder)
    }

    fn choose_import(
        &self,
        _kind: ProjectImport,
    ) -> Result<Option<PathBuf>, refrain_core::RefrainError> {
        self.choose_root(RootKind::File)
    }
}

#[test]
fn one_project_use_case_owns_chooser_adoption_paging_and_search() {
    let data = scratch("data");
    let root = scratch("root");
    fs::write(root.join("一.md"), "共同词。\n\n第一份。\n").unwrap();
    fs::write(root.join("二.md"), "共同词。\n\n第二份。\n").unwrap();
    let platform = ChosenPaths::new([Some(root.clone()), None]);
    let application = Application::open(&data).unwrap();

    let opened = application
        .project(
            &platform,
            ProjectInput::ChooseAndAdoptRoot {
                kind: RootKind::Folder,
            },
        )
        .unwrap();
    let ProjectOutput::Opened(opened) = opened else {
        panic!("adopt must return the opened project");
    };
    assert_eq!(opened.documents.len(), 2);
    let root_id = opened.root_id;

    let page = application
        .project(
            &platform,
            ProjectInput::DocumentPage {
                root_id: root_id.clone(),
                after: None,
            },
        )
        .unwrap();
    let ProjectOutput::Page(page) = page else {
        panic!("page input must return a page");
    };
    assert_eq!(page.documents.len(), 2);

    let documents = application
        .project(
            &platform,
            ProjectInput::DocumentSearch {
                root_id: root_id.clone(),
                query: "共同词".to_string(),
                precision: SearchPrecision::Exact,
            },
        )
        .unwrap();
    let ProjectOutput::Documents(documents) = documents else {
        panic!("document search must return documents");
    };
    assert_eq!(documents.documents.len(), 2);
    assert!(!documents.truncated);

    let blocks = application
        .project(
            &platform,
            ProjectInput::BlockSearch {
                root_id: root_id.clone(),
                query: "第二份".to_string(),
                precision: SearchPrecision::Exact,
            },
        )
        .unwrap();
    let ProjectOutput::Blocks(blocks) = blocks else {
        panic!("block search must return blocks");
    };
    assert_eq!(blocks.blocks.len(), 1);
    assert!(blocks.blocks[0].text.contains("第二份"));
    assert!(!blocks.truncated);

    let disclosure = application
        .project(
            &platform,
            ProjectInput::SetDisclosure {
                root_id: root_id.clone(),
                path: "二.md".to_string(),
                disclosure: Disclosure::Full,
            },
        )
        .unwrap();
    let ProjectOutput::DisclosureSet(disclosure) = disclosure else {
        panic!("disclosure input must return the changed document");
    };
    assert_eq!(disclosure.disclosure, Some(Disclosure::Full));

    let delete_error = application
        .project(
            &platform,
            ProjectInput::DeleteDocument {
                root_id,
                path: "没有.md".to_string(),
            },
        )
        .unwrap_err();
    assert_eq!(delete_error.code, refrain_core::ErrorCode::StateUnavailable);
    assert!(root.join("一.md").exists());

    assert!(matches!(
        application
            .project(
                &platform,
                ProjectInput::ChooseAndAdoptRoot {
                    kind: RootKind::Folder,
                },
            )
            .unwrap(),
        ProjectOutput::Cancelled,
    ));

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn creating_a_project_validates_the_name_before_it_mutates_disk() {
    let data = scratch("data");
    let parent = scratch("parent");
    let platform = ChosenPaths::new([Some(parent.clone())]);
    let application = Application::open(&data).unwrap();

    let error = application
        .project(
            &platform,
            ProjectInput::ChooseAndCreateProject {
                name: "../escape".to_string(),
            },
        )
        .unwrap_err();
    assert_eq!(error.code, refrain_core::ErrorCode::IllegalName);
    assert!(!parent.join("escape").exists());

    let created = application
        .project(
            &platform,
            ProjectInput::ChooseAndCreateProject {
                name: "书稿".to_string(),
            },
        )
        .unwrap();
    let ProjectOutput::Opened(created) = created else {
        panic!("valid creation must return the opened project");
    };
    assert!(parent.join("书稿").is_dir());
    assert!(created.documents.is_empty());
    assert_eq!(created.opened_path, None);

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(parent).unwrap();
}

#[test]
fn project_acquisition_opens_creates_and_imports_without_exposing_source_paths() {
    let data = scratch("acquisition-data");
    let root = scratch("acquisition-root");
    fs::write(root.join("既有.md"), "既有正文。\n").unwrap();
    let sources = scratch("acquisition-sources");
    let manuscript_source = sources.join("外来稿.txt");
    let material_source = sources.join("资料.html");
    fs::write(&manuscript_source, "导入正文。\n\n第二段。\n").unwrap();
    fs::write(
        &material_source,
        "<!doctype html><html><head><title>来源资料</title></head><body><p>材料正文。</p></body></html>",
    )
    .unwrap();
    let platform = ChosenPaths::new([
        Some(root.clone()),
        Some(manuscript_source.clone()),
        Some(material_source.clone()),
    ]);
    let application = Application::open(&data).unwrap();
    let ProjectOutput::Opened(project) = application
        .project(
            &platform,
            ProjectInput::ChooseAndAdoptRoot {
                kind: RootKind::Folder,
            },
        )
        .unwrap()
    else {
        panic!("adopt must open the project");
    };

    let ProjectOutput::DocumentOpened(opened) = application
        .project(
            &platform,
            ProjectInput::OpenDocument {
                root_id: project.root_id.clone(),
                path: "既有.md".to_string(),
            },
        )
        .unwrap()
    else {
        panic!("open input must return an open document");
    };
    assert_eq!(opened.blocks[0].text, "既有正文。");
    assert!(opened.kara.is_some());

    let ProjectOutput::DocumentOpened(created) = application
        .project(
            &platform,
            ProjectInput::CreateDocument {
                root_id: project.root_id.clone(),
                title: "新章".to_string(),
                role: DocumentRole::Chapter,
            },
        )
        .unwrap()
    else {
        panic!("create input must return the created document");
    };
    assert_eq!(created.document.role, DocumentRole::Chapter);
    assert!(root.join(&created.document.path).is_file());

    let ProjectOutput::Imported(manuscript) = application
        .project(
            &platform,
            ProjectInput::ChooseAndImportManuscript {
                root_id: project.root_id.clone(),
            },
        )
        .unwrap()
    else {
        panic!("manuscript import must return the imported row");
    };
    assert_eq!(manuscript.role, DocumentRole::Chapter);
    let ProjectOutput::DocumentOpened(imported_manuscript) = application
        .project(
            &platform,
            ProjectInput::OpenDocument {
                root_id: project.root_id.clone(),
                path: manuscript.path,
            },
        )
        .unwrap()
    else {
        panic!("imported manuscript must open through the same use case");
    };
    assert!(
        imported_manuscript
            .blocks
            .iter()
            .any(|block| block.text.contains("导入正文"))
    );

    let ProjectOutput::Imported(material) = application
        .project(
            &platform,
            ProjectInput::ChooseAndImportMaterial {
                root_id: project.root_id.clone(),
            },
        )
        .unwrap()
    else {
        panic!("material import must return the imported row");
    };
    assert_eq!(material.role, DocumentRole::Material);
    let ProjectOutput::DocumentOpened(imported_material) = application
        .project(
            &platform,
            ProjectInput::OpenDocument {
                root_id: project.root_id,
                path: material.path,
            },
        )
        .unwrap()
    else {
        panic!("imported material must open through the same use case");
    };
    let serialized = serde_json::to_string(&imported_material).unwrap();
    assert!(serialized.contains("材料正文"));
    assert!(!serialized.contains(&sources.display().to_string()));

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(sources).unwrap();
}

#[test]
fn chooser_failures_never_serialize_the_selected_absolute_path() {
    let data = scratch("path-redaction-data");
    let secret_root = scratch("path-redaction-secret");
    let secret = secret_root.join("private-draft");
    let application = Application::open(&data).unwrap();

    let chooser_error = application
        .project(
            &FailingChooser {
                selected: secret.clone(),
            },
            ProjectInput::ChooseAndAdoptRoot {
                kind: RootKind::Folder,
            },
        )
        .unwrap_err();
    assert_eq!(chooser_error.code, refrain_core::ErrorCode::Io);
    assert_eq!(
        chooser_error.recovery,
        vec![refrain_core::RecoveryStep::Retry]
    );
    assert!(
        !serde_json::to_string(&chooser_error)
            .unwrap()
            .contains(&secret.display().to_string())
    );

    let parent = scratch("path-redaction-parent");
    fs::create_dir(parent.join("Occupied")).unwrap();
    let occupied_error = application
        .project(
            &ChosenPaths::new([Some(parent.clone())]),
            ProjectInput::ChooseAndCreateProject {
                name: "Occupied".to_string(),
            },
        )
        .unwrap_err();
    assert_eq!(occupied_error.code, refrain_core::ErrorCode::Occupied);
    assert!(
        !serde_json::to_string(&occupied_error)
            .unwrap()
            .contains(&parent.display().to_string())
    );

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(secret_root).unwrap();
    fs::remove_dir_all(parent).unwrap();
}

#[test]
fn material_draft_commit_uses_the_application_document_lifecycle() {
    let data = scratch("material-draft-data");
    let root = scratch("material-draft-root");
    fs::write(root.join("正文.md"), "原稿。\n").unwrap();
    let application = Application::open(&data).unwrap();
    let ProjectOutput::Opened(project) = application
        .project(
            &ChosenPaths::new([Some(root.clone())]),
            ProjectInput::ChooseAndAdoptRoot {
                kind: RootKind::Folder,
            },
        )
        .unwrap()
    else {
        panic!("adoption must open the project");
    };

    application
        .with_project(&project.root_id, |entry| {
            entry
                .store
                .material_draft_insert(&MaterialDraftRow {
                    id: "draft-1".to_string(),
                    run_id: "run-1".to_string(),
                    document: "正文.md".to_string(),
                    kind: "summary".to_string(),
                    title: "资料摘录".to_string(),
                    basis: "[]".to_string(),
                    body: "原始草稿".to_string(),
                    created_at: 1,
                })
                .map_err(refrain_app::journal::into_domain)
        })
        .unwrap();

    let material = application
        .commit_material_action(
            &project.root_id,
            "draft-1",
            Some("作者确认后的正文".to_string()),
            false,
        )
        .unwrap()
        .expect("commit must create one Material");
    assert_eq!(material.role, DocumentRole::Material);
    application
        .with_project(&project.root_id, |entry| {
            assert!(entry.store.material_drafts().unwrap().is_empty());
            Ok(())
        })
        .unwrap();

    let ProjectOutput::DocumentOpened(opened) = application
        .project(
            &ChosenPaths::new([]),
            ProjectInput::OpenDocument {
                root_id: project.root_id,
                path: material.path,
            },
        )
        .unwrap()
    else {
        panic!("committed Material must open through the Project use case");
    };
    assert!(
        opened
            .blocks
            .iter()
            .any(|block| block.text.contains("作者确认后的正文"))
    );

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn adopting_a_project_rearms_karas_one_automatic_entry() {
    let data = scratch("kara-rearm-data");
    let root = scratch("kara-rearm-root");
    fs::write(root.join("正文.md"), "原稿。\n").unwrap();
    let application = Application::open(&data).unwrap();
    let ProjectOutput::Opened(project) = application
        .project(
            &ChosenPaths::new([Some(root.clone())]),
            ProjectInput::ChooseAndAdoptRoot {
                kind: RootKind::Folder,
            },
        )
        .unwrap()
    else {
        panic!("adoption must open the project");
    };

    let ProjectOutput::DocumentOpened(_) = application
        .project(
            &ChosenPaths::new([]),
            ProjectInput::OpenDocument {
                root_id: project.root_id,
                path: "正文.md".to_string(),
            },
        )
        .unwrap()
    else {
        panic!("opening a manuscript must use the Project use case");
    };
    assert_eq!(
        application.kara_state().unwrap().auto_entry,
        KaraAutoEntry::Consumed
    );

    let ProjectOutput::Opened(_) = application
        .project(
            &ChosenPaths::new([Some(root.clone())]),
            ProjectInput::ChooseAndAdoptRoot {
                kind: RootKind::Folder,
            },
        )
        .unwrap()
    else {
        panic!("re-adoption must open the project");
    };
    assert_eq!(
        application.kara_state().unwrap().auto_entry,
        KaraAutoEntry::Pending
    );

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(root).unwrap();
}
