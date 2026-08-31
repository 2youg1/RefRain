// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! What a search index holds one row of.
//!
//! # Why this exists
//!
//! The index used to hold one row per document: a query could answer *which
//! file*, never *which block*. That is enough for a sidebar and not enough
//! for an agent, which needs to read a paragraph rather than a chapter — the
//! whole point of handing it an outline instead of 100KB of prose.
//!
//! # Why the boundaries are not decided here
//!
//! `SourceLayout` is the byte-level authority on where a block starts and
//! ends, and `BlockShape` reads what kind of block it is from the block's own
//! text. This module composes those two and adds nothing: a second scanner
//! would be a second authority, and the two would drift the first time
//! either changed. What it *does* own is the numbering — which block is the
//! third block — because that is the handle the agent and the index share,
//! and neither of the two authorities above has any reason to know it.
//!
//! # Why an ordinal rather than an `Id`
//!
//! Tool-writing guidance, measured: resolving opaque identifiers
//! into "semantically meaningful" ones "significantly improves Claude's
//! precision in retrieval tasks by reducing hallucinations". A block's
//! ordinal within its document is derivable from the source bytes by anyone
//! holding them, survives a rebuild of the index, and reads as a location a
//! human can check. An `Id` would be none of those.

use crate::block_shape::{BlockKind, BlockShape};
use crate::source_layout::BlockScan;

/// The largest ordinal this module will number.
///
/// A document with more blocks than this is indexed up to the cap rather
/// than refused: an author who opens a generated 10-million-line log should
/// get a searchable beginning, not an error. The cap exists because the
/// ordinal is a `u32` in the index and because an index entry per block of a
/// 1GB file is a cost the author never asked to pay.
pub const MAX_INDEXED_BLOCKS: usize = 100_000;

/// One indexable block: where it is, what kind it is, and its text.
///
/// Borrowed rather than owned. Indexing a 252MB corpus allocates once per
/// document for the read and then walks it; copying every block's text would
/// double that for no reader's benefit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchableBlock<'source> {
    /// Which block this is within its document, counting from zero.
    ///
    /// The join key between the index, the agent's citation, and the bytes on
    /// disk. Stable for as long as the document's blocks are: an edit that
    /// adds a paragraph renumbers everything after it, which is why an index
    /// entry records the digest it was built from.
    pub ordinal: u32,
    /// What the author made this block: a heading they wrote to mark a place,
    /// a fence they pasted, or running prose.
    pub kind: BlockKind,
    /// The block's exact bytes, as they sit in the source.
    pub text: &'source str,
    /// Byte offset of `text` within the document.
    ///
    /// Kept so a caller can seek to the block without re-scanning, and so a
    /// retrieved block can prove it is the same bytes the index saw.
    pub start: usize,
}

/// Every indexable block of a document, in source order.
///
/// Blocks that hold no text after trimming are dropped rather than numbered:
/// they match nothing, rank nowhere, and would spend an index row each. The
/// ordinal still counts them, because it is a position in the document's
/// block sequence — the same sequence the editor and the layout use — and
/// a numbering that skipped them would disagree with both.
///
/// `scan` divides the bytes. Under the plain scan a block's kind is always
/// `Paragraph`: a `#` or a fence marker in code is text, never structure, so
/// the Markdown classifier is not asked.
#[must_use]
pub fn blocks_of(source: &str, scan: BlockScan) -> Vec<SearchableBlock<'_>> {
    let layout = scan.layout(source.as_bytes());
    layout
        .blocks()
        .iter()
        .take(MAX_INDEXED_BLOCKS)
        .enumerate()
        .filter_map(|(ordinal, span)| {
            // `SourceLayout` measures byte intervals without decoding, so a
            // span can in principle land mid-character on input this module
            // did not produce. `get` returns None there rather than panicking:
            // a malformed block is skipped, never a crash mid-index.
            let text = source.get(span.start..span.end)?;
            if text.trim().is_empty() {
                return None;
            }
            let kind = match scan {
                BlockScan::Markdown => BlockShape::of(text).kind,
                BlockScan::Plain => BlockKind::Paragraph,
            };
            Some(SearchableBlock {
                ordinal: u32::try_from(ordinal).ok()?,
                kind,
                text,
                start: span.start,
            })
        })
        .collect()
}

/// The text of one block by its ordinal, if the document still has it.
///
/// `None` is the honest answer for an ordinal past the end — which is what an
/// agent citing a block from a document the author has since shortened will
/// produce, and the caller must be able to tell that from an empty block.
#[must_use]
pub fn block_at(source: &str, ordinal: u32, scan: BlockScan) -> Option<SearchableBlock<'_>> {
    blocks_of(source, scan)
        .into_iter()
        .find(|block| block.ordinal == ordinal)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str =
        "# 第一章\n\n这是第一段的正文。\n\n```rust\nlet x = 1;\n```\n\n这是最后一段。";

    #[test]
    fn a_document_yields_its_blocks_in_source_order_with_their_kinds() {
        let blocks = blocks_of(SAMPLE, BlockScan::Markdown);
        let kinds: Vec<BlockKind> = blocks.iter().map(|block| block.kind).collect();
        assert_eq!(
            kinds,
            vec![
                BlockKind::Heading(
                    crate::block_shape::HeadingLevel::from_level(1).expect("1 is a level")
                ),
                BlockKind::Paragraph,
                BlockKind::Fence,
                BlockKind::Paragraph
            ]
        );
        let ordinals: Vec<u32> = blocks.iter().map(|block| block.ordinal).collect();
        assert_eq!(ordinals, vec![0, 1, 2, 3]);
    }

    /// The ordinal is a handle into the bytes, so it has to seek to exactly
    /// the text the index saw — this is judgement 1-3's core claim.
    #[test]
    fn an_ordinal_seeks_to_the_bytes_the_index_read() {
        for block in blocks_of(SAMPLE, BlockScan::Markdown) {
            let fetched =
                block_at(SAMPLE, block.ordinal, BlockScan::Markdown).expect("block still there");
            assert_eq!(fetched.text, block.text);
            assert_eq!(
                &SAMPLE[fetched.start..fetched.start + fetched.text.len()],
                block.text
            );
        }
    }

    #[test]
    fn an_ordinal_past_the_end_is_absent_not_empty() {
        assert!(block_at(SAMPLE, 99, BlockScan::Markdown).is_none());
    }

    /// A fence holding a blank line stays one block: the boundary authority
    /// already knows this, and this module must not re-decide it.
    #[test]
    fn a_blank_line_inside_a_fence_does_not_split_the_block() {
        let source = "```\nfirst\n\nsecond\n```";
        let blocks = blocks_of(source, BlockScan::Markdown);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].kind, BlockKind::Fence);
        assert!(blocks[0].text.contains("first"));
        assert!(blocks[0].text.contains("second"));
    }

    #[test]
    fn an_empty_document_has_no_blocks() {
        assert!(blocks_of("", BlockScan::Markdown).is_empty());
        assert!(blocks_of("\n\n   \n", BlockScan::Markdown).is_empty());
    }

    /// Astral characters and CJK must not shift a block's byte offsets: the
    /// offset is what lets a retrieved block prove it is the same bytes.
    #[test]
    fn offsets_survive_multibyte_text() {
        let source = "第一段🎈的正文。\n\n第二段。";
        let blocks = blocks_of(source, BlockScan::Markdown);
        assert_eq!(blocks.len(), 2);
        for block in &blocks {
            assert_eq!(
                &source[block.start..block.start + block.text.len()],
                block.text
            );
        }
    }

    /// Plain text never splits on Markdown structure: a fence marker, a
    /// heading hash and a table row are text. Every line is a block, empty
    /// lines included in the ordinals though not in the index.
    #[test]
    fn the_plain_scan_keeps_markdown_punctuation_literal() {
        let source = "# not a heading\n\n```\n| a | b |\n|---|---|\n\n**bold** tail";
        let blocks = blocks_of(source, BlockScan::Plain);
        let texts: Vec<&str> = blocks.iter().map(|block| block.text).collect();
        assert_eq!(
            texts,
            vec![
                "# not a heading",
                "```",
                "| a | b |",
                "|---|---|",
                "**bold** tail"
            ]
        );
        assert!(
            blocks
                .iter()
                .all(|block| block.kind == BlockKind::Paragraph)
        );
        // The empty lines are ordinals too: block 1 and 5 exist but carry no
        // text, so they never reach the index.
        let ordinals: Vec<u32> = blocks.iter().map(|block| block.ordinal).collect();
        assert_eq!(ordinals, vec![0, 2, 3, 4, 6]);
    }

    /// The plain scan's offsets are byte offsets into the same source, so a
    /// search hit lands the caret exactly where the line starts.
    #[test]
    fn plain_offsets_seek_to_the_same_bytes() {
        let source = "fn main() {\n    let x = 1;\n}\n";
        for block in blocks_of(source, BlockScan::Plain) {
            assert_eq!(
                &source[block.start..block.start + block.text.len()],
                block.text
            );
        }
    }
}
