// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Where a block's text lives.
//
// A manuscript arrives as one `Arc<[u8]>` with an interval per block, so the
// text of every block that was read from disk is already in memory before any
// `Block` exists. Giving each `Block` its own `String` would copy all of it a
// second time and allocate once per block: a 1 GiB manuscript splits into 7.2
// million blocks, and the probe in `refrain-store/tests/huge_input_probe.rs`
// measured 2,980 ms to open one against 25 ms to walk every block it had just
// built.
//
// Editing needs the other shape. A replacement's text does not exist in the
// snapshot, so it has to be owned.
//
// `BlockText` holds both cases so that callers see neither. Every reader goes
// through `Deref<Target = str>`, which is why adding this type changed no call
// site: the 41 places that read block text kept reading `&str`.

use std::ops::Deref;
use std::sync::Arc;

/// The text of one block, either borrowed from the manuscript snapshot it was
/// read from or owned because an edit produced it.
#[derive(Debug, Clone)]
pub enum BlockText {
    /// A half-open interval of a snapshot's text.
    ///
    /// The snapshot settled UTF-8 validity when it was read, so this is a
    /// slice of a `str` and needs no scan of its own.
    Shared {
        text: Arc<String>,
        start: usize,
        end: usize,
    },
    /// Text produced by an edit, which has no interval in any snapshot.
    Owned(String),
}

impl BlockText {
    /// Borrows `text[start..end]`.
    ///
    /// # Errors
    ///
    /// Returns [`BoundaryError`] when the interval does not fall on character
    /// boundaries, which would make the slice unrepresentable. Refusing here
    /// keeps [`BlockText::as_str`] a slice with nothing to check.
    pub fn shared(text: Arc<String>, start: usize, end: usize) -> Result<Self, BoundaryError> {
        if !text.is_char_boundary(start) || !text.is_char_boundary(end) || start > end {
            return Err(BoundaryError { start, end });
        }
        Ok(Self::Shared { text, start, end })
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Shared { text, start, end } => &text[*start..*end],
            Self::Owned(text) => text,
        }
    }
}

/// An interval that does not fall on character boundaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BoundaryError {
    pub start: usize,
    pub end: usize,
}

impl std::fmt::Display for BoundaryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{}..{} does not fall on character boundaries",
            self.start, self.end
        )
    }
}

impl std::error::Error for BoundaryError {}

impl Deref for BlockText {
    type Target = str;

    fn deref(&self) -> &str {
        self.as_str()
    }
}

// Two blocks say the same thing when their text matches, whatever holds it.
// Deriving these would make a shared block and an owned block with identical
// text compare unequal, which would report a no-op edit as a change.
impl PartialEq for BlockText {
    fn eq(&self, other: &Self) -> bool {
        self.as_str() == other.as_str()
    }
}

impl Eq for BlockText {}

// Tests compare block text against literals; without this they would need
// `.as_str()` at every assertion.
impl PartialEq<&str> for BlockText {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}

impl From<String> for BlockText {
    fn from(text: String) -> Self {
        Self::Owned(text)
    }
}

impl From<&str> for BlockText {
    fn from(text: &str) -> Self {
        Self::Owned(text.to_owned())
    }
}

impl std::fmt::Display for BlockText {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::BlockText;
    use std::sync::Arc;

    fn arc(text: &str) -> Arc<String> {
        Arc::new(text.to_owned())
    }

    #[test]
    fn shared_text_reads_the_interval_it_was_given() {
        let text = arc("序章\n\n本文");
        let block = BlockText::shared(text, 0, "序章".len()).expect("a block boundary");
        assert_eq!(block.as_str(), "序章");
    }

    #[test]
    fn an_interval_that_splits_a_character_is_refused() {
        // Two bytes into a three-byte character. The snapshot's text is valid
        // either way; what this refuses is an interval that cannot name a
        // slice of it.
        let text = arc("序");
        assert!(BlockText::shared(text, 0, 2).is_err());
    }

    #[test]
    fn shared_and_owned_text_compare_by_what_they_say() {
        let text = arc("same");
        let shared = BlockText::shared(text, 0, 4).expect("a block boundary");
        let owned = BlockText::Owned("same".to_owned());
        assert_eq!(shared, owned);
    }
}
