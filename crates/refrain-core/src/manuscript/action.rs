// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

use super::{
    AppliedRegion, Block, BlockSequence, EditorAction, EditorChange, Id, TextAction, TextHead,
    TextRefusal,
};
use crate::BlockScan;
use std::collections::{BTreeMap, HashMap, HashSet};

struct PreparedRange {
    start: usize,
    end: usize,
    before: Box<[Block]>,
    after: Box<[Block]>,
}

pub(super) fn apply_editor(
    head: &TextHead,
    editor: &EditorAction,
    scan: BlockScan,
) -> Result<(TextHead, TextAction), TextRefusal> {
    let at = head
        .blocks
        .iter()
        .enumerate()
        .map(|(index, block)| (block.id, index))
        .collect();
    apply_editor_indexed(head, editor, &at, scan)
}

pub(super) fn apply_editor_indexed(
    head: &TextHead,
    editor: &EditorAction,
    at: &HashMap<Id, usize>,
    scan: BlockScan,
) -> Result<(TextHead, TextAction), TextRefusal> {
    if editor.base != head.id {
        return Err(TextRefusal::StaleBase {
            expected: head.id,
            actual: editor.base,
        });
    }
    if editor.changes.is_empty() {
        return Err(TextRefusal::NothingChanged);
    }
    if let Some(result) = apply_single_block(head, editor, at, scan) {
        return result;
    }

    let mut covered = vec![false; head.blocks.len()];
    let mut ranges = BTreeMap::new();

    for change in &editor.changes {
        let EditorChange::Replace(replacement) = change else {
            continue;
        };
        let positions = replacement
            .blocks
            .iter()
            .map(|block| {
                at.get(block)
                    .copied()
                    .ok_or(TextRefusal::MissingBlock { block: *block })
            })
            .collect::<Result<Vec<_>, _>>()?;
        if positions
            .windows(2)
            .any(|pair| pair[1] != pair[0].saturating_add(1))
        {
            return Err(TextRefusal::NonContiguousRange);
        }
        let start = positions[0];
        let end = *positions
            .last()
            .expect("replacement positions are non-empty");
        for (offset, slot) in covered[start..=end].iter_mut().enumerate() {
            let index = start + offset;
            if *slot {
                return Err(TextRefusal::OverlappingChanges {
                    block: head.blocks[index].id,
                });
            }
            *slot = true;
        }

        let texts = replacement
            .text
            .as_deref()
            .map(|text| split_blocks(text, scan))
            .unwrap_or_default();
        let after = texts
            .into_iter()
            .enumerate()
            .map(|(index, text)| Block {
                id: replacement
                    .blocks
                    .get(index)
                    .copied()
                    .unwrap_or_else(Id::new),
                text: text.into(),
            })
            .collect::<Vec<_>>()
            .into_boxed_slice();
        let before = head
            .blocks
            .iter()
            .skip(start)
            .take(end - start + 1)
            .cloned()
            .collect::<Vec<_>>()
            .into_boxed_slice();
        if before == after {
            continue;
        }
        ranges.insert(
            start,
            PreparedRange {
                start,
                end,
                before,
                after,
            },
        );
    }

    let mut replaced = Vec::with_capacity(head.blocks.len());
    let mut regions = Vec::new();
    let mut index = 0;
    while index < head.blocks.len() {
        if let Some(range) = ranges.get(&index) {
            let left = range.start.checked_sub(1).map(|at| head.blocks[at].id);
            let right = head.blocks.get(range.end + 1).map(|block| block.id);
            replaced.extend_from_slice(&range.after);
            regions.push(AppliedRegion {
                before: range.before.clone(),
                after: range.after.clone(),
                left,
                right,
            });
            index = range.end + 1;
        } else {
            replaced.push(head.blocks[index].clone());
            index += 1;
        }
    }

    let present: HashMap<Id, usize> = replaced
        .iter()
        .enumerate()
        .map(|(index, block)| (block.id, index))
        .collect();
    let mut pending: BTreeMap<usize, Vec<Block>> = BTreeMap::new();
    for change in &editor.changes {
        let EditorChange::Insert(insertion) = change else {
            continue;
        };
        let slot = match insertion.before {
            Some(block) => present
                .get(&block)
                .copied()
                .ok_or(TextRefusal::MissingBoundary { block })?,
            None => replaced.len(),
        };
        pending
            .entry(slot)
            .or_default()
            .extend(insertion.texts.iter().map(|text| Block {
                id: Id::new(),
                text: text.as_str().into(),
            }));
    }

    for (slot, blocks) in &pending {
        regions.push(AppliedRegion {
            before: Box::default(),
            after: blocks.clone().into_boxed_slice(),
            left: slot.checked_sub(1).map(|index| replaced[index].id),
            right: replaced.get(*slot).map(|block| block.id),
        });
    }

    let append_slot = replaced.len();
    let mut blocks = Vec::with_capacity(
        replaced.len() + pending.values().map(std::vec::Vec::len).sum::<usize>(),
    );
    for (index, block) in replaced.into_iter().enumerate() {
        if let Some(inserted) = pending.get(&index) {
            blocks.extend_from_slice(inserted);
        }
        blocks.push(block);
    }
    if let Some(inserted) = pending.get(&append_slot) {
        blocks.extend_from_slice(inserted);
    }
    if blocks.iter().eq(head.blocks.iter()) {
        return Err(TextRefusal::NothingChanged);
    }

    let positions: HashMap<Id, usize> = blocks
        .iter()
        .enumerate()
        .map(|(index, block)| (block.id, index))
        .collect();
    regions.sort_by_key(|region| {
        region
            .after
            .first()
            .and_then(|block| positions.get(&block.id).copied())
            .or_else(|| {
                region
                    .right
                    .and_then(|block| positions.get(&block).copied())
            })
            .or_else(|| {
                region
                    .left
                    .and_then(|block| positions.get(&block).copied())
                    .map(|index| index + 1)
            })
            .unwrap_or(0)
    });

    let touched = super::touched_of(&regions);
    let edits = super::edits_from_regions(&regions);
    let action = TextAction {
        id: Id::new(),
        base: head.id,
        cause: editor.cause.clone(),
        touched,
        regions: regions.into_boxed_slice(),
        edits,
        verdicts: Box::default(),
    };
    let head = TextHead {
        id: Id::new(),
        blocks: BlockSequence::from_vec(blocks),
        cause: editor.cause.clone(),
    };
    Ok((head, action))
}

fn apply_single_block(
    head: &TextHead,
    editor: &EditorAction,
    at: &HashMap<Id, usize>,
    scan: BlockScan,
) -> Option<Result<(TextHead, TextAction), TextRefusal>> {
    let [EditorChange::Replace(replacement)] = editor.changes.as_ref() else {
        return None;
    };
    let [block_id] = replacement.blocks.as_ref() else {
        return None;
    };
    let text = replacement.text.as_deref()?;
    let texts = split_blocks(text, scan);
    let [text] = texts.as_slice() else {
        return None;
    };
    let Some(index) = at.get(block_id).copied() else {
        return Some(Err(TextRefusal::MissingBlock { block: *block_id }));
    };
    // The index map and the block tree are two records of the same thing, and
    // this is the one place that trusts the first to address the second. A
    // disagreement is a missing block, which is exactly what the caller above
    // already knows how to report.
    let Some(before) = head.blocks.get(index).cloned() else {
        return Some(Err(TextRefusal::MissingBlock { block: *block_id }));
    };
    let after = Block {
        id: *block_id,
        text: text.as_str().into(),
    };
    if before == after {
        return Some(Err(TextRefusal::NothingChanged));
    }
    let region = AppliedRegion {
        before: vec![before].into_boxed_slice(),
        after: vec![after.clone()].into_boxed_slice(),
        left: index
            .checked_sub(1)
            .and_then(|left| head.blocks.get(left))
            .map(|left| left.id),
        right: head.blocks.get(index + 1).map(|right| right.id),
    };
    let action = TextAction {
        id: Id::new(),
        base: head.id,
        cause: editor.cause.clone(),
        touched: vec![*block_id].into_boxed_slice(),
        edits: super::edits_from_regions(std::slice::from_ref(&region)),
        regions: vec![region].into_boxed_slice(),
        verdicts: Box::default(),
    };
    let Some(blocks) = head.blocks.replace(index, after) else {
        return Some(Err(TextRefusal::MissingBlock { block: *block_id }));
    };
    Some(Ok((
        TextHead {
            id: Id::new(),
            blocks,
            cause: editor.cause.clone(),
        },
        action,
    )))
}

fn split_blocks(text: &str, scan: BlockScan) -> Vec<String> {
    let layout = scan.layout(text.as_bytes());
    layout
        .blocks()
        .iter()
        .map(|span| text[span.start..span.end].to_owned())
        .collect()
}

/// The block list of the head an action was based on, rebuilt from its regions.
///
/// A region records the blocks it replaced (`before`) and what it put there
/// (`after`), and the action being undone is the one that produced this head
/// — so each region's `after` run sits in the head exactly where the region
/// says, and swapping it back for `before` restores the earlier state. A
/// region with an empty `after` (a deletion) carries no position of its own,
/// so it re-enters at the surviving boundary it recorded.
pub(super) fn invert(head: &TextHead, action: &TextAction) -> Result<Vec<Block>, TextRefusal> {
    let mut first_after: HashMap<Id, &AppliedRegion> = HashMap::new();
    let mut after_ids: HashSet<Id> = HashSet::new();
    let mut anchored: HashMap<Id, Vec<&AppliedRegion>> = HashMap::new();
    let mut at_end: Vec<&AppliedRegion> = Vec::new();
    for region in &action.regions {
        if let Some(first) = region.after.first() {
            first_after.insert(first.id, region);
            after_ids.extend(region.after.iter().map(|block| block.id));
        } else if !region.before.is_empty() {
            match region.right {
                Some(anchor) => anchored.entry(anchor).or_default().push(region),
                None => at_end.push(region),
            }
        }
    }

    let blocks = &head.blocks;
    let mut out: Vec<Block> = Vec::with_capacity(blocks.len());
    let mut index = 0;
    while index < blocks.len() {
        let block = &blocks[index];
        if let Some(region) = first_after.get(&block.id) {
            // The run must sit here exactly: this head is the action's own
            // product, so anything else means the record does not describe
            // this text, and inverting it would invent bytes.
            let exact = region.after.iter().enumerate().all(|(offset, recorded)| {
                blocks
                    .get(index + offset)
                    .is_some_and(|present| present.id == recorded.id)
            });
            if !exact {
                return Err(TextRefusal::NotInvertible { action: action.id });
            }
            out.extend(region.before.iter().cloned());
            index += region.after.len();
            continue;
        }
        if let Some(regions) = anchored.get(&block.id) {
            for region in regions {
                out.extend(region.before.iter().cloned());
            }
        }
        if after_ids.contains(&block.id) {
            // A mid-run block: the record and the head disagree, as above.
            return Err(TextRefusal::NotInvertible { action: action.id });
        }
        out.push(block.clone());
        index += 1;
    }
    for region in at_end {
        out.extend(region.before.iter().cloned());
    }
    Ok(out)
}
