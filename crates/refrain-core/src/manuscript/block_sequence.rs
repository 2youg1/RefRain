// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

use super::Block;
use std::ops::Index;
use std::sync::Arc;

const BRANCH_BITS: usize = 5;
const BRANCH_WIDTH: usize = 1 << BRANCH_BITS;
const BRANCH_MASK: usize = BRANCH_WIDTH - 1;

/// An immutable indexed block sequence. A one-block replacement copies one
/// leaf and one branch per tree level; untouched blocks and branches are shared.
#[derive(Debug, Clone)]
pub struct BlockSequence {
    root: Arc<Node>,
    depth: usize,
    len: usize,
}

#[derive(Debug)]
enum Node {
    Leaf(Arc<[Block]>),
    Branch(Arc<[Arc<Node>]>),
}

impl Node {
    /// The block at `index` inside a subtree that is `depth` levels tall.
    ///
    /// Structural recursion: the match decides on the node's own shape, and
    /// `depth` only says which slot bits to read. A node whose shape disagrees
    /// with the depth it was reached at falls through to `None`, so a malformed
    /// tree costs the caller one missing block instead of the process.
    ///
    /// **What this does not do.** The depth of this tree and the shape of its
    /// nodes are still not related by a type; a malformed tree is still
    /// representable, and it now returns `None` or a wrong block rather than
    /// panicking. Relating them would need a depth-indexed type whose cost is
    /// far above what this buys. The four `unreachable!` that stood here are
    /// gone; the gap they marked is not closed.
    fn get(&self, depth: usize, index: usize) -> Option<&Block> {
        // `checked_sub` is the depth test and the descent in one value: `None`
        // is "no level below this one", which is exactly when a leaf belongs
        // here, and `Some` carries the depth to recurse at without a bare
        // subtraction that a reader has to re-prove cannot wrap.
        match (self, depth.checked_sub(1)) {
            (Self::Leaf(blocks), None) => blocks.get(index & BRANCH_MASK),
            (Self::Branch(children), Some(below)) => {
                children.get(slot_of(index, depth))?.get(below, index)
            }
            _ => None,
        }
    }

    /// This subtree with the block at `index` replaced, sharing everything else.
    ///
    /// Same recursion and the same refusal as [`Self::get`]: a shape that
    /// disagrees with its depth yields `None`, which the caller turns into a
    /// named refusal rather than a rewritten tree it cannot trust.
    fn replaced(&self, depth: usize, index: usize, block: Block) -> Option<Arc<Self>> {
        match (self, depth.checked_sub(1)) {
            (Self::Leaf(blocks), None) => {
                let mut blocks = blocks.to_vec();
                *blocks.get_mut(index & BRANCH_MASK)? = block;
                Some(Arc::new(Self::Leaf(blocks.into())))
            }
            (Self::Branch(children), Some(below)) => {
                let mut children = children.to_vec();
                let child = children.get_mut(slot_of(index, depth))?;
                *child = child.replaced(below, index, block)?;
                Some(Arc::new(Self::Branch(children.into())))
            }
            _ => None,
        }
    }
}

/// Which child of a branch at `depth` holds `index`.
///
/// The shift saturates rather than wrapping: a depth beyond `usize`'s width
/// cannot address anything, so it reads as slot zero and the descent then fails
/// on the shape, which is the same refusal every other malformed tree gets.
fn slot_of(index: usize, depth: usize) -> usize {
    depth
        .checked_mul(BRANCH_BITS)
        .and_then(|shift| index.checked_shr(u32::try_from(shift).ok()?))
        .unwrap_or(0)
        & BRANCH_MASK
}

/// The blocks in order, one walk of the tree rather than one descent per block.
///
/// The iterator this replaced was `(0..len).map(|index| &self[index])`: a full
/// root-to-leaf descent for every block, and every one of them through the
/// `expect` that `Index` owes its trait. Walking the leaves reaches each branch
/// once instead of once per block beneath it, and reaches no panicking call at
/// all. Only forward. The one reverse consumer in this repository asked for the
/// tail block, which [`BlockSequence::last`] answers in one descent; a
/// double-ended leaf walk would be a second traversal written to serve it.
pub struct Blocks<'a> {
    /// The branches still being walked, outermost first.
    pending: Vec<std::slice::Iter<'a, Arc<Node>>>,
    /// The leaf currently being drained.
    leaf: std::slice::Iter<'a, Block>,
    /// What `len` promised. Iteration stops here even if the tree holds more,
    /// so a malformed tree cannot make `len()` and `iter()` disagree.
    remaining: usize,
}

impl<'a> Iterator for Blocks<'a> {
    type Item = &'a Block;

    fn next(&mut self) -> Option<&'a Block> {
        if self.remaining == 0 {
            return None;
        }
        loop {
            if let Some(block) = self.leaf.next() {
                self.remaining = self.remaining.saturating_sub(1);
                return Some(block);
            }
            let node = loop {
                match self.pending.last_mut()?.next() {
                    Some(node) => break node,
                    None => {
                        self.pending.pop();
                    }
                }
            };
            match node.as_ref() {
                Node::Leaf(blocks) => self.leaf = blocks.iter(),
                Node::Branch(children) => self.pending.push(children.iter()),
            }
        }
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        (self.remaining, Some(self.remaining))
    }
}

impl ExactSizeIterator for Blocks<'_> {}

impl BlockSequence {
    pub(super) fn from_vec(blocks: Vec<Block>) -> Self {
        let len = blocks.len();
        let mut nodes = Vec::with_capacity(len.div_ceil(BRANCH_WIDTH));
        let mut leaf = Vec::with_capacity(BRANCH_WIDTH);
        for block in blocks {
            leaf.push(block);
            if leaf.len() == BRANCH_WIDTH {
                nodes.push(Arc::new(Node::Leaf(std::mem::take(&mut leaf).into())));
                leaf = Vec::with_capacity(BRANCH_WIDTH);
            }
        }
        if !leaf.is_empty() {
            nodes.push(Arc::new(Node::Leaf(leaf.into())));
        }
        if nodes.is_empty() {
            nodes.push(Arc::new(Node::Leaf(Arc::default())));
        }

        let mut depth = 0;
        while nodes.len() > 1 {
            nodes = nodes
                .chunks(BRANCH_WIDTH)
                .map(|children| Arc::new(Node::Branch(Arc::from(children))))
                .collect();
            depth += 1;
        }
        Self {
            root: nodes.pop().expect("a block tree always has a root"),
            depth,
            len,
        }
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.len
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The last block, or `None` when there is none.
    ///
    /// One descent rather than a walk: the tail is a real question — "what did
    /// the author write last" — and answering it by draining a forward iterator
    /// costs the whole manuscript.
    #[must_use]
    pub fn last(&self) -> Option<&Block> {
        self.get(self.len.checked_sub(1)?)
    }

    #[must_use]
    pub fn get(&self, index: usize) -> Option<&Block> {
        if index >= self.len {
            return None;
        }
        self.root.get(self.depth, index)
    }

    pub fn iter(&self) -> Blocks<'_> {
        const NO_BLOCKS: &[Block] = &[];
        let mut blocks = Blocks {
            pending: Vec::with_capacity(self.depth),
            leaf: NO_BLOCKS.iter(),
            remaining: self.len,
        };
        match self.root.as_ref() {
            Node::Leaf(leaf) => blocks.leaf = leaf.iter(),
            Node::Branch(children) => blocks.pending.push(children.iter()),
        }
        blocks
    }

    /// This sequence with one block replaced, sharing every untouched branch.
    ///
    /// `None` when `index` names no block. The caller turns that into the same
    /// named refusal it already raises when the materialised bytes and the block
    /// tree disagree, which is the only way this can happen.
    pub(super) fn replace(&self, index: usize, block: Block) -> Option<Self> {
        if index >= self.len {
            return None;
        }
        Some(Self {
            root: self.root.replaced(self.depth, index, block)?,
            depth: self.depth,
            len: self.len,
        })
    }
}

impl Index<usize> for BlockSequence {
    type Output = Block;

    fn index(&self, index: usize) -> &Self::Output {
        self.get(index).expect("block index must exist")
    }
}

impl PartialEq for BlockSequence {
    fn eq(&self, other: &Self) -> bool {
        self.len == other.len && self.iter().eq(other.iter())
    }
}

impl Eq for BlockSequence {}

#[cfg(test)]
mod tests {
    use super::BlockSequence;
    use crate::Id;

    #[test]
    fn replacement_crosses_multiple_tree_levels_without_moving_other_blocks() {
        let blocks = (0..4_000)
            .map(|index| super::Block {
                id: Id::new(),
                text: format!("block {index}").into(),
            })
            .collect::<Vec<_>>();
        let sequence = BlockSequence::from_vec(blocks);
        let kept = sequence[2_001].clone();
        let id = sequence[2_000].id;
        let replaced = sequence
            .replace(
                2_000,
                super::Block {
                    id,
                    text: "changed".into(),
                },
            )
            .expect("block 2,000 of 4,000 exists");

        assert_eq!(sequence[2_000].text, "block 2000");
        assert_eq!(replaced[2_000].id, id);
        assert_eq!(replaced[2_000].text, "changed");
        assert_eq!(replaced[2_001], kept);
        assert_eq!(replaced.iter().count(), 4_000);

        // An index past the end refuses instead of asserting, which is what let
        // `apply_single_block` answer `MissingBlock` when its index map and this
        // tree disagree.
        assert!(
            sequence
                .replace(
                    4_000,
                    super::Block {
                        id: Id::new(),
                        text: "past the end".into(),
                    }
                )
                .is_none()
        );
    }

    /// The walk visits the same blocks, in the same order, as the descent.
    ///
    /// Four thousand blocks is two tree levels, so the two paths differ: `get`
    /// descends from the root for each index, and `iter` reaches each branch
    /// once. They must still agree block for block, and `iter` must stop at
    /// exactly `len` — the size hint is what `collect` sizes its allocation on.
    #[test]
    fn walking_the_leaves_yields_what_descending_from_the_root_yields() {
        let sequence = BlockSequence::from_vec(
            (0..4_000)
                .map(|index| super::Block {
                    id: Id::new(),
                    text: format!("block {index}").into(),
                })
                .collect(),
        );

        let walked: Vec<&super::Block> = sequence.iter().collect();
        assert_eq!(walked.len(), 4_000);
        assert_eq!(sequence.iter().size_hint(), (4_000, Some(4_000)));
        for (index, block) in walked.iter().enumerate() {
            assert_eq!(
                sequence.get(index).map(|expected| expected.id),
                Some(block.id),
                "the walk and the descent disagree at block {index}"
            );
        }

        let empty = BlockSequence::from_vec(Vec::new());
        assert_eq!(empty.iter().count(), 0);
        assert_eq!(empty.len(), 0);
    }
}
