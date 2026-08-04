//! Native document state: one Rust authority for bytes, selection, IME, undo,
//! and bounded block projections consumed by the platform view.

use refrain_core::manuscript::{PersistedRegion, Verdict};
use refrain_core::{
    DocumentFormat, Id, Lineage, Manuscript, SourceSnapshot, TextAction, TextRefusal, digest,
};
use refrain_store::atomic::{replace_file_atomically, replace_state_file_atomically};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::ops::Range;
use std::path::PathBuf;
use thiserror::Error;

pub const DOCUMENT_FIXTURE_BLOCKS: usize = 100_000;
pub const DOCUMENT_FIXTURE_BYTES: usize = 11_953_766;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
    Persistent { path: PathBuf, state_path: PathBuf },
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
    Save,
}

/// Which part of the manuscript a caller wants projected.
///
/// A platform reports where the reader scrolled to; resolving that into a block
/// index needs the manuscript's block count, which only this module holds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DocumentAnchor {
    /// Start at this block index, clamped to the document.
    Block(usize),
    /// Start at the block under this pixel offset in a uniform-height track.
    Scroll { offset: f64, block_height: f64 },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DocumentViewport {
    pub anchor: DocumentAnchor,
    pub block_count: usize,
    pub max_bytes: usize,
    /// How many 字身 fit on one line. The platform measures the real font and
    /// sends this; Rust turns it into break offsets so the 禁则 live with the
    /// text authority rather than in the view. Zero means "do not break".
    pub columns_em: f32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Composition {
    pub range: Range<usize>,
    pub text: String,
    pub cursor: usize,
}

/// The visible text of one viewport plus the offsets a renderer needs.
///
/// `text` is what the reader sees: the manuscript window with any in-flight IME
/// preedit already spliced in. Selection and composition are byte offsets into
/// that same string, so a consumer renders it without knowing the manuscript's
/// global coordinates or reconstructing the preedit itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentProjection {
    pub revision: u64,
    pub total_bytes: usize,
    pub total_blocks: usize,
    pub first_block: usize,
    pub block_count: usize,
    pub window_start: usize,
    pub text: String,
    /// Selection within `text`. Collapsed at the preedit cursor while composing.
    pub selection: Range<usize>,
    /// The same selection in manuscript coordinates, so a caller can report how
    /// much of the whole document is selected without holding the byte range.
    pub document_selection: Range<usize>,
    /// The preedit's range within `text`, present only while composing.
    pub composition: Option<Range<usize>>,
    /// Byte offsets into `text` where each line starts, first entry always 0.
    ///
    /// Computed by `refrain_core::typeset` under CLREQ 禁则: a closing bracket
    /// or a full stop never starts a line, an opening bracket never ends one,
    /// and a western word is not split. The SDK cannot do this — its only break
    /// opportunities are space and tab — so the view draws these offsets rather
    /// than wrapping the text itself.
    pub line_starts: Vec<usize>,
    /// Which grammar highlights this document. Decided at open from the file
    /// name and carried here because the view cannot recover it: a projection
    /// is a window of bytes, and a window into a `.rs` file looks exactly like
    /// a fenced block inside Markdown.
    pub format: DocumentFormat,
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
    #[error("the document has no durable target")]
    NotPersistent,
    #[error("cannot {action} {path}: {source}")]
    Persistence {
        action: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("cannot decode document state {path}: {source}")]
    StateDecode {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("document state {path} is invalid: {detail}")]
    InvalidState { path: PathBuf, detail: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Persistence {
    path: PathBuf,
    state_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct PersistedAction {
    id: Id,
    base: Id,
    cause: String,
    regions: Vec<PersistedRegion>,
    verdicts: Vec<Verdict>,
}

impl PersistedAction {
    fn from_action(action: &TextAction) -> Self {
        Self {
            id: action.id(),
            base: action.base(),
            cause: action.cause().to_owned(),
            regions: action.persisted_regions(),
            verdicts: action.verdicts().to_vec(),
        }
    }

    fn into_action(self) -> TextAction {
        TextAction::from_persisted(self.id, self.base, self.cause, self.regions, self.verdicts)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedDocumentState {
    schema_version: u32,
    content_digest: String,
    revision: u64,
    selection: ByteSelection,
    selection_history: Vec<ByteSelection>,
    head: Id,
    lineage: Vec<Id>,
    actions: Vec<PersistedAction>,
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
    persistence: Option<Persistence>,
    /// Which grammar this document is written in, decided once at open from
    /// the file name. The surface cannot re-derive it later: the projection is
    /// a window of bytes, and a window into a `.rs` file is indistinguishable
    /// from a fenced block inside Markdown.
    format: DocumentFormat,
}

impl DocumentSurface {
    /// Open one manuscript. This is the only constructor exposed by the module.
    pub fn open(source: DocumentOpen) -> Result<Self, DocumentError> {
        let (bytes, persistence, format) = match source {
            DocumentOpen::Bytes(bytes) => (bytes, None, DocumentFormat::Markdown),
            DocumentOpen::ScaleFixture => (document_fixture(), None, DocumentFormat::Markdown),
            DocumentOpen::Persistent { path, state_path } => {
                let bytes =
                    fs::read(&path).map_err(|source| persistence_error("read", &path, source))?;
                let format = DocumentFormat::of_path(&path.to_string_lossy());
                (bytes, Some(Persistence { path, state_path }), format)
            }
        };
        let persisted = persistence
            .as_ref()
            .map(|target| read_persisted_state(&target.state_path, &bytes))
            .transpose()?
            .flatten();
        let source =
            SourceSnapshot::read_checked(bytes).map_err(|_| DocumentError::InvalidProjection)?;
        let (manuscript, selection, selection_history, revision) = match persisted {
            Some(state) => {
                let history = state
                    .actions
                    .into_iter()
                    .map(PersistedAction::into_action)
                    .collect();
                (
                    Manuscript::open_at(
                        source,
                        Lineage::from_ids(state.lineage),
                        state.head,
                        history,
                    )?,
                    state.selection,
                    state.selection_history,
                    state.revision,
                )
            }
            None => {
                let lineage = Lineage::fresh(source.block_count());
                (
                    Manuscript::open(source, lineage)?,
                    collapsed(0),
                    Vec::new(),
                    0,
                )
            }
        };
        let document = Self {
            manuscript,
            selection,
            composition: None,
            selection_history,
            revision,
            persistence,
            format,
        };
        document.validate_persisted_state()?;
        Ok(document)
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
            DocumentInput::Save => self.save(),
        }
    }

    /// Return one bounded projection resolved from a block viewport.
    ///
    /// The returned text already contains any in-flight preedit, and both
    /// offsets are relative to it, so a platform consumer renders the string
    /// directly instead of splicing bytes or translating coordinates.
    pub fn project(&self, viewport: DocumentViewport) -> Result<DocumentProjection, DocumentError> {
        let total_blocks = self.manuscript.head().blocks().len();
        let first_block = self.anchor_block(viewport.anchor, viewport.block_count, total_blocks);
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
        let window = byte_range.start..end;
        let mut text = String::from_utf8(self.manuscript.read_bytes(window.clone())?)
            .map_err(|_| DocumentError::InvalidProjection)?;
        let mut selection = self.window_range(selection_range(self.selection), &window);
        let composition = self
            .composition
            .as_ref()
            .filter(|composition| {
                composition.range.start >= window.start && composition.range.end <= window.end
            })
            .map(|composition| {
                let local = self.window_range(composition.range.clone(), &window);
                text.replace_range(local.clone(), &composition.text);
                let range = local.start..local.start + composition.text.len();
                selection = range.start + composition.cursor..range.start + composition.cursor;
                range
            });
        let line_starts = if viewport.columns_em > 0.0 {
            // 预设暂时固定简中：文档尚未携带语言字段。它决定行尾标点压不压
            // （GB/T 15834 压半字 vs JLREQ 保留后置空白）与混排间距值，
            // 所以接上文档语言之前，日文正文的行尾会按中文规矩排。
            refrain_core::typeset::line_starts(
                &text,
                viewport.columns_em,
                &refrain_core::typeset::ZH_HANS,
            )
        } else {
            vec![0]
        };
        Ok(DocumentProjection {
            revision: self.revision,
            total_bytes: self.manuscript.byte_len(),
            total_blocks,
            first_block,
            block_count: end_block - first_block,
            window_start: window.start,
            text,
            selection,
            document_selection: selection_range(self.selection),
            composition,
            line_starts,
            format: self.format,
        })
    }

    /// Resolve one anchor into the first block a projection starts at.
    ///
    /// A scroll anchor maps pixels to blocks over a uniform-height track and
    /// stops at the last full window, so scrolling past the end still shows the
    /// document's tail rather than an empty projection.
    fn anchor_block(&self, anchor: DocumentAnchor, block_count: usize, total: usize) -> usize {
        match anchor {
            DocumentAnchor::Block(index) => index.min(total),
            DocumentAnchor::Scroll {
                offset,
                block_height,
            } => {
                let last_window = total.saturating_sub(block_count.min(total));
                if offset.is_nan() || block_height <= 0.0 {
                    return 0;
                }
                let projected = (offset / block_height).floor();
                if projected <= 0.0 {
                    return 0;
                }
                if projected >= last_window as f64 {
                    return last_window;
                }
                (projected as usize).min(last_window)
            }
        }
    }

    /// Clamp one manuscript range into offsets inside the projected window.
    fn window_range(&self, range: Range<usize>, window: &Range<usize>) -> Range<usize> {
        let length = window.end - window.start;
        let start = range.start.saturating_sub(window.start).min(length);
        let end = range.end.saturating_sub(window.start).min(length);
        start..end.max(start)
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

    fn save(&mut self) -> Result<(), DocumentError> {
        let persistence = self
            .persistence
            .as_ref()
            .ok_or(DocumentError::NotPersistent)?;
        let bytes = self
            .manuscript
            .materialize()
            .map_err(TextRefusal::SourceDrift)?;
        let state = PersistedDocumentState {
            schema_version: 1,
            content_digest: digest::content_hex(&bytes),
            revision: self.revision,
            selection: self.selection,
            selection_history: self.selection_history.clone(),
            head: self.manuscript.head().id(),
            lineage: self.manuscript.lineage_ids(),
            actions: self
                .manuscript
                .actions()
                .iter()
                .map(PersistedAction::from_action)
                .collect(),
        };
        let encoded = serde_json::to_vec(&state).map_err(|source| DocumentError::StateDecode {
            path: persistence.state_path.clone(),
            source,
        })?;
        replace_file_atomically(&persistence.path, &bytes, |_| Ok(()))
            .map_err(|source| persistence_error("save", &persistence.path, source))?;
        replace_state_file_atomically(&persistence.state_path, &encoded)
            .map_err(|source| persistence_error("save state", &persistence.state_path, source))?;
        Ok(())
    }

    fn validate_persisted_state(&self) -> Result<(), DocumentError> {
        let Some(persistence) = &self.persistence else {
            return Ok(());
        };
        if self.selection_history.len() != self.manuscript.actions().len() {
            return Err(DocumentError::InvalidState {
                path: persistence.state_path.clone(),
                detail: format!(
                    "{} selection snapshots for {} actions",
                    self.selection_history.len(),
                    self.manuscript.actions().len()
                ),
            });
        }
        self.validate_range(selection_range(self.selection))
            .map_err(|error| DocumentError::InvalidState {
                path: persistence.state_path.clone(),
                detail: error.to_string(),
            })?;
        for selection in &self.selection_history {
            self.validate_range(selection_range(*selection))
                .map_err(|error| DocumentError::InvalidState {
                    path: persistence.state_path.clone(),
                    detail: error.to_string(),
                })?;
        }
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

fn persistence_error(
    action: &'static str,
    path: &std::path::Path,
    source: io::Error,
) -> DocumentError {
    DocumentError::Persistence {
        action,
        path: path.to_path_buf(),
        source,
    }
}

fn read_persisted_state(
    state_path: &std::path::Path,
    bytes: &[u8],
) -> Result<Option<PersistedDocumentState>, DocumentError> {
    let encoded = match fs::read(state_path) {
        Ok(encoded) => encoded,
        Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(persistence_error("read state", state_path, source)),
    };
    let state: PersistedDocumentState =
        serde_json::from_slice(&encoded).map_err(|source| DocumentError::StateDecode {
            path: state_path.to_path_buf(),
            source,
        })?;
    if state.schema_version != 1 {
        return Err(DocumentError::InvalidState {
            path: state_path.to_path_buf(),
            detail: format!("unsupported schema version {}", state.schema_version),
        });
    }
    if state.content_digest != digest::content_hex(bytes) {
        return Ok(None);
    }
    if state.selection_history.len() != state.actions.len() {
        return Err(DocumentError::InvalidState {
            path: state_path.to_path_buf(),
            detail: format!(
                "{} selection snapshots for {} actions",
                state.selection_history.len(),
                state.actions.len()
            ),
        });
    }
    Ok(Some(state))
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
            anchor: DocumentAnchor::Block(first_block),
            block_count,
            max_bytes: 40_960,
            columns_em: 0.0,
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
    fn a_scroll_offset_resolves_against_the_documents_own_block_count() {
        let document = DocumentSurface::open(DocumentOpen::ScaleFixture).unwrap();
        let scrolled = |offset: f64| DocumentViewport {
            anchor: DocumentAnchor::Scroll {
                offset,
                block_height: 36.0,
            },
            block_count: 96,
            max_bytes: 40_960,
            columns_em: 0.0,
        };

        // The top of the track is the first block, whatever the offset's sign.
        assert_eq!(document.project(scrolled(0.0)).unwrap().first_block, 0);
        assert_eq!(document.project(scrolled(-10.0)).unwrap().first_block, 0);

        // A pixel offset maps to the block at that height.
        assert_eq!(
            document
                .project(scrolled(36.0 * 50_000.0))
                .unwrap()
                .first_block,
            50_000
        );

        // Scrolling past the end stops at the last full window instead of
        // projecting an empty tail — the block count is a Rust-side fact.
        let last_window = DOCUMENT_FIXTURE_BLOCKS - 96;
        let past_end = document.project(scrolled(36.0 * 1_000_000.0)).unwrap();
        assert_eq!(past_end.first_block, last_window);
        assert_eq!(past_end.block_count, 96);

        // NaN has no position so it stays at the head; infinity means the reader
        // dragged to the very bottom, which is the last window.
        assert_eq!(document.project(scrolled(f64::NAN)).unwrap().first_block, 0);
        assert_eq!(
            document
                .project(scrolled(f64::INFINITY))
                .unwrap()
                .first_block,
            last_window
        );
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
        // The projection carries the preedit already spliced into the visible
        // text, with the composition range and caret expressed against it.
        let composing = document.project(viewport(0, 3)).unwrap();
        let range = composing.composition.clone().unwrap();
        assert_eq!(&composing.text[range.clone()], "输入中");
        // The caret sits at the preedit's own cursor, six bytes in, not at its end.
        assert_eq!(composing.selection, range.start + 6..range.start + 6);
        assert!(composing.selection.end < range.end);
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
        assert_eq!(restored.selection, selection_range(selection));
    }

    #[test]
    fn the_projection_carries_the_grammar_the_file_name_declares() {
        use std::fs;
        use std::sync::atomic::{AtomicU64, Ordering};

        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let directory = std::env::temp_dir().join(format!(
            "refrain-native-document-format-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(&directory).unwrap();

        // 同样的字节，两个扩展名。这是判别条件：格式必须来自文件名，
        // 不能从内容猜——`fn main` 在 Markdown 里是一段围栏代码的内容，
        // 在 `.rs` 里是整份稿子的语法。
        let bytes = "fn main() {}\n";
        let mut opened = Vec::new();
        for (name, expected) in [
            ("draft.rs", DocumentFormat::Rust),
            ("draft.md", DocumentFormat::Markdown),
            ("draft.py", DocumentFormat::Python),
        ] {
            let path = directory.join(name);
            let state_path = directory.join(format!("{name}.state.json"));
            fs::write(&path, bytes).unwrap();
            let document =
                DocumentSurface::open(DocumentOpen::Persistent { path, state_path }).unwrap();
            let projection = document.project(viewport(0, 4)).unwrap();
            assert_eq!(
                projection.format, expected,
                "{name} projected as {:?}",
                projection.format
            );
            opened.push(projection.format.wire_code());
        }
        // 三个号必须互不相同，否则「格式过界了」这句话是空的：
        // 全部返回 0 也能让上面三条断言之一通过。
        opened.sort_unstable();
        opened.dedup();
        assert_eq!(
            opened.len(),
            3,
            "the formats collapsed to the same wire code"
        );
    }

    #[test]
    fn persistent_surface_reopens_bytes_revision_selection_and_undo_history() {
        use std::fs;
        use std::sync::atomic::{AtomicU64, Ordering};

        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let directory = std::env::temp_dir().join(format!(
            "refrain-native-document-persistence-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("draft.md");
        let state_path = directory.join("draft.state.json");
        let original = "alpha\n\nbeta";
        fs::write(&path, original).unwrap();

        let mut document = DocumentSurface::open(DocumentOpen::Persistent {
            path: path.clone(),
            state_path: state_path.clone(),
        })
        .unwrap();
        document
            .apply(DocumentInput::SetSelection(collapsed(2)))
            .unwrap();
        document
            .apply(DocumentInput::InsertText("中".to_owned()))
            .unwrap();
        document.apply(DocumentInput::Save).unwrap();
        let saved = document.project(viewport(0, 2)).unwrap();
        assert_eq!(saved.text, "al中pha\n\nbeta");
        assert_eq!(saved.revision, 2);
        assert_eq!(saved.selection, 5..5);
        drop(document);

        let mut reopened = DocumentSurface::open(DocumentOpen::Persistent {
            path: path.clone(),
            state_path: state_path.clone(),
        })
        .unwrap();
        let restored = reopened.project(viewport(0, 2)).unwrap();
        assert_eq!(restored.text, "al中pha\n\nbeta");
        assert_eq!(restored.revision, 2);
        assert_eq!(restored.selection, 5..5);
        reopened.apply(DocumentInput::Undo).unwrap();
        let undone = reopened.project(viewport(0, 2)).unwrap();
        assert_eq!(undone.text, original);
        assert_eq!(undone.revision, 3);
        assert_eq!(undone.selection, 2..2);

        fs::remove_dir_all(directory).unwrap();
    }

    /// An editor outside RefRain rewrote the file between sessions. The saved
    /// state describes bytes that no longer exist, so replaying its undo
    /// history would restore text the author never wrote. `read_persisted_state`
    /// compares the content digest and drops the state; this pins that the
    /// reopened surface shows the new bytes and offers no undo.
    #[test]
    fn external_bytes_drop_the_saved_undo_history_instead_of_replaying_it() {
        use std::sync::atomic::{AtomicU64, Ordering};

        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let directory = std::env::temp_dir().join(format!(
            "refrain-native-document-external-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("draft.md");
        let state_path = directory.join("draft.state.json");
        fs::write(&path, "原文").unwrap();

        let mut document = DocumentSurface::open(DocumentOpen::Persistent {
            path: path.clone(),
            state_path: state_path.clone(),
        })
        .unwrap();
        document
            .apply(DocumentInput::SetSelection(collapsed("原".len())))
            .unwrap();
        document
            .apply(DocumentInput::InsertText("新".to_owned()))
            .unwrap();
        document.apply(DocumentInput::Save).unwrap();
        drop(document);

        fs::write(&path, "外部改写").unwrap();
        let mut reopened = DocumentSurface::open(DocumentOpen::Persistent {
            path: path.clone(),
            state_path,
        })
        .unwrap();
        let projection = reopened.project(viewport(0, 1)).unwrap();
        assert_eq!(projection.text, "外部改写");
        assert!(matches!(
            reopened.apply(DocumentInput::Undo),
            Err(DocumentError::Text(TextRefusal::NothingToUndo))
        ));

        fs::remove_dir_all(directory).unwrap();
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
        // A selection anchored before the window clamps to its start, so the
        // offsets a renderer receives always index the projected text.
        let projected = document.project(viewport(50_000, 24)).unwrap();
        assert_eq!(projected.selection, 0..0);
        assert_eq!(projected.first_block, 50_000);
        assert!(projected.window_start > first.text.len());

        // Back at the head, the same selection reads as a real range.
        let head = document.project(viewport(0, 24)).unwrap();
        assert_eq!(head.selection.start, 0);
        assert!(head.selection.end > 0);
    }
}
