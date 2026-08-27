// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! One content-identity algorithm for every RefRain product boundary.
//!
//! BLAKE3 names file stamps, source layouts, imported material clones, context
//! manifests, staged requests, and collected artifacts. Keeping the algorithm
//! here prevents two crates from assigning different identities to the same
//! bytes during a migration.

/// The fixed-width BLAKE3 identity of `content`.
#[must_use]
pub fn content_bytes(content: &[u8]) -> [u8; 32] {
    *blake3::hash(content).as_bytes()
}

/// The lowercase BLAKE3 identity used in durable text and filenames.
#[must_use]
pub fn content_hex(content: &[u8]) -> String {
    blake3::hash(content).to_hex().to_string()
}

/// Names a sequence of parts without joining them into one buffer first.
///
/// The catalogue fingerprints 100,000 scanned rows on every open. Building one
/// string to hash would allocate megabytes to answer a question the caller
/// throws away — this feeds the parts through instead.
///
/// Each part carries its length, so two different sequences cannot collide by
/// concatenating to the same bytes: a path may contain any character, which
/// leaves no separator safe to rely on.
#[must_use]
pub fn sequence_bytes<'part>(parts: impl IntoIterator<Item = &'part [u8]>) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new();
    for part in parts {
        hasher.update(&(part.len() as u64).to_le_bytes());
        hasher.update(part);
    }
    *hasher.finalize().as_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sequence_is_named_by_its_parts_and_their_order() {
        let one = sequence_bytes([b"alpha".as_slice(), b"beta".as_slice()]);
        assert_eq!(
            one,
            sequence_bytes([b"alpha".as_slice(), b"beta".as_slice()])
        );
        // A different order names a different sequence.
        assert_ne!(
            one,
            sequence_bytes([b"beta".as_slice(), b"alpha".as_slice()])
        );
        // Length prefixes distinguish different part boundaries.
        assert_ne!(one, sequence_bytes([b"alphabeta".as_slice()]));
        assert_ne!(
            one,
            sequence_bytes([b"alph".as_slice(), b"abeta".as_slice()])
        );
        // An empty sequence differs from a sequence with one empty part.
        assert_ne!(
            sequence_bytes(std::iter::empty()),
            sequence_bytes([b"".as_slice()])
        );
    }

    #[test]
    fn byte_and_text_forms_name_the_same_content() {
        let content = "同一份内容。".as_bytes();
        let expected = content_bytes(content)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();

        assert_eq!(content_hex(content), expected);
        assert_eq!(content_hex(content).len(), 64);
        assert_ne!(content_hex(content), content_hex(b"different"));
    }
}
