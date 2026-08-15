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
use std::path::{Path, PathBuf};
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
    /// 回到某一条动作刚落下的状态：它之后的动作全部撤销，它自己保留。
    /// 领域先查再动——上面有带裁决的动作时整次拒绝，不做半截回档。
    RevertTo {
        action: Id,
    },
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
    /// Keep the block that holds the caret in view.
    ///
    /// The window stays where it is while the caret is inside it. It moves the
    /// minimum distance when the caret is outside it. An action that moves the
    /// caret uses this anchor, because the author must see the character that
    /// the action wrote.
    Caret { window_first_block: usize },
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

/// 一条要锚进当前正文的来源。
///
/// 批注与提案共用这一个类型：它们都以块身份锚（block_id 在编辑中稳定），
/// 解析规则不同所以分两个变体。解析不出就省略——绝不钉错段落。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnchorSource {
    /// 批注：块内字节区间 + 当时被标记的原文。区间越出块现在的长度、或那
    /// 一段的字已经不是当时的原文（作者改过了），都按「锚不上」省略——
    /// quote 仍在批注名录里说得出它当初标的是什么。id 是批注的稳定身份
    /// （uuid 的 36 字节串），界面的动作按它点名。
    Annotation {
        id: String,
        block_id: String,
        start: u64,
        end: u64,
        quote: String,
        comment: bool,
    },
    /// 提案：按切片顺序的候选文本（评审切片的 Same/Delete 片，由裁决那侧
    /// 的切法给出）。第一个还能在块当前文本里锚上的落点；全部锚不上→省略。
    /// id 是提案身份——印点上的裁决动作按它记账。
    Proposal {
        id: String,
        block_id: String,
        candidates: Vec<String>,
    },
}

/// 锚定区间的种类。线码跨 ABI（1=高亮 2=评论 3=提案），
/// 与生成的 `AnchorRangeWire.kind` 一张表。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum AnchorKind {
    Highlight = 1,
    Comment = 2,
    Proposal = 3,
}

/// 锚进当前正文的一段：文档字节坐标（不是窗口坐标——解析随内容变、
/// 不随窗口变；视图拿 window_start 自剪）。id 是来源的稳定身份
/// （36 字节的 uuid 串），界面的动作按它点名。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AnchoredRange {
    pub start: u64,
    pub end: u64,
    pub kind: AnchorKind,
    pub id: [u8; 36],
}

/// 来源身份 → 线槽：uuid 串恰好 36 字节。不是这个形状的来源不锚——
/// 一个点不了名的印点，上面的动作落不下去。
fn anchor_id(id: &str) -> Option<[u8; 36]> {
    let bytes = id.as_bytes();
    if bytes.len() != 36 {
        return None;
    }
    let mut out = [0u8; 36];
    out.copy_from_slice(bytes);
    Some(out)
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
            DocumentInput::RevertTo { action } => self.revert_to(action),
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
            // 代码与散文分流（P3.7）：代码走等宽硬切（无禁则、无行尾调整），
            // 散文走禁则与候选。判据是格式——Markdown 与 LaTeX 是写作格式，
            // 中文注释与公式文字按散文排；其余格式按代码排。
            if self.format.is_code() {
                refrain_core::typeset::line_starts_code(&text, viewport.columns_em)
            } else {
                // 预设暂时固定简中：文档尚未携带语言字段。它决定行尾标点压不压
                // （GB/T 15834 压半字 vs JLREQ 保留后置空白）与混排间距值，
                // 所以接上文档语言之前，日文正文的行尾会按中文规矩排。
                refrain_core::typeset::line_starts(
                    &text,
                    viewport.columns_em,
                    &refrain_core::typeset::ZH_HANS,
                )
            }
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

    /// 把一批锚定来源解析成当前正文的文档字节区间。    ///
    /// 解析只做一次查表：块身份 → 当前字节包络（`block_byte_range`），锚
    /// 不上的来源（块没了、原文对不上、候选全落空）一律省略——界面按返回
    /// 的顺序分层绘制，缺席的那一个就是它「锚不上」的全部表示，绝不钉错
    /// 段落。
    #[must_use]
    pub fn anchored_ranges(&self, sources: &[AnchorSource]) -> Vec<AnchoredRange> {
        let mut resolved = Vec::new();
        for source in sources {
            match source {
                AnchorSource::Annotation {
                    id,
                    block_id,
                    start,
                    end,
                    quote,
                    comment,
                } => {
                    let Some(id) = anchor_id(id) else { continue };
                    let Some((start, end)) = self.anchor_in_block(block_id, |text| {
                        let (start, end) = (*start as usize, *end as usize);
                        if start >= end || end > text.len() {
                            return None;
                        }
                        if !text.is_char_boundary(start) || !text.is_char_boundary(end) {
                            return None;
                        }
                        if &text[start..end] != quote {
                            return None;
                        }
                        Some(start..end)
                    }) else {
                        continue;
                    };
                    resolved.push(AnchoredRange {
                        start,
                        end,
                        kind: if *comment {
                            AnchorKind::Comment
                        } else {
                            AnchorKind::Highlight
                        },
                        id,
                    });
                }
                AnchorSource::Proposal {
                    id,
                    block_id,
                    candidates,
                } => {
                    let Some(id) = anchor_id(id) else { continue };
                    let Some((start, end)) = self.anchor_in_block(block_id, |text| {
                        candidates
                            .iter()
                            .filter(|candidate| !candidate.is_empty())
                            .find_map(|candidate| {
                                text.find(candidate.as_str())
                                    .map(|at| at..at + candidate.len())
                            })
                    }) else {
                        continue;
                    };
                    resolved.push(AnchoredRange {
                        start,
                        end,
                        kind: AnchorKind::Proposal,
                        id,
                    });
                }
            }
        }
        resolved
    }

    /// 在一个块里按块内规则解析，交出文档字节坐标。块没了 → None。
    fn anchor_in_block(
        &self,
        block_id: &str,
        locate: impl FnOnce(&str) -> Option<Range<usize>>,
    ) -> Option<(u64, u64)> {
        let target = block_id.parse::<Id>().ok()?;
        let blocks = self.manuscript.head().blocks();
        let (index, block) = blocks
            .iter()
            .enumerate()
            .find(|(_, block)| block.id() == target)?;
        let within = locate(block.text())?;
        // 包络起点即块文本起点（分隔符附在末尾），块内偏移因此直接平移成
        // 文档字节坐标。
        let envelope = self.manuscript.block_byte_range(index..index + 1).ok()?;
        Some((
            (envelope.start + within.start) as u64,
            (envelope.start + within.end) as u64,
        ))
    }

    /// Resolve one anchor into the first block a projection starts at.
    ///
    /// A scroll anchor maps pixels to blocks over a uniform-height track and
    /// stops at the last full window, so scrolling past the end still shows the
    /// document's tail rather than an empty projection.
    fn anchor_block(&self, anchor: DocumentAnchor, block_count: usize, total: usize) -> usize {
        match anchor {
            DocumentAnchor::Block(index) => index.min(total),
            // Injection proof for this arm: return `window` unconditionally and
            // `the_caret_anchor_brings_the_caret_into_the_window` fails on the
            // first assertion.
            DocumentAnchor::Caret { window_first_block } => {
                let last_window = total.saturating_sub(block_count.min(total));
                let window = window_first_block.min(last_window);
                // A range selection keeps the window. The author selected text;
                // the author did not ask to go somewhere. "Select all" would
                // otherwise move the window to the end of the manuscript.
                if self.selection.anchor != self.selection.focus {
                    return window;
                }
                let caret = selection_range(self.selection).end;
                let Some(block) = self.manuscript.block_at_offset(caret) else {
                    return window;
                };
                if block < window {
                    return block;
                }
                let window_end = window.saturating_add(block_count);
                if block >= window_end {
                    return block
                        .saturating_sub(block_count.saturating_sub(1))
                        .min(last_window);
                }
                window
            }
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

    fn revert_to(&mut self, action: Id) -> Result<(), DocumentError> {
        let transitions = self.manuscript.revert_to(action)?;
        // 回到链尖是空走：什么都没动，revision 也不该涨——涨了界面会以为
        // 字节变了去重画。动了才与 undo 同一口径：一步弹一层选区史。
        if transitions.is_empty() {
            return Ok(());
        }
        for _ in 0..transitions.len() {
            self.selection = self.selection_history.pop().unwrap_or_else(|| collapsed(0));
        }
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
        if let Err(error) = self.manuscript.replace_bytes(range.clone(), text, cause) {
            return Err(error.into());
        }
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

/// 一次原生保存落盘的动作链，给历史同步用。
pub struct SavedChain {
    pub actions: Vec<TextAction>,
    pub head: Id,
}

/// 读一次原生保存写下的状态文件，取出动作链。
///
/// 解析仍只有 `read_persisted_state` 一处——这里只是它的一个调用方，不是
/// 第二份解析。文件刚由 `save` 原子写下，字节与状态同真，digest 校验自然
/// 通过；外部改动过文件时这里拿不到状态（与打开路径同一条规则），同步方
/// 把这份历史丢弃而不是重放到别人的字节上。
pub fn read_saved_chain(
    path: &Path,
    state_path: &Path,
) -> Result<Option<SavedChain>, DocumentError> {
    let bytes = fs::read(path).map_err(|source| persistence_error("read", path, source))?;
    let Some(state) = read_persisted_state(state_path, &bytes)? else {
        return Ok(None);
    };
    Ok(Some(SavedChain {
        actions: state
            .actions
            .into_iter()
            .map(PersistedAction::into_action)
            .collect(),
        head: state.head,
    }))
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

    /// 断行分流（P3.7）：同样的字节，`.rs` 走等宽硬切、`.md` 走散文候选。
    /// 一行 26 个 ASCII 字符在 5 em 版心里，硬切断在词中间，散文退到空格。
    /// 把 `is_code` 改成恒 false（或恒 true），这条测试失败。
    #[test]
    fn code_files_break_hard_while_prose_breaks_at_candidates() {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let directory = std::env::temp_dir().join(format!(
            "refrain-native-document-code-break-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed),
        ));
        std::fs::create_dir_all(&directory).unwrap();

        let bytes = "abcdefgh ijklmnop qrstuvwx
";
        let mut starts_by_format = Vec::new();
        for name in ["draft.rs", "draft.md"] {
            let path = directory.join(name);
            let state_path = directory.join(format!("{name}.state.json"));
            std::fs::write(&path, bytes).unwrap();
            let document =
                DocumentSurface::open(DocumentOpen::Persistent { path, state_path }).unwrap();
            let mut viewport = viewport(0, 1);
            viewport.columns_em = 5.0;
            let projection = document.project(viewport).unwrap();
            assert_eq!(
                projection.line_starts,
                if name.ends_with(".rs") {
                    vec![0, 10, 20, 27]
                } else {
                    vec![0, 9, 18, 27]
                },
                "{name} broke at the wrong places"
            );
            starts_by_format.push(projection.line_starts);
        }
        assert_ne!(
            starts_by_format[0], starts_by_format[1],
            "code and prose must break differently"
        );
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

    /// The caret anchor keeps the caret in view and moves the minimum distance.
    ///
    /// Without this rule an action that moves the caret re-projects at the last
    /// scroll offset that the surface sent. The window then stays where the
    /// author scrolled, and the character that the author just wrote is off the
    /// screen. Measured before the rule: from block 99,904 a caret at byte 0
    /// left the window at block 99,904.
    #[test]
    fn the_caret_anchor_brings_the_caret_into_the_window() {
        let mut document = DocumentSurface::open(DocumentOpen::ScaleFixture).unwrap();
        let caret = |window: usize| DocumentViewport {
            anchor: DocumentAnchor::Caret {
                window_first_block: window,
            },
            block_count: 32,
            max_bytes: 40_960,
            columns_em: 0.0,
        };

        // The caret is at byte 0, and the window is at the tail: the window
        // comes back to the caret.
        document
            .apply(DocumentInput::SetSelection(ByteSelection {
                anchor: 0,
                focus: 0,
            }))
            .unwrap();
        assert_eq!(document.project(caret(99_904)).unwrap().first_block, 0);

        // The caret is inside the window: the window does not move.
        let window = document.project(viewport(50_000, 32)).unwrap();
        let inside = window.window_start;
        document
            .apply(DocumentInput::SetSelection(ByteSelection {
                anchor: inside,
                focus: inside,
            }))
            .unwrap();
        assert_eq!(
            document.project(caret(50_000)).unwrap().first_block,
            50_000,
            "a caret inside the window must not move it"
        );

        // The caret is below the window: the window moves the minimum distance,
        // and the caret's block is the last block in it.
        let below = document.project(viewport(50_100, 32)).unwrap();
        let offset = below.window_start;
        document
            .apply(DocumentInput::SetSelection(ByteSelection {
                anchor: offset,
                focus: offset,
            }))
            .unwrap();
        let moved = document.project(caret(50_000)).unwrap();
        assert!(
            moved.first_block > 50_000,
            "a caret below the window must move it down, got {}",
            moved.first_block
        );
        assert!(moved.first_block <= 50_100);

        // A range selection keeps the window, even when its focus is at the end
        // of the manuscript. Select-all must not move the author.
        let total_bytes = document.project(viewport(0, 1)).unwrap().total_bytes;
        document
            .apply(DocumentInput::SetSelection(ByteSelection {
                anchor: 0,
                focus: total_bytes,
            }))
            .unwrap();
        assert_eq!(document.project(caret(0)).unwrap().first_block, 0);
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

    /// 回档由表面直通领域的 `revert_to`：回到链尖是空走，回到中途把上面的
    /// 动作撤掉，已离链的 id 是具名拒绝而不是再撤一次。
    #[test]
    fn revert_to_walks_back_to_the_chosen_action_and_refuses_an_unknown_one() {
        use std::fs;
        use std::sync::atomic::{AtomicU64, Ordering};

        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let directory = std::env::temp_dir().join(format!(
            "refrain-native-document-revert-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("draft.md");
        let state_path = directory.join("draft.state.json");
        fs::write(&path, "原稿。\n").unwrap();

        let mut document = DocumentSurface::open(DocumentOpen::Persistent {
            path: path.clone(),
            state_path: state_path.clone(),
        })
        .unwrap();
        document
            .apply(DocumentInput::InsertText("第一笔。".to_owned()))
            .unwrap();
        document
            .apply(DocumentInput::InsertText("第二笔。".to_owned()))
            .unwrap();
        let revision = document.project(viewport(0, 1)).unwrap().revision;
        let first = document.manuscript.actions()[0].id();
        let tip = document.manuscript.actions()[1].id();

        // 回到链尖什么都没动：revision 不涨，界面不会白重画一次。
        document
            .apply(DocumentInput::RevertTo { action: tip })
            .unwrap();
        assert_eq!(document.project(viewport(0, 1)).unwrap().revision, revision);

        // 回到第一笔：第二笔离链，目标自己保留——「回到第 1 步」之后第 1 步
        // 还在历史里。
        document
            .apply(DocumentInput::RevertTo { action: first })
            .unwrap();
        let reverted = document.project(viewport(0, 1)).unwrap();
        assert_eq!(reverted.text, "第一笔。原稿。\n");
        assert_eq!(reverted.revision, revision + 1);
        assert_eq!(document.manuscript.actions().len(), 1);

        // 已离链的 id 是具名拒绝，不是「再撤一次」。
        assert!(matches!(
            document.apply(DocumentInput::RevertTo { action: tip }),
            Err(DocumentError::Text(TextRefusal::UnknownAction { .. }))
        ));

        fs::remove_dir_all(directory).unwrap();
    }
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

    /// 锚定测试共用的三块文档："alpha one" / "beta two gamma" / "delta three"。
    fn anchored_fixture() -> DocumentSurface {
        DocumentSurface::open(DocumentOpen::Bytes(
            "alpha one\n\nbeta two gamma\n\ndelta three"
                .as_bytes()
                .to_vec(),
        ))
        .unwrap()
    }

    #[test]
    fn annotation_anchors_at_its_block_in_document_coordinates() {
        let document = anchored_fixture();
        let block = document.manuscript.head().blocks().iter().nth(1).unwrap();
        let ranges = document.anchored_ranges(&[AnchorSource::Annotation {
            id: "11111111-1111-1111-1111-111111111111".to_string(),
            block_id: block.id().to_string(),
            start: 5,
            end: 8,
            quote: "two".to_string(),
            comment: false,
        }]);
        assert_eq!(ranges.len(), 1);
        let envelope = document.manuscript.block_byte_range(1..2).unwrap();
        assert_eq!(ranges[0].start as usize, envelope.start + 5);
        assert_eq!(ranges[0].end as usize, envelope.start + 8);
        assert_eq!(ranges[0].kind, AnchorKind::Highlight);
    }

    #[test]
    fn comment_annotation_carries_the_comment_kind() {
        let document = anchored_fixture();
        let block = document.manuscript.head().blocks().iter().next().unwrap();
        let ranges = document.anchored_ranges(&[AnchorSource::Annotation {
            id: "11111111-1111-1111-1111-111111111111".to_string(),
            block_id: block.id().to_string(),
            start: 0,
            end: 5,
            quote: "alpha".to_string(),
            comment: true,
        }]);
        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0].kind, AnchorKind::Comment);
    }

    #[test]
    fn stale_or_lost_annotations_are_omitted_never_misplaced() {
        let document = anchored_fixture();
        let blocks = document.manuscript.head().blocks();
        let first = blocks.iter().next().unwrap().id().to_string();
        // 原文对不上（作者改过了）。
        let stale_quote = AnchorSource::Annotation {
            id: "11111111-1111-1111-1111-111111111111".to_string(),
            block_id: first.clone(),
            start: 0,
            end: 5,
            quote: "ALPHA".to_string(),
            comment: false,
        };
        // 区间越出块现在的长度。
        let out_of_range = AnchorSource::Annotation {
            id: "11111111-1111-1111-1111-111111111111".to_string(),
            block_id: first,
            start: 0,
            end: 500,
            quote: "alpha".to_string(),
            comment: false,
        };
        // 块没了。
        let lost_block = AnchorSource::Annotation {
            id: "11111111-1111-1111-1111-111111111111".to_string(),
            block_id: Id::new().to_string(),
            start: 0,
            end: 1,
            quote: "x".to_string(),
            comment: false,
        };
        let ranges = document.anchored_ranges(&[stale_quote, out_of_range, lost_block]);
        assert!(ranges.is_empty());
    }

    #[test]
    fn proposal_anchors_at_the_first_candidate_that_still_matches() {
        let document = anchored_fixture();
        let block = document.manuscript.head().blocks().iter().nth(1).unwrap();
        let ranges = document.anchored_ranges(&[AnchorSource::Proposal {
            id: "33333333-3333-3333-3333-333333333333".to_string(),
            block_id: block.id().to_string(),
            // 第一个候选锚不上，第二个落上；空候选不占位。
            candidates: vec![
                "不存在的一句".to_string(),
                "".to_string(),
                "gamma".to_string(),
            ],
        }]);
        assert_eq!(ranges.len(), 1);
        let envelope = document.manuscript.block_byte_range(1..2).unwrap();
        // "beta two gamma" 里 "gamma" 从 9 开始。
        assert_eq!(ranges[0].start as usize, envelope.start + 9);
        assert_eq!(ranges[0].end as usize, envelope.start + 14);
        assert_eq!(ranges[0].kind, AnchorKind::Proposal);

        let none = document.anchored_ranges(&[AnchorSource::Proposal {
            id: "33333333-3333-3333-3333-333333333333".to_string(),
            block_id: block.id().to_string(),
            candidates: vec!["全落空".to_string()],
        }]);
        assert!(none.is_empty());
    }
}
