use refrain_app::{
    Application, ProjectImport, ProjectInput, ProjectOutput, ProjectPlatform, SearchPrecision,
};
use refrain_core::material_listing::Disclosure;
use refrain_core::{DocumentRole, KaraAutoEntry};
use refrain_store::annotations::{AnnotationKind, AnnotationRow};
use refrain_store::ledger::VerdictKindName;
use refrain_store::materials::MaterialDraftRow;
use refrain_store::project::ProposalRow;
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
            DocumentRole::Material,
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
fn native_anchor_sources_collect_annotations_and_only_undecided_proposals() {
    let data = scratch("anchor-sources-data");
    let root = scratch("anchor-sources-root");
    fs::write(root.join("正文.md"), "原稿。下一句。\n\n第二块。\n").unwrap();
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

    let block_id = refrain_core::Id::new().to_string();
    let pending_id = refrain_core::Id::new().to_string();
    let judged_id = refrain_core::Id::new().to_string();
    let malformed_id = refrain_core::Id::new().to_string();
    application
        .with_project(&project.root_id, |entry| {
            entry
                .store
                .annotation_upsert(&AnnotationRow {
                    id: "a1".to_string(),
                    document: "正文.md".to_string(),
                    block_id: refrain_core::Id::new().to_string(),
                    start: 3,
                    end: 9,
                    quote: "下一句".to_string(),
                    kind: AnnotationKind::Comment,
                    body: Some("这里再说".to_string()),
                    created_at: 1,
                    updated_at: 1,
                })
                .map_err(refrain_app::journal::into_domain)
        })
        .unwrap();

    let pending = ProposalRow {
        id: pending_id,
        run: refrain_core::Id::new().to_string(),
        baseline: refrain_core::Id::new().to_string(),
        document_path: "正文.md".to_string(),
        scope: format!("[\"{block_id}\"]"),
        before_text: "原稿。下一句。".to_string(),
        after_text: Some("改后。下一句。".to_string()),
        created_at: 1,
    };
    let judged = ProposalRow {
        id: judged_id.clone(),
        ..pending.clone()
    };
    let malformed = ProposalRow {
        id: malformed_id,
        scope: "not json".to_string(),
        ..pending.clone()
    };
    application
        .with_project(&project.root_id, |entry| {
            for row in [&pending, &judged, &malformed] {
                entry
                    .store
                    .proposal_insert(row)
                    .map_err(refrain_app::journal::into_domain)?;
            }
            Ok(())
        })
        .unwrap();

    // 判掉 p2：拒绝不进正文，是区分「判过」与「待裁决」最薄的判法。
    application
        .project(
            &ChosenPaths::new([]),
            ProjectInput::StageVerdict {
                root_id: project.root_id.clone(),
                path: "正文.md".to_string(),
                proposal_id: judged_id,
                kind: VerdictKindName::Reject,
                final_text: None,
                reason: None,
            },
        )
        .unwrap();

    let sources = application
        .native_anchor_sources(&project.root_id, "正文.md")
        .unwrap();
    // 批注 a1 + 待裁决的 p1；p2 判过省略，p3 的 scope 坏了省略。
    assert_eq!(sources.len(), 2);
    match &sources[0] {
        refrain_app::AnchorSource::Annotation {
            id,
            block_id: _,
            start,
            end,
            quote,
            comment,
        } => {
            assert_eq!(id, "a1");
            assert_eq!((*start, *end), (3, 9));
            assert_eq!(quote, "下一句");
            assert!(comment);
        }
        other => panic!("the annotation must come first: {other:?}"),
    }
    match &sources[1] {
        refrain_app::AnchorSource::Proposal {
            id,
            block_id: anchored,
            candidates,
        } => {
            assert_eq!(id, &pending.id);
            assert_eq!(anchored, &block_id);
            assert!(
                !candidates.is_empty(),
                "a rewrite proposal carries anchorable slices"
            );
        }
        other => panic!("the pending proposal must follow: {other:?}"),
    }

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_material_draft_promotes_to_manuscript_through_the_project_channel() {
    let data = scratch("material-promote-data");
    let root = scratch("material-promote-root");
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
                    id: "draft-9".to_string(),
                    run_id: "run-9".to_string(),
                    document: "正文.md".to_string(),
                    kind: "chapter-synopsis".to_string(),
                    title: "全文摘要".to_string(),
                    basis: "[]".to_string(),
                    body: "这一章写河湾起雾。".to_string(),
                    created_at: 1,
                })
                .map_err(refrain_app::journal::into_domain)
        })
        .unwrap();

    // 读名录：一条草稿在列。
    let ProjectOutput::MaterialDrafts(drafts) = application
        .project(
            &ChosenPaths::new([]),
            ProjectInput::ReadMaterialDrafts {
                root_id: project.root_id.clone(),
            },
        )
        .unwrap()
    else {
        panic!("reading drafts must answer with the listing");
    };
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].title, "全文摘要");
    assert_eq!(drafts[0].body, "这一章写河湾起雾。");

    // 提拔成正文：答复即刷新后的名录（空了），落地的是一份 Chapter。
    let ProjectOutput::MaterialDrafts(after) = application
        .project(
            &ChosenPaths::new([]),
            ProjectInput::CommitMaterialDraft {
                root_id: project.root_id.clone(),
                draft_id: "draft-9".to_string(),
                edited_body: None,
                dismiss: false,
                as_chapter: true,
            },
        )
        .unwrap()
    else {
        panic!("committing must answer with the refreshed listing");
    };
    assert!(after.is_empty(), "a committed draft leaves the listing");

    let ProjectOutput::Page(page) = application
        .project(
            &ChosenPaths::new([]),
            ProjectInput::DocumentPage {
                root_id: project.root_id.clone(),
                after: None,
            },
        )
        .unwrap()
    else {
        panic!("the document page must list the promoted chapter");
    };
    assert!(
        page.documents
            .iter()
            .any(|row| row.role == DocumentRole::Chapter && row.path.contains("全文摘要")),
        "the promoted draft must land as a Chapter: {:?}",
        page.documents
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
        application.kara().state().unwrap().auto_entry,
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
        application.kara().state().unwrap().auto_entry,
        KaraAutoEntry::Pending
    );

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(root).unwrap();
}

// ---------- 2.2 派发深度回迁：ReadBlocks（派发台块清单） ----------

/// 起一个打开着一份五段稿子的应用：ReadBlocks 列的是活 Manuscript，
/// 不打开就没有清单。
fn open_chapter(label: &str, body: &str) -> (PathBuf, Application, String) {
    let data = scratch(label);
    let root = scratch(label);
    fs::write(root.join("章.md"), body).unwrap();
    let platform = ChosenPaths::new([Some(root.clone())]);
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
    let root_id = project.root_id.clone();
    let ProjectOutput::DocumentOpened(_) = application
        .project(
            &platform,
            ProjectInput::OpenDocument {
                root_id: root_id.clone(),
                path: "章.md".to_string(),
            },
        )
        .unwrap()
    else {
        panic!("open input must return an open document");
    };
    (data, application, root_id)
}

fn read_blocks(
    application: &Application,
    root_id: &str,
    after: Option<u32>,
    count: u32,
) -> refrain_app::DocumentBlocks {
    let platform = ChosenPaths::new([]);
    let ProjectOutput::DocumentBlocks(page) = application
        .project(
            &platform,
            ProjectInput::ReadBlocks {
                root_id: root_id.to_string(),
                path: "章.md".to_string(),
                after,
                count,
            },
        )
        .unwrap()
    else {
        panic!("readBlocks must return the block list");
    };
    page
}

#[test]
fn read_blocks_pages_by_ordinal_until_nothing_remains() {
    let (_data, application, root_id) = open_chapter(
        "blocks-paging",
        "一。

二。

三。

四。

五。
",
    );

    let first = read_blocks(&application, &root_id, None, 2);
    assert_eq!(first.blocks.len(), 2);
    assert_eq!(first.blocks[0].ordinal, 0);
    assert_eq!(first.blocks[0].peek, "一。");
    assert_eq!(first.blocks[1].ordinal, 1);
    // 还有剩余：下一页从末行的下一个 ordinal 起。
    assert_eq!(first.next, Some(2));

    let second = read_blocks(&application, &root_id, first.next, 2);
    assert_eq!(
        second
            .blocks
            .iter()
            .map(|row| row.ordinal)
            .collect::<Vec<_>>(),
        vec![2, 3]
    );
    assert_eq!(second.next, Some(4));

    // 翻到末尾：余一行，next 熄灭。
    let last = read_blocks(&application, &root_id, second.next, 2);
    assert_eq!(last.blocks.len(), 1);
    assert_eq!(last.blocks[0].ordinal, 4);
    assert_eq!(last.next, None);

    // 行视图：id 是 36 字节的 uuid，chars 数字符不数字节。
    let row = &first.blocks[0];
    assert_eq!(row.id.len(), 36);
    assert_eq!(row.chars, 2);
}

#[test]
fn read_blocks_on_a_document_that_is_not_open_is_a_named_refusal() {
    let data = scratch("blocks-closed-data");
    let root = scratch("blocks-closed-root");
    fs::write(
        root.join("章.md"),
        "一。
",
    )
    .unwrap();
    let platform = ChosenPaths::new([Some(root.clone())]);
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

    // 没打开就列块：具名拒绝，而不是拿磁盘字节顶替——那份可能已被别处改过。
    let error = application
        .project(
            &platform,
            ProjectInput::ReadBlocks {
                root_id: project.root_id,
                path: "章.md".to_string(),
                after: None,
                count: 10,
            },
        )
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("not open"),
        "the refusal names the closed document: {error}"
    );
}

#[test]
fn read_blocks_peek_never_cuts_a_character_in_half() {
    // 70 个汉字：前 60 个字符的 peek 若按字节切会切在半个字上（一个汉字
    // 三个字节），那一刀在 UTF-8 里甚至不是合法切片。
    let paragraph = "剑".repeat(70);
    let (_data, application, root_id) = open_chapter(
        "blocks-peek",
        &format!(
            "{paragraph}
"
        ),
    );

    let page = read_blocks(&application, &root_id, None, 10);
    assert_eq!(page.blocks.len(), 1);
    let row = &page.blocks[0];
    assert_eq!(row.peek.chars().count(), 60);
    assert_eq!(row.peek, "剑".repeat(60));
    assert_eq!(row.chars, 70);
    // 块种类线名：与索引库同一个词，散文块是 paragraph。
    assert_eq!(row.kind, "paragraph");
}

// ---------- 2.2 资料分区：ReadMaterials（派发台的资料勾选行） ----------

/// 起一个 adopt 了 root 的应用，root 里只有一篇正文。
fn adopt_chapter(label: &str) -> (Application, String, PathBuf) {
    let data = scratch(label);
    let root = scratch(label);
    fs::write(
        root.join("章.md"),
        "一。
",
    )
    .unwrap();
    let platform = ChosenPaths::new([Some(root.clone())]);
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
    (application, project.root_id, root)
}

#[test]
fn read_materials_lists_only_materials_with_their_disclosure() {
    let (application, root_id, _root) = adopt_chapter("materials-listed");
    // 两份项目外的来源文件，各导入成一份资料。资料来源是 HTML——
    // markdown 是正文不是资料，`prepare_material_source` 具名拒绝。
    let sources = scratch("materials-sources");
    let source_a = sources.join("人物志.html");
    let source_b = sources.join("年表.html");
    fs::write(
        &source_a,
        "<!doctype html><html><body><p>陆沉舟。</p></body></html>\n",
    )
    .unwrap();
    fs::write(
        &source_b,
        "<!doctype html><html><body><p>元年。</p></body></html>\n",
    )
    .unwrap();
    let mut paths = Vec::new();
    for source in [source_a, source_b] {
        let platform = ChosenPaths::new([Some(source)]);
        let ProjectOutput::Imported(row) = application
            .project(
                &platform,
                ProjectInput::ChooseAndImportMaterial {
                    root_id: root_id.clone(),
                },
            )
            .unwrap()
        else {
            panic!("material import must return the imported row");
        };
        assert_eq!(row.role, DocumentRole::Material);
        paths.push(row.path);
    }
    // 给其中一份设档位：名录带着它过河。
    application
        .project(
            &ChosenPaths::new([]),
            ProjectInput::SetDisclosure {
                root_id: root_id.clone(),
                path: paths[0].clone(),
                disclosure: Disclosure::OutlineOnly,
            },
        )
        .unwrap();

    let ProjectOutput::Materials(listing) = application
        .project(
            &ChosenPaths::new([]),
            ProjectInput::ReadMaterials {
                root_id: root_id.clone(),
            },
        )
        .unwrap()
    else {
        panic!("readMaterials must return the materials listing");
    };
    // 只有资料两行：正文不在内；截断旗没立。
    assert_eq!(listing.materials.len(), 2);
    assert!(!listing.truncated);
    assert!(listing.materials.iter().all(|row| row.path != "章.md"));
    let first = &listing.materials[0];
    assert_eq!(first.path, paths[0]);
    assert_eq!(first.disclosure.as_deref(), Some("outline-only"));
    // 没设过档位的另一份是 null：默认档的读法归界面。
    assert_eq!(listing.materials[1].path, paths[1]);
    assert_eq!(listing.materials[1].disclosure, None);
}

#[test]
fn read_materials_on_a_project_without_materials_is_an_empty_list() {
    let (application, root_id, _root) = adopt_chapter("materials-empty");
    let ProjectOutput::Materials(listing) = application
        .project(
            &ChosenPaths::new([]),
            ProjectInput::ReadMaterials { root_id },
        )
        .unwrap()
    else {
        panic!("readMaterials must return the materials listing");
    };
    // 空名录是空表，不是错误。
    assert!(listing.materials.is_empty());
    assert!(!listing.truncated);
}
