// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 原生编辑的历史：保存那一刻动作链 reconcile 进 text_actions。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use refrain_app::native_document::{DocumentInput, DocumentOpen, DocumentSurface};
use refrain_app::{Application, ProjectImport, ProjectInput, ProjectOutput, ProjectPlatform};
use refrain_store::root::RootKind;

const CHAPTER: &str = "正文.md";

static SEQUENCE: AtomicU32 = AtomicU32::new(0);

fn scratch(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "refrain-native-history-{label}-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed),
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

struct Chosen(PathBuf);

impl ProjectPlatform for Chosen {
    fn choose_root(&self, _kind: RootKind) -> Result<Option<PathBuf>, refrain_core::RefrainError> {
        Ok(Some(self.0.clone()))
    }

    fn choose_project_parent(&self) -> Result<Option<PathBuf>, refrain_core::RefrainError> {
        self.choose_root(RootKind::Folder)
    }

    fn choose_import(
        &self,
        _kind: ProjectImport,
    ) -> Result<Option<PathBuf>, refrain_core::RefrainError> {
        self.choose_root(RootKind::Folder)
    }
}

fn adopt(data: &Path, root: &Path) -> (Application, String) {
    fs::write(root.join(CHAPTER), "原稿。\n").unwrap();
    let application = Application::open(data).unwrap();
    let ProjectOutput::Opened(opened) = application
        .project(
            &Chosen(root.to_path_buf()),
            ProjectInput::ChooseAndAdoptRoot {
                kind: RootKind::Folder,
            },
        )
        .unwrap()
    else {
        panic!("adoption must open the project");
    };
    (application, opened.root_id)
}

fn history_of(application: &Application, root_id: &str) -> Vec<refrain_app::history::HistoryEntry> {
    let ProjectOutput::History(history) = application
        .project(
            &Chosen(PathBuf::new()),
            ProjectInput::ReadHistory {
                root_id: root_id.to_owned(),
                path: CHAPTER.to_owned(),
            },
        )
        .unwrap()
    else {
        panic!("read history must return entries");
    };
    history
}

fn native_save(root: &Path, text: &str) {
    let path = root.join(CHAPTER);
    let state_path = path.with_extension("refrain-state.json");
    let mut surface = DocumentSurface::open(DocumentOpen::Persistent { path, state_path }).unwrap();
    surface
        .apply(DocumentInput::InsertText(text.to_owned()))
        .unwrap();
    surface.apply(DocumentInput::Save).unwrap();
}

#[test]
fn a_native_edit_enters_history_at_save_time_not_before() {
    let data = scratch("data");
    let root = scratch("root");
    let (application, root_id) = adopt(&data, &root);

    // near-miss：编辑落盘之前，历史里什么都没有——证明是同步写进来的，
    // 而不是打开或 adopt 顺手写的。
    native_save(&root, "第一笔。");
    let before = history_of(&application, &root_id);
    assert!(
        before.is_empty(),
        "before NativeSaved the table stays empty"
    );

    let ProjectOutput::History(history) = application
        .project(
            &Chosen(PathBuf::new()),
            ProjectInput::NativeSaved {
                root_id: root_id.clone(),
                path: CHAPTER.to_owned(),
            },
        )
        .unwrap()
    else {
        panic!("native saved must return the refreshed history");
    };
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].cause, "native text input");
    assert!(!history[0].undone);

    // 第二次保存只补新动作：已记录的行不重复。
    native_save(&root, "第二笔。");
    let history = history_of(&application, &root_id);
    assert_eq!(
        history.len(),
        1,
        "still un synced before the second NativeSaved"
    );

    application
        .project(
            &Chosen(PathBuf::new()),
            ProjectInput::NativeSaved {
                root_id: root_id.clone(),
                path: CHAPTER.to_owned(),
            },
        )
        .unwrap();
    let history = history_of(&application, &root_id);
    assert_eq!(history.len(), 2, "the second save adds exactly one row");
    assert!(history.iter().all(|entry| !entry.undone));

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_undone_native_edit_is_marked_at_the_next_save() {
    let data = scratch("undo-data");
    let root = scratch("undo-root");
    let (application, root_id) = adopt(&data, &root);

    native_save(&root, "第一笔。");
    application
        .project(
            &Chosen(PathBuf::new()),
            ProjectInput::NativeSaved {
                root_id: root_id.clone(),
                path: CHAPTER.to_owned(),
            },
        )
        .unwrap();

    // 撤销第二笔再保存：同步把那一行标成已撤销，而不是删掉。
    let path = root.join(CHAPTER);
    let state_path = path.with_extension("refrain-state.json");
    let mut surface = DocumentSurface::open(DocumentOpen::Persistent { path, state_path }).unwrap();
    surface
        .apply(DocumentInput::InsertText("第二笔。".to_owned()))
        .unwrap();
    surface.apply(DocumentInput::Save).unwrap();
    application
        .project(
            &Chosen(PathBuf::new()),
            ProjectInput::NativeSaved {
                root_id: root_id.clone(),
                path: CHAPTER.to_owned(),
            },
        )
        .unwrap();

    let mut surface = DocumentSurface::open(DocumentOpen::Persistent {
        path: root.join(CHAPTER),
        state_path: root.join(CHAPTER).with_extension("refrain-state.json"),
    })
    .unwrap();
    surface.apply(DocumentInput::Undo).unwrap();
    surface.apply(DocumentInput::Save).unwrap();
    application
        .project(
            &Chosen(PathBuf::new()),
            ProjectInput::NativeSaved {
                root_id: root_id.clone(),
                path: CHAPTER.to_owned(),
            },
        )
        .unwrap();

    let history = history_of(&application, &root_id);
    assert_eq!(history.len(), 2, "an undone row stays in the ledger");
    assert_eq!(history.iter().filter(|entry| entry.undone).count(), 1);

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(root).unwrap();
}
