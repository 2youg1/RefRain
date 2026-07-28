use refrain_core::{
    DecisionBatch, EditScope, EditorAction, EditorChange, Id, Lineage, Manuscript, Proposal,
    Replacement, SourceSnapshot, TextCommand, Verdict, VerdictKind,
};

fn open(source: &[u8]) -> Manuscript {
    let source = SourceSnapshot::read(source.to_vec());
    let lineage = Lineage::fresh(source.block_count());
    Manuscript::open(source, lineage).unwrap()
}

fn accept(proposal: &Proposal) -> Vec<Verdict> {
    proposal
        .slices()
        .iter()
        .filter(|slice| slice.kind().is_changed())
        .map(|slice| Verdict::new(proposal, slice.id(), VerdictKind::Accept, None).unwrap())
        .collect()
}

fn proposal(manuscript: &Manuscript, block: Id, after: String) -> Proposal {
    let before = manuscript
        .head()
        .blocks()
        .iter()
        .find(|candidate| candidate.id() == block)
        .unwrap()
        .text()
        .to_owned();
    Proposal::new(
        Id::new(),
        manuscript.head().id(),
        EditScope::new(vec![block]).unwrap(),
        before,
        Some(after),
    )
}

#[test]
fn generated_utf8_sources_round_trip_without_losing_a_byte() {
    let alphabet = [
        "中", "文", "L", "a", "t", "i", "n", " ", "\n", "\r", "\t", "　", "\u{feff}", "😀", "。",
        "！", "?", "`", "~", "#", ">", "_", "-", "*",
    ];
    let mut state = 0x5eed_u64;

    for _ in 0..300 {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        let length = (state as usize) % 400;
        let mut source = String::new();
        for _ in 0..length {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            source.push_str(alphabet[(state as usize) % alphabet.len()]);
        }
        let manuscript = open(source.as_bytes());
        assert_eq!(manuscript.materialize().unwrap(), source.as_bytes());
    }
}

#[test]
fn every_pair_of_disjoint_single_block_proposals_commutes() {
    let source = (0..12)
        .map(|index| format!("原文 {index}。"))
        .collect::<Vec<_>>()
        .join("\n\n");
    let baseline = open(source.as_bytes());
    let blocks = baseline.head().block_ids();

    for left in 0..blocks.len() {
        for right in left + 1..blocks.len() {
            let first = proposal(&baseline, blocks[left], format!("改写 {left}。"));
            let second = proposal(&baseline, blocks[right], format!("改写 {right}。"));
            let verdicts = [accept(&first), accept(&second)].concat();

            let mut forward = baseline.clone();
            forward
                .execute(TextCommand::CommitDecisionBatch(DecisionBatch::new(
                    baseline.head().id(),
                    vec![first.clone(), second.clone()],
                    verdicts.clone(),
                )))
                .unwrap();
            let mut backward = baseline.clone();
            backward
                .execute(TextCommand::CommitDecisionBatch(DecisionBatch::new(
                    baseline.head().id(),
                    vec![second, first],
                    verdicts,
                )))
                .unwrap();

            assert_eq!(
                forward.materialize().unwrap(),
                backward.materialize().unwrap()
            );
        }
    }
}

#[test]
fn four_disjoint_actions_can_be_undone_in_all_twenty_four_orders() {
    let source = b"zero\n\none\n\ntwo\n\nthree";
    let mut changed = open(source);
    let blocks = changed.head().block_ids();
    let mut actions = Vec::new();
    for (index, block) in blocks.iter().copied().enumerate() {
        let transition = changed
            .execute(TextCommand::Editor(EditorAction::new(
                changed.head().id(),
                vec![EditorChange::Replace(
                    Replacement::new(vec![block], Some(format!("changed {index}"))).unwrap(),
                )],
                "property action",
            )))
            .unwrap();
        actions.push(transition.action().id());
    }

    let mut orders = 0;
    for first in 0..4 {
        for second in 0..4 {
            for third in 0..4 {
                for fourth in 0..4 {
                    let order = [first, second, third, fourth];
                    if (0..4).any(|index| order[index + 1..].contains(&order[index])) {
                        continue;
                    }
                    let mut manuscript = changed.clone();
                    for index in order {
                        manuscript
                            .execute(TextCommand::SelectiveUndo {
                                action: actions[index],
                            })
                            .unwrap();
                    }
                    assert_eq!(manuscript.materialize().unwrap(), source);
                    orders += 1;
                }
            }
        }
    }
    assert_eq!(orders, 24);
}
