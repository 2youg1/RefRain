// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::ByteSpan;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct BlockOffsets {
    baseline: Arc<[ByteSpan]>,
    deltas: Vec<i64>,
}

impl BlockOffsets {
    pub(super) fn from_spans(spans: Vec<ByteSpan>) -> Self {
        let deltas = vec![0; spans.len()];
        Self {
            baseline: spans.into(),
            deltas,
        }
    }

    pub(super) fn span(&self, index: usize) -> Option<ByteSpan> {
        let baseline = *self.baseline.get(index)?;
        let before = self.prefix(index);
        let own = self.prefix(index + 1) - before;
        Some(ByteSpan {
            start: shift(baseline.start, before)?,
            end: shift(baseline.end, before + own)?,
        })
    }

    pub(super) fn replace(&mut self, index: usize, new_len: usize) -> Option<ByteSpan> {
        let previous = self.span(index)?;
        let previous_len = i64::try_from(previous.end - previous.start).ok()?;
        let next_len = i64::try_from(new_len).ok()?;
        self.add(index, next_len - previous_len);
        Some(previous)
    }

    /// Find the block envelope that covers a byte range without walking every
    /// block. Gaps belong to their neighbouring envelope exactly as the source
    /// materialiser treats them: the start chooses the last block beginning at
    /// or before it, and the end chooses the first block ending at or after it.
    pub(super) fn envelope(&self, start: usize, end: usize) -> Option<(usize, usize)> {
        let first = self.block_at_or_before(start)?;
        let mut low = first;
        let mut high = self.baseline.len();
        while low < high {
            let middle = low + (high - low) / 2;
            if self.span(middle)?.end < end {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        let last = low.min(self.baseline.len().checked_sub(1)?);
        Some((first, last))
    }

    pub(super) fn block_at_or_before(&self, offset: usize) -> Option<usize> {
        if self.baseline.is_empty() {
            return None;
        }
        let mut low = 0;
        let mut high = self.baseline.len();
        while low < high {
            let middle = low + (high - low) / 2;
            if self.span(middle)?.start <= offset {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        Some(low.saturating_sub(1))
    }

    fn prefix(&self, end: usize) -> i64 {
        let mut cursor = end.min(self.deltas.len());
        let mut sum = 0;
        while cursor > 0 {
            sum += self.deltas[cursor - 1];
            cursor &= cursor - 1;
        }
        sum
    }

    fn add(&mut self, index: usize, delta: i64) {
        let mut cursor = index + 1;
        while cursor <= self.deltas.len() {
            self.deltas[cursor - 1] += delta;
            cursor += cursor & cursor.wrapping_neg();
        }
    }
}

fn shift(value: usize, delta: i64) -> Option<usize> {
    let shifted = i128::try_from(value).ok()? + i128::from(delta);
    usize::try_from(shifted).ok()
}

#[cfg(test)]
mod tests {
    use super::BlockOffsets;
    use crate::ByteSpan;

    #[test]
    fn one_length_change_shifts_later_spans_without_rewriting_them() {
        let spans = vec![
            ByteSpan { start: 0, end: 3 },
            ByteSpan { start: 5, end: 8 },
            ByteSpan { start: 10, end: 13 },
        ];
        let mut offsets = BlockOffsets::from_spans(spans);

        assert_eq!(offsets.replace(1, 5), Some(ByteSpan { start: 5, end: 8 }));
        assert_eq!(offsets.span(0), Some(ByteSpan { start: 0, end: 3 }));
        assert_eq!(offsets.span(1), Some(ByteSpan { start: 5, end: 10 }));
        assert_eq!(offsets.span(2), Some(ByteSpan { start: 12, end: 15 }));

        assert_eq!(offsets.replace(1, 1), Some(ByteSpan { start: 5, end: 10 }));
        assert_eq!(offsets.span(1), Some(ByteSpan { start: 5, end: 6 }));
        assert_eq!(offsets.span(2), Some(ByteSpan { start: 8, end: 11 }));
    }

    #[test]
    fn byte_envelopes_find_blocks_across_source_gaps_after_edits() {
        let mut offsets = BlockOffsets::from_spans(vec![
            ByteSpan { start: 1, end: 4 },
            ByteSpan { start: 6, end: 9 },
            ByteSpan { start: 11, end: 14 },
        ]);
        offsets.replace(1, 5).unwrap();

        assert_eq!(offsets.envelope(0, 0), Some((0, 0)));
        assert_eq!(offsets.envelope(5, 12), Some((0, 2)));
        assert_eq!(offsets.envelope(6, 10), Some((1, 1)));
        assert_eq!(offsets.block_at_or_before(14), Some(2));
    }
}
