use super::{Block, Id, SourceDrift, SourceSnapshot};
use std::collections::HashMap;

const DEFAULT_SEPARATOR: &[u8] = b"\n\n";

pub(super) fn blocks(
    source: &SourceSnapshot,
    original_ids: &[Id],
    current: &[Block],
) -> Result<Vec<u8>, SourceDrift> {
    source.layout.reproduce(&source.bytes)?;
    let spans = source.layout.blocks();
    let original_at: HashMap<Id, usize> = original_ids
        .iter()
        .enumerate()
        .map(|(index, id)| (*id, index))
        .collect();
    let mut output = Vec::new();
    let mut source_cursor = 0;
    let mut original_cursor = 0;

    for block in current {
        if let Some(found) = original_at.get(&block.id).copied() {
            debug_assert!(
                found >= original_cursor,
                "Text Actions cannot reorder lineage"
            );
            for span in &spans[original_cursor..found] {
                output.extend_from_slice(&source.bytes[source_cursor..span.start]);
                source_cursor = span.end;
            }
            let span = spans[found];
            output.extend_from_slice(&source.bytes[source_cursor..span.start]);
            output.extend_from_slice(block.text.as_bytes());
            source_cursor = span.end;
            original_cursor = found + 1;
            continue;
        }

        if let Some(next) = spans.get(original_cursor) {
            output.extend_from_slice(&source.bytes[source_cursor..next.start]);
            source_cursor = next.start;
            output.extend_from_slice(block.text.as_bytes());
            output.extend_from_slice(DEFAULT_SEPARATOR);
        } else {
            if original_ids.is_empty() && output.is_empty() {
                output.extend_from_slice(&source.bytes);
                source_cursor = source.bytes.len();
            } else if !output.is_empty() {
                output.extend_from_slice(DEFAULT_SEPARATOR);
            }
            output.extend_from_slice(block.text.as_bytes());
        }
    }

    for span in &spans[original_cursor..] {
        output.extend_from_slice(&source.bytes[source_cursor..span.start]);
        source_cursor = span.end;
    }
    output.extend_from_slice(&source.bytes[source_cursor..]);
    Ok(output)
}
