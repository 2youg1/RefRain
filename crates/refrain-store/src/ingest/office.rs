//! The zip-family formats (DOCX / PPTX / XLSX / EPUB): a container read plus
//! a targeted tag-content scanner. No generic XML library — the tags these
//! formats carry text in are few, named, and stable, and a general parser
//! would only widen the surface we must defend (SPEC 5 依赖纪律).

use std::io::Read as _;

use refrain_core::{ErrorCode, RefrainError};

fn zip_failure(what: &str) -> RefrainError {
    RefrainError::new(
        ErrorCode::UnsupportedFormat,
        "read a zip-family material",
        what.to_string(),
    )
}

const MAX_ARCHIVE_MEMBERS: usize = 4_096;
const MAX_MEMBER_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ARCHIVE_TEXT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_COMPRESSION_RATIO: u64 = 1_000;

#[derive(Clone, Copy)]
enum Family {
    Docx,
    Pptx,
    Xlsx,
    Epub,
}

impl Family {
    fn needs(self, name: &str) -> bool {
        match self {
            Self::Docx => name == "word/document.xml",
            Self::Pptx => name.starts_with("ppt/slides/slide") && name.ends_with(".xml"),
            Self::Xlsx => {
                name == "xl/sharedStrings.xml"
                    || (name.starts_with("xl/worksheets/") && name.ends_with(".xml"))
            }
            Self::Epub => {
                name == "META-INF/container.xml"
                    || name.ends_with(".opf")
                    || name.ends_with(".html")
                    || name.ends_with(".xhtml")
            }
        }
    }
}

fn members(
    bytes: &[u8],
    family: Family,
) -> Result<std::collections::HashMap<String, Vec<u8>>, RefrainError> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|error| zip_failure("not a zip container").with_detail(error.to_string()))?;
    if archive.len() > MAX_ARCHIVE_MEMBERS {
        return Err(zip_failure("too many archive members"));
    }
    let mut total = 0_u64;
    let mut out = std::collections::HashMap::new();
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|error| {
            zip_failure("a member cannot be read").with_detail(error.to_string())
        })?;
        if file.is_dir() {
            continue;
        }
        let name = file.name().replace('\\', "/");
        if !family.needs(&name) {
            continue;
        }
        let size = file.size();
        if size > MAX_MEMBER_BYTES {
            return Err(zip_failure(&format!(
                "{name}: member exceeds {MAX_MEMBER_BYTES} bytes"
            )));
        }
        let compressed = file.compressed_size();
        if size > 64 * 1024 && compressed.saturating_mul(MAX_COMPRESSION_RATIO) < size {
            return Err(zip_failure(&format!(
                "{name}: suspicious compression ratio"
            )));
        }
        total = total
            .checked_add(size)
            .ok_or_else(|| zip_failure("archive size overflow"))?;
        if total > MAX_ARCHIVE_TEXT_BYTES {
            return Err(zip_failure("archive text budget exceeded"));
        }
        if out.contains_key(&name) {
            return Err(zip_failure(&format!("{name}: duplicate member")));
        }
        let mut content = Vec::with_capacity(size as usize);
        file.by_ref()
            .take(MAX_MEMBER_BYTES + 1)
            .read_to_end(&mut content)
            .map_err(|error| {
                zip_failure("a member cannot be read").with_detail(error.to_string())
            })?;
        if content.len() as u64 > MAX_MEMBER_BYTES {
            return Err(zip_failure(&format!(
                "{name}: member exceeded its read budget"
            )));
        }
        out.insert(name, content);
    }
    Ok(out)
}

fn member<'a>(
    all: &'a std::collections::HashMap<String, Vec<u8>>,
    name: &str,
) -> Result<&'a str, RefrainError> {
    let bytes = all.get(name).ok_or_else(|| zip_failure(name))?;
    std::str::from_utf8(bytes)
        .map_err(|error| zip_failure(name).with_detail(format!("not UTF-8: {error}")))
}

/// The text of every `<tag>…</tag>` pair, in document order. Attribute
/// forms (`<w:t xml:space="preserve">`) are accepted; self-closing pairs
/// yield nothing.
fn tag_contents<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut rest = xml;
    while let Some(at) = rest.find(&open) {
        let after_open = &rest[at + open.len()..];
        // The opener must end as a tag: `>` or an attribute boundary.
        let Some(end) = after_open.find('>') else {
            break;
        };
        if after_open[..end]
            .chars()
            .any(|ch| !ch.is_whitespace() && ch != '/')
            && after_open[..end].contains('<')
        {
            rest = after_open;
            continue;
        }
        if after_open[..end].trim_end().ends_with('/') {
            rest = &after_open[end + 1..];
            continue;
        }
        let body_start = &after_open[end + 1..];
        let Some(stop) = body_start.find(&close) else {
            break;
        };
        out.push(&body_start[..stop]);
        rest = &body_start[stop + close.len()..];
    }
    out
}

/// Paragraph-shaped text: one joined line per `<ptag>` chunk.
fn paragraphs(xml: &str, paragraph_tag: &str, run_tag: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    let open = format!("<{paragraph_tag}");
    let close = format!("</{paragraph_tag}>");
    let mut rest = xml;
    while let Some(at) = rest.find(&open) {
        let after = &rest[at + open.len()..];
        let Some(stop) = after.find(&close) else {
            break;
        };
        let chunk = &after[..stop];
        let line = tag_contents(chunk, run_tag)
            .iter()
            .map(|run| super::decode_entities(run))
            .collect::<String>();
        if !line.trim().is_empty() {
            lines.push(line);
        }
        rest = &after[stop + close.len()..];
    }
    super::normalize(&lines.join("\n"))
}

pub fn extract_docx(bytes: &[u8]) -> Result<String, RefrainError> {
    let all = members(bytes, Family::Docx)?;
    Ok(paragraphs(member(&all, "word/document.xml")?, "w:p", "w:t"))
}

pub fn extract_pptx(bytes: &[u8]) -> Result<String, RefrainError> {
    let all = members(bytes, Family::Pptx)?;
    let mut slides: Vec<(u32, String)> = all
        .keys()
        .filter_map(|name| {
            let number = name
                .strip_prefix("ppt/slides/slide")?
                .strip_suffix(".xml")?
                .parse::<u32>()
                .ok()?;
            Some((number, name.clone()))
        })
        .collect();
    slides.sort();
    if slides.is_empty() {
        return Err(zip_failure("ppt/slides"));
    }
    let mut pages: Vec<String> = Vec::new();
    for (_, name) in slides {
        let text = tag_contents(member(&all, &name)?, "a:t")
            .iter()
            .map(|run| super::decode_entities(run))
            .collect::<Vec<_>>()
            .join(" ");
        if !text.trim().is_empty() {
            pages.push(text);
        }
    }
    Ok(super::normalize(&pages.join("\n\n")))
}

pub fn extract_xlsx(bytes: &[u8]) -> Result<String, RefrainError> {
    let all = members(bytes, Family::Xlsx)?;
    let shared: Vec<String> = match all.keys().find(|name| name.ends_with("sharedStrings.xml")) {
        Some(name) => {
            let xml = member(&all, name)?.to_string();
            let open = "<si>";
            let close = "</si>";
            let mut items = Vec::new();
            let mut rest = xml.as_str();
            while let Some(at) = rest.find(open) {
                let after = &rest[at + open.len()..];
                let Some(stop) = after.find(close) else {
                    break;
                };
                items.push(
                    tag_contents(&after[..stop], "t")
                        .iter()
                        .map(|run| super::decode_entities(run))
                        .collect::<String>(),
                );
                rest = &after[stop + close.len()..];
            }
            items
        }
        None => Vec::new(),
    };
    let sheet_name = all
        .keys()
        .find(|name| name.starts_with("xl/worksheets/") && name.ends_with(".xml"))
        .cloned()
        .ok_or_else(|| zip_failure("xl/worksheets"))?;
    let sheet = member(&all, &sheet_name)?;
    let mut lines: Vec<String> = Vec::new();
    let mut rest = sheet;
    while let Some(at) = rest.find("<row") {
        let after = &rest[at + 4..];
        let Some(stop) = after.find("</row>") else {
            break;
        };
        let row = &after[..stop];
        let mut cells: Vec<String> = Vec::new();
        let mut cursor = row;
        while let Some(cell_at) = cursor.find("<c ") {
            let cell = &cursor[cell_at..];
            let Some(cell_end) = cell.find("</c>") else {
                break;
            };
            let chunk = &cell[..cell_end];
            let value = tag_contents(chunk, "v").first().map(|v| (*v).to_string());
            let inline = tag_contents(chunk, "t").first().map(|v| (*v).to_string());
            let text = if chunk.contains("t=\"s\"") {
                value
                    .and_then(|index| index.parse::<usize>().ok())
                    .and_then(|index| shared.get(index).cloned())
                    .unwrap_or_default()
            } else {
                inline.or(value).unwrap_or_default()
            };
            cells.push(super::decode_entities(&text));
            cursor = &cell[cell_end + 4..];
        }
        let line = cells.join("\t");
        if !line.trim().is_empty() {
            lines.push(line);
        }
        rest = &after[stop + 6..];
    }
    Ok(super::normalize(&lines.join("\n")))
}

pub fn extract_epub(bytes: &[u8]) -> Result<String, RefrainError> {
    let all = members(bytes, Family::Epub)?;
    let container = member(&all, "META-INF/container.xml")?;
    let opf_path = {
        let at = container
            .find("full-path=\"")
            .ok_or_else(|| zip_failure("META-INF/container.xml rootfile"))?;
        let after = &container[at + 11..];
        let end = after.find('"').ok_or_else(|| zip_failure("rootfile"))?;
        after[..end].to_string()
    };
    let opf = member(&all, &opf_path)?;
    let base = opf_path
        .rsplit_once('/')
        .map(|(dir, _)| format!("{dir}/"))
        .unwrap_or_default();
    let mut items: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut rest = opf;
    while let Some(at) = rest.find("<item ") {
        let chunk_end = rest[at..]
            .find('>')
            .ok_or_else(|| zip_failure("manifest item"))?;
        let chunk = &rest[at..at + chunk_end];
        let id = attr(chunk, "id");
        let href = attr(chunk, "href");
        if let (Some(id), Some(href)) = (id, href) {
            items.insert(id, href);
        }
        rest = &rest[at + chunk_end..];
    }
    let mut pages: Vec<String> = Vec::new();
    let mut spine = opf;
    while let Some(at) = spine.find("<itemref ") {
        let chunk_end = spine[at..]
            .find('>')
            .ok_or_else(|| zip_failure("spine itemref"))?;
        let chunk = &spine[at..at + chunk_end];
        if let Some(idref) = attr(chunk, "idref")
            && let Some(href) = items.get(&idref)
        {
            let page_path = format!("{base}{href}");
            if let Ok(xhtml) = member(&all, &page_path) {
                let text = super::html::extract(xhtml);
                if !text.is_empty() {
                    pages.push(text);
                }
            }
        }
        spine = &spine[at + chunk_end..];
    }
    if pages.is_empty() {
        return Err(zip_failure("epub spine"));
    }
    Ok(pages.join("\n\n"))
}

fn attr(chunk: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=\"");
    let at = chunk.find(&needle)? + needle.len();
    let end = chunk[at..].find('"')?;
    Some(chunk[at..at + end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn zip_of(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        for (name, content) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn docx_with_blob(name: &str, size: usize) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        if name != "word/document.xml" {
            writer.start_file("word/document.xml", options).unwrap();
            writer
                .write_all(b"<w:document><w:p><w:t>safe</w:t></w:p></w:document>")
                .unwrap();
        }
        writer.start_file(name, options).unwrap();
        writer.write_all(&vec![b'x'; size]).unwrap();
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn irrelevant_archive_members_are_never_expanded() {
        let bytes = docx_with_blob("word/media/unused.bin", MAX_MEMBER_BYTES as usize + 1);
        assert_eq!(extract_docx(&bytes).unwrap(), "safe");
    }

    #[test]
    fn oversized_required_member_is_refused() {
        let bytes = docx_with_blob("word/document.xml", MAX_MEMBER_BYTES as usize + 1);
        assert!(extract_docx(&bytes).is_err());
    }

    #[test]
    fn duplicate_required_member_is_refused() {
        let bytes = zip_of(&[
            ("word\\document.xml", "<w:t>one</w:t>"),
            ("word/document.xml", "<w:t>two</w:t>"),
        ]);
        assert!(extract_docx(&bytes).is_err());
    }

    #[test]
    fn docx_paragraphs_come_out_in_order() {
        let bytes = zip_of(&[(
            "word/document.xml",
            r#"<w:document><w:body>
                <w:p><w:r><w:t>第一章 &amp; 引子</w:t></w:r></w:p>
                <w:p><w:r><w:t xml:space="preserve"> 她说话很省。</w:t></w:r></w:p>
            </w:body></w:document>"#,
        )]);
        let text = extract_docx(&bytes).unwrap();
        assert!(text.contains("第一章 & 引子"), "{text}");
        assert!(text.contains("她说话很省。"), "{text}");
        assert!(text.find("第一章").unwrap() < text.find("她说话很省").unwrap());
    }

    #[test]
    fn pptx_slides_come_out_in_slide_order() {
        let bytes = zip_of(&[
            (
                "ppt/slides/slide2.xml",
                "<p:sld><a:p><a:t>第二页</a:t></a:p></p:sld>",
            ),
            (
                "ppt/slides/slide1.xml",
                "<p:sld><a:p><a:t>第一页</a:t> <a:t>标题</a:t></a:p></p:sld>",
            ),
        ]);
        let text = extract_pptx(&bytes).unwrap();
        assert!(text.contains("第一页 标题"), "{text}");
        assert!(
            text.find("第一页").unwrap() < text.find("第二页").unwrap(),
            "{text}"
        );
    }

    #[test]
    fn xlsx_rows_resolve_shared_strings() {
        let bytes = zip_of(&[
            (
                "xl/sharedStrings.xml",
                "<sst><si><t>姓名</t></si><si><r><t>林栖迟</t></r></si></sst>",
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<worksheet><sheetData>
                    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
                    <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42</v></c></row>
                </sheetData></worksheet>"#,
            ),
        ]);
        let text = extract_xlsx(&bytes).unwrap();
        assert!(text.contains("姓名 林栖迟"), "{text}");
        assert!(text.contains("林栖迟 42"), "{text}");
    }

    #[test]
    fn epub_pages_follow_the_spine() {
        let bytes = zip_of(&[
            ("mimetype", "application/epub+zip"),
            (
                "META-INF/container.xml",
                r#"<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#,
            ),
            (
                "OEBPS/content.opf",
                r#"<package><manifest>
                    <item id="c2" href="c2.xhtml"/><item id="c1" href="c1.xhtml"/>
                </manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>"#,
            ),
            ("OEBPS/c1.xhtml", "<html><body><p>开篇。</p></body></html>"),
            ("OEBPS/c2.xhtml", "<html><body><p>承接。</p></body></html>"),
        ]);
        let text = extract_epub(&bytes).unwrap();
        assert!(
            text.find("开篇").unwrap() < text.find("承接").unwrap(),
            "{text}"
        );
    }
}
