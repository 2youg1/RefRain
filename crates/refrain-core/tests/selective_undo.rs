use refrain_core::{
    EditorAction, EditorChange, Insertion, Lineage, Manuscript, Replacement, SourceSnapshot,
    TextCommand, TextRefusal,
};

fn open(source: &str) -> Manuscript {
    let source = SourceSnapshot::read(source.as_bytes().to_vec());
    let lineage = Lineage::fresh(source.block_count());
    Manuscript::open(source, lineage).unwrap()
}

fn replace(
    manuscript: &mut Manuscript,
    block: refrain_core::Id,
    text: Option<&str>,
) -> refrain_core::TextTransition {
    manuscript
        .execute(TextCommand::Editor(EditorAction::new(
            manuscript.head().id(),
            vec![EditorChange::Replace(
                Replacement::new(vec![block], text.map(str::to_owned)).unwrap(),
            )],
            "replace",
        )))
        .unwrap()
}

#[test]
fn undo_appends_a_compensation_and_keeps_disjoint_later_text() {
    let mut manuscript = open("one\n\ntwo");
    let ids = manuscript.head().block_ids();
    let first = replace(&mut manuscript, ids[0], Some("ONE"));
    replace(&mut manuscript, ids[1], Some("TWO"));
    let before_undo = manuscript.head().id();

    let undone = manuscript
        .execute(TextCommand::SelectiveUndo {
            action: first.action().id(),
        })
        .unwrap();

    assert_eq!(undone.head().text(), "one\n\nTWO");
    assert_ne!(undone.head().id(), before_undo);
    assert_eq!(
        undone.action().cause(),
        format!("selective-undo({})", first.action().id())
    );
}

#[test]
fn a_noop_delta_does_not_create_a_false_selective_undo_conflict() {
    let mut manuscript = open("one\n\ntwo");
    let ids = manuscript.head().block_ids();
    let mixed = manuscript
        .execute(TextCommand::Editor(EditorAction::new(
            manuscript.head().id(),
            vec![
                EditorChange::Replace(
                    Replacement::new(vec![ids[0]], Some("one".to_owned())).unwrap(),
                ),
                EditorChange::Insert(
                    Insertion::new(Some(ids[1]), vec!["middle".to_owned()]).unwrap(),
                ),
            ],
            "mixed",
        )))
        .unwrap();
    replace(&mut manuscript, ids[0], Some("ONE"));

    manuscript
        .execute(TextCommand::SelectiveUndo {
            action: mixed.action().id(),
        })
        .unwrap();

    assert_eq!(manuscript.head().text(), "ONE\n\ntwo");
}

#[test]
fn ten_thousand_disjoint_later_actions_do_not_make_lookup_linear_in_history() {
    let mut manuscript = open("target\n\nother");
    let ids = manuscript.head().block_ids();
    let target = replace(&mut manuscript, ids[0], Some("changed"));
    for index in 0..10_000 {
        replace(&mut manuscript, ids[1], Some(&format!("other {index}")));
    }

    let started = std::time::Instant::now();
    manuscript
        .execute(TextCommand::SelectiveUndo {
            action: target.action().id(),
        })
        .unwrap();

    assert!(started.elapsed() < std::time::Duration::from_millis(100));
    assert_eq!(manuscript.head().blocks()[0].text(), "target");
    assert_eq!(manuscript.head().blocks()[1].text(), "other 9999");
}

#[test]
fn an_intersection_refuses_with_the_three_texts_and_moves_nothing() {
    let mut manuscript = open("before\n\nother");
    let block = manuscript.head().block_ids()[0];
    let target = replace(&mut manuscript, block, Some("after"));
    replace(&mut manuscript, block, Some("current"));
    let unchanged = manuscript.head().clone();

    assert!(matches!(
        manuscript.execute(TextCommand::SelectiveUndo {
            action: target.action().id(),
        }),
        Err(TextRefusal::LaterActionIntersects {
            block: conflict,
            before,
            after,
            current,
        }) if conflict == block && before == "before" && after == "after" && current == "current"
    ));
    assert_eq!(manuscript.head(), &unchanged);
}

#[test]
fn undoing_a_deletion_restores_the_same_block_at_its_lineage_boundary() {
    let mut manuscript = open("one\n\ntwo\n\nthree");
    let ids = manuscript.head().block_ids();
    let deletion = replace(&mut manuscript, ids[1], None);
    assert_eq!(manuscript.head().text(), "one\n\nthree");

    manuscript
        .execute(TextCommand::SelectiveUndo {
            action: deletion.action().id(),
        })
        .unwrap();

    assert_eq!(manuscript.head().text(), "one\n\ntwo\n\nthree");
    assert_eq!(manuscript.head().block_ids(), ids);
}

#[test]
fn undoing_an_insertion_that_a_later_action_rewrote_is_refused() {
    let mut manuscript = open("one\n\nthree");
    let boundary = manuscript.head().block_ids()[1];
    let insertion = manuscript
        .execute(TextCommand::Editor(EditorAction::new(
            manuscript.head().id(),
            vec![EditorChange::Insert(
                Insertion::new(Some(boundary), vec!["two".to_owned()]).unwrap(),
            )],
            "insert",
        )))
        .unwrap();
    let inserted = manuscript.head().block_ids()[1];
    replace(&mut manuscript, inserted, Some("TWO"));

    assert!(matches!(
        manuscript.execute(TextCommand::SelectiveUndo {
            action: insertion.action().id(),
        }),
        Err(TextRefusal::LaterActionIntersects { block, .. }) if block == inserted
    ));
}

#[test]
fn undoing_the_compensation_restores_the_original_change() {
    let mut manuscript = open("before");
    let block = manuscript.head().block_ids()[0];
    let changed = replace(&mut manuscript, block, Some("after"));
    let compensation = manuscript
        .execute(TextCommand::SelectiveUndo {
            action: changed.action().id(),
        })
        .unwrap();
    assert_eq!(manuscript.head().text(), "before");

    manuscript
        .execute(TextCommand::SelectiveUndo {
            action: compensation.action().id(),
        })
        .unwrap();
    assert_eq!(manuscript.head().text(), "after");
}
