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
    /// A half-open interval of a snapshot's bytes, known to be valid UTF-8
    /// because `Manuscript::open_at` validates each interval before building
    /// the block.
    Shared {
        bytes: Arc<[u8]>,
        start: usize,
        end: usize,
    },
    /// Text produced by an edit, which has no interval in any snapshot.
    Owned(String),
}

impl BlockText {
    /// Borrows `bytes[start..end]`.
    ///
    /// # Errors
    ///
    /// Returns [`std::str::Utf8Error`] when the interval does not begin and end
    /// on character boundaries, so that an invalid interval is refused where it
    /// is built rather than panicking later in [`BlockText::as_str`].
    pub fn shared(bytes: Arc<[u8]>, start: usize, end: usize) -> Result<Self, std::str::Utf8Error> {
        std::str::from_utf8(&bytes[start..end])?;
        Ok(Self::Shared { bytes, start, end })
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            // `shared` validated this interval and the bytes behind the `Arc`
            // are immutable, so this cannot fail. The domain crate is
            // `forbid(unsafe_code)`, so the check is re-run rather than
            // skipped: it is a linear scan with no allocation, against a copy
            // of the whole manuscript.
            Self::Shared { bytes, start, end } => std::str::from_utf8(&bytes[*start..*end])
                .expect("BlockText::shared validated this interval as UTF-8"),
            Self::Owned(text) => text,
        }
    }
}

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

    fn arc(text: &str) -> Arc<[u8]> {
        text.as_bytes().into()
    }

    #[test]
    fn shared_text_reads_the_interval_it_was_given() {
        let bytes = arc("序章\n\n本文");
        let block = BlockText::shared(Arc::clone(&bytes), 0, "序章".len()).expect("valid utf-8");
        assert_eq!(block.as_str(), "序章");
    }

    #[test]
    fn a_split_character_is_refused_rather_than_read() {
        // Half of a three-byte character. Accepting this would put invalid
        // UTF-8 behind `from_utf8_unchecked`.
        let bytes = arc("序");
        assert!(BlockText::shared(bytes, 0, 2).is_err());
    }

    #[test]
    fn shared_and_owned_text_compare_by_what_they_say() {
        let bytes = arc("same");
        let shared = BlockText::shared(bytes, 0, 4).expect("valid utf-8");
        let owned = BlockText::Owned("same".to_owned());
        assert_eq!(shared, owned);
    }
}
