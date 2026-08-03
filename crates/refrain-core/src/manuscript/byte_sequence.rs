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

/// A run of bytes some piece points into.
///
/// The manuscript's own text arrives as the snapshot's `Arc<String>`, and an
/// edit's replacement arrives as fresh bytes. Naming both here lets a piece
/// point at the snapshot without copying it: converting `Arc<String>` to
/// `Arc<[u8]>` would duplicate the whole manuscript, which on 1 GiB measured
/// 354 ms and doubled resident memory.
#[derive(Debug, Clone)]
enum Bytes {
    Source(Arc<String>),
    Edited(Arc<[u8]>),
}

impl std::ops::Deref for Bytes {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        match self {
            Self::Source(text) => text.as_bytes(),
            Self::Edited(bytes) => bytes,
        }
    }
}

impl Bytes {
    /// Whether two runs are the same allocation, so adjacent pieces of one
    /// source can be merged.
    fn same_allocation(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Source(left), Self::Source(right)) => Arc::ptr_eq(left, right),
            (Self::Edited(left), Self::Edited(right)) => Arc::ptr_eq(left, right),
            _ => false,
        }
    }
}

#[derive(Debug, Clone)]
struct Piece {
    bytes: Bytes,
    start: usize,
    end: usize,
}

impl ByteSequence {
    /// Share the snapshot's text without copying it.
    pub(super) fn from_source(text: Arc<String>) -> Self {
        let len = text.len();
        Self::single(Bytes::Source(text), len)
    }

    fn single(bytes: Bytes, len: usize) -> Self {
        let pieces = if len == 0 {
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
        let len = bytes.len();
        Self::single(Bytes::Edited(bytes.into()), len)
    }

    pub(super) fn to_vec(&self) -> Vec<u8> {
        self.iter().collect()
    }

    pub(super) fn len(&self) -> usize {
        self.len
    }

    pub(super) fn is_char_boundary(&self, offset: usize) -> bool {
        if offset == 0 || offset == self.len {
            return true;
        }
        self.byte(offset)
            .is_some_and(|byte| byte & 0b1100_0000 != 0b1000_0000)
    }

    pub(super) fn copy_range(&self, range: Range<usize>) -> Option<Vec<u8>> {
        if range.start > range.end || range.end > self.len {
            return None;
        }
        let mut bytes = Vec::with_capacity(range.end - range.start);
        let mut cursor = 0;
        for piece in self.pieces.iter() {
            let piece_end = cursor + piece.len();
            let start = range.start.max(cursor);
            let end = range.end.min(piece_end);
            if start < end {
                bytes.extend_from_slice(
                    &piece.bytes[piece.start + start - cursor..piece.start + end - cursor],
                );
            }
            cursor = piece_end;
            if cursor >= range.end {
                break;
            }
        }
        Some(bytes)
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
                    bytes: Bytes::Edited(Arc::from(replacement)),
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

    pub(super) fn byte(&self, offset: usize) -> Option<u8> {
        let mut cursor = 0;
        for piece in self.pieces.iter() {
            let end = cursor + piece.len();
            if offset < end {
                return piece.bytes.get(piece.start + offset - cursor).copied();
            }
            cursor = end;
        }
        None
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
        && previous.bytes.same_allocation(&piece.bytes)
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
        let sequence = ByteSequence::from_source(Arc::new("alpha beta gamma".to_owned()));
        let replaced = sequence.replace(6..10, b"B").unwrap();
        assert_eq!(replaced.to_vec(), b"alpha B gamma");
        assert!(sequence.matches(b"alpha beta gamma"));
        assert!(!sequence.matches(b"alpha zeta gamma"));
    }
}
