use refrain_core::{
    EditorAction, EditorChange, Insertion, Lineage, Manuscript, Replacement, SourceSnapshot,
    TextCommand, TextRefusal,
};

fn open(source: &[u8]) -> Manuscript {
    let source = SourceSnapshot::read(source.to_vec());
    let lineage = Lineage::fresh(source.block_count());
    Manuscript::open(source, lineage).unwrap()
}

#[test]
fn duplicate_lineage_ids_are_rejected_before_a_head_exists() {
    let source = SourceSnapshot::read(b"one\n\ntwo".to_vec());
    let repeated = refrain_core::Id::new();

    assert!(matches!(
        Manuscript::open(source, Lineage::from_ids(vec![repeated, repeated])),
        Err(TextRefusal::DuplicateLineage { block }) if block == repeated
    ));
}

#[test]
fn unreadable_bytes_are_refused_before_a_manuscript_exists() {
    // UTF-8 is settled when the snapshot is read, so a manuscript never holds
    // bytes it cannot read. The author hears about the file they opened rather
    // than about lineage they never see — and every later read is a slice with
    // nothing left to check.
    //
    // Bytes 4..6 are the first two bytes of a three-byte character.
    let mut bytes = b"ab\n\n".to_vec();
    bytes.extend_from_slice(&"序".as_bytes()[..2]);

    assert!(SourceSnapshot::read_checked(bytes).is_err());
}

#[test]
fn a_duplicate_id_is_reported_when_every_block_reads() {
    // The other side of the order above: with nothing wrong in the bytes, the
    // duplicate is found and named.
    let source = SourceSnapshot::read(b"one\n\ntwo".to_vec());
    let repeated = refrain_core::Id::new();

    assert!(matches!(
        Manuscript::open(source, Lineage::from_ids(vec![repeated, repeated])),
        Err(TextRefusal::DuplicateLineage { block }) if block == repeated
    ));
}

#[test]
fn insertion_members_must_each_be_one_rust_source_block() {
    for (text, blocks) in [("", 0), (" \n\t", 0), ("one\n\ntwo", 2)] {
        assert!(matches!(
            Insertion::new(None, vec![text.to_owned()]),
            Err(TextRefusal::InvalidInsertionBlock {
                index: 0,
                blocks: actual,
            }) if actual == blocks
        ));
    }
    assert!(matches!(
        Insertion::new(None, vec!["\nN\n".to_owned()]),
        Err(TextRefusal::InsertionBlockHasGaps { index: 0 })
    ));
}

#[test]
fn opening_and_materialising_preserves_every_source_byte() {
    for source in [
        b"\xEF\xBB\xBF\xe7\x94\xb2\xe3\x80\x82\r\n\r\n\xe4\xb9\x99\xe3\x80\x82\r\n".as_slice(),
        b"\n\n   \n\n".as_slice(),
        b"```ts\nlet x = 1;\n\nlet y = 2;\n```\n".as_slice(),
    ] {
        let manuscript = open(source);
        assert_eq!(manuscript.materialize().unwrap(), source);
    }
}

#[test]
fn the_same_lineage_keeps_block_ids_across_a_reload_but_heads_are_fresh() {
    let source = SourceSnapshot::read(b"one\n\ntwo\n".to_vec());
    let lineage = Lineage::fresh(source.block_count());
    let first = Manuscript::open(source.clone(), lineage.clone()).unwrap();
    let second = Manuscript::open(source, lineage).unwrap();

    assert_eq!(first.head().block_ids(), second.head().block_ids());
    assert_ne!(first.head().id(), second.head().id());
}

#[test]
fn replacing_a_range_preserves_positional_ids_and_untouched_source_bytes() {
    let source =
        b"\n\xe7\x94\xb2\xe3\x80\x82\n\n\n\xe4\xb9\x99\xe3\x80\x82\n\n\xe4\xb8\x99\xe3\x80\x82\n";
    let mut manuscript = open(source);
    let before = manuscript.head().clone();
    let ids = before.block_ids();
    let replacement =
        Replacement::new(ids[..2].to_vec(), Some("乙改。\n\n甲改。".to_owned())).unwrap();
    let command = TextCommand::Editor(EditorAction::new(
        before.id(),
        vec![EditorChange::Replace(replacement)],
        "shuffled cross-block replacement",
    ));

    let transition = manuscript.execute(command).unwrap();
    assert_eq!(before.text(), "甲。\n\n乙。\n\n丙。");
    assert_eq!(transition.head().text(), "乙改。\n\n甲改。\n\n丙。");
    assert_eq!(transition.head().block_ids(), ids);
    assert_eq!(manuscript.materialize().unwrap(), b"\n\xe4\xb9\x99\xe6\x94\xb9\xe3\x80\x82\n\n\n\xe7\x94\xb2\xe6\x94\xb9\xe3\x80\x82\n\n\xe4\xb8\x99\xe3\x80\x82\n");
    assert_eq!(
        transition.byte_patch().apply(source).unwrap(),
        manuscript.materialize().unwrap()
    );
}

#[test]
fn replacing_a_block_with_identical_text_is_not_a_text_action() {
    let mut manuscript = open(b"one\n\ntwo");
    let before = manuscript.head().clone();
    let block = before.block_ids()[1];

    assert!(matches!(
        manuscript.execute(TextCommand::Editor(EditorAction::new(
            before.id(),
            vec![EditorChange::Replace(
                Replacement::new(vec![block], Some("two".to_owned())).unwrap(),
            )],
            "no-op",
        ))),
        Err(TextRefusal::NothingChanged)
    ));
    assert_eq!(manuscript.head(), &before);
}

#[test]
fn overlapping_replacements_refuse_the_whole_editor_action() {
    let mut manuscript = open(b"one\n\ntwo\n\nthree\n");
    let before = manuscript.head().clone();
    let ids = before.block_ids();
    let action = EditorAction::new(
        before.id(),
        vec![
            EditorChange::Replace(
                Replacement::new(ids[..2].to_vec(), Some("first".to_owned())).unwrap(),
            ),
            EditorChange::Replace(
                Replacement::new(ids[1..].to_vec(), Some("second".to_owned())).unwrap(),
            ),
        ],
        "overlap",
    );

    assert!(matches!(
        manuscript.execute(TextCommand::Editor(action)),
        Err(TextRefusal::OverlappingChanges { block }) if block == ids[1]
    ));
    assert_eq!(manuscript.head(), &before);
}

#[test]
fn a_stale_editor_action_cannot_move_the_current_head() {
    let mut manuscript = open(b"one\n\ntwo\n");
    let before = manuscript.head().clone();
    let id = before.block_ids()[0];
    let action = EditorAction::new(
        refrain_core::Id::new(),
        vec![EditorChange::Replace(
            Replacement::new(vec![id], Some("changed".to_owned())).unwrap(),
        )],
        "stale",
    );

    assert!(matches!(
        manuscript.execute(TextCommand::Editor(action)),
        Err(TextRefusal::StaleBase { .. })
    ));
    assert_eq!(manuscript.head(), &before);
}

#[test]
fn an_insertion_group_is_ordered_and_minted_only_by_rust() {
    let mut manuscript = open(b"first\n\nlast\n");
    let base = manuscript.head().id();
    let original = manuscript.head().block_ids();
    let first = original[0];
    let last = original[1];
    let insertion =
        Insertion::new(Some(last), vec!["second".to_owned(), "third".to_owned()]).unwrap();

    let transition = manuscript
        .execute(TextCommand::Editor(EditorAction::new(
            base,
            vec![EditorChange::Insert(insertion)],
            "insert two",
        )))
        .unwrap();

    assert_eq!(transition.head().text(), "first\n\nsecond\n\nthird\n\nlast");
    let ids = transition.head().block_ids();
    assert_eq!(ids.len(), 4);
    assert_eq!(ids[0], first);
    assert_eq!(ids[3], last);
    assert!(ids[1].as_uuid().get_version_num() == 7 && ids[2].as_uuid().get_version_num() == 7);
}

#[test]
fn inserting_before_the_old_first_block_preserves_the_prefix_and_old_gap() {
    let source = b"\nA\n\n\nB\n";
    let mut manuscript = open(source);
    let first = manuscript.head().block_ids()[0];

    manuscript
        .execute(TextCommand::Editor(EditorAction::new(
            manuscript.head().id(),
            vec![EditorChange::Insert(
                Insertion::new(Some(first), vec!["N".to_owned()]).unwrap(),
            )],
            "insert before first",
        )))
        .unwrap();

    assert_eq!(manuscript.materialize().unwrap(), b"\nN\n\nA\n\n\nB\n");
}

#[test]
fn a_missing_insertion_boundary_fails_closed() {
    let mut manuscript = open(b"one\n");
    let before = manuscript.head().clone();
    let insertion = Insertion::new(Some(refrain_core::Id::new()), vec!["lost".to_owned()]).unwrap();

    assert!(matches!(
        manuscript.execute(TextCommand::Editor(EditorAction::new(
            before.id(),
            vec![EditorChange::Insert(insertion)],
            "missing boundary",
        ))),
        Err(TextRefusal::MissingBoundary { .. })
    ));
    assert_eq!(manuscript.head(), &before);
}

#[test]
fn many_interleaved_insertions_are_linear_in_blocks_plus_changes() {
    let source = (0..20_000)
        .map(|index| format!("block {index}"))
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut manuscript = open(source.as_bytes());
    let before = manuscript.head().clone();
    let changes = before
        .block_ids()
        .into_iter()
        .enumerate()
        .map(|(index, boundary)| {
            EditorChange::Insert(
                Insertion::new(Some(boundary), vec![format!("insert {index}")]).unwrap(),
            )
        })
        .collect();

    let started = std::time::Instant::now();
    let transition = manuscript
        .execute(TextCommand::Editor(EditorAction::new(
            before.id(),
            changes,
            "interleaved",
        )))
        .unwrap();

    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    assert_eq!(transition.head().blocks().len(), 40_000);
    assert_eq!(transition.head().blocks()[0].text(), "insert 0");
    assert_eq!(transition.head().blocks()[1].text(), "block 0");
}
