// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! The durable form of a Text Action, and the way back from it.
//!
//! `regions` is the authority: undo inverts from it, so the persisted form
//! carries the full before/after text of every region. `touched` and `edits`
//! both derive from regions — a hydrated action re-derives them here rather
//! than trusting a second stored copy, because a fact stored twice is a fact
//! that can disagree with itself.

use serde::{Deserialize, Serialize};

use super::{AppliedRegion, Block, BlockText, Id, TextAction, Verdict, edits_from_regions};

/// One block in a region, with the text it held. The persisted form owns its
/// copy: the snapshot a shared block borrows from is gone by the next open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedBlock {
    pub id: Id,
    pub text: String,
}

/// One applied region as a row stores it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedRegion {
    pub before: Vec<PersistedBlock>,
    pub after: Vec<PersistedBlock>,
    pub left: Option<Id>,
    pub right: Option<Id>,
}

impl TextAction {
    /// The regions in their persisted form. Everything else a row carries is
    /// already public (`edits`, `verdicts`) or a column of its own (id, base,
    /// cause).
    #[must_use]
    pub fn persisted_regions(&self) -> Vec<PersistedRegion> {
        self.regions
            .iter()
            .map(|region| PersistedRegion {
                before: region.before.iter().map(persist_block).collect(),
                after: region.after.iter().map(persist_block).collect(),
                left: region.left,
                right: region.right,
            })
            .collect()
    }

    /// Rebuild an action from the parts of its row that undo needs. Linkage
    /// — this action's `base` being the head the previous row produced — was
    /// proven by the store's walk over the row columns; what this layer
    /// re-derives is everything the regions already say.
    #[must_use]
    pub fn from_persisted(
        id: Id,
        base: Id,
        cause: String,
        regions: Vec<PersistedRegion>,
        verdicts: Vec<Verdict>,
    ) -> Self {
        let regions: Box<[AppliedRegion]> = regions
            .into_iter()
            .map(|region| AppliedRegion {
                before: region.before.into_iter().map(owned_block).collect(),
                after: region.after.into_iter().map(owned_block).collect(),
                left: region.left,
                right: region.right,
            })
            .collect();
        let edits = edits_from_regions(&regions);
        let touched = super::touched_of(&regions);
        Self {
            id,
            base,
            cause,
            touched,
            regions,
            edits,
            verdicts: verdicts.into_boxed_slice(),
        }
    }
}

fn persist_block(block: &Block) -> PersistedBlock {
    PersistedBlock {
        id: block.id(),
        text: block.text().to_owned(),
    }
}

fn owned_block(block: PersistedBlock) -> Block {
    Block {
        id: block.id,
        text: BlockText::Owned(block.text),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{EditorChange, Lineage, Manuscript, Replacement, SourceSnapshot, TextCommand};

    /// A round trip through the persisted form must restore everything undo
    /// reads: identity, base, cause, touched blocks, regions, and verdicts.
    /// Edit ids are minted per computation, so edits compare by content.
    #[test]
    fn a_persisted_action_round_trips_field_for_field() {
        let mut manuscript = Manuscript::open(
            SourceSnapshot::read(b"one\n\ntwo\n\nthree".to_vec()),
            Lineage::fresh(3),
        )
        .unwrap();
        let blocks = manuscript.head().block_ids();
        let transition = manuscript
            .execute(TextCommand::Editor(crate::EditorAction::new(
                manuscript.head().id(),
                vec![EditorChange::Replace(
                    Replacement::new(vec![blocks[1]], Some("TWO".to_owned())).unwrap(),
                )],
                "author edit",
            )))
            .unwrap();
        let action = transition.action();

        let restored = TextAction::from_persisted(
            action.id(),
            action.base(),
            action.cause().to_owned(),
            action.persisted_regions(),
            action.verdicts().to_vec(),
        );

        assert_eq!(restored.id(), action.id());
        assert_eq!(restored.base(), action.base());
        assert_eq!(restored.cause(), action.cause());
        assert_eq!(restored.touched_blocks(), action.touched_blocks());
        // The regions are the authority undo inverts from: byte-identical.
        assert_eq!(restored.persisted_regions(), action.persisted_regions());
        assert_eq!(restored.verdicts(), action.verdicts());
        let content = |edits: &[crate::Edit]| {
            edits
                .iter()
                .map(|edit| {
                    (
                        edit.kind(),
                        edit.block(),
                        edit.before().map(str::to_owned),
                        edit.after().map(str::to_owned),
                    )
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(content(restored.edits()), content(action.edits()));
    }

    /// The regions cross JSON unchanged — the row stores them as text.
    #[test]
    fn persisted_regions_survive_json() {
        let regions = vec![PersistedRegion {
            before: vec![PersistedBlock {
                id: Id::new(),
                text: "原文。".to_owned(),
            }],
            after: vec![PersistedBlock {
                id: Id::new(),
                text: "改过的。".to_owned(),
            }],
            left: None,
            right: Some(Id::new()),
        }];
        let json = serde_json::to_string(&regions).unwrap();
        let back: Vec<PersistedRegion> = serde_json::from_str(&json).unwrap();
        assert_eq!(back, regions);
    }
}
