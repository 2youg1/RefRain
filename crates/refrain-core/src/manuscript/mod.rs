mod action;
mod align;
mod block_offsets;
mod block_sequence;
mod block_text;
mod byte_sequence;
mod command;
mod decision;
mod materialize;
mod persist;
mod review;

pub use block_sequence::BlockSequence;
pub use block_text::BlockText;
pub use command::{EditorAction, EditorChange, Insertion, Replacement, TextCommand};
pub use decision::{DecisionBatch, Verdict, VerdictKind, merged_text};
pub use persist::{PersistedBlock, PersistedRegion};
pub use review::{
    ChangeClass, EditScope, Proposal, ReviewSlice, ReviewSliceId, SliceKind, classify_change,
};

use crate::{BlockScan, Id, SourceDrift, SourceLayout};
use block_offsets::BlockOffsets;
use byte_sequence::ByteSequence;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use thiserror::Error;

/// Immutable text and block intervals read from one manuscript revision.
///
/// The text is held as a `str`, not as bytes, because that is where the UTF-8
/// question is settled: once, when the snapshot is read. Every block is then an
/// interval of a string already known to be valid, so reading a block's text is
/// a slice rather than another scan. Blocks are read on every render, diff,
/// export and search, and read in exactly once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceSnapshot {
    text: Arc<String>,
    layout: SourceLayout,
    scan: BlockScan,
}

impl SourceSnapshot {
    /// Read a snapshot whose bytes are already known to be valid UTF-8,
    /// scanned as Markdown.
    ///
    /// # Panics
    ///
    /// Panics on invalid bytes. Callers holding bytes of unknown provenance —
    /// anything read from disk — want [`SourceSnapshot::read_checked`].
    #[must_use]
    pub fn read(bytes: Vec<u8>) -> Self {
        Self::read_checked(bytes).expect("SourceSnapshot::read requires valid UTF-8")
    }

    /// Read a snapshot whose bytes are already known to be valid UTF-8,
    /// scanned by the given rule.
    ///
    /// # Panics
    ///
    /// Panics on invalid bytes. Callers holding bytes of unknown provenance —
    /// anything read from disk — want [`SourceSnapshot::read_checked_with`].
    #[must_use]
    pub fn read_with(bytes: Vec<u8>, scan: BlockScan) -> Self {
        Self::read_checked_with(bytes, scan)
            .expect("SourceSnapshot::read_with requires valid UTF-8")
    }

    /// Read a snapshot, refusing bytes that are not valid UTF-8.
    ///
    /// The whole buffer is validated once, here. Every block is then a byte
    /// interval of a string already known to be valid, so reading a block's
    /// text is a slice rather than another scan — which matters because blocks
    /// are read on every render, diff, export and search, while they are only
    /// read in once.
    ///
    /// # Errors
    ///
    /// Returns [`std::str::Utf8Error`] naming where the bytes stop being
    /// valid UTF-8.
    pub fn read_checked(bytes: Vec<u8>) -> Result<Self, std::str::Utf8Error> {
        Self::read_checked_with(bytes, BlockScan::Markdown)
    }

    /// Read a snapshot scanned by the given rule, refusing bytes that are not
    /// valid UTF-8. The scan is kept: every re-scan an edit triggers must
    /// divide the bytes the same way the first read did, or the block model
    /// and the byte offsets would drift apart.
    ///
    /// # Errors
    ///
    /// Returns [`std::str::Utf8Error`] naming where the bytes stop being
    /// valid UTF-8.
    pub fn read_checked_with(bytes: Vec<u8>, scan: BlockScan) -> Result<Self, std::str::Utf8Error> {
        let layout = scan.layout(&bytes);
        // `from_utf8` consumes the vector rather than copying it, so settling
        // the question here costs a scan and no allocation.
        let text = String::from_utf8(bytes).map_err(|error| error.utf8_error())?;
        Ok(Self {
            text: Arc::new(text),
            layout,
            scan,
        })
    }

    /// The snapshot's bytes. Valid UTF-8 by construction.
    #[must_use]
    pub fn bytes(&self) -> &[u8] {
        self.text.as_bytes()
    }

    /// The snapshot's text, shared. Blocks hold intervals of this.
    #[must_use]
    pub(crate) fn text(&self) -> Arc<String> {
        Arc::clone(&self.text)
    }

    #[must_use]
    pub fn block_count(&self) -> usize {
        self.layout.blocks().len()
    }
}

/// Persistent block identity supplied when a source snapshot is opened.
///
/// Two shapes, one vocabulary: an opening manuscript derives its whole
/// lineage from one random seed (`Derived`), and a manuscript resumed from a
/// persisted state carries the ids it was saved with (`Listed`). The open
/// path pays one mint instead of one per block — 200k mints measured 59 ms,
/// the whole v0.3.0 open budget — while the resumed path keeps its ids
/// verbatim and its duplicate check (a restored state must describe the
/// bytes it names).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lineage {
    /// One seed plus the block count; every id is a bijective image of the
    /// seed, so uniqueness holds by construction and `id_at` is O(1).
    Derived { seed: Id, blocks: usize },
    /// Explicit ids from a persisted state; duplicates are possible and are
    /// refused at open.
    Listed(Box<[Id]>),
}

impl Lineage {
    /// A lineage that costs one mint and derives every id from it. The ids
    /// are new on every open (the seed is fresh) and unique within the
    /// document (derivation is injective); see [`Id::derive`] for why this
    /// does not break INV-9.
    #[must_use]
    pub fn fresh(blocks: usize) -> Self {
        Self::Derived {
            seed: Id::new(),
            blocks,
        }
    }

    /// The lineage a persisted state was saved with. Resumed verbatim.
    #[must_use]
    pub fn from_ids(ids: Vec<Id>) -> Self {
        Self::Listed(ids.into_boxed_slice())
    }

    /// How many blocks this lineage names.
    #[must_use]
    pub fn len(&self) -> usize {
        match self {
            Self::Derived { blocks, .. } => *blocks,
            Self::Listed(ids) => ids.len(),
        }
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The id of one block. O(1) in both shapes.
    #[must_use]
    pub fn id_at(&self, index: usize) -> Id {
        match self {
            Self::Derived { seed, .. } => Id::derive(*seed, index),
            Self::Listed(ids) => ids[index],
        }
    }

    /// The index an id names in this lineage, if it names one at all.
    ///
    /// Derived lineages answer by inverting the bijection — O(1), no map.
    /// A `Listed` lineage has no derivation rule, so it answers nothing
    /// (the caller keeps its own map, as materialisation always did).
    #[must_use]
    pub fn index_of(&self, id: Id) -> Option<usize> {
        match self {
            Self::Derived { seed, blocks } => Id::invert(*seed, id, *blocks),
            Self::Listed(_) => None,
        }
    }

    /// Every id, oldest first. The persisted form a later open resumes from.
    #[must_use]
    pub fn to_vec(&self) -> Vec<Id> {
        match self {
            Self::Derived { seed, blocks } => {
                (0..*blocks).map(|index| Id::derive(*seed, index)).collect()
            }
            Self::Listed(ids) => ids.to_vec(),
        }
    }
}

/// A locatable manuscript block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    id: Id,
    text: BlockText,
}

impl Block {
    #[must_use]
    pub fn id(&self) -> Id {
        self.id
    }

    #[must_use]
    pub fn text(&self) -> &str {
        self.text.as_str()
    }
}

/// One immutable manuscript state produced by a completed Text Action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextHead {
    id: Id,
    blocks: BlockSequence,
    cause: String,
}

impl TextHead {
    #[must_use]
    pub fn id(&self) -> Id {
        self.id
    }

    #[must_use]
    pub fn blocks(&self) -> &BlockSequence {
        &self.blocks
    }

    #[must_use]
    pub fn block_ids(&self) -> Vec<Id> {
        self.blocks.iter().map(Block::id).collect()
    }

    #[must_use]
    pub fn text(&self) -> String {
        self.blocks
            .iter()
            .map(Block::text)
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    #[must_use]
    pub fn cause(&self) -> &str {
        &self.cause
    }
}

/// One minimal replacement over canonical source bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BytePatch {
    before: ByteSequence,
    start: usize,
    end: usize,
    replacement: Box<[u8]>,
}

impl BytePatch {
    fn at(before: &ByteSequence, start: usize, end: usize, replacement: &[u8]) -> Self {
        Self {
            before: before.clone(),
            start,
            end,
            replacement: replacement.to_vec().into_boxed_slice(),
        }
    }

    fn between(before: &ByteSequence, after: &[u8]) -> Self {
        let before_bytes = before.to_vec();
        if before_bytes == after {
            return Self {
                before: before.clone(),
                start: 0,
                end: 0,
                replacement: Box::default(),
            };
        }

        let prefix = before_bytes
            .iter()
            .zip(after)
            .take_while(|(left, right)| left == right)
            .count();
        let suffix = before_bytes[prefix..]
            .iter()
            .rev()
            .zip(after[prefix..].iter().rev())
            .take_while(|(left, right)| left == right)
            .count();
        Self {
            before: before.clone(),
            start: prefix,
            end: before_bytes.len() - suffix,
            replacement: after[prefix..after.len() - suffix]
                .to_vec()
                .into_boxed_slice(),
        }
    }

    pub fn apply(&self, source: &[u8]) -> Result<Vec<u8>, SourceDrift> {
        if !self.before.matches(source) {
            return Err(SourceDrift);
        }
        let mut output =
            Vec::with_capacity(source.len() - (self.end - self.start) + self.replacement.len());
        output.extend_from_slice(&source[..self.start]);
        output.extend_from_slice(&self.replacement);
        output.extend_from_slice(&source[self.end..]);
        Ok(output)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppliedRegion {
    before: Box<[Block]>,
    after: Box<[Block]>,
    left: Option<Id>,
    right: Option<Id>,
}

/// The reader-facing classification of one addressable change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EditKind {
    Replace,
    Insert,
    Remove,
}

/// One addressable difference produced by a Text Action.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Edit {
    id: Id,
    kind: EditKind,
    block: Id,
    before: Option<String>,
    after: Option<String>,
}

impl Edit {
    #[must_use]
    pub fn id(&self) -> Id {
        self.id
    }

    #[must_use]
    pub fn kind(&self) -> EditKind {
        self.kind
    }

    #[must_use]
    pub fn block(&self) -> Id {
        self.block
    }

    #[must_use]
    pub fn before(&self) -> Option<&str> {
        self.before.as_deref()
    }

    #[must_use]
    pub fn after(&self) -> Option<&str> {
        self.after.as_deref()
    }
}

fn edits_from_regions(regions: &[AppliedRegion]) -> Box<[Edit]> {
    let mut edits = Vec::new();
    for region in regions {
        let shared = region.before.len().min(region.after.len());
        for index in 0..shared {
            let before = &region.before[index];
            let after = &region.after[index];
            if before.text != after.text {
                edits.push(Edit {
                    id: Id::new(),
                    kind: EditKind::Replace,
                    block: after.id,
                    before: Some(before.text.to_string()),
                    after: Some(after.text.to_string()),
                });
            }
        }
        for before in &region.before[shared..] {
            edits.push(Edit {
                id: Id::new(),
                kind: EditKind::Remove,
                block: before.id,
                before: Some(before.text.to_string()),
                after: None,
            });
        }
        for after in &region.after[shared..] {
            edits.push(Edit {
                id: Id::new(),
                kind: EditKind::Insert,
                block: after.id,
                before: None,
                after: Some(after.text.to_string()),
            });
        }
    }
    edits.into_boxed_slice()
}

/// The blocks an action's regions name, deduplicated and sorted. Derived at
/// apply time and again at hydration, so the derivation lives in one place.
fn touched_of(regions: &[AppliedRegion]) -> Box<[Id]> {
    let mut touched = HashSet::new();
    for region in regions {
        touched.extend(region.before.iter().map(|block| block.id));
        touched.extend(region.after.iter().map(|block| block.id));
    }
    let mut touched = touched.into_iter().collect::<Vec<_>>();
    touched.sort();
    touched.into_boxed_slice()
}

/// The immutable audit record of one completed Text Action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextAction {
    id: Id,
    /// The Text Head the action was applied against. Undo restores exactly
    /// this head, so a revision id never names two different states.
    base: Id,
    cause: String,
    touched: Box<[Id]>,
    regions: Box<[AppliedRegion]>,
    edits: Box<[Edit]>,
    verdicts: Box<[Verdict]>,
}

impl TextAction {
    #[must_use]
    pub fn id(&self) -> Id {
        self.id
    }

    /// The head this action moved from — the revision [`Manuscript::undo_last`]
    /// restores when it reverts this action.
    #[must_use]
    pub fn base(&self) -> Id {
        self.base
    }

    #[must_use]
    pub fn cause(&self) -> &str {
        &self.cause
    }

    #[must_use]
    pub fn touched_blocks(&self) -> &[Id] {
        &self.touched
    }

    #[must_use]
    pub fn edits(&self) -> &[Edit] {
        &self.edits
    }

    #[must_use]
    pub fn verdicts(&self) -> &[Verdict] {
        &self.verdicts
    }
}

/// A completed command: audit record, new head, and canonical source patch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextTransition {
    action: TextAction,
    head: TextHead,
    byte_patch: BytePatch,
}

impl TextTransition {
    #[must_use]
    pub fn action(&self) -> &TextAction {
        &self.action
    }

    #[must_use]
    pub fn head(&self) -> &TextHead {
        &self.head
    }

    #[must_use]
    pub fn byte_patch(&self) -> &BytePatch {
        &self.byte_patch
    }
}

/// A command refused before any manuscript state moved.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TextRefusal {
    #[error("lineage has {actual} ids for {expected} source blocks")]
    LineageLength { expected: usize, actual: usize },
    #[error("source block {block} is not UTF-8")]
    InvalidUtf8 { block: usize },
    #[error("byte range {start}..{end} is outside document length {length}")]
    InvalidByteRange {
        start: usize,
        end: usize,
        length: usize,
    },
    #[error("byte offset {offset} splits a UTF-8 scalar")]
    InvalidByteBoundary { offset: usize },
    #[error("block range {start}..{end} is outside document block count {length}")]
    InvalidBlockRange {
        start: usize,
        end: usize,
        length: usize,
    },
    #[error("a replacement range cannot be empty")]
    EmptyRange,
    #[error("an Edit Scope cannot be empty")]
    EmptyScope,
    #[error("block {block} appears twice in one range")]
    DuplicateBlock { block: Id },
    #[error("block {block} appears twice in one Edit Scope")]
    DuplicateScopeBlock { block: Id },
    #[error("an insertion group cannot be empty")]
    EmptyInsertion,
    #[error("insertion member {index} resolves to {blocks} source blocks instead of one")]
    InvalidInsertionBlock { index: usize, blocks: usize },
    #[error("insertion member {index} carries bytes outside its source block")]
    InsertionBlockHasGaps { index: usize },
    #[error("lineage repeats block {block}")]
    DuplicateLineage { block: Id },
    #[error("editor action is based on {actual}, current head is {expected}")]
    StaleBase { expected: Id, actual: Id },
    #[error("there is no Text Action to undo")]
    NothingToUndo,
    #[error("Text Action {action} is not in the undo history: unknown or already undone")]
    UnknownAction { action: Id },
    #[error("Text Action {action} is not invertible: its verdicts are already ledger facts")]
    NotInvertible { action: Id },
    #[error("block {block} does not exist in the current head")]
    MissingBlock { block: Id },
    #[error("replacement range is not contiguous in the current head")]
    NonContiguousRange,
    #[error("two changes address block {block}")]
    OverlappingChanges { block: Id },
    #[error("insertion boundary {block} does not exist after replacements")]
    MissingBoundary { block: Id },
    #[error("an editor action must contain at least one change")]
    NothingChanged,
    #[error("block {block} has no surviving lineage boundary")]
    LineageGone { block: Id },
    #[error("a Decision Batch must contain at least one staged Verdict")]
    NothingStaged,
    #[error("Verdict names Proposal {proposal}, which is not in the batch")]
    UnknownProposal { proposal: Id },
    #[error("Proposal {proposal} appears twice in one Decision Batch")]
    DuplicateProposal { proposal: Id },
    #[error("Verdict names an unknown or unchanged Review Slice")]
    UnknownSlice,
    #[error("modified Verdict requires an inserted Review Slice, got {slice:?}")]
    ModifiedVerdictRequiresInsertion { slice: ReviewSliceId },
    #[error("Proposal {proposal} Review Slice {slice:?} is judged twice")]
    DuplicateVerdict { proposal: Id, slice: ReviewSliceId },
    #[error("Proposal {proposal} no longer matches its baseline scope")]
    StaleProposal { proposal: Id },
    #[error("two staged Proposals both replace block {block}")]
    OverlappingScopes { block: Id },
    #[error(transparent)]
    SourceDrift(#[from] SourceDrift),
}

/// The current manuscript plus its source layout and the action history. The
/// history is hydrated from the persisted chain at open, grows at `execute`,
/// and shrinks at `undo_last` — it is the undo stack, newest last.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manuscript {
    source: SourceSnapshot,
    /// The lineage this manuscript opened with. Materialisation inverts
    /// derived ids to source spans without a map; a resumed lineage keeps
    /// its ids verbatim.
    lineage: Lineage,
    head: TextHead,
    materialized: ByteSequence,
    offsets: BlockOffsets,
    /// id → block position, built on first use. An opening manuscript
    /// derives its ids and skips the index entirely; editing and undoing
    /// build it once and keep it. `Option` so open stays O(blocks) not
    /// O(blocks · hash).
    block_at: Option<HashMap<Id, usize>>,
    actions: Vec<TextAction>,
    action_at: HashMap<Id, usize>,
    last_touched: HashMap<Id, usize>,
    /// How bytes divide into blocks. Re-scans after an edit must use the same
    /// rule the open used, or offsets and block identity drift apart.
    scan: BlockScan,
}

struct LocalUndoPlan {
    restored: TextHead,
    materialized: ByteSequence,
    byte_patch: BytePatch,
    block_index: usize,
    restored_block_len: usize,
}

fn local_replacement(
    editor: &EditorAction,
    at: &HashMap<Id, usize>,
    scan: BlockScan,
) -> Option<usize> {
    let [EditorChange::Replace(replacement)] = editor.changes.as_ref() else {
        return None;
    };
    let [block] = replacement.blocks.as_ref() else {
        return None;
    };
    let text = replacement.text.as_deref()?;
    if scan.layout(text.as_bytes()).blocks().len() != 1 {
        return None;
    }
    at.get(block).copied()
}

fn undo_record(current_head: Id, restored: &TextHead, action: &TextAction) -> TextAction {
    let inverted: Vec<AppliedRegion> = action
        .regions
        .iter()
        .map(|region| AppliedRegion {
            before: region.after.clone(),
            after: region.before.clone(),
            left: region.left,
            right: region.right,
        })
        .collect();
    TextAction {
        id: Id::new(),
        base: current_head,
        cause: restored.cause.clone(),
        touched: action.touched.clone(),
        edits: edits_from_regions(&inverted),
        regions: inverted.into_boxed_slice(),
        verdicts: Box::default(),
    }
}

impl Manuscript {
    pub fn open(source: SourceSnapshot, lineage: Lineage) -> Result<Self, TextRefusal> {
        Self::open_at(source, lineage, Id::new(), Vec::new())
    }

    /// Open with an explicit head id and the persisted action history that
    /// led to it. Continuity across restarts lives here: the store persists
    /// the head id and block lineage with the on-disk digest, so a reopened
    /// document resumes the revision chain it left — and a journaled
    /// EditorAction's base still names a real head.
    ///
    /// `history` is the persisted undo chain, oldest first. Linkage — every
    /// action's `base` naming the head the row before it produced — is proven
    /// by the store's walk over its own columns, which is where those columns
    /// live. Undo still re-verifies every region against the head it inverts,
    /// so a row that does not describe this text refuses at undo rather than
    /// inventing bytes.
    pub fn open_at(
        source: SourceSnapshot,
        lineage: Lineage,
        head: Id,
        history: Vec<TextAction>,
    ) -> Result<Self, TextRefusal> {
        let expected = source.layout.blocks().len();
        if lineage.len() != expected {
            return Err(TextRefusal::LineageLength {
                expected,
                actual: lineage.len(),
            });
        }
        // Build the blocks, then the id index. A `Listed` lineage (resumed
        // from a persisted state) still gets the duplicate check: a repeated
        // id collapses into one map entry, so a shorter map is exactly the
        // duplicate case. A `Derived` lineage needs none — derivation is a
        // bijection, uniqueness holds by construction.
        //
        // The two loops stay separate on purpose. Fusing them — inserting into
        // the map inside the block loop — writes two large structures in
        // alternation and costs about twice as much: on a 1 GiB manuscript
        // (7.2 million blocks) fused ran 1,055-1,460 ms against 497-563 ms
        // split. Each loop alone walks its own memory in order.
        let mut blocks = Vec::with_capacity(expected);
        for (index, span) in source.layout.blocks().iter().enumerate() {
            // Borrow the snapshot's bytes rather than copying them. This is
            // the whole reason `BlockText` exists; see its module comment for
            // the measurement that motivated it.
            let text = BlockText::shared(source.text(), span.start, span.end)
                .map_err(|_| TextRefusal::InvalidUtf8 { block: index })?;
            blocks.push(Block {
                id: lineage.id_at(index),
                text,
            });
        }
        if let Lineage::Listed(_) = &lineage {
            let block_at: HashMap<Id, usize> = blocks
                .iter()
                .enumerate()
                .map(|(index, block)| (block.id, index))
                .collect();
            if block_at.len() != blocks.len() {
                let mut seen = HashSet::with_capacity(block_at.len());
                let repeated = blocks
                    .iter()
                    .find(|block| !seen.insert(block.id))
                    .map(|block| block.id)
                    .expect("a shorter index than block list means some id repeats");
                return Err(TextRefusal::DuplicateLineage { block: repeated });
            }
        }
        let materialized = ByteSequence::from_source(source.text());
        let offsets = BlockOffsets::from_spans(source.layout.blocks().to_vec());
        let action_at: HashMap<Id, usize> = history
            .iter()
            .enumerate()
            .map(|(index, action)| (action.id, index))
            .collect();
        let last_touched: HashMap<Id, usize> = history
            .iter()
            .enumerate()
            .flat_map(|(index, action)| action.touched.iter().map(move |block| (*block, index)))
            .collect();
        let scan = source.scan;
        Ok(Self {
            source,
            lineage,
            head: TextHead {
                id: head,
                blocks: BlockSequence::from_vec(blocks),
                cause: "open".to_owned(),
            },
            materialized,
            offsets,
            block_at: None,
            actions: history,
            action_at,
            last_touched,
            scan,
        })
    }

    #[must_use]
    pub fn head(&self) -> &TextHead {
        &self.head
    }

    /// How this manuscript's bytes divide into blocks. Anything that joins
    /// block texts back into a document — a scope read, a materialisation —
    /// must use the same rule, or the join invents bytes the author never
    /// wrote.
    #[must_use]
    pub fn scan(&self) -> BlockScan {
        self.scan
    }

    /// The completed Text Actions, oldest first: hydrated from the persisted
    /// chain at open, grown at `execute`, shrunk at `undo_last`.
    #[must_use]
    pub fn actions(&self) -> &[TextAction] {
        &self.actions
    }

    fn local_undo_plan(&self, action: &TextAction) -> Result<Option<LocalUndoPlan>, TextRefusal> {
        let [region] = action.regions.as_ref() else {
            return Ok(None);
        };
        let ([before], [after]) = (region.before.as_ref(), region.after.as_ref()) else {
            return Ok(None);
        };
        if before.id != after.id {
            return Ok(None);
        }
        let index = self
            .block_at
            .as_ref()
            .and_then(|at| at.get(&after.id).copied())
            .ok_or(TextRefusal::NotInvertible { action: action.id })?;
        if self.head.blocks.get(index) != Some(after) {
            return Err(TextRefusal::NotInvertible { action: action.id });
        }
        let span = self
            .offsets
            .span(index)
            .ok_or(TextRefusal::SourceDrift(SourceDrift))?;
        let replacement = before.text.as_str().as_bytes();
        let byte_patch = BytePatch::at(&self.materialized, span.start, span.end, replacement);
        let materialized = self
            .materialized
            .replace(span.start..span.end, replacement)
            .ok_or(TextRefusal::SourceDrift(SourceDrift))?;
        Ok(Some(LocalUndoPlan {
            restored: TextHead {
                id: action.base,
                blocks: self
                    .head
                    .blocks
                    .replace(index, before.clone())
                    .ok_or(TextRefusal::SourceDrift(SourceDrift))?,
                cause: format!("undo: {}", action.cause),
            },
            materialized,
            byte_patch,
            block_index: index,
            restored_block_len: replacement.len(),
        }))
    }

    fn finish_undo(
        &mut self,
        restored: TextHead,
        byte_patch: BytePatch,
        undo: TextAction,
    ) -> TextTransition {
        self.head = restored.clone();
        let done = self
            .actions
            .pop()
            .expect("an undo plan saw the last action");
        self.action_at.remove(&done.id);
        // A block has no back-pointer to its earlier actions, so a pop cannot
        // repair `last_touched` selectively: rebuild walks the remaining
        // history once, which an interactive undo affords.
        self.last_touched = self
            .actions
            .iter()
            .enumerate()
            .flat_map(|(index, action)| action.touched.iter().map(move |block| (*block, index)))
            .collect();
        TextTransition {
            action: undo,
            head: restored,
            byte_patch,
        }
    }

    /// Revert the most recent Text Action, restoring the head it was based on.
    ///
    /// The inverse comes out of the action's own regions: every region records
    /// the blocks it replaced and what stands there now, so swapping them back
    /// rebuilds the earlier state byte for byte. The restored head carries the
    /// id the undone action was based on — a revision id names one state, so
    /// an EditorAction still based on the undone head meets [`TextRefusal::StaleBase`]
    /// rather than landing on text it never saw.
    ///
    /// # Errors
    ///
    /// - [`TextRefusal::NothingToUndo`]: the session holds no action yet.
    /// - [`TextRefusal::NotInvertible`]: the action carries verdicts. Its text
    ///   inverse exists, but reverting merged text would falsify the Verdict
    ///   Ledger, which already recorded those decisions.
    pub fn undo_last(&mut self) -> Result<TextTransition, TextRefusal> {
        // Undoing hydrates an action whose block ids the index must resolve;
        // the index was skipped at open (derived lineages cost one mint), so
        // build it now if the first edit never did. `local_undo_plan` reads the
        // field, thus this call is here for the build and not for the value.
        Self::block_index(&mut self.block_at, &self.head);
        let local = {
            let action = self.actions.last().ok_or(TextRefusal::NothingToUndo)?;
            if !action.verdicts.is_empty() {
                return Err(TextRefusal::NotInvertible { action: action.id });
            }
            self.local_undo_plan(action)?
        };
        if let Some(plan) = local {
            let undo = undo_record(
                self.head.id,
                &plan.restored,
                self.actions.last().expect("the local plan saw an action"),
            );
            self.offsets
                .replace(plan.block_index, plan.restored_block_len)
                .ok_or(TextRefusal::SourceDrift(SourceDrift))?;
            self.materialized = plan.materialized;
            return Ok(self.finish_undo(plan.restored, plan.byte_patch, undo));
        }

        let (restored, after, byte_patch, undo) = {
            let action = self.actions.last().expect("the local plan saw an action");
            let restored = TextHead {
                id: action.base,
                blocks: BlockSequence::from_vec(action::invert(&self.head, action)?),
                cause: format!("undo: {}", action.cause),
            };
            let after = materialize::blocks(&self.source, &self.lineage, restored.blocks())?;
            let byte_patch = BytePatch::between(&self.materialized, &after);
            let undo = undo_record(self.head.id, &restored, action);
            (restored, after, byte_patch, undo)
        };
        self.offsets = BlockOffsets::from_spans(self.scan.layout(&after).blocks().to_vec());
        self.materialized = ByteSequence::from_vec(after);
        self.block_at = Some(
            restored
                .blocks
                .iter()
                .enumerate()
                .map(|(index, block)| (block.id, index))
                .collect(),
        );
        Ok(self.finish_undo(restored, byte_patch, undo))
    }

    /// Revert to just after `target`: undo every action newer than it.
    ///
    /// Reverting a middle point undoes everything above it, so the walk is
    /// checked before anything moves: when an action above `target` carries
    /// verdicts the whole revert refuses. The author sees unchanged text with
    /// an honest refusal, not a revert that stopped halfway.
    ///
    /// Returns one transition per undone action, newest first. When `target`
    /// is the tip there is nothing above it and the vec is empty.
    ///
    /// # Errors
    ///
    /// - [`TextRefusal::UnknownAction`]: `target` is not in the undo history —
    ///   never seen, already undone, or older than the hydrated depth.
    /// - [`TextRefusal::NotInvertible`]: an action above `target` carries
    ///   verdicts. Undo cannot cross it — the same refusal [`Manuscript::undo_last`]
    ///   gives, named before any state moved.
    pub fn revert_to(&mut self, target: Id) -> Result<Vec<TextTransition>, TextRefusal> {
        let position = self
            .action_at
            .get(&target)
            .copied()
            .ok_or(TextRefusal::UnknownAction { action: target })?;
        if let Some(blocking) = self.actions[position + 1..]
            .iter()
            .find(|action| !action.verdicts.is_empty())
        {
            return Err(TextRefusal::NotInvertible {
                action: blocking.id,
            });
        }
        let mut transitions = Vec::new();
        while self.actions.len() > position + 1 {
            transitions.push(self.undo_last()?);
        }
        Ok(transitions)
    }

    /// The lineage the current head pairs with the materialised bytes: the
    /// persisted form a later open resumes from (SPEC 7.2).
    #[must_use]
    pub fn lineage_ids(&self) -> Vec<Id> {
        self.head.block_ids()
    }

    #[must_use]
    pub fn byte_len(&self) -> usize {
        self.materialized.len()
    }

    #[must_use]
    pub fn is_byte_boundary(&self, offset: usize) -> bool {
        self.materialized.is_char_boundary(offset)
    }

    #[must_use]
    pub fn byte(&self, offset: usize) -> Option<u8> {
        self.materialized.byte(offset)
    }

    pub fn read_bytes(&self, range: std::ops::Range<usize>) -> Result<Vec<u8>, TextRefusal> {
        self.materialized
            .copy_range(range.clone())
            .ok_or(TextRefusal::InvalidByteRange {
                start: range.start,
                end: range.end,
                length: self.materialized.len(),
            })
    }

    /// Resolve a half-open block range to its exact source-byte envelope.
    ///
    /// The end uses the next block's start, not the previous block's end, so
    /// separators remain attached to the projection and adjacent windows join
    /// back into the original source without inventing delimiter bytes.
    /// Which block holds this document byte offset.
    ///
    /// The manuscript owns block lineage and source gaps, so it answers this
    /// question once. A caller that walks the blocks itself makes a second
    /// authority for the same fact. An offset past the end belongs to the last
    /// block, and an empty manuscript has no block to name.
    #[must_use]
    pub fn block_at_offset(&self, offset: usize) -> Option<usize> {
        self.offsets.block_at_or_before(offset)
    }

    pub fn block_byte_range(
        &self,
        range: std::ops::Range<usize>,
    ) -> Result<std::ops::Range<usize>, TextRefusal> {
        let length = self.head.blocks.len();
        if range.start > range.end || range.end > length {
            return Err(TextRefusal::InvalidBlockRange {
                start: range.start,
                end: range.end,
                length,
            });
        }
        if range.is_empty() {
            let offset = if range.start == length {
                self.materialized.len()
            } else {
                self.offsets
                    .span(range.start)
                    .ok_or(TextRefusal::SourceDrift(SourceDrift))?
                    .start
            };
            return Ok(offset..offset);
        }
        let start = self
            .offsets
            .span(range.start)
            .ok_or(TextRefusal::SourceDrift(SourceDrift))?
            .start;
        let end = if range.end == length {
            self.materialized.len()
        } else {
            self.offsets
                .span(range.end)
                .ok_or(TextRefusal::SourceDrift(SourceDrift))?
                .start
        };
        Ok(start..end)
    }

    pub fn materialize(&self) -> Result<Vec<u8>, SourceDrift> {
        Ok(self.materialized.to_vec())
    }

    /// Replace one UTF-8 byte range through the same Text Action and undo
    /// history used by block-addressed edits.
    ///
    /// The editor speaks document offsets. The manuscript owns block lineage,
    /// source gaps, and action records. This boundary translates once instead
    /// of making every UI reproduce those rules. Only the affected block
    /// envelope is copied; ordinary input inside one block keeps the existing
    /// piece-table fast path.
    pub fn replace_bytes(
        &mut self,
        range: std::ops::Range<usize>,
        replacement: &str,
        cause: impl Into<String>,
    ) -> Result<TextTransition, TextRefusal> {
        let length = self.materialized.len();
        if range.start > range.end || range.end > length {
            return Err(TextRefusal::InvalidByteRange {
                start: range.start,
                end: range.end,
                length,
            });
        }
        for offset in [range.start, range.end] {
            if !self.materialized.is_char_boundary(offset) {
                return Err(TextRefusal::InvalidByteBoundary { offset });
            }
        }

        let (first, last) = self
            .offsets
            .envelope(range.start, range.end)
            .ok_or(TextRefusal::SourceDrift(SourceDrift))?;
        let first_span = self
            .offsets
            .span(first)
            .ok_or(TextRefusal::SourceDrift(SourceDrift))?;
        let last_span = self
            .offsets
            .span(last)
            .ok_or(TextRefusal::SourceDrift(SourceDrift))?;
        // 文档末尾总是合法插入点：最后的块 span 不含尾随分隔符，而光标
        // 停在文档末尾（尾随换行之后）输入是最常见的写作动作——把
        //  一并拒绝，光标在文末的每一次输入都会
        // 失败（e2e 仿真抓出：set_text 在 41 字节文档的 41 处被拒）。
        if range.start < first_span.start || (range.end > last_span.end && range.end != length) {
            return Err(TextRefusal::InvalidByteRange {
                start: range.start,
                end: range.end,
                length,
            });
        }

        let before = self
            .materialized
            .copy_range(first_span.start..range.start)
            .ok_or(TextRefusal::SourceDrift(SourceDrift))?;
        // 文档末尾追加时  超出最后一块的 span 末尾
        // （尾随分隔符不属于任何块）：after 应为空，而不是一次 start >
        // end 的越界拷贝。
        let after = self
            .materialized
            .copy_range(range.end.min(last_span.end)..last_span.end)
            .ok_or(TextRefusal::SourceDrift(SourceDrift))?;
        let mut text = Vec::with_capacity(before.len() + replacement.len() + after.len());
        text.extend_from_slice(&before);
        text.extend_from_slice(replacement.as_bytes());
        text.extend_from_slice(&after);
        let text = String::from_utf8(text).map_err(|_| TextRefusal::SourceDrift(SourceDrift))?;
        // The envelope names one or two blocks; reading them one by one costs a
        // descent each. `block_ids()` would build the whole id vector first —
        // 16 MB of `Id` for a million-block manuscript, allocated and dropped on
        // every keystroke, which is the shape a release performance test caught.
        let blocks = (first..=last)
            .map(|index| {
                self.head
                    .blocks
                    .get(index)
                    .map(Block::id)
                    .ok_or(TextRefusal::SourceDrift(SourceDrift))
            })
            .collect::<Result<Vec<Id>, TextRefusal>>()?;
        let exact = if first != last {
            Some(
                self.materialized
                    .replace(range.clone(), replacement.as_bytes())
                    .ok_or(TextRefusal::SourceDrift(SourceDrift))?,
            )
        } else {
            None
        };
        let exact_patch = BytePatch::at(
            &self.materialized,
            range.start,
            range.end,
            replacement.as_bytes(),
        );
        let mut transition = self.execute(TextCommand::Editor(EditorAction::new(
            self.head.id,
            vec![EditorChange::Replace(Replacement::new(blocks, Some(text))?)],
            cause,
        )))?;
        if let Some(exact) = exact {
            let exact_bytes = exact.to_vec();
            self.offsets =
                BlockOffsets::from_spans(self.scan.layout(&exact_bytes).blocks().to_vec());
            self.materialized = exact;
            transition.byte_patch = exact_patch;
        }
        Ok(transition)
    }

    /// The id → position index, built on first use. Opening skips it (a
    /// derived lineage costs one mint, an index would cost one hash per
    /// block); the first edit or undo pays the build once.
    ///
    /// This returns the index rather than filling the field, so no caller ever
    /// holds the `Option`. It used to be `ensure_block_at()`, after which two
    /// call sites re-established the same fact — one with `unwrap()`, one with
    /// `expect("ensured above")`. Both were correct and both were the kind of
    /// correctness that stops being true when someone reorders two lines.
    ///
    /// It takes the two fields rather than `&mut self` so the caller can hold
    /// the index and `&self.head` at once: they are disjoint fields, and
    /// cloning either to satisfy one `&mut self` would put an allocation on
    /// the path that every keystroke takes.
    fn block_index<'a>(
        block_at: &'a mut Option<HashMap<Id, usize>>,
        head: &TextHead,
    ) -> &'a HashMap<Id, usize> {
        block_at.get_or_insert_with(|| {
            head.blocks
                .iter()
                .enumerate()
                .map(|(index, block)| (block.id, index))
                .collect()
        })
    }

    pub fn execute(&mut self, command: TextCommand) -> Result<TextTransition, TextRefusal> {
        // The index is built on the editor arm only: a decision batch does not
        // address blocks by id, and building it there would cost one hash per
        // block for nothing.
        let local = match &command {
            TextCommand::Editor(editor) => local_replacement(
                editor,
                Self::block_index(&mut self.block_at, &self.head),
                self.scan,
            ),
            TextCommand::CommitDecisionBatch(_) => None,
        };
        let (head, action) = match command {
            TextCommand::Editor(editor) => action::apply_editor_indexed(
                &self.head,
                &editor,
                Self::block_index(&mut self.block_at, &self.head),
                self.scan,
            )?,
            TextCommand::CommitDecisionBatch(batch) => {
                decision::apply(&self.head, &batch, self.scan)?
            }
        };
        let byte_patch = if let Some(index) = local {
            self.replace_materialized_block(index, &head)?
        } else {
            let after = materialize::blocks(&self.source, &self.lineage, head.blocks())?;
            let patch = BytePatch::between(&self.materialized, &after);
            self.offsets = BlockOffsets::from_spans(self.scan.layout(&after).blocks().to_vec());
            self.materialized = ByteSequence::from_vec(after);
            self.block_at = Some(
                head.blocks
                    .iter()
                    .enumerate()
                    .map(|(index, block)| (block.id, index))
                    .collect(),
            );
            patch
        };
        let transition = TextTransition {
            byte_patch,
            action: action.clone(),
            head: head.clone(),
        };
        self.head = head;
        let action_index = self.actions.len();
        self.action_at.insert(action.id, action_index);
        for block in &action.touched {
            self.last_touched.insert(*block, action_index);
        }
        self.actions.push(action);
        Ok(transition)
    }

    fn replace_materialized_block(
        &mut self,
        index: usize,
        head: &TextHead,
    ) -> Result<BytePatch, TextRefusal> {
        let span = self
            .offsets
            .span(index)
            .ok_or(TextRefusal::SourceDrift(SourceDrift))?;
        let replacement = head.blocks[index].text.as_bytes();
        let patch = BytePatch::at(&self.materialized, span.start, span.end, replacement);
        let materialized = self
            .materialized
            .replace(span.start..span.end, replacement)
            .ok_or(TextRefusal::SourceDrift(SourceDrift))?;
        self.offsets
            .replace(index, replacement.len())
            .ok_or(TextRefusal::SourceDrift(SourceDrift))?;
        self.materialized = materialized;
        Ok(patch)
    }
}

#[cfg(test)]
mod boundary_tests {
    use super::*;

    #[test]
    fn insert_at_the_end_of_the_document_is_valid() {
        let bytes = "# 第一章\n\n剑一直握在他手里。\n";
        let snapshot = SourceSnapshot::read(bytes.as_bytes().to_vec());
        let lineage = Lineage::fresh(snapshot.block_count());
        let mut manuscript = Manuscript::open(snapshot, lineage).unwrap();
        let length = manuscript.byte_len();
        let _transition = manuscript
            .replace_bytes(length..length, "这是新写的一段。", "boundary probe")
            .expect("insert at the very end is a normal input");
        assert!(manuscript.byte_len() > length);
    }
}
