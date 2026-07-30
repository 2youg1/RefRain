use super::{
    AppliedRegion, Block, BlockSequence, EditorAction, EditorChange, Id, TextAction, TextHead,
    TextRefusal,
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
    let at = head
        .blocks
        .iter()
        .enumerate()
        .map(|(index, block)| (block.id, index))
        .collect();
    apply_editor_indexed(head, editor, &at)
}

pub(super) fn apply_editor_indexed(
    head: &TextHead,
    editor: &EditorAction,
    at: &HashMap<Id, usize>,
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
    if let Some(result) = apply_single_block(head, editor, at) {
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
        blocks: BlockSequence::from_vec(blocks),
        cause: editor.cause.clone(),
    };
    Ok((head, action))
}

fn apply_single_block(
    head: &TextHead,
    editor: &EditorAction,
    at: &HashMap<Id, usize>,
) -> Option<Result<(TextHead, TextAction), TextRefusal>> {
    let [EditorChange::Replace(replacement)] = editor.changes.as_ref() else {
        return None;
    };
    let [block_id] = replacement.blocks.as_ref() else {
        return None;
    };
    let text = replacement.text.as_deref()?;
    let texts = split_blocks(text);
    let [text] = texts.as_slice() else {
        return None;
    };
    let Some(index) = at.get(block_id).copied() else {
        return Some(Err(TextRefusal::MissingBlock { block: *block_id }));
    };
    let before = head.blocks[index].clone();
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
        left: index.checked_sub(1).map(|left| head.blocks[left].id),
        right: head.blocks.get(index + 1).map(|right| right.id),
    };
    let action = TextAction {
        id: Id::new(),
        cause: editor.cause.clone(),
        touched: vec![*block_id].into_boxed_slice(),
        edits: super::edits_from_regions(std::slice::from_ref(&region)),
        regions: vec![region].into_boxed_slice(),
        verdicts: Box::default(),
    };
    Some(Ok((
        TextHead {
            id: Id::new(),
            blocks: head.blocks.replace(index, after),
            cause: editor.cause.clone(),
        },
        action,
    )))
}

fn split_blocks(text: &str) -> Vec<String> {
    let layout = SourceLayout::read(text.as_bytes());
    layout
        .blocks()
        .iter()
        .map(|span| text[span.start..span.end].to_owned())
        .collect()
}
