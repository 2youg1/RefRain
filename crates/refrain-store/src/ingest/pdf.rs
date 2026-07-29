//! PDF projection (KL9: the SumatraPDF approach in our language — a focused,
//! fast, engine-free component): lopdf parses the document, and we walk each
//! page's content stream ourselves, collecting positioned text fragments and
//! assembling lines by baseline. No renderer, no browser engine.
//!
//! Honest v1 limits: text decodes as UTF-16BE (BOM-marked) or single-byte;
//! ToUnicode CMaps and font-metric word gaps are not consulted, so embedded
//! CID fonts without simple encodings may project poorly. The digest in the
//! material's provenance header always pins the original bytes.

use lopdf::{Document, Object, content::Content};
use refrain_core::{ErrorCode, RefrainError};

const MAX_PDF_PAGES: usize = 10_000;
const MAX_PDF_PAGE_CONTENT_BYTES: usize = 16 * 1024 * 1024;
const MAX_PDF_CONTENT_BYTES: usize = 64 * 1024 * 1024;
const MAX_PDF_FRAGMENTS: usize = 2_000_000;

/// One shown text run, with the baseline it sits on.
struct Fragment {
    page: u32,
    x: f32,
    y: f32,
    text: String,
}

fn push_fragment(fragments: &mut Vec<Fragment>, fragment: Fragment) -> Result<(), RefrainError> {
    if fragments.len() == MAX_PDF_FRAGMENTS {
        return Err(RefrainError::new(
            ErrorCode::UnsupportedFormat,
            "ingest a PDF",
            format!("more than {MAX_PDF_FRAGMENTS} text fragments"),
        ));
    }
    fragments.push(fragment);
    Ok(())
}

fn number(object: &Object) -> f32 {
    match object {
        Object::Integer(value) => *value as f32,
        Object::Real(value) => *value,
        _ => 0.0,
    }
}

fn decode_text(object: &Object) -> String {
    let Object::String(bytes, _) = object else {
        return String::new();
    };
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        bytes.iter().map(|byte| char::from(*byte)).collect()
    }
}

/// The PDF text-showing operators and the positioning that gives each run
/// its baseline. Everything else in the stream is not text.
fn fragments_of(document: &Document) -> Result<Vec<Fragment>, RefrainError> {
    let pages = document.get_pages();
    if pages.len() > MAX_PDF_PAGES {
        return Err(RefrainError::new(
            ErrorCode::UnsupportedFormat,
            "ingest a PDF",
            format!(
                "{} pages exceeds the {MAX_PDF_PAGES} page limit",
                pages.len()
            ),
        ));
    }
    let mut content_bytes = 0_usize;
    let mut fragments = Vec::new();
    for (page, page_id) in pages {
        let content = document.get_page_content(page_id).map_err(|error| {
            RefrainError::new(
                ErrorCode::UnsupportedFormat,
                "read a PDF page",
                format!("{page}"),
            )
            .with_detail(error.to_string())
        })?;
        if content.len() > MAX_PDF_PAGE_CONTENT_BYTES {
            return Err(RefrainError::new(
                ErrorCode::UnsupportedFormat,
                "read a PDF page",
                format!("{page}: decoded content exceeds {MAX_PDF_PAGE_CONTENT_BYTES} bytes"),
            ));
        }
        content_bytes = content_bytes.checked_add(content.len()).ok_or_else(|| {
            RefrainError::new(
                ErrorCode::UnsupportedFormat,
                "ingest a PDF",
                "decoded content size overflow",
            )
        })?;
        if content_bytes > MAX_PDF_CONTENT_BYTES {
            return Err(RefrainError::new(
                ErrorCode::UnsupportedFormat,
                "ingest a PDF",
                format!("decoded content exceeds {MAX_PDF_CONTENT_BYTES} bytes"),
            ));
        }
        let content = Content::decode(&content).map_err(|error| {
            RefrainError::new(
                ErrorCode::UnsupportedFormat,
                "decode a PDF stream",
                format!("{page}"),
            )
            .with_detail(error.to_string())
        })?;
        let mut x = 0.0_f32;
        let mut y = 0.0_f32;
        let mut leading = 0.0_f32;
        for operation in &content.operations {
            match operation.operator.as_str() {
                "Td" | "TD" => {
                    let [dx, dy, ..] = operation.operands.as_slice() else {
                        continue;
                    };
                    x += number(dx);
                    y += number(dy);
                    if operation.operator == "TD" {
                        leading = -number(dy);
                    }
                }
                "Tm" => {
                    let [_, _, _, _, next_x, next_y, ..] = operation.operands.as_slice() else {
                        continue;
                    };
                    x = number(next_x);
                    y = number(next_y);
                }
                "TL" => {
                    let Some(value) = operation.operands.first() else {
                        continue;
                    };
                    leading = number(value);
                }
                "T*" => y -= leading,
                "Tj" | "'" => {
                    let Some(object) = operation.operands.first() else {
                        continue;
                    };
                    push_fragment(
                        &mut fragments,
                        Fragment {
                            page,
                            x,
                            y,
                            text: decode_text(object),
                        },
                    )?;
                }
                "TJ" => {
                    let Some(Object::Array(items)) = operation.operands.first() else {
                        continue;
                    };
                    let mut text = String::new();
                    for item in items {
                        match item {
                            Object::String(_, _) => text.push_str(&decode_text(item)),
                            // A wide negative adjustment is the producer's word gap.
                            _ if number(item) < -100.0 => text.push(' '),
                            _ => {}
                        }
                    }
                    push_fragment(&mut fragments, Fragment { page, x, y, text })?;
                }
                _ => {}
            }
        }
    }
    Ok(fragments)
}

/// Lines are baselines: fragments within a small vertical tolerance form
/// one line, ordered left to right; lines stack top to bottom (PDF's y
/// grows upward, so larger y comes first).
fn assemble(fragments: Vec<Fragment>) -> String {
    let mut sorted = fragments;
    sorted.sort_by(|a, b| {
        a.page
            .cmp(&b.page)
            .then_with(|| b.y.total_cmp(&a.y))
            .then_with(|| a.x.total_cmp(&b.x))
    });
    let mut lines: Vec<String> = Vec::new();
    let mut last: Option<(u32, f32)> = None;
    for fragment in sorted {
        if fragment.text.trim().is_empty() {
            continue;
        }
        match last {
            Some((page, y)) if page == fragment.page && (y - fragment.y).abs() <= 2.0 => {
                if let Some(line) = lines.last_mut() {
                    if !line.is_empty() {
                        line.push(' ');
                    }
                    line.push_str(&fragment.text);
                }
            }
            _ => lines.push(fragment.text),
        }
        last = Some((fragment.page, fragment.y));
    }
    super::normalize(&lines.join("\n"))
}

/// Project the text of one PDF document.
pub fn extract(bytes: &[u8]) -> Result<String, RefrainError> {
    if !bytes.starts_with(b"%PDF") {
        return Err(RefrainError::new(
            ErrorCode::UnsupportedFormat,
            "ingest a PDF",
            "missing %PDF magic",
        ));
    }
    let document = Document::load_mem(bytes).map_err(|error| {
        RefrainError::new(ErrorCode::UnsupportedFormat, "parse a PDF", "lopdf")
            .with_detail(error.to_string())
    })?;
    Ok(assemble(fragments_of(&document)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal but well-formed PDF: correct xref offsets, one page, and a
    /// caller-supplied content stream.
    fn fixture_with_stream(stream: &str) -> Vec<u8> {
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".to_string(),
            format!("<< /Length {} >>\nstream\n{}\nendstream", stream.len(), stream),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        ];
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (index, body) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend(format!("{} 0 obj\n{}\nendobj\n", index + 1, body).bytes());
        }
        let xref_at = out.len();
        out.extend(format!("xref\n0 {}\n", objects.len() + 1).bytes());
        out.extend(b"0000000000 65535 f \n".as_slice());
        for offset in offsets {
            out.extend(format!("{offset:010} 00000 n \n").bytes());
        }
        out.extend(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n",
                objects.len() + 1
            )
            .bytes(),
        );
        out
    }

    fn fixture() -> Vec<u8> {
        fixture_with_stream(
            "BT /F1 24 Tf 14 TL 72 700 Td (Hello RefRain) Tj T* [(sum) -300 (atra)] TJ T* <FEFF4F60597D> Tj ET",
        )
    }

    #[test]
    fn malformed_position_operators_do_not_panic() {
        let text = extract(&fixture_with_stream("BT Td TD Tm TL (safe) Tj ET")).unwrap();
        assert!(text.contains("safe"), "{text}");
    }

    #[test]
    fn text_comes_out_line_by_line() {
        let text = extract(&fixture()).unwrap();
        assert!(text.contains("Hello RefRain"), "{text}");
        assert!(text.contains("sum atra"), "{text}");
        assert!(text.contains("你好"), "{text}");
        let hello = text.find("Hello").unwrap();
        let sumatra = text.find("sum").unwrap();
        let cjk = text.find("你好").unwrap();
        assert!(hello < sumatra && sumatra < cjk, "{text}");
    }

    #[test]
    fn a_non_pdf_is_a_typed_refusal() {
        assert!(extract(b"not a pdf at all").is_err());
    }
}
