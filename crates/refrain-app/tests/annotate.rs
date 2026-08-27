// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 批注：在选中的一段正文上留高亮或评论。
//!
//! 定位与派发同源（`locate_scope`），所以这里问的是那条路在批注上的
//! 特有性质：高亮与评论只差一个正文，重复出现的原文不替作者选，
//! 而被标记的原文要存下来——作者改过那一段之后，批注仍要说得出它
//! 当初标的是什么。

use std::fs;
use std::path::{Path, PathBuf};

use refrain_app::history::{annotate, annotations_of};
use refrain_core::{Id, Lineage, Manuscript, SourceSnapshot};
use refrain_store::project::{ProjectStore, RootLocator};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;

const CHAPTER: &str = "章一.md";
const FIRST: &str = "剑一直握在他手里。";
const SECOND: &str = "他没有说话。";

fn scratch(body: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("refrain-annotate-{}", Id::new()));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join(CHAPTER), body).unwrap();
    root
}

fn store_at(root: &Path) -> (Connection, ProjectStore) {
    let mut app = Connection::open_in_memory().unwrap();
    AppDb::migrate(&mut app).unwrap();
    let (store, _) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: root.to_path_buf(),
            kind: RootKind::Folder,
        },
    )
    .unwrap();
    (app, store)
}

fn manuscript_of(root: &Path) -> Manuscript {
    let bytes = fs::read(root.join(CHAPTER)).unwrap();
    let snapshot = SourceSnapshot::read(bytes);
    let lineage = Lineage::fresh(snapshot.block_count());
    Manuscript::open(snapshot, lineage).unwrap()
}

#[test]
fn a_comment_and_a_highlight_differ_by_exactly_one_thing() {
    // 有正文是评论，没有是高亮。用别的判据（比如「长度大于零」）会把
    // 一条正文为空的评论画成高亮，而作者写下它时是想说点什么的。
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    let (_app, mut store) = store_at(&root);
    let manuscript = manuscript_of(&root);

    annotate(&mut store, &manuscript, CHAPTER, FIRST, None, 1).unwrap();
    annotate(
        &mut store,
        &manuscript,
        CHAPTER,
        SECOND,
        Some("这里太满了".to_string()),
        2,
    )
    .unwrap();

    let rows = annotations_of(&store, CHAPTER).unwrap();
    assert_eq!(rows.len(), 2);
    let highlight = rows.iter().find(|row| !row.comment).unwrap();
    let comment = rows.iter().find(|row| row.comment).unwrap();
    assert!(highlight.body.is_empty());
    assert_eq!(comment.body, "这里太满了");
}

#[test]
fn the_quoted_text_is_stored_so_it_survives_the_author_editing_it() {
    // 作者改过那一段之后，原文就取不到了。不存下来，界面上剩下的是一条
    // 没有上下文的评论——作者读不出自己当初在说什么。
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    let (_app, mut store) = store_at(&root);
    let manuscript = manuscript_of(&root);
    annotate(
        &mut store,
        &manuscript,
        CHAPTER,
        FIRST,
        Some("这句可以更短".to_string()),
        1,
    )
    .unwrap();

    let rows = annotations_of(&store, CHAPTER).unwrap();
    assert_eq!(rows[0].quote, FIRST, "the quoted text was not preserved");
    assert!(!rows[0].block_id.is_empty(), "the anchor has no block");
}

#[test]
fn text_that_appears_twice_is_not_annotated_on_the_author_s_behalf() {
    // 近失手：默认第一处会把批注落在另一段上，而两段逐字相同——作者
    // 要过很久才会发现，因为那条批注看起来完全正常。
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n\n{FIRST}\n"));
    let (_app, mut store) = store_at(&root);
    let manuscript = manuscript_of(&root);
    let error = annotate(&mut store, &manuscript, CHAPTER, FIRST, None, 1).unwrap_err();
    assert!(
        error.to_string().contains("more than once"),
        "unexpected refusal: {error}"
    );
    // 拒绝之后一条也不该留下：半途写入会让作者以为标上了。
    assert!(annotations_of(&store, CHAPTER).unwrap().is_empty());
}

#[test]
fn annotating_text_the_manuscript_does_not_have_is_refused() {
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    let (_app, mut store) = store_at(&root);
    let manuscript = manuscript_of(&root);
    let error = annotate(
        &mut store,
        &manuscript,
        CHAPTER,
        "这段稿子里没有。",
        None,
        1,
    )
    .unwrap_err();
    assert!(
        error.to_string().contains("not in this manuscript"),
        "unexpected refusal: {error}"
    );
}

#[test]
fn an_empty_selection_is_refused_rather_than_anchored_at_the_start() {
    // 极端：空选区。锚在开头会产生一条指着第一个字的批注，而作者
    // 什么也没选——他会以为自己误触了。
    let root = scratch(&format!("{FIRST}\n\n{SECOND}\n"));
    let (_app, mut store) = store_at(&root);
    let manuscript = manuscript_of(&root);
    for empty in ["", "   ", "\n"] {
        let error = annotate(&mut store, &manuscript, CHAPTER, empty, None, 1).unwrap_err();
        assert!(error.to_string().contains("select the text"), "{error}");
    }
    assert!(annotations_of(&store, CHAPTER).unwrap().is_empty());
}
