// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! PDF projection using a focused, engine-free component: lopdf parses the document,
//! and we walk each
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
///
/// 页锚：抽出来的文字里，每一页从哪里开始。
///
/// 一份 PDF 在 RefRain 里只有一个用途——当资料被引用。作者读一篇论文，
/// 引一句话进自己的稿子，日后（或者审稿人）要能回到原件核对那一句。
/// 没有页码，这条链在最后一步断掉：出处头钉住了原件的 blake3 与克隆路径，
/// 却说不出「在第几页」，于是一份 400 页的 PDF 只能重新通读。
///
/// 页号本来就在手上——`Fragment.page` 一直参与排序（同页同基线才合并成
/// 一行），只是 join 之后被丢掉了。留下它不需要任何新依赖，也不需要渲染器。
///
/// 形态选 HTML 注释而不是可见文字：抽出来的文本是一份 Markdown 文档，
/// 作者会在上面搜索与引用，一行可见的「第 47 页」会混进搜索结果，也会被
/// Agent 当成正文的一部分抄进提案里。注释在渲染时消失，在字节里仍然可查。
fn page_anchor(page: u32) -> String {
    format!("<!-- p.{page} -->")
}

/// Assemble positioned fragments into lines, page by page (PDF's y axis
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
        // 换页时下一个锚。空页不产生锚——锚标的是「这一页的字从这里开始」，
        // 一页没有可抽取的字（整页是图）就没有那个「这里」，凭空写一个锚
        // 会让作者以为那一页有文字而自己没搜到。
        let page_changed = match last {
            Some((page, _)) => page != fragment.page,
            None => true,
        };
        if page_changed {
            lines.push(page_anchor(fragment.page));
            lines.push(String::new());
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

    /// 一份多页 PDF：每页一条内容流，页序与 `/Kids` 一致。
    fn multi_page_fixture(streams: &[&str]) -> Vec<u8> {
        let kids: Vec<String> = (0..streams.len())
            .map(|index| format!("{} 0 R", 3 + index * 2))
            .collect();
        let mut objects = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            format!(
                "<< /Type /Pages /Kids [{}] /Count {} >>",
                kids.join(" "),
                streams.len()
            ),
        ];
        let font_id = 3 + streams.len() * 2;
        for (index, stream) in streams.iter().enumerate() {
            objects.push(format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font_id} 0 R >> >> /Contents {} 0 R >>",
                4 + index * 2
            ));
            objects.push(format!(
                "<< /Length {} >>\nstream\n{}\nendstream",
                stream.len(),
                stream
            ));
        }
        objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string());

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

    #[test]
    fn every_page_that_carries_text_is_locatable_afterwards() {
        // 一份 PDF 在 RefRain 里是被引用的资料。作者引一句话之后要能说出
        // 「见第几页」，审稿人要能回到原件核对那一句——出处头钉住了原件的
        // blake3，页锚补上原件里的位置。
        let text = extract(&multi_page_fixture(&[
            "BT /F1 24 Tf 72 700 Td (first page line) Tj ET",
            "BT /F1 24 Tf 72 700 Td (second page line) Tj ET",
            "BT /F1 24 Tf 72 700 Td (third page line) Tj ET",
        ]))
        .unwrap();

        for page in 1..=3 {
            assert!(
                text.contains(&format!("<!-- p.{page} -->")),
                "page {page} has no anchor:\n{text}"
            );
        }

        // 锚必须排在它那一页的字之前，否则「这句话在第几页」读出来差一页——
        // 而两种排法下每个锚与每句话都各自存在，只看是否出现分不出来。
        let anchor_two = text.find("<!-- p.2 -->").unwrap();
        let first_line = text.find("first page line").unwrap();
        let second_line = text.find("second page line").unwrap();
        assert!(
            first_line < anchor_two && anchor_two < second_line,
            "the second page's anchor is not between the two pages:\n{text}"
        );
    }

    #[test]
    fn a_page_without_extractable_text_gets_no_anchor() {
        // 整页是图（或抽不出字）时不写锚。写一个空锚会让作者以为那一页有
        // 文字而自己没搜到，于是他去翻原件，翻到的是一张图——一次凭空的
        // 往返。近失手：中间那页留空，锚必须从 1 直接跳到 3。
        let text = extract(&multi_page_fixture(&[
            "BT /F1 24 Tf 72 700 Td (first page line) Tj ET",
            "BT /F1 24 Tf 72 700 Td () Tj ET",
            "BT /F1 24 Tf 72 700 Td (third page line) Tj ET",
        ]))
        .unwrap();
        assert!(text.contains("<!-- p.1 -->"), "{text}");
        assert!(
            !text.contains("<!-- p.2 -->"),
            "an empty page claimed to carry text:\n{text}"
        );
        assert!(text.contains("<!-- p.3 -->"), "{text}");
    }

    #[test]
    fn one_page_still_says_which_page_it_was() {
        // 极端：单页文档。锚看起来多余，但作者引用时读到的仍是同一句话
        // 「在第 1 页」，而不是一份有时有页码、有时没有的资料。
        let text = extract(&fixture()).unwrap();
        assert!(text.contains("<!-- p.1 -->"), "{text}");
        let anchor = text.find("<!-- p.1 -->").unwrap();
        let hello = text.find("Hello").unwrap();
        assert!(anchor < hello, "the anchor trails its own page:\n{text}");
    }
}
