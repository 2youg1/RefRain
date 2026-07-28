use super::{
    AppliedRegion, Block, EditorAction, EditorChange, Id, TextAction, TextHead, TextRefusal,
};
use crate::SourceLayout;
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

    let at: HashMap<Id, usize> = head
        .blocks
        .iter()
        .enumerate()
        .map(|(index, block)| (block.id, index))
        .collect();
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
            .map(split_blocks)
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
                text,
            })
            .collect::<Vec<_>>()
            .into_boxed_slice();
        let before = head.blocks[start..=end].to_vec().into_boxed_slice();
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
                text: text.clone(),
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
    if blocks == head.blocks.as_ref() {
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

    let mut touched = HashSet::new();
    for region in &regions {
        touched.extend(region.before.iter().map(|block| block.id));
        touched.extend(region.after.iter().map(|block| block.id));
    }
    let mut touched = touched.into_iter().collect::<Vec<_>>();
    touched.sort();
    let edits = super::edits_from_regions(&regions);
    let action = TextAction {
        id: Id::new(),
        cause: editor.cause.clone(),
        touched: touched.into_boxed_slice(),
        regions: regions.into_boxed_slice(),
        edits,
        verdicts: Box::default(),
    };
    let head = TextHead {
        id: Id::new(),
        blocks: blocks.into_boxed_slice(),
        cause: editor.cause.clone(),
    };
    Ok((head, action))
}

fn split_blocks(text: &str) -> Vec<String> {
    let layout = SourceLayout::read(text.as_bytes());
    layout
        .blocks()
        .iter()
        .map(|span| text[span.start..span.end].to_owned())
        .collect()
}
