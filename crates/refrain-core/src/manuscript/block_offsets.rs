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
}
