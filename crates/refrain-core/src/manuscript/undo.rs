use super::{
    AppliedRegion, Block, BlockSequence, Id, Manuscript, TextAction, TextHead, TextRefusal,
};
use std::collections::{BTreeMap, HashMap};

pub(super) fn selective(
    manuscript: &Manuscript,
    action_id: Id,
) -> Result<(TextHead, TextAction), TextRefusal> {
    let target_index = manuscript
        .action_at
        .get(&action_id)
        .copied()
        .ok_or(TextRefusal::UnknownAction { action: action_id })?;
    let target = &manuscript.actions[target_index];
    if target.regions.is_empty() {
        return Err(TextRefusal::ActionHasNoTextEffect { action: action_id });
    }

    for block in &target.touched {
        if manuscript
            .last_touched
            .get(block)
            .copied()
            .unwrap_or(target_index)
            > target_index
        {
            let region = target
                .regions
                .iter()
                .find(|region| {
                    region.before.iter().any(|candidate| candidate.id == *block)
                        || region.after.iter().any(|candidate| candidate.id == *block)
                })
                .expect("every touched block belongs to an applied region");
            return Err(TextRefusal::LaterActionIntersects {
                block: *block,
                before: region
                    .before
                    .iter()
                    .find(|candidate| candidate.id == *block)
                    .map(|candidate| candidate.text.clone())
                    .unwrap_or_default(),
                after: region
                    .after
                    .iter()
                    .find(|candidate| candidate.id == *block)
                    .map(|candidate| candidate.text.clone())
                    .unwrap_or_default(),
                current: manuscript
                    .head
                    .blocks
                    .iter()
                    .find(|candidate| candidate.id == *block)
                    .map(|candidate| candidate.text.clone())
                    .unwrap_or_default(),
            });
        }
    }

    let blocks = revert_regions(&manuscript.head, &target.regions)?;
    let regions = target
        .regions
        .iter()
        .map(|region| AppliedRegion {
            before: region.after.clone(),
            after: region.before.clone(),
            left: region.left,
            right: region.right,
        })
        .collect::<Vec<_>>()
        .into_boxed_slice();
    let cause = format!("selective-undo({action_id})");
    let edits = super::edits_from_regions(&regions);
    Ok((
        TextHead {
            id: Id::new(),
            blocks: BlockSequence::from_vec(blocks),
            cause: cause.clone(),
        },
        TextAction {
            id: Id::new(),
            cause,
            touched: target.touched.clone(),
            regions,
            edits,
            verdicts: Box::default(),
        },
    ))
}

struct Replacement {
    end: usize,
    blocks: Box<[Block]>,
}

fn revert_regions(head: &TextHead, regions: &[AppliedRegion]) -> Result<Vec<Block>, TextRefusal> {
    let at: HashMap<Id, usize> = head
        .blocks
        .iter()
        .enumerate()
        .map(|(index, block)| (block.id, index))
        .collect();
    let mut replacements = BTreeMap::new();
    let mut insertions: BTreeMap<usize, Vec<Block>> = BTreeMap::new();

    for region in regions {
        if let Some(first) = region.after.first() {
            let start = at
                .get(&first.id)
                .copied()
                .ok_or(TextRefusal::LineageGone { block: first.id })?;
            let end = region.after.iter().try_fold(start, |previous, block| {
                let found = at
                    .get(&block.id)
                    .copied()
                    .ok_or(TextRefusal::LineageGone { block: block.id })?;
                if found != previous && found != previous + 1 {
                    return Err(TextRefusal::LineageGone { block: block.id });
                }
                Ok(found)
            })?;
            replacements.insert(
                start,
                Replacement {
                    end,
                    blocks: region.before.clone(),
                },
            );
            continue;
        }

        let slot = if let Some(right) = region.right.and_then(|block| at.get(&block).copied()) {
            right
        } else if let Some(left) = region.left.and_then(|block| at.get(&block).copied()) {
            left + 1
        } else if head.blocks.is_empty() {
            0
        } else {
            let block = region.right.or(region.left).unwrap_or_else(Id::new);
            return Err(TextRefusal::LineageGone { block });
        };
        insertions
            .entry(slot)
            .or_default()
            .extend_from_slice(&region.before);
    }

    let mut output = Vec::new();
    let mut index = 0;
    while index < head.blocks.len() {
        if let Some(inserted) = insertions.get(&index) {
            output.extend_from_slice(inserted);
        }
        if let Some(replacement) = replacements.get(&index) {
            output.extend_from_slice(&replacement.blocks);
            index = replacement.end + 1;
        } else {
            output.push(head.blocks[index].clone());
            index += 1;
        }
    }
    if let Some(inserted) = insertions.get(&head.blocks.len()) {
        output.extend_from_slice(inserted);
    }
    Ok(output)
}
