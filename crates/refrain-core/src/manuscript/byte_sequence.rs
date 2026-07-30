use std::fmt;
use std::ops::Range;
use std::sync::Arc;

#[derive(Clone)]
pub(super) struct ByteSequence {
    pieces: Arc<[Piece]>,
    len: usize,
}

impl fmt::Debug for ByteSequence {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ByteSequence")
            .field("len", &self.len)
            .field("pieces", &self.pieces.len())
            .finish()
    }
}

#[derive(Debug, Clone)]
struct Piece {
    bytes: Arc<[u8]>,
    start: usize,
    end: usize,
}

impl ByteSequence {
    pub(super) fn from_arc(bytes: Arc<[u8]>) -> Self {
        let len = bytes.len();
        let pieces = if bytes.is_empty() {
            Vec::new()
        } else {
            vec![Piece {
                bytes,
                start: 0,
                end: len,
            }]
        };
        Self {
            pieces: pieces.into(),
            len,
        }
    }

    pub(super) fn from_vec(bytes: Vec<u8>) -> Self {
        Self::from_arc(bytes.into())
    }

    pub(super) fn to_vec(&self) -> Vec<u8> {
        self.iter().collect()
    }

    pub(super) fn matches(&self, source: &[u8]) -> bool {
        self.len == source.len() && self.iter().eq(source.iter().copied())
    }

    pub(super) fn replace(&self, range: Range<usize>, replacement: &[u8]) -> Option<Self> {
        if range.start > range.end || range.end > self.len {
            return None;
        }
        let mut pieces = Vec::new();
        self.append_range(0..range.start, &mut pieces);
        if !replacement.is_empty() {
            push_piece(
                &mut pieces,
                Piece {
                    bytes: Arc::from(replacement),
                    start: 0,
                    end: replacement.len(),
                },
            );
        }
        self.append_range(range.end..self.len, &mut pieces);
        Some(Self {
            pieces: pieces.into(),
            len: self.len - (range.end - range.start) + replacement.len(),
        })
    }

    fn iter(&self) -> impl Iterator<Item = u8> + '_ {
        self.pieces
            .iter()
            .flat_map(|piece| piece.bytes[piece.start..piece.end].iter().copied())
    }

    fn append_range(&self, range: Range<usize>, output: &mut Vec<Piece>) {
        if range.is_empty() {
            return;
        }
        let mut cursor = 0;
        for piece in self.pieces.iter() {
            let piece_end = cursor + piece.len();
            let start = range.start.max(cursor);
            let end = range.end.min(piece_end);
            if start < end {
                push_piece(
                    output,
                    Piece {
                        bytes: piece.bytes.clone(),
                        start: piece.start + (start - cursor),
                        end: piece.start + (end - cursor),
                    },
                );
            }
            cursor = piece_end;
            if cursor >= range.end {
                break;
            }
        }
    }
}

impl Piece {
    fn len(&self) -> usize {
        self.end - self.start
    }
}

fn push_piece(output: &mut Vec<Piece>, piece: Piece) {
    if piece.start == piece.end {
        return;
    }
    if let Some(previous) = output.last_mut()
        && Arc::ptr_eq(&previous.bytes, &piece.bytes)
        && previous.end == piece.start
    {
        previous.end = piece.end;
        return;
    }
    output.push(piece);
}

impl PartialEq for ByteSequence {
    fn eq(&self, other: &Self) -> bool {
        self.len == other.len && self.iter().eq(other.iter())
    }
}

impl Eq for ByteSequence {}

#[cfg(test)]
mod tests {
    use super::ByteSequence;
    use std::sync::Arc;

    #[test]
    fn replacement_reuses_untouched_bytes_and_preserves_exact_output() {
        let sequence = ByteSequence::from_arc(Arc::from(&b"alpha beta gamma"[..]));
        let replaced = sequence.replace(6..10, b"B").unwrap();
        assert_eq!(replaced.to_vec(), b"alpha B gamma");
        assert!(sequence.matches(b"alpha beta gamma"));
        assert!(!sequence.matches(b"alpha zeta gamma"));
    }
}
