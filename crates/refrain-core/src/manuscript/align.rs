// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::ops::Range;

const ANCHOR: usize = 8;
const PROBE: usize = 64;
const TABLE_BUDGET: usize = 16_000_000;

pub(super) struct Region {
    pub before: Range<usize>,
    pub after: Range<usize>,
    pub anchor: bool,
}

pub(super) fn segment<K: Eq + Hash>(before: &[K], after: &[K]) -> Vec<Region> {
    let before_anchors = anchor_positions(before);
    let after_anchors = anchor_positions(after);
    let mut regions = Vec::new();
    let mut left = 0;
    let mut right = 0;
    let mut held_left = 0;
    let mut held_right = 0;

    let flush = |regions: &mut Vec<Region>,
                 left: usize,
                 right: usize,
                 held_left: &mut usize,
                 held_right: &mut usize| {
        if *held_left == 0 && *held_right == 0 {
            return;
        }
        regions.push(Region {
            before: left - *held_left..left,
            after: right - *held_right..right,
            anchor: false,
        });
        *held_left = 0;
        *held_right = 0;
    };

    while left < before.len() && right < after.len() {
        if before[left] != after[right] {
            let (next_left, next_right) =
                resync(before, after, left, right, &before_anchors, &after_anchors);
            held_left += next_left - left;
            held_right += next_right - right;
            left = next_left;
            right = next_right;
            continue;
        }

        let mut run = 0;
        while left + run < before.len()
            && right + run < after.len()
            && before[left + run] == after[right + run]
        {
            run += 1;
        }
        if run >= ANCHOR {
            flush(&mut regions, left, right, &mut held_left, &mut held_right);
            regions.push(Region {
                before: left..left + run,
                after: right..right + run,
                anchor: true,
            });
            left += run;
            right += run;
        } else {
            left += run;
            right += run;
            held_left += run;
            held_right += run;
        }
    }

    held_left += before.len() - left;
    held_right += after.len() - right;
    left = before.len();
    right = after.len();
    flush(&mut regions, left, right, &mut held_left, &mut held_right);
    regions
}

type AnchorPositions = HashMap<u64, Vec<usize>>;

fn anchor_hash<K: Hash>(window: &[K]) -> u64 {
    let mut hasher = DefaultHasher::new();
    window.hash(&mut hasher);
    hasher.finish()
}

fn anchor_window<K>(items: &[K], start: usize) -> Option<&[K]> {
    items.get(start..start.checked_add(ANCHOR)?)
}

fn anchor_positions<K: Hash>(items: &[K]) -> AnchorPositions {
    let mut positions: AnchorPositions = HashMap::new();
    if items.len() < ANCHOR {
        return positions;
    }
    for start in 0..=items.len() - ANCHOR {
        positions
            .entry(anchor_hash(&items[start..start + ANCHOR]))
            .or_default()
            .push(start);
    }
    positions
}

fn next_anchor<K: Eq + Hash>(
    items: &[K],
    positions: &AnchorPositions,
    window: &[K],
    after: usize,
) -> Option<usize> {
    let candidates = positions.get(&anchor_hash(window))?;
    let first = candidates.partition_point(|start| *start <= after);
    candidates[first..]
        .iter()
        .copied()
        .find(|start| anchor_window(items, *start) == Some(window))
}

fn resync<K: Eq + Hash>(
    before: &[K],
    after: &[K],
    left: usize,
    right: usize,
    before_anchors: &AnchorPositions,
    after_anchors: &AnchorPositions,
) -> (usize, usize) {
    for distance in 1..=PROBE {
        if left + distance < before.len() && before[left + distance] == after[right] {
            return (left + distance, right);
        }
        if right + distance < after.len() && before[left] == after[right + distance] {
            return (left, right + distance);
        }
    }

    let deletion = anchor_window(after, right)
        .and_then(|window| next_anchor(before, before_anchors, window, left));
    let insertion = anchor_window(before, left)
        .and_then(|window| next_anchor(after, after_anchors, window, right));
    match (deletion, insertion) {
        (Some(next_left), Some(next_right)) if next_left - left <= next_right - right => {
            (next_left, right)
        }
        (Some(_), Some(next_right)) => (left, next_right),
        (Some(next_left), None) => (next_left, right),
        (None, Some(next_right)) => (left, next_right),
        (None, None) => (left + 1, right + 1),
    }
}

pub(super) struct CommonTable {
    cells: Vec<u32>,
    width: usize,
}

impl CommonTable {
    pub fn get(&self, left: usize, right: usize) -> u32 {
        self.cells[left * self.width + right]
    }
}

pub(super) fn common_table<K: Eq>(before: &[K], after: &[K]) -> Option<CommonTable> {
    let width = after.len() + 1;
    let cells = (before.len() + 1).checked_mul(width)?;
    if cells > TABLE_BUDGET {
        return None;
    }

    let mut table = CommonTable {
        cells: vec![0; cells],
        width,
    };
    for left in (0..before.len()).rev() {
        for right in (0..after.len()).rev() {
            let value = if before[left] == after[right] {
                table.get(left + 1, right + 1) + 1
            } else {
                table.get(left + 1, right).max(table.get(left, right + 1))
            };
            table.cells[left * width + right] = value;
        }
    }
    Some(table)
}
