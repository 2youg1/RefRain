//! Native document state: one Rust authority for bytes, selection, IME, undo,
//! and bounded block projections consumed by the platform view.

use refrain_core::{Lineage, Manuscript, SourceSnapshot, TextRefusal};
use std::ops::Range;
use thiserror::Error;

pub const DOCUMENT_FIXTURE_BLOCKS: usize = 100_000;
pub const DOCUMENT_FIXTURE_BYTES: usize = 11_953_766;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteSelection {
    pub anchor: usize,
    pub focus: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaretDirection {
    Previous,
    Next,
    PreviousWord,
    NextWord,
    Start,
    End,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocumentOpen {
    Bytes(Vec<u8>),
    ScaleFixture,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocumentInput {
    SetSelection(ByteSelection),
    InsertText(String),
    DeleteBackward,
    DeleteForward,
    DeleteWordBackward,
    DeleteWordForward,
    Clear,
    MoveCaret {
        direction: CaretDirection,
        extend: bool,
    },
    SetComposition {
        text: String,
        cursor: usize,
    },
    CommitComposition,
    CancelComposition,
    Undo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DocumentViewport {
    pub first_block: usize,
    pub block_count: usize,
    pub max_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Composition {
    pub range: Range<usize>,
    pub text: String,
    pub cursor: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentProjection {
    pub revision: u64,
    pub total_bytes: usize,
    pub total_blocks: usize,
    pub first_block: usize,
    pub block_count: usize,
    pub window_start: usize,
    pub text: String,
    pub selection: ByteSelection,
    pub composition: Option<Composition>,
}

#[derive(Debug, Error)]
pub enum DocumentError {
    #[error(transparent)]
    Text(#[from] TextRefusal),
    #[error("composition cursor {cursor} is outside {length} UTF-8 bytes")]
    InvalidCompositionCursor { cursor: usize, length: usize },
    #[error("composition cursor {cursor} splits a UTF-8 scalar")]
    InvalidCompositionBoundary { cursor: usize },
    #[error("document bytes are not UTF-8")]
    InvalidProjection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunClass {
    Word,
    Space,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentSurface {
    manuscript: Manuscript,
    selection: ByteSelection,
    composition: Option<Composition>,
    selection_history: Vec<ByteSelection>,
    revision: u64,
}

impl DocumentSurface {
    /// Open one manuscript. This is the only constructor exposed by the module.
    pub fn open(source: DocumentOpen) -> Result<Self, DocumentError> {
        let bytes = match source {
            DocumentOpen::Bytes(bytes) => bytes,
            DocumentOpen::ScaleFixture => document_fixture(),
        };
        let source =
            SourceSnapshot::read_checked(bytes).map_err(|_| DocumentError::InvalidProjection)?;
        let lineage = Lineage::fresh(source.block_count());
        Ok(Self {
            manuscript: Manuscript::open(source, lineage)?,
            selection: collapsed(0),
            composition: None,
            selection_history: Vec::new(),
            revision: 0,
        })
    }

    /// Apply one exhaustive document input over the authoritative state.
    pub fn apply(&mut self, input: DocumentInput) -> Result<(), DocumentError> {
        match input {
            DocumentInput::SetSelection(selection) => self.set_selection(selection),
            DocumentInput::InsertText(text) => {
                self.replace_range(self.selection_range(), &text, "native text input")
            }
            DocumentInput::DeleteBackward => self.delete_backward(false),
            DocumentInput::DeleteForward => self.delete_forward(false),
            DocumentInput::DeleteWordBackward => self.delete_backward(true),
            DocumentInput::DeleteWordForward => self.delete_forward(true),
            DocumentInput::Clear => {
                self.replace_range(0..self.manuscript.byte_len(), "", "keyboard clear")
            }
            DocumentInput::MoveCaret { direction, extend } => {
                self.move_caret(direction, extend);
                Ok(())
            }
            DocumentInput::SetComposition { text, cursor } => self.set_composition(text, cursor),
            DocumentInput::CommitComposition => self.commit_composition(),
            DocumentInput::CancelComposition => {
                self.cancel_composition();
                Ok(())
            }
            DocumentInput::Undo => self.undo(),
        }
    }

    /// Return one bounded projection resolved from a block viewport.
    pub fn project(&self, viewport: DocumentViewport) -> Result<DocumentProjection, DocumentError> {
        let total_blocks = self.manuscript.head().blocks().len();
        let first_block = viewport.first_block.min(total_blocks);
        let requested_end = first_block
            .saturating_add(viewport.block_count)
            .min(total_blocks);
        let max_bytes = viewport.max_bytes;
        let end_block = self.bounded_end_block(first_block, requested_end, max_bytes)?;
        let byte_range = self.manuscript.block_byte_range(first_block..end_block)?;
        let mut end = byte_range
            .end
            .min(byte_range.start.saturating_add(max_bytes));
        while end > byte_range.start && !self.manuscript.is_byte_boundary(end) {
            end -= 1;
        }
        let text = String::from_utf8(self.manuscript.read_bytes(byte_range.start..end)?)
            .map_err(|_| DocumentError::InvalidProjection)?;
        Ok(DocumentProjection {
            revision: self.revision,
            total_bytes: self.manuscript.byte_len(),
            total_blocks,
            first_block,
            block_count: end_block - first_block,
            window_start: byte_range.start,
            text,
            selection: self.selection,
            composition: self.composition.clone(),
        })
    }

    fn bounded_end_block(
        &self,
        first: usize,
        requested_end: usize,
        max_bytes: usize,
    ) -> Result<usize, DocumentError> {
        if first == requested_end || max_bytes == 0 {
            return Ok(first);
        }
        if self
            .manuscript
            .block_byte_range(first..requested_end)?
            .len()
            <= max_bytes
        {
            return Ok(requested_end);
        }
        let mut low = first + 1;
        let mut high = requested_end;
        while low < high {
            let middle = low + (high - low).div_ceil(2);
            if self.manuscript.block_byte_range(first..middle)?.len() <= max_bytes {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        Ok(low)
    }

    fn set_selection(&mut self, selection: ByteSelection) -> Result<(), DocumentError> {
        self.validate_range(selection_range(selection))?;
        if self.selection != selection || self.composition.is_some() {
            self.selection = selection;
            self.composition = None;
            self.revision += 1;
        }
        Ok(())
    }

    fn delete_backward(&mut self, word: bool) -> Result<(), DocumentError> {
        let range = self.selection_range();
        let range = if range.is_empty() {
            let start = if word {
                self.previous_word(range.start)
            } else {
                self.previous_offset(range.start)
            };
            start..range.start
        } else {
            range
        };
        self.replace_range(range, "", "keyboard delete backward")
    }

    fn delete_forward(&mut self, word: bool) -> Result<(), DocumentError> {
        let range = self.selection_range();
        let range = if range.is_empty() {
            let end = if word {
                self.next_word(range.end)
            } else {
                self.next_offset(range.end)
            };
            range.end..end
        } else {
            range
        };
        self.replace_range(range, "", "keyboard delete forward")
    }

    fn move_caret(&mut self, direction: CaretDirection, extend: bool) {
        let range = self.selection_range();
        let focus = if !extend && !range.is_empty() {
            match direction {
                CaretDirection::Previous | CaretDirection::PreviousWord | CaretDirection::Start => {
                    range.start
                }
                CaretDirection::Next | CaretDirection::NextWord | CaretDirection::End => range.end,
            }
        } else {
            match direction {
                CaretDirection::Previous => self.previous_offset(self.selection.focus),
                CaretDirection::Next => self.next_offset(self.selection.focus),
                CaretDirection::PreviousWord => self.previous_word(self.selection.focus),
                CaretDirection::NextWord => self.next_word(self.selection.focus),
                CaretDirection::Start => 0,
                CaretDirection::End => self.manuscript.byte_len(),
            }
        };
        let next = if extend {
            ByteSelection {
                anchor: self.selection.anchor,
                focus,
            }
        } else {
            collapsed(focus)
        };
        if self.selection != next || self.composition.is_some() {
            self.selection = next;
            self.composition = None;
            self.revision += 1;
        }
    }

    fn set_composition(&mut self, text: String, cursor: usize) -> Result<(), DocumentError> {
        if cursor > text.len() {
            return Err(DocumentError::InvalidCompositionCursor {
                cursor,
                length: text.len(),
            });
        }
        if !text.is_char_boundary(cursor) {
            return Err(DocumentError::InvalidCompositionBoundary { cursor });
        }
        self.composition = Some(Composition {
            range: self.selection_range(),
            text,
            cursor,
        });
        self.revision += 1;
        Ok(())
    }

    fn commit_composition(&mut self) -> Result<(), DocumentError> {
        let composition = self
            .composition
            .clone()
            .ok_or(TextRefusal::NothingChanged)?;
        self.replace_range(
            composition.range,
            &composition.text,
            "IME composition commit",
        )
    }

    fn cancel_composition(&mut self) {
        if self.composition.take().is_some() {
            self.revision += 1;
        }
    }

    fn undo(&mut self) -> Result<(), DocumentError> {
        self.manuscript.undo_last()?;
        self.selection = self.selection_history.pop().unwrap_or_else(|| collapsed(0));
        self.composition = None;
        self.revision += 1;
        Ok(())
    }

    fn replace_range(
        &mut self,
        range: Range<usize>,
        text: &str,
        cause: impl Into<String>,
    ) -> Result<(), DocumentError> {
        let before = self.selection;
        let cursor = range.start + text.len();
        self.manuscript.replace_bytes(range, text, cause)?;
        self.selection_history.push(before);
        self.selection = collapsed(cursor);
        self.composition = None;
        self.revision += 1;
        Ok(())
    }

    fn selection_range(&self) -> Range<usize> {
        selection_range(self.selection)
    }

    fn previous_offset(&self, offset: usize) -> usize {
        let mut cursor = offset.min(self.manuscript.byte_len());
        if cursor == 0 {
            return 0;
        }
        cursor -= 1;
        while cursor > 0
            && self
                .manuscript
                .byte(cursor)
                .is_some_and(|byte| byte & 0xc0 == 0x80)
        {
            cursor -= 1;
        }
        if cursor > 0
            && self.manuscript.byte(cursor) == Some(b'\n')
            && self.manuscript.byte(cursor - 1) == Some(b'\r')
        {
            cursor -= 1;
        }
        cursor
    }

    fn next_offset(&self, offset: usize) -> usize {
        let cursor = offset.min(self.manuscript.byte_len());
        let Some(lead) = self.manuscript.byte(cursor) else {
            return self.manuscript.byte_len();
        };
        if lead == b'\r' && self.manuscript.byte(cursor + 1) == Some(b'\n') {
            return (cursor + 2).min(self.manuscript.byte_len());
        }
        let length = match lead {
            0x00..=0x7f => 1,
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            _ => 1,
        };
        (cursor + length).min(self.manuscript.byte_len())
    }

    fn previous_word(&self, offset: usize) -> usize {
        let mut cursor = offset.min(self.manuscript.byte_len());
        while cursor > 0 {
            let previous = self.previous_offset(cursor);
            if self.class_at(previous) == Some(RunClass::Word) {
                break;
            }
            cursor = previous;
        }
        while cursor > 0 {
            let previous = self.previous_offset(cursor);
            if self.class_at(previous) != Some(RunClass::Word) {
                break;
            }
            cursor = previous;
        }
        cursor
    }

    fn next_word(&self, offset: usize) -> usize {
        let mut cursor = offset.min(self.manuscript.byte_len());
        while cursor < self.manuscript.byte_len() && self.class_at(cursor) != Some(RunClass::Word) {
            cursor = self.next_offset(cursor);
        }
        while cursor < self.manuscript.byte_len() && self.class_at(cursor) == Some(RunClass::Word) {
            cursor = self.next_offset(cursor);
        }
        cursor
    }

    fn class_at(&self, offset: usize) -> Option<RunClass> {
        let byte = self.manuscript.byte(offset)?;
        if byte & 0x80 != 0 || byte.is_ascii_alphanumeric() || byte == b'_' {
            Some(RunClass::Word)
        } else if byte.is_ascii_whitespace() {
            Some(RunClass::Space)
        } else {
            Some(RunClass::Other)
        }
    }

    fn validate_range(&self, range: Range<usize>) -> Result<(), DocumentError> {
        if range.end > self.manuscript.byte_len() {
            return Err(TextRefusal::InvalidByteRange {
                start: range.start,
                end: range.end,
                length: self.manuscript.byte_len(),
            }
            .into());
        }
        for offset in [range.start, range.end] {
            if !self.manuscript.is_byte_boundary(offset) {
                return Err(TextRefusal::InvalidByteBoundary { offset }.into());
            }
        }
        Ok(())
    }
}

const fn collapsed(offset: usize) -> ByteSelection {
    ByteSelection {
        anchor: offset,
        focus: offset,
    }
}

fn selection_range(selection: ByteSelection) -> Range<usize> {
    selection.anchor.min(selection.focus)..selection.anchor.max(selection.focus)
}

fn document_fixture() -> Vec<u8> {
    let separators = (DOCUMENT_FIXTURE_BLOCKS - 1) * 2;
    let content = DOCUMENT_FIXTURE_BYTES - separators;
    let base = content / DOCUMENT_FIXTURE_BLOCKS;
    let longer = content % DOCUMENT_FIXTURE_BLOCKS;
    let mut bytes = Vec::with_capacity(DOCUMENT_FIXTURE_BYTES);
    for index in 0..DOCUMENT_FIXTURE_BLOCKS {
        let length = base + usize::from(index < longer);
        let prefix = format!("{index:06} | 中文と日本語 | ");
        bytes.extend_from_slice(prefix.as_bytes());
        bytes.resize(
            bytes.len() + length - prefix.len(),
            b'a' + (index % 26) as u8,
        );
        if index + 1 < DOCUMENT_FIXTURE_BLOCKS {
            bytes.extend_from_slice(b"\n\n");
        }
    }
    debug_assert_eq!(bytes.len(), DOCUMENT_FIXTURE_BYTES);
    bytes
}

#[cfg(test)]
fn fixture_digest(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn viewport(first_block: usize, block_count: usize) -> DocumentViewport {
        DocumentViewport {
            first_block,
            block_count,
            max_bytes: 40_960,
        }
    }

    #[test]
    fn fixture_is_exactly_one_hundred_thousand_blocks_and_eleven_point_four_mib() {
        let bytes = document_fixture();
        let first = fixture_digest(&bytes);
        assert_eq!(bytes.len(), DOCUMENT_FIXTURE_BYTES);
        assert_eq!(
            bytes.windows(2).filter(|pair| *pair == b"\n\n").count() + 1,
            DOCUMENT_FIXTURE_BLOCKS
        );
        assert_eq!(fixture_digest(&document_fixture()), first);
    }

    #[test]
    fn projection_is_bounded_by_the_requested_block_viewport() {
        let document = DocumentSurface::open(DocumentOpen::ScaleFixture).unwrap();
        let first = document.project(viewport(0, 32)).unwrap();
        let middle = document.project(viewport(50_000, 32)).unwrap();
        let tail = document.project(viewport(99_990, 32)).unwrap();

        assert_eq!(first.total_bytes, DOCUMENT_FIXTURE_BYTES);
        assert_eq!(first.total_blocks, DOCUMENT_FIXTURE_BLOCKS);
        assert_eq!(first.first_block, 0);
        assert_eq!(first.block_count, 32);
        assert!(first.text.len() < 40_960);
        assert_eq!(middle.first_block, 50_000);
        assert!(middle.window_start > first.text.len());
        assert_eq!(tail.first_block, 99_990);
        assert_eq!(tail.block_count, 10);
        assert_eq!(tail.window_start + tail.text.len(), DOCUMENT_FIXTURE_BYTES);
    }

    #[test]
    fn cross_window_selection_composition_commit_cancel_and_undo_share_one_authority() {
        let source = "开头。\n\n第二段。\n\n结尾。";
        let mut document =
            DocumentSurface::open(DocumentOpen::Bytes(source.as_bytes().to_vec())).unwrap();
        let start = source.find("头。\n\n第").unwrap();
        let end = start + "头。\n\n第".len();
        let selection = ByteSelection {
            anchor: end,
            focus: start,
        };
        document
            .apply(DocumentInput::SetSelection(selection))
            .unwrap();
        document
            .apply(DocumentInput::SetComposition {
                text: "输入中".to_owned(),
                cursor: 6,
            })
            .unwrap();
        assert_eq!(
            document
                .project(viewport(1, 1))
                .unwrap()
                .composition
                .unwrap()
                .text,
            "输入中"
        );
        document.apply(DocumentInput::CancelComposition).unwrap();
        assert_eq!(document.project(viewport(0, 3)).unwrap().text, source);

        document
            .apply(DocumentInput::SetComposition {
                text: "確定".to_owned(),
                cursor: 6,
            })
            .unwrap();
        document.apply(DocumentInput::CommitComposition).unwrap();
        assert_eq!(
            document.project(viewport(0, 3)).unwrap().text,
            "开確定二段。\n\n结尾。"
        );
        document.apply(DocumentInput::Undo).unwrap();
        let restored = document.project(viewport(0, 3)).unwrap();
        assert_eq!(restored.text, source);
        assert_eq!(restored.selection, selection);
    }

    #[test]
    fn caret_extension_crosses_projection_boundaries_without_surface_state() {
        let mut document = DocumentSurface::open(DocumentOpen::ScaleFixture).unwrap();
        let first = document.project(viewport(0, 1)).unwrap();
        let second = document.project(viewport(1, 1)).unwrap();
        document
            .apply(DocumentInput::SetSelection(ByteSelection {
                anchor: first.window_start,
                focus: second.window_start,
            }))
            .unwrap();
        document
            .apply(DocumentInput::MoveCaret {
                direction: CaretDirection::Next,
                extend: true,
            })
            .unwrap();
        let projected = document.project(viewport(50_000, 24)).unwrap();
        assert_eq!(projected.selection.anchor, 0);
        assert!(projected.selection.focus > first.text.len());
        assert_eq!(projected.first_block, 50_000);
    }
}
