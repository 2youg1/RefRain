// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Byte layout of a manuscript source.
//!
//! The source remains bytes. This module only records which byte intervals are
//! editor blocks; gaps, line endings, indentation, and every untouched byte stay
//! in the original buffer. A layout can slice only the source digest it read.

use thiserror::Error;

use crate::digest::content_bytes;

/// One half-open block interval in the original source bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteSpan {
    pub start: usize,
    pub end: usize,
}

/// The block intervals and identity of one immutable source snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceLayout {
    digest: [u8; 32],
    blocks: Box<[ByteSpan]>,
}

/// The caller supplied bytes other than those this layout measured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[error("source bytes differ from the layout digest")]
pub struct SourceDrift;

/// How a document's bytes divide into blocks.
///
/// The scanner is chosen at the call site from the document's
/// [`crate::document_format::DocumentFormat`]; this module never decides.
/// Keeping the choice outside the scanner is what keeps the Markdown scanner
/// the sole authority on Markdown blocks: the plain-text scanner is a second
/// function, not a second grammar inside the first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockScan {
    /// Markdown structure: blank lines separate blocks, and a fenced code
    /// block holds the blank lines inside it.
    Markdown,
    /// Plain text: every line is a block. Nothing is structural — a `#`, a
    /// fence marker and a table row are text, never structure.
    Plain,
}

impl BlockScan {
    /// Measure block intervals by this scan's rule.
    #[must_use]
    pub fn layout(self, source: &[u8]) -> SourceLayout {
        match self {
            Self::Markdown => SourceLayout::read(source),
            Self::Plain => SourceLayout::read_plain(source),
        }
    }

    /// The bytes written between two freshly minted blocks.
    ///
    /// Untouched gaps never go through here: they are reproduced from the
    /// source verbatim. This separator is only what an edit *adds* — a new
    /// paragraph in prose, a new line in plain text.
    ///
    /// The type carries the fact that these bytes are text. It used to return
    /// `&'static [u8]`, and each of the five callers that joins block text
    /// re-established the same fact at run time with
    /// `from_utf8(...).expect("separators are ASCII")` — five assertions of
    /// something this `match` decides. Callers that want the bytes ask for
    /// them; `materialize` is the only one.
    #[must_use]
    pub fn separator(self) -> &'static str {
        match self {
            Self::Markdown => "\n\n",
            Self::Plain => "\n",
        }
    }
}

impl SourceLayout {
    /// Measures block intervals without decoding or normalising the source.
    #[must_use]
    pub fn read(source: &[u8]) -> Self {
        Self {
            digest: content_bytes(source),
            blocks: block_spans(source).into_boxed_slice(),
        }
    }

    /// Measures plain-text block intervals: one block per line, no structure.
    #[must_use]
    pub fn read_plain(source: &[u8]) -> Self {
        Self {
            digest: content_bytes(source),
            blocks: plain_block_spans(source).into_boxed_slice(),
        }
    }

    #[must_use]
    pub fn blocks(&self) -> &[ByteSpan] {
        &self.blocks
    }

    /// Rebuilds an unedited source from its measured intervals and untouched gaps.
    pub fn reproduce(&self, source: &[u8]) -> Result<Vec<u8>, SourceDrift> {
        if content_bytes(source) != self.digest {
            return Err(SourceDrift);
        }

        let mut output = Vec::with_capacity(source.len());
        let mut cursor = 0;
        for block in &self.blocks {
            output.extend_from_slice(&source[cursor..block.start]);
            output.extend_from_slice(&source[block.start..block.end]);
            cursor = block.end;
        }
        output.extend_from_slice(&source[cursor..]);
        Ok(output)
    }
}

#[derive(Debug, Clone, Copy)]
struct Fence {
    marker: u8,
    width: usize,
}

fn block_spans(source: &[u8]) -> Vec<ByteSpan> {
    let mut spans = Vec::new();
    let mut block_start = None;
    let mut block_end = 0;
    let mut fence = None;
    let mut cursor = 0;

    loop {
        // Finding the next newline is the one part of this scan that is both
        // proportional to file size and entirely mechanical, so it runs on a
        // SIMD kernel. Everything the loop then decides — fence state, whether
        // the line is all ASCII whitespace, the `\r\n` ending — is unchanged.
        let newline = memchr::memchr(b'\n', &source[cursor..]).map(|offset| cursor + offset);
        let line_end = newline.unwrap_or(source.len());
        let content_end = if line_end > cursor && source[line_end - 1] == b'\r' {
            line_end - 1
        } else {
            line_end
        };
        let content = &source[cursor..content_end];
        let marker = fence_marker(content);

        match (fence, marker) {
            (None, Some(opened)) => fence = Some(opened),
            (Some(opened), Some(closed))
                if opened.marker == closed.marker && closed.width >= opened.width =>
            {
                fence = None;
            }
            _ => {}
        }

        if fence.is_none() && content.iter().all(u8::is_ascii_whitespace) {
            if let Some(start) = block_start.take() {
                spans.push(ByteSpan {
                    start,
                    end: block_end,
                });
            }
        } else {
            block_start.get_or_insert(cursor);
            block_end = content_end;
        }

        let Some(newline) = newline else {
            break;
        };
        cursor = newline + 1;
    }

    if let Some(start) = block_start {
        spans.push(ByteSpan {
            start,
            end: block_end,
        });
    }
    spans
}

/// Every line one block, including empty lines.
///
/// A block holds no line ending and no `\r`; those bytes stay in the gaps
/// and reproduce verbatim. A source that ends with a newline has an empty
/// last line, and that line is a block the author can type into — the shape
/// every plain-text editor shows. The empty source scans as one empty block
/// for the same reason.
fn plain_block_spans(source: &[u8]) -> Vec<ByteSpan> {
    let mut spans = Vec::new();
    let mut cursor = 0;
    loop {
        let newline = memchr::memchr(b'\n', &source[cursor..]).map(|offset| cursor + offset);
        let line_end = newline.unwrap_or(source.len());
        let content_end = if line_end > cursor && source[line_end - 1] == b'\r' {
            line_end - 1
        } else {
            line_end
        };
        spans.push(ByteSpan {
            start: cursor,
            end: content_end,
        });
        let Some(newline) = newline else {
            break;
        };
        cursor = newline + 1;
    }
    spans
}

fn fence_marker(line: &[u8]) -> Option<Fence> {
    let indent = line
        .iter()
        .take(4)
        .take_while(|byte| matches!(byte, b' ' | b'\t'))
        .count();
    if indent == 4 {
        return None;
    }

    let marker = *line.get(indent)?;
    if !matches!(marker, b'`' | b'~') {
        return None;
    }
    let width = line[indent..]
        .iter()
        .take_while(|byte| **byte == marker)
        .count();
    (width >= 3).then_some(Fence { marker, width })
}
