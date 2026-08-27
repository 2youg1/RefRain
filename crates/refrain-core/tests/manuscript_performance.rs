// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use refrain_core::{
    EditorAction, EditorChange, Lineage, Manuscript, Replacement, SourceSnapshot, TextCommand,
};
use std::time::{Duration, Instant};

fn percentile(samples: &mut [Duration], numerator: usize, denominator: usize) -> Duration {
    samples.sort_unstable();
    samples[(samples.len() * numerator)
        .div_ceil(denominator)
        .saturating_sub(1)]
}

fn manuscript_with_blocks(blocks: usize) -> Manuscript {
    let source = (0..blocks)
        .map(|index| format!("block {index:06} carries enough text for a real editing projection"))
        .collect::<Vec<_>>()
        .join("\n\n")
        .into_bytes();
    let snapshot = SourceSnapshot::read(source);
    let lineage = Lineage::fresh(snapshot.block_count());
    Manuscript::open(snapshot, lineage).unwrap()
}

fn hundred_thousand_block_manuscript() -> Manuscript {
    manuscript_with_blocks(100_000)
}

fn one_block_replacement(
    manuscript: &Manuscript,
    block: refrain_core::Id,
    index: usize,
) -> TextCommand {
    TextCommand::Editor(EditorAction::new(
        manuscript.head().id(),
        vec![EditorChange::Replace(
            Replacement::new(vec![block], Some(format!("replacement {index}"))).unwrap(),
        )],
        "performance contract",
    ))
}

#[test]
fn one_block_confirmation_is_not_linear_in_a_hundred_thousand_block_manuscript() {
    let mut manuscript = hundred_thousand_block_manuscript();
    let block = manuscript.head().block_ids()[50_000];
    let mut samples = Vec::with_capacity(20);

    for index in 0..20 {
        let command = one_block_replacement(&manuscript, block, index);
        let before = manuscript.materialize().unwrap();
        let started = Instant::now();
        let transition = manuscript.execute(command).unwrap();
        samples.push(started.elapsed());
        assert_eq!(
            transition.byte_patch().apply(&before).unwrap(),
            manuscript.materialize().unwrap()
        );
        if index == 0 {
            assert!(transition.byte_patch().apply(b"different source").is_err());
        }
    }

    let p95 = percentile(&mut samples, 95, 100);
    let budget = Duration::from_millis(10);
    eprintln!("one-block confirmation p95: {p95:?}");
    assert!(
        p95 < budget,
        "one-block confirmation p95 was {p95:?}, budget {budget:?}; samples: {samples:?}"
    );
}

#[test]
fn one_block_undo_is_not_linear_in_a_hundred_thousand_block_manuscript() {
    let mut manuscript = hundred_thousand_block_manuscript();
    let block = manuscript.head().block_ids()[50_000];
    let mut samples = Vec::with_capacity(20);

    for index in 0..20 {
        let before = manuscript.materialize().unwrap();
        manuscript
            .execute(one_block_replacement(&manuscript, block, index))
            .unwrap();
        let edited = manuscript.materialize().unwrap();
        let started = Instant::now();
        let transition = manuscript.undo_last().unwrap();
        samples.push(started.elapsed());

        assert_eq!(transition.byte_patch().apply(&edited).unwrap(), before);
        assert_eq!(manuscript.materialize().unwrap(), before);
    }

    let p95 = percentile(&mut samples, 95, 100);
    let budget = Duration::from_millis(10);
    eprintln!("one-block undo p95: {p95:?}");
    assert!(
        p95 < budget,
        "one-block undo p95 was {p95:?}, budget {budget:?}; samples: {samples:?}"
    );
}

#[test]
fn production_byte_edit_does_not_scale_with_total_block_count() {
    if cfg!(debug_assertions) {
        eprintln!("production byte-edit scaling is measured by the release test profile");
        return;
    }

    fn samples(blocks: usize) -> Vec<Duration> {
        let mut manuscript = manuscript_with_blocks(blocks);
        let middle = blocks / 2;
        let mut samples = Vec::with_capacity(20);
        for index in 0..20 {
            let block = manuscript.block_byte_range(middle..middle + 1).unwrap();
            let offset = block.start + 6;
            let replacement = if index % 2 == 0 { "X" } else { "Y" };
            let started = Instant::now();
            manuscript
                .replace_bytes(offset..offset + 1, replacement, "performance contract")
                .unwrap();
            samples.push(started.elapsed());
        }
        samples
    }

    let mut small = samples(10_000);
    let mut large = samples(1_000_000);
    let small_p95 = percentile(&mut small, 95, 100);
    let large_p95 = percentile(&mut large, 95, 100);
    eprintln!("production byte edit p95: 10k={small_p95:?}, 1m={large_p95:?}");
    assert!(
        large_p95 < small_p95.saturating_mul(20),
        "production byte-edit cost grew with total block count: 10k p95 {small_p95:?}, 1m p95 {large_p95:?}"
    );
}
