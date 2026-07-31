//! What a search index holds one row of.
//!
//! # Why this exists
//!
//! The index used to hold one row per document: a query could answer *which
//! file*, never *which passage*. That is enough for a sidebar and not enough
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
//! Anthropic's tool-writing guidance, measured: resolving opaque identifiers
//! into "semantically meaningful" ones "significantly improves Claude's
//! precision in retrieval tasks by reducing hallucinations". A block's
//! ordinal within its document is derivable from the source bytes by anyone
//! holding them, survives a rebuild of the index, and reads as a location a
//! human can check. An `Id` would be none of those.

use crate::block_shape::{BlockKind, BlockShape};
use crate::source_layout::SourceLayout;

/// The largest ordinal this module will number.
///
/// A document with more blocks than this is indexed up to the cap rather
/// than refused: an author who opens a generated 10-million-line log should
/// get a searchable beginning, not an error. The cap exists because the
/// ordinal is a `u32` in the index and because an index entry per block of a
/// 1GB file is a cost the author never asked to pay.
pub const MAX_INDEXED_BLOCKS: usize = 100_000;

/// One indexable passage: where it is, what kind it is, and its text.
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
    /// Kept so a caller can seek to the passage without re-scanning, and so a
    /// retrieved fragment can prove it is the same bytes the index saw.
    pub start: usize,
}

/// Every indexable block of a document, in source order.
///
/// Blocks that hold no text after trimming are dropped rather than numbered:
/// they match nothing, rank nowhere, and would spend an index row each. The
/// ordinal still counts them, because it is a position in the document's
/// block sequence — the same sequence the editor and `SourceLayout` use — and
/// a numbering that skipped them would disagree with both.
#[must_use]
pub fn blocks_of(source: &str) -> Vec<SearchableBlock<'_>> {
    let layout = SourceLayout::read(source.as_bytes());
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
            Some(SearchableBlock {
                ordinal: u32::try_from(ordinal).ok()?,
                kind: BlockShape::of(text).kind,
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
pub fn block_at(source: &str, ordinal: u32) -> Option<SearchableBlock<'_>> {
    blocks_of(source)
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
        let blocks = blocks_of(SAMPLE);
        let kinds: Vec<BlockKind> = blocks.iter().map(|block| block.kind).collect();
        assert_eq!(
            kinds,
            vec![
                BlockKind::Heading,
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
        for block in blocks_of(SAMPLE) {
            let fetched = block_at(SAMPLE, block.ordinal).expect("block still there");
            assert_eq!(fetched.text, block.text);
            assert_eq!(
                &SAMPLE[fetched.start..fetched.start + fetched.text.len()],
                block.text
            );
        }
    }

    #[test]
    fn an_ordinal_past_the_end_is_absent_not_empty() {
        assert!(block_at(SAMPLE, 99).is_none());
    }

    /// A fence holding a blank line stays one block: the boundary authority
    /// already knows this, and this module must not re-decide it.
    #[test]
    fn a_blank_line_inside_a_fence_does_not_split_the_block() {
        let source = "```\nfirst\n\nsecond\n```";
        let blocks = blocks_of(source);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].kind, BlockKind::Fence);
        assert!(blocks[0].text.contains("first"));
        assert!(blocks[0].text.contains("second"));
    }

    #[test]
    fn an_empty_document_has_no_blocks() {
        assert!(blocks_of("").is_empty());
        assert!(blocks_of("\n\n   \n").is_empty());
    }

    /// Astral characters and CJK must not shift a block's byte offsets: the
    /// offset is what lets a fragment prove it is the same bytes.
    #[test]
    fn offsets_survive_multibyte_text() {
        let source = "第一段🎈的正文。\n\n第二段。";
        let blocks = blocks_of(source);
        assert_eq!(blocks.len(), 2);
        for block in &blocks {
            assert_eq!(
                &source[block.start..block.start + block.text.len()],
                block.text
            );
        }
    }
}
