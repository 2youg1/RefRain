use refrain_app::{Application, ProjectInput, ProjectOutput, ProjectPlatform, SearchPrecision};
use refrain_core::material_listing::Disclosure;
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
