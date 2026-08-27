// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use refrain_core::{
    EditKind, EditorAction, EditorChange, Insertion, Lineage, Manuscript, Replacement,
    SourceSnapshot, TextCommand,
};

fn open() -> Manuscript {
    let source = SourceSnapshot::read(b"one\n\ntwo\n\nthree".to_vec());
    let lineage = Lineage::fresh(source.block_count());
    Manuscript::open(source, lineage).unwrap()
}

#[test]
fn each_text_action_carries_addressable_replace_insert_and_remove_edits() {
    let mut manuscript = open();
    let ids = manuscript.head().block_ids();

    let replaced = manuscript
        .execute(TextCommand::Editor(EditorAction::new(
            manuscript.head().id(),
            vec![EditorChange::Replace(
                Replacement::new(vec![ids[1]], Some("TWO".to_owned())).unwrap(),
            )],
            "replace",
        )))
        .unwrap();
    assert_eq!(replaced.action().edits().len(), 1);
    assert_eq!(replaced.action().edits()[0].kind(), EditKind::Replace);
    assert_eq!(replaced.action().edits()[0].block(), ids[1]);
    assert_eq!(replaced.action().edits()[0].before(), Some("two"));
    assert_eq!(replaced.action().edits()[0].after(), Some("TWO"));

    let inserted = manuscript
        .execute(TextCommand::Editor(EditorAction::new(
            manuscript.head().id(),
            vec![EditorChange::Insert(
                Insertion::new(
                    Some(ids[2]),
                    vec!["between".to_owned()],
                    refrain_core::BlockScan::Markdown,
                )
                .unwrap(),
            )],
            "insert",
        )))
        .unwrap();
    assert_eq!(inserted.action().edits().len(), 1);
    assert_eq!(inserted.action().edits()[0].kind(), EditKind::Insert);
    assert_eq!(inserted.action().edits()[0].before(), None);
    assert_eq!(inserted.action().edits()[0].after(), Some("between"));

    let removed = manuscript
        .execute(TextCommand::Editor(EditorAction::new(
            manuscript.head().id(),
            vec![EditorChange::Replace(
                Replacement::new(vec![ids[1]], None).unwrap(),
            )],
            "remove",
        )))
        .unwrap();
    assert_eq!(removed.action().edits().len(), 1);
    assert_eq!(removed.action().edits()[0].kind(), EditKind::Remove);
    assert_eq!(removed.action().edits()[0].before(), Some("TWO"));
    assert_eq!(removed.action().edits()[0].after(), None);
}

#[test]
fn action_edits_follow_document_order_across_change_kinds() {
    let mut manuscript = open();
    let ids = manuscript.head().block_ids();

    let transition = manuscript
        .execute(TextCommand::Editor(EditorAction::new(
            manuscript.head().id(),
            vec![
                EditorChange::Replace(
                    Replacement::new(vec![ids[2]], Some("THREE".to_owned())).unwrap(),
                ),
                EditorChange::Insert(
                    Insertion::new(
                        Some(ids[0]),
                        vec!["before".to_owned()],
                        refrain_core::BlockScan::Markdown,
                    )
                    .unwrap(),
                ),
            ],
            "ordered edits",
        )))
        .unwrap();

    assert_eq!(
        transition
            .action()
            .edits()
            .iter()
            .map(|edit| edit.kind())
            .collect::<Vec<_>>(),
        [EditKind::Insert, EditKind::Replace]
    );
}
