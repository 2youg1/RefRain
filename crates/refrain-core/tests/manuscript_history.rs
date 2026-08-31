// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! The persisted undo history: revert to a chosen action, and hydration of
//! the undo stack at open. The failure each test names: a revert that stops
//! halfway across a ledger fact, or an author told their work is gone because
//! the window closed.

use refrain_core::{
    DecisionBatch, EditScope, EditorAction, EditorChange, Id, Lineage, Manuscript, PersistedRegion,
    Proposal, Replacement, SourceSnapshot, TextAction, TextCommand, TextRefusal, Verdict,
    VerdictKind,
};

fn open(source: &str) -> Manuscript {
    let source = SourceSnapshot::read(source.as_bytes().to_vec());
    let lineage = Lineage::fresh(source.block_count());
    Manuscript::open(source, lineage).unwrap()
}

fn type_over(manuscript: &mut Manuscript, block: Id, text: &str) -> Id {
    manuscript
        .execute(TextCommand::Editor(EditorAction::new(
            manuscript.head().id(),
            vec![EditorChange::Replace(
                Replacement::new(vec![block], Some(text.to_owned())).unwrap(),
            )],
            "author edit",
        )))
        .unwrap()
        .action()
        .id()
}

fn verdict_carrying_commit(manuscript: &mut Manuscript, block: Id, after: &str) -> Id {
    let before = manuscript
        .head()
        .blocks()
        .iter()
        .find(|candidate| candidate.id() == block)
        .unwrap()
        .text()
        .to_owned();
    let proposal = Proposal::new(
        Id::new(),
        manuscript.head().id(),
        EditScope::new(vec![block]).unwrap(),
        before,
        Some(after.to_owned()),
    );
    let verdicts: Vec<Verdict> = proposal
        .slices()
        .iter()
        .filter(|slice| slice.kind().is_changed())
        .map(|slice| Verdict::new(&proposal, slice.id(), VerdictKind::Accept, None).unwrap())
        .collect();
    manuscript
        .execute(TextCommand::CommitDecisionBatch(DecisionBatch::new(
            manuscript.head().id(),
            vec![proposal],
            verdicts,
        )))
        .unwrap()
        .action()
        .id()
}

#[test]
fn reverting_to_a_middle_point_undoes_everything_above_it() {
    let mut manuscript = open("one\n\ntwo\n\nthree");
    let blocks = manuscript.head().block_ids();
    let first = type_over(&mut manuscript, blocks[0], "ONE");
    let second = type_over(&mut manuscript, blocks[1], "TWO");
    let third = type_over(&mut manuscript, blocks[2], "THREE");
    assert_eq!(manuscript.head().text(), "ONE\n\nTWO\n\nTHREE");

    let undone = manuscript.revert_to(first).unwrap();

    // Two actions sat above the target; the newest comes back first. The
    // target itself stays applied — the revert lands just after it.
    assert_eq!(undone.len(), 2);
    assert_eq!(manuscript.actions().len(), 1);
    assert_eq!(manuscript.actions()[0].id(), first);
    assert_eq!(manuscript.head().text(), "ONE\n\ntwo\n\nthree");
    assert_eq!(
        manuscript.materialize().unwrap(),
        b"ONE\n\ntwo\n\nthree".to_vec()
    );

    // The undone ids left the stack: reverting to one now refuses as unknown.
    for popped in [second, third] {
        assert!(matches!(
            manuscript.revert_to(popped),
            Err(TextRefusal::UnknownAction { action }) if action == popped
        ));
    }
}

#[test]
fn reverting_to_the_tip_is_an_empty_walk() {
    let mut manuscript = open("one");
    let blocks = manuscript.head().block_ids();
    let only = type_over(&mut manuscript, blocks[0], "ONE");
    let head = manuscript.head().clone();

    let undone = manuscript.revert_to(only).unwrap();

    assert!(undone.is_empty());
    assert_eq!(manuscript.head(), &head);
}

#[test]
fn reverting_to_an_unknown_action_is_a_typed_refusal() {
    let mut manuscript = open("one");
    let unknown = Id::new();

    assert!(matches!(
        manuscript.revert_to(unknown),
        Err(TextRefusal::UnknownAction { action }) if action == unknown
    ));
}

#[test]
fn a_revert_cannot_cross_a_verdict_carrying_action() {
    let mut manuscript = open("one\n\ntwo");
    let blocks = manuscript.head().block_ids();
    let first = type_over(&mut manuscript, blocks[0], "ONE");
    let ledger_fact = verdict_carrying_commit(&mut manuscript, blocks[1], "TWO");
    let head = manuscript.head().clone();

    // Reverting to `first` would have to undo the ledger fact above it.
    assert!(matches!(
        manuscript.revert_to(first),
        Err(TextRefusal::NotInvertible { action }) if action == ledger_fact
    ));
    // The refusal moved nothing: not half a revert, not one undone action.
    assert_eq!(manuscript.head(), &head);
    assert_eq!(manuscript.actions().len(), 2);

    // The ledger fact itself is a valid target: it stays, nothing above it.
    assert!(manuscript.revert_to(ledger_fact).unwrap().is_empty());
    assert_eq!(manuscript.head(), &head);
}

/// The restart promise: rows written at execute, read back at open, and
/// `undo_last` walks them as if the window had never closed.
#[test]
fn a_reopened_manuscript_undoes_hydrated_actions_byte_for_byte() {
    let mut manuscript = open("one\n\ntwo");
    let blocks = manuscript.head().block_ids();
    type_over(&mut manuscript, blocks[0], "ONE");
    type_over(&mut manuscript, blocks[1], "TWO");

    // What a save persists: bytes, head, lineage. What the history rows
    // persist: every action, through its JSON form.
    let saved = manuscript.materialize().unwrap();
    let head = manuscript.head().id();
    let lineage = manuscript.lineage_ids();
    let history: Vec<TextAction> = manuscript
        .actions()
        .iter()
        .map(|action| {
            let regions = serde_json::to_string(&action.persisted_regions()).unwrap();
            let verdicts = serde_json::to_string(action.verdicts()).unwrap();
            TextAction::from_persisted(
                action.id(),
                action.base(),
                action.cause().to_owned(),
                serde_json::from_str::<Vec<PersistedRegion>>(&regions).unwrap(),
                serde_json::from_str(&verdicts).unwrap(),
            )
        })
        .collect();
    drop(manuscript);

    let snapshot = SourceSnapshot::read(saved);
    let mut reopened =
        Manuscript::open_at(snapshot, Lineage::from_ids(lineage), head, history).unwrap();
    assert_eq!(reopened.actions().len(), 2);

    let undone = reopened.undo_last().unwrap();
    assert_eq!(undone.head().text(), "ONE\n\ntwo");
    let undone = reopened.undo_last().unwrap();
    assert_eq!(undone.head().text(), "one\n\ntwo");
    assert_eq!(
        reopened.materialize().unwrap(),
        b"one\n\ntwo".to_vec(),
        "undo across a restart must restore the exact bytes"
    );
    assert!(matches!(
        reopened.undo_last(),
        Err(TextRefusal::NothingToUndo)
    ));
}
