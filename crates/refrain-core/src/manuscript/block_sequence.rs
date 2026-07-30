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

    #[must_use]
    pub fn get(&self, index: usize) -> Option<&Block> {
        if index >= self.len {
            return None;
        }
        let mut node = self.root.as_ref();
        for level in (1..=self.depth).rev() {
            let Node::Branch(children) = node else {
                unreachable!("block tree depth must match its node shape");
            };
            node = children[(index >> (level * BRANCH_BITS)) & BRANCH_MASK].as_ref();
        }
        let Node::Leaf(blocks) = node else {
            unreachable!("block tree leaves must end every path");
        };
        blocks.get(index & BRANCH_MASK)
    }

    pub fn iter(&self) -> impl DoubleEndedIterator<Item = &Block> + ExactSizeIterator + '_ {
        (0..self.len).map(|index| &self[index])
    }

    pub(super) fn replace(&self, index: usize, block: Block) -> Self {
        assert!(index < self.len, "block replacement index must exist");
        Self {
            root: replace_node(&self.root, self.depth, index, block),
            depth: self.depth,
            len: self.len,
        }
    }
}

fn replace_node(node: &Arc<Node>, depth: usize, index: usize, block: Block) -> Arc<Node> {
    if depth == 0 {
        let Node::Leaf(blocks) = node.as_ref() else {
            unreachable!("block tree depth must match its node shape");
        };
        let mut blocks = blocks.to_vec();
        blocks[index & BRANCH_MASK] = block;
        return Arc::new(Node::Leaf(blocks.into()));
    }

    let Node::Branch(children) = node.as_ref() else {
        unreachable!("block tree depth must match its node shape");
    };
    let slot = (index >> (depth * BRANCH_BITS)) & BRANCH_MASK;
    let mut children = children.to_vec();
    children[slot] = replace_node(&children[slot], depth - 1, index, block);
    Arc::new(Node::Branch(children.into()))
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
                text: format!("block {index}"),
            })
            .collect::<Vec<_>>();
        let sequence = BlockSequence::from_vec(blocks);
        let kept = sequence[2_001].clone();
        let id = sequence[2_000].id;
        let replaced = sequence.replace(
            2_000,
            super::Block {
                id,
                text: "changed".to_owned(),
            },
        );

        assert_eq!(sequence[2_000].text, "block 2000");
        assert_eq!(replaced[2_000].id, id);
        assert_eq!(replaced[2_000].text, "changed");
        assert_eq!(replaced[2_001], kept);
        assert_eq!(replaced.iter().count(), 4_000);
    }
}
