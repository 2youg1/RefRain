// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! Material ingestion (C12.3, SPEC 8.7's source side): turn a source file in
//! one of the six reference formats into the plain text a Material carries.
//! Everything is local — no cloud conversion: the source bytes are read,
//! never written, and the digest pins exactly what the text was projected
//! from. The extracted text is a projection for reading and context, never a
//! claim of byte fidelity (INV-5 covers manuscripts, not materials).

use std::{
    io::Read as _,
    path::{Path, PathBuf},
};

use refrain_core::{ErrorCode, RefrainError, digest::content_hex};

mod html;
mod office;
mod pdf;

pub const MAX_SOURCE_BYTES: u64 = 128 * 1024 * 1024;
pub const MAX_EXTRACTED_TEXT_BYTES: usize = 32 * 1024 * 1024;

/// The six reference formats (Plan C12.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceFormat {
    Pdf,
    Epub,
    Html,
    Docx,
    Pptx,
    Xlsx,
}

impl SourceFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Epub => "epub",
            Self::Html => "html",
            Self::Docx => "docx",
            Self::Pptx => "pptx",
            Self::Xlsx => "xlsx",
        }
    }
}

/// One ingested source: the projected text plus the provenance a reader can
/// audit — which file, which format, which exact bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IngestedMaterial {
    pub format: SourceFormat,
    pub title: String,
    pub text: String,
    pub source_path: PathBuf,
    pub source_digest: String,
}

fn failure(action: &str, subject: impl Into<String>) -> RefrainError {
    RefrainError::new(ErrorCode::UnsupportedFormat, action, subject.into())
}

pub fn read_source(path: &Path) -> Result<Vec<u8>, RefrainError> {
    let metadata = std::fs::metadata(path).map_err(|error| {
        RefrainError::new(
            ErrorCode::Io,
            "inspect a source file",
            path.display().to_string(),
        )
        .with_detail(error.to_string())
    })?;
    if metadata.len() > MAX_SOURCE_BYTES {
        return Err(failure(
            "read a source file",
            format!(
                "{} bytes exceeds the {} byte source limit",
                metadata.len(),
                MAX_SOURCE_BYTES
            ),
        ));
    }
    let file = std::fs::File::open(path).map_err(|error| {
        RefrainError::new(
            ErrorCode::Io,
            "read a source file",
            path.display().to_string(),
        )
        .with_detail(error.to_string())
    })?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            RefrainError::new(
                ErrorCode::Io,
                "read a source file",
                path.display().to_string(),
            )
            .with_detail(error.to_string())
        })?;
    if bytes.len() as u64 > MAX_SOURCE_BYTES {
        return Err(failure(
            "read a source file",
            format!("source grew beyond the {MAX_SOURCE_BYTES} byte limit"),
        ));
    }
    Ok(bytes)
}

/// Read and project one source file. The format is named by the extension
/// and proven by the bytes: a zip container must carry the member its
/// claimed family requires, and a PDF must start with its magic.
pub fn ingest(path: &Path) -> Result<IngestedMaterial, RefrainError> {
    let bytes = read_source(path)?;
    ingest_bytes(path, &bytes)
}

/// Project bytes that have already passed the bounded reader.
/// Material preparation uses this to parse and clone one identical buffer.
pub(crate) fn ingest_bytes(path: &Path, bytes: &[u8]) -> Result<IngestedMaterial, RefrainError> {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let digest = content_hex(bytes);
    let title = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("material")
        .to_string();
    let (format, text) = match extension.as_str() {
        "pdf" => (SourceFormat::Pdf, pdf::extract(bytes)?),
        "html" | "htm" => (
            SourceFormat::Html,
            html::extract(&String::from_utf8_lossy(bytes)),
        ),
        "epub" => (SourceFormat::Epub, office::extract_epub(bytes)?),
        "docx" => (SourceFormat::Docx, office::extract_docx(bytes)?),
        "pptx" => (SourceFormat::Pptx, office::extract_pptx(bytes)?),
        "xlsx" => (SourceFormat::Xlsx, office::extract_xlsx(bytes)?),
        other => {
            return Err(failure(
                "ingest a material source",
                format!("{other}: pdf / epub / html / docx / pptx / xlsx"),
            ));
        }
    };
    if text.len() > MAX_EXTRACTED_TEXT_BYTES {
        return Err(failure(
            "ingest a material source",
            format!(
                "projected text is {} bytes; limit is {MAX_EXTRACTED_TEXT_BYTES}",
                text.len()
            ),
        ));
    }
    Ok(IngestedMaterial {
        format,
        title,
        text,
        source_path: path.to_path_buf(),
        source_digest: digest,
    })
}

/// Decode the numeric character references and the five named ones any of
/// the targeted extractors can meet. Everything else stays verbatim.
pub(crate) fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let after = &rest[at..];
        let Some(end) = after.find(';') else {
            out.push_str(after);
            return out;
        };
        let entity = &after[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some(' '),
            _ if entity.starts_with("#x") || entity.starts_with("#X") => {
                u32::from_str_radix(&entity[2..], 16)
                    .ok()
                    .and_then(char::from_u32)
            }
            _ if entity.starts_with('#') => {
                entity[1..].parse::<u32>().ok().and_then(char::from_u32)
            }
            _ => None,
        };
        match decoded {
            Some(ch) => out.push(ch),
            None => {
                out.push_str(&after[..=end]);
            }
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/// Collapse a run of extracted text: trim lines, squeeze interior
/// whitespace, drop empty lines, cap blank runs at one.
pub(crate) fn normalize(text: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for line in text.lines() {
        let squeezed = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if squeezed.is_empty() && lines.last().is_some_and(|last: &String| last.is_empty()) {
            continue;
        }
        lines.push(squeezed);
    }
    let first = lines
        .iter()
        .position(|line| !line.is_empty())
        .unwrap_or(lines.len());
    lines.drain(..first);
    while lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leading_empty_lines_are_removed_in_one_pass() {
        let source = format!("{}text", "\n".repeat(10_000));
        assert_eq!(normalize(&source), "text");
    }
}
