// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use refrain_core::{
    DecisionBatch, EditScope, Id, Lineage, Manuscript, Proposal, SourceSnapshot, TextCommand,
    Verdict, VerdictKind,
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
