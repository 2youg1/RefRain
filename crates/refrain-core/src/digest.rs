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

#[cfg(test)]
mod tests {
    use super::*;

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
