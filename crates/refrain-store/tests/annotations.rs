// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use refrain_store::annotations::{AnnotationKind, AnnotationRow};
use refrain_store::project::{ProjectStore, RootLocator};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};

fn scratch() -> (std::path::PathBuf, rusqlite::Connection, ProjectStore) {
    let dir = std::env::temp_dir().join(format!("refrain-annotations-{}", refrain_core::Id::new()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut app = refrain_store::schema::open_in_memory().unwrap();
    AppDb::migrate(&mut app).unwrap();
    let (store, _) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: dir.clone(),
            kind: RootKind::Folder,
        },
    )
    .unwrap();
    (dir, app, store)
}

fn comment() -> AnnotationRow {
    AnnotationRow {
        id: "annotation-1".into(),
        document: "chapter.md".into(),
        block_id: "block-a".into(),
        start: 2,
        end: 5,
        quote: "原文".into(),
        kind: AnnotationKind::Comment,
        body: Some("这里需要证据".into()),
        created_at: 100,
        updated_at: 100,
    }
}

#[test]
fn annotations_round_trip_across_project_reopen() {
    let (dir, mut app, mut store) = scratch();
    store.annotation_upsert(&comment()).unwrap();
    drop(store);

    let (mut reopened, _) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: dir.clone(),
            kind: RootKind::Folder,
        },
    )
    .unwrap();
    assert_eq!(reopened.annotations("chapter.md").unwrap(), vec![comment()]);

    let mut moved = comment();
    moved.start = 8;
    moved.end = 10;
    moved.quote = "新锚".into();
    moved.updated_at = 200;
    reopened.annotation_upsert(&moved).unwrap();
    assert_eq!(reopened.annotations("chapter.md").unwrap(), vec![moved]);

    assert!(reopened.annotation_delete("annotation-1").unwrap());
    assert!(!reopened.annotation_delete("annotation-1").unwrap());
    assert!(reopened.annotations("chapter.md").unwrap().is_empty());
    drop(reopened);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_annotation_id_cannot_move_between_documents() {
    let (dir, _app, mut store) = scratch();
    let original = comment();
    store.annotation_upsert(&original).unwrap();

    let mut stolen = original.clone();
    stolen.document = "other.md".into();
    stolen.block_id = "block-z".into();
    stolen.updated_at = 200;
    let error = store.annotation_upsert(&stolen).unwrap_err();

    assert!(error.to_string().contains("another document"));
    assert_eq!(store.annotations("chapter.md").unwrap(), vec![original]);
    assert!(store.annotations("other.md").unwrap().is_empty());
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn highlights_and_comments_are_distinct_persisted_kinds() {
    let (dir, _app, mut store) = scratch();
    let mut highlight = comment();
    highlight.id = "highlight-1".into();
    highlight.kind = AnnotationKind::Highlight;
    highlight.body = None;
    store.annotation_upsert(&highlight).unwrap();
    store.annotation_upsert(&comment()).unwrap();

    let rows = store.annotations("chapter.md").unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].kind, AnnotationKind::Highlight);
    assert_eq!(rows[1].kind, AnnotationKind::Comment);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}
