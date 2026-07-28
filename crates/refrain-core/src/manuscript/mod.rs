mod action;
mod align;
mod decision;
mod materialize;
mod review;
mod undo;

pub use decision::{DecisionBatch, Verdict, VerdictKind};
pub use review::{
    ChangeClass, EditScope, Proposal, ReviewSlice, ReviewSliceId, SliceKind, classify_change,
};

use crate::{Id, SourceDrift, SourceLayout};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use thiserror::Error;

/// Immutable bytes and block intervals read from one manuscript revision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceSnapshot {
    bytes: Arc<[u8]>,
    layout: SourceLayout,
}

impl SourceSnapshot {
    #[must_use]
    pub fn read(bytes: Vec<u8>) -> Self {
        let layout = SourceLayout::read(&bytes);
        Self {
            bytes: bytes.into(),
            layout,
        }
    }

    #[must_use]
    pub fn block_count(&self) -> usize {
        self.layout.blocks().len()
    }
}

/// Persistent block identity supplied when a source snapshot is opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lineage(Box<[Id]>);

impl Lineage {
    #[must_use]
    pub fn fresh(blocks: usize) -> Self {
        Self((0..blocks).map(|_| Id::new()).collect())
    }

    #[must_use]
    pub fn from_ids(ids: Vec<Id>) -> Self {
        Self(ids.into_boxed_slice())
    }
}

/// A locatable manuscript block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    id: Id,
    text: String,
}

impl Block {
    #[must_use]
    pub fn id(&self) -> Id {
        self.id
    }

    #[must_use]
    pub fn text(&self) -> &str {
        &self.text
    }
}

/// One immutable manuscript state produced by a completed Text Action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextHead {
    id: Id,
    blocks: Box<[Block]>,
    cause: String,
}

impl TextHead {
    #[must_use]
    pub fn id(&self) -> Id {
        self.id
    }

    #[must_use]
    pub fn blocks(&self) -> &[Block] {
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

/// A non-empty run of existing blocks to replace or delete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Replacement {
    blocks: Box<[Id]>,
    text: Option<String>,
}

impl Replacement {
    pub fn new(blocks: Vec<Id>, text: Option<String>) -> Result<Self, TextRefusal> {
        if blocks.is_empty() {
            return Err(TextRefusal::EmptyRange);
        }
        let mut seen = HashSet::with_capacity(blocks.len());
        if let Some(block) = blocks.iter().find(|block| !seen.insert(**block)) {
            return Err(TextRefusal::DuplicateBlock { block: *block });
        }
        Ok(Self {
            blocks: blocks.into_boxed_slice(),
            text,
        })
    }
}

/// An ordered, non-empty group of new blocks at one existing right boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Insertion {
    before: Option<Id>,
    texts: Box<[String]>,
}

impl Insertion {
    pub fn new(before: Option<Id>, texts: Vec<String>) -> Result<Self, TextRefusal> {
        if texts.is_empty() {
            return Err(TextRefusal::EmptyInsertion);
        }
        for (index, text) in texts.iter().enumerate() {
            let layout = SourceLayout::read(text.as_bytes());
            let blocks = layout.blocks();
            if blocks.len() != 1 {
                return Err(TextRefusal::InvalidInsertionBlock {
                    index,
                    blocks: blocks.len(),
                });
            }
            if blocks[0].start != 0 || blocks[0].end != text.len() {
                return Err(TextRefusal::InsertionBlockHasGaps { index });
            }
        }
        Ok(Self {
            before,
            texts: texts.into_boxed_slice(),
        })
    }
}

/// One independently locatable change reported by the editor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditorChange {
    Replace(Replacement),
    Insert(Insertion),
}

/// All settled editor input against one exact Text Head.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorAction {
    base: Id,
    changes: Box<[EditorChange]>,
    cause: String,
}

impl EditorAction {
    #[must_use]
    pub fn new(base: Id, changes: Vec<EditorChange>, cause: impl Into<String>) -> Self {
        Self {
            base,
            changes: changes.into_boxed_slice(),
            cause: cause.into(),
        }
    }
}

/// The three authorised ways to ask the manuscript to move.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextCommand {
    Editor(EditorAction),
    CommitDecisionBatch(DecisionBatch),
    SelectiveUndo { action: Id },
}

/// One minimal replacement over canonical source bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BytePatch {
    before_digest: [u8; 32],
    start: usize,
    end: usize,
    replacement: Box<[u8]>,
}

impl BytePatch {
    fn between(before: &[u8], after: &[u8]) -> Self {
        if before == after {
            return Self {
                before_digest: Sha256::digest(before).into(),
                start: 0,
                end: 0,
                replacement: Box::default(),
            };
        }

        let prefix = before
            .iter()
            .zip(after)
            .take_while(|(left, right)| left == right)
            .count();
        let suffix = before[prefix..]
            .iter()
            .rev()
            .zip(after[prefix..].iter().rev())
            .take_while(|(left, right)| left == right)
            .count();
        Self {
            before_digest: Sha256::digest(before).into(),
            start: prefix,
            end: before.len() - suffix,
            replacement: after[prefix..after.len() - suffix]
                .to_vec()
                .into_boxed_slice(),
        }
    }

    pub fn apply(&self, source: &[u8]) -> Result<Vec<u8>, SourceDrift> {
        if <[u8; 32]>::from(Sha256::digest(source)) != self.before_digest {
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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditKind {
    Replace,
    Insert,
    Remove,
}

/// One addressable difference produced by a Text Action.
#[derive(Debug, Clone, PartialEq, Eq)]
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
                    before: Some(before.text.clone()),
                    after: Some(after.text.clone()),
                });
            }
        }
        for before in &region.before[shared..] {
            edits.push(Edit {
                id: Id::new(),
                kind: EditKind::Remove,
                block: before.id,
                before: Some(before.text.clone()),
                after: None,
            });
        }
        for after in &region.after[shared..] {
            edits.push(Edit {
                id: Id::new(),
                kind: EditKind::Insert,
                block: after.id,
                before: None,
                after: Some(after.text.clone()),
            });
        }
    }
    edits.into_boxed_slice()
}

/// The immutable audit record of one completed Text Action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextAction {
    id: Id,
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
    #[error("text action {action} does not exist")]
    UnknownAction { action: Id },
    #[error("text action {action} has no manuscript effect to undo")]
    ActionHasNoTextEffect { action: Id },
    #[error("a later action changed block {block}")]
    LaterActionIntersects {
        block: Id,
        before: String,
        after: String,
        current: String,
    },
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

/// The current manuscript plus its source layout and append-only action history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manuscript {
    source: SourceSnapshot,
    original_ids: Box<[Id]>,
    head: TextHead,
    actions: Vec<TextAction>,
    action_at: HashMap<Id, usize>,
    last_touched: HashMap<Id, usize>,
}

impl Manuscript {
    pub fn open(source: SourceSnapshot, lineage: Lineage) -> Result<Self, TextRefusal> {
        Self::open_at(source, lineage, Id::new())
    }

    /// Open with an explicit head id. Continuity across restarts lives here:
    /// the store persists the head id and block lineage with the on-disk
    /// digest, so a reopened document resumes the revision chain it left —
    /// and a journaled EditorAction's base still names a real head.
    pub fn open_at(
        source: SourceSnapshot,
        lineage: Lineage,
        head: Id,
    ) -> Result<Self, TextRefusal> {
        let expected = source.layout.blocks().len();
        if lineage.0.len() != expected {
            return Err(TextRefusal::LineageLength {
                expected,
                actual: lineage.0.len(),
            });
        }
        let mut seen = HashSet::with_capacity(lineage.0.len());
        if let Some(block) = lineage.0.iter().find(|block| !seen.insert(**block)) {
            return Err(TextRefusal::DuplicateLineage { block: *block });
        }

        let mut blocks = Vec::with_capacity(expected);
        for (index, (span, id)) in source
            .layout
            .blocks()
            .iter()
            .zip(lineage.0.iter())
            .enumerate()
        {
            let text = std::str::from_utf8(&source.bytes[span.start..span.end])
                .map_err(|_| TextRefusal::InvalidUtf8 { block: index })?;
            blocks.push(Block {
                id: *id,
                text: text.to_owned(),
            });
        }
        Ok(Self {
            source,
            original_ids: lineage.0,
            head: TextHead {
                id: head,
                blocks: blocks.into_boxed_slice(),
                cause: "open".to_owned(),
            },
            actions: Vec::new(),
            action_at: HashMap::new(),
            last_touched: HashMap::new(),
        })
    }

    #[must_use]
    pub fn head(&self) -> &TextHead {
        &self.head
    }

    /// The lineage the current head pairs with the materialised bytes: the
    /// persisted form a later open resumes from (SPEC 7.2).
    #[must_use]
    pub fn lineage_ids(&self) -> Vec<Id> {
        self.head.block_ids()
    }

    pub fn materialize(&self) -> Result<Vec<u8>, SourceDrift> {
        materialize::blocks(&self.source, &self.original_ids, self.head.blocks())
    }

    pub fn execute(&mut self, command: TextCommand) -> Result<TextTransition, TextRefusal> {
        let before = self.materialize()?;
        let (head, action) = match command {
            TextCommand::Editor(editor) => action::apply_editor(&self.head, &editor)?,
            TextCommand::CommitDecisionBatch(batch) => decision::apply(&self.head, &batch)?,
            TextCommand::SelectiveUndo { action } => undo::selective(self, action)?,
        };
        let after = materialize::blocks(&self.source, &self.original_ids, head.blocks())?;
        let transition = TextTransition {
            byte_patch: BytePatch::between(&before, &after),
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
}
