// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::action::apply_editor;
use super::review::{EditScope, Proposal, ReviewSliceId, SliceKind};
use super::{EditorAction, EditorChange, Id, Replacement, TextAction, TextHead, TextRefusal};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// A human judgment whose shape cannot omit required modified text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum VerdictKind {
    Accept,
    AcceptModified(String),
    Reject,
    CommentOnly,
}

impl VerdictKind {
    fn is_accepted(&self) -> bool {
        matches!(self, Self::Accept | Self::AcceptModified(_))
    }
}

/// One human judgment on one changed Review Slice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Verdict {
    id: Id,
    proposal: Id,
    slice: ReviewSliceId,
    kind: VerdictKind,
    reason: Option<String>,
}

impl Verdict {
    pub fn new(
        proposal: &Proposal,
        slice: ReviewSliceId,
        kind: VerdictKind,
        reason: Option<String>,
    ) -> Result<Self, TextRefusal> {
        let Some(candidate) = proposal
            .slices()
            .iter()
            .find(|candidate| candidate.id() == slice && candidate.kind().is_changed())
        else {
            return Err(TextRefusal::UnknownSlice);
        };
        if slice.proposal() != proposal.id() {
            return Err(TextRefusal::UnknownSlice);
        }
        if matches!(kind, VerdictKind::AcceptModified(_)) && !candidate.kind().is_insertion() {
            return Err(TextRefusal::ModifiedVerdictRequiresInsertion { slice });
        }
        Ok(Self {
            id: Id::new(),
            proposal: proposal.id(),
            slice,
            kind,
            reason,
        })
    }

    #[must_use]
    pub fn id(&self) -> Id {
        self.id
    }

    #[must_use]
    pub fn reason(&self) -> Option<&str> {
        self.reason.as_deref()
    }
}

/// The proposals and staged verdicts committed atomically against one head.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecisionBatch {
    base: Id,
    proposals: Box<[Proposal]>,
    verdicts: Box<[Verdict]>,
}

impl DecisionBatch {
    #[must_use]
    pub fn new(base: Id, proposals: Vec<Proposal>, verdicts: Vec<Verdict>) -> Self {
        Self {
            base,
            proposals: proposals.into_boxed_slice(),
            verdicts: verdicts.into_boxed_slice(),
        }
    }
}

pub(super) fn apply(
    head: &TextHead,
    batch: &DecisionBatch,
    scan: crate::BlockScan,
) -> Result<(TextHead, TextAction), TextRefusal> {
    if batch.base != head.id {
        return Err(TextRefusal::StaleBase {
            expected: head.id,
            actual: batch.base,
        });
    }
    if batch.verdicts.is_empty() {
        return Err(TextRefusal::NothingStaged);
    }

    let mut proposals = HashMap::with_capacity(batch.proposals.len());
    for proposal in &batch.proposals {
        if proposals.insert(proposal.id(), proposal).is_some() {
            return Err(TextRefusal::DuplicateProposal {
                proposal: proposal.id(),
            });
        }
    }
    let mut judged = HashSet::new();
    let mut staged = HashSet::new();
    for verdict in &batch.verdicts {
        if !proposals.contains_key(&verdict.proposal) {
            return Err(TextRefusal::UnknownProposal {
                proposal: verdict.proposal,
            });
        }
        if !judged.insert((verdict.proposal, verdict.slice)) {
            return Err(TextRefusal::DuplicateVerdict {
                proposal: verdict.proposal,
                slice: verdict.slice,
            });
        }
        staged.insert(verdict.proposal);
    }

    let staged = batch
        .proposals
        .iter()
        .filter(|proposal| staged.contains(&proposal.id()))
        .collect::<Vec<_>>();

    let mut changes = Vec::new();
    let mut occupied = HashMap::new();
    for proposal in staged {
        let replacement = rebuild(
            proposal,
            batch
                .verdicts
                .iter()
                .filter(|verdict| verdict.proposal == proposal.id()),
        );
        if replacement == proposal.before() {
            continue;
        }
        if proposal.baseline() != head.id
            || scope_text(head, proposal.scope(), scan) != proposal.before()
        {
            return Err(TextRefusal::StaleProposal {
                proposal: proposal.id(),
            });
        }
        for block in proposal.scope().blocks() {
            if occupied.insert(*block, proposal.id()).is_some() {
                return Err(TextRefusal::OverlappingScopes { block: *block });
            }
        }
        changes.push(EditorChange::Replace(Replacement::new(
            proposal.scope().blocks().to_vec(),
            (!replacement.is_empty()).then_some(replacement),
        )?));
    }

    if changes.is_empty() {
        return Ok((
            head.clone(),
            TextAction {
                id: Id::new(),
                base: head.id,
                cause: "decision-batch".to_owned(),
                touched: Box::default(),
                regions: Box::default(),
                edits: Box::default(),
                verdicts: batch.verdicts.clone(),
            },
        ));
    }

    let editor = EditorAction::new(head.id, changes, "decision-batch");
    let (head, mut action) = apply_editor(head, &editor, scan)?;
    action.verdicts = batch.verdicts.clone();
    Ok((head, action))
}

/// The text a set of verdicts would merge into the proposal's scope.
///
/// The merge path computes this inline; the countermand path needs the same
/// bytes to anchor on — what landed in the manuscript is what must be found
/// again before it can be reversed. One rule, two callers: keep it here so
/// the two paths can never disagree about what "merged" meant.
#[must_use]
pub fn merged_text(proposal: &Proposal, verdicts: &[Verdict]) -> String {
    rebuild(proposal, verdicts.iter())
}

fn scope_text(head: &TextHead, scope: &EditScope, scan: crate::BlockScan) -> String {
    let separator = scan.separator();
    scope
        .blocks()
        .iter()
        .filter_map(|id| {
            head.blocks
                .iter()
                .find(|block| block.id == *id)
                .map(|block| block.text.as_str())
        })
        .collect::<Vec<_>>()
        .join(separator)
}

fn rebuild<'a>(proposal: &Proposal, verdicts: impl Iterator<Item = &'a Verdict>) -> String {
    let by_slice: HashMap<ReviewSliceId, &Verdict> =
        verdicts.map(|verdict| (verdict.slice, verdict)).collect();
    let mut output = String::new();

    for slice in proposal.slices() {
        let verdict = by_slice.get(&slice.id()).copied();
        let keep = |output: &mut String, text: &str| {
            output.push_str(slice.lead());
            output.push_str(text);
            output.push_str(slice.trail());
        };
        match slice.kind() {
            SliceKind::Same => keep(&mut output, slice.text()),
            SliceKind::Delete if verdict.is_some_and(|verdict| verdict.kind.is_accepted()) => {}
            SliceKind::Delete => keep(&mut output, slice.text()),
            SliceKind::Insert => match verdict.map(|verdict| &verdict.kind) {
                Some(VerdictKind::Accept) => keep(&mut output, slice.text()),
                Some(VerdictKind::AcceptModified(text)) => keep(&mut output, text),
                Some(VerdictKind::Reject | VerdictKind::CommentOnly) | None => {}
            },
        }
    }
    output
}
