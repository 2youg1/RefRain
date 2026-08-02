//! Plain-text manuscripts: one block per line, nothing structural, and the
//! same byte discipline prose has — open, edit, undo, materialise.
//!
//! The failure each test names: the Markdown scanner reaching into code and
//! coming back with a different document — a fence swallowing a blank line, a
//! new line joined by a blank line, a `\r` counted as content.

use refrain_core::source_layout::BlockScan;
use refrain_core::{
    EditorAction, EditorChange, Insertion, Lineage, Manuscript, Replacement, SourceLayout,
    SourceSnapshot, TextCommand,
};

fn open_plain(source: &[u8]) -> Manuscript {
    let snapshot = SourceSnapshot::read_with(source.to_vec(), BlockScan::Plain);
    let lineage = Lineage::fresh(snapshot.block_count());
    Manuscript::open(snapshot, lineage).expect("manuscript opens")
}

/// The plain layout: lines are blocks, empty lines included, and a trailing
/// newline leaves an empty last block the author can type into.
#[test]
fn every_line_is_a_block_including_empty_ones() {
    let layout = SourceLayout::read_plain(b"fn main() {\n\n}\n");
    let spans: Vec<(usize, usize)> = layout
        .blocks()
        .iter()
        .map(|span| (span.start, span.end))
        .collect();
    assert_eq!(spans, vec![(0, 11), (12, 12), (13, 14), (15, 15)]);
}

/// The empty source is one empty block, so the editor shows one line to type
/// into rather than nothing at all.
#[test]
fn the_empty_source_is_one_empty_block() {
    let layout = SourceLayout::read_plain(b"");
    assert_eq!(layout.blocks().len(), 1);
    assert_eq!(layout.blocks()[0].start, 0);
    assert_eq!(layout.blocks()[0].end, 0);
}

/// A carriage return is never line content: it stays in the gap and
/// reproduces verbatim, so a CRLF file keeps its CRLF.
#[test]
fn a_crlf_file_keeps_its_carriage_returns() {
    let source = b"one\r\ntwo\r\n";
    let layout = SourceLayout::read_plain(source);
    let spans: Vec<(usize, usize)> = layout
        .blocks()
        .iter()
        .map(|span| (span.start, span.end))
        .collect();
    assert_eq!(spans, vec![(0, 3), (5, 8), (10, 10)]);
    assert_eq!(layout.reproduce(source).unwrap(), source);
}

/// Nothing in plain text is structural: the bytes that would split, fence or
/// head a Markdown document scan as ordinary lines, and reproduce exactly.
#[test]
fn markdown_structure_scans_as_ordinary_lines() {
    let source = b"# not a heading\n```\ninside\n\n```\n| a |\n|---|---|\ntail";
    let layout = SourceLayout::read_plain(source);
    assert_eq!(layout.blocks().len(), 8);
    assert_eq!(layout.reproduce(source).unwrap(), source);
}

/// A no-edit open materialises to exactly the bytes read — the round-trip
/// the whole feature stands on.
#[test]
fn opening_materialises_to_the_same_bytes() {
    for source in [
        b"fn main() {\n    let x = 1;\n}\n".as_slice(),
        b"no trailing newline here".as_slice(),
        b"\n\nthree empty lines\n\n".as_slice(),
        b"crlf\r\nfile\r\n".as_slice(),
        b"".as_slice(),
    ] {
        let manuscript = open_plain(source);
        assert_eq!(manuscript.materialize().unwrap(), source, "{source:?}");
    }
}

/// Replacing a line writes it back with ONE newline on each side. The
/// Markdown paragraph separator would put a blank line into the file.
#[test]
fn replacing_a_line_joins_with_one_newline() {
    let mut manuscript = open_plain(b"one\ntwo\nthree");
    let ids = manuscript.head().block_ids();
    manuscript
        .execute(TextCommand::Editor(EditorAction::new(
            manuscript.head().id(),
            vec![EditorChange::Replace(
                Replacement::new(vec![ids[1]], Some("TWO".to_string())).unwrap(),
            )],
            "author edit",
        )))
        .unwrap();
    assert_eq!(manuscript.materialize().unwrap(), b"one\nTWO\nthree");
}

/// Enter in the editor is an Insert of one line: the new block joins with a
/// single newline, exactly what a code editor writes.
#[test]
fn an_inserted_line_joins_with_one_newline() {
    let mut manuscript = open_plain(b"one\nthree");
    let ids = manuscript.head().block_ids();
    manuscript
        .execute(TextCommand::Editor(EditorAction::new(
            manuscript.head().id(),
            vec![EditorChange::Insert(
                Insertion::new(Some(ids[1]), vec!["two".to_string()], BlockScan::Plain).unwrap(),
            )],
            "author edit",
        )))
        .unwrap();
    assert_eq!(manuscript.materialize().unwrap(), b"one\ntwo\nthree");
}

/// An empty line is a legal block in plain text: Enter at a line's end
/// inserts one, and it materialises as an empty line — never as the space
/// Markdown's placeholder uses.
#[test]
fn an_empty_line_is_a_legal_inserted_block() {
    let mut manuscript = open_plain(b"one\nthree");
    let ids = manuscript.head().block_ids();
    manuscript
        .execute(TextCommand::Editor(EditorAction::new(
            manuscript.head().id(),
            vec![EditorChange::Insert(
                Insertion::new(Some(ids[1]), vec![String::new()], BlockScan::Plain).unwrap(),
            )],
            "author edit",
        )))
        .unwrap();
    assert_eq!(manuscript.materialize().unwrap(), b"one\n\nthree");
}

/// Undo restores the adopted bytes exactly — the history path is the one
/// prose uses, and it must hold for code.
#[test]
fn undo_restores_the_original_bytes() {
    let mut manuscript = open_plain(b"one\ntwo\nthree");
    let ids = manuscript.head().block_ids();
    manuscript
        .execute(TextCommand::Editor(EditorAction::new(
            manuscript.head().id(),
            vec![EditorChange::Replace(
                Replacement::new(vec![ids[0]], Some("ONE".to_string())).unwrap(),
            )],
            "author edit",
        )))
        .unwrap();
    manuscript.undo_last().unwrap();
    assert_eq!(manuscript.materialize().unwrap(), b"one\ntwo\nthree");
}

/// A replacement text carrying newlines splits into line blocks, so the head
/// the editor shows and the bytes on disk never disagree about where a block
/// ends.
#[test]
fn a_multiline_replacement_splits_into_line_blocks() {
    let mut manuscript = open_plain(b"one\nfour");
    let ids = manuscript.head().block_ids();
    manuscript
        .execute(TextCommand::Editor(EditorAction::new(
            manuscript.head().id(),
            vec![EditorChange::Replace(
                Replacement::new(vec![ids[0]], Some("one\ntwo\nthree".to_string())).unwrap(),
            )],
            "author edit",
        )))
        .unwrap();
    assert_eq!(manuscript.head().blocks().len(), 4);
    assert_eq!(manuscript.materialize().unwrap(), b"one\ntwo\nthree\nfour");
}

/// An insertion text that spans lines is refused: the editor splits by line
/// before asking, so a multi-line member means the two sides disagreed.
#[test]
fn a_multiline_insertion_member_is_refused() {
    let refusal = Insertion::new(None, vec!["one\ntwo".to_string()], BlockScan::Plain);
    assert!(matches!(
        refusal,
        Err(refrain_core::TextRefusal::InvalidInsertionBlock {
            index: 0,
            blocks: 2
        })
    ));
}
