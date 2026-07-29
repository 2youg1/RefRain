//! Material ingestion (C12.3, SPEC 8.7's source side): turn a source file in
//! one of the six reference formats into the plain text a Material carries.
//! Everything is local — no cloud conversion: the source bytes are read,
//! never written, and the digest pins exactly what the text was projected
//! from. The extracted text is a projection for reading and context, never a
//! claim of byte fidelity (INV-5 covers manuscripts, not materials).

use std::path::{Path, PathBuf};

use refrain_core::{ErrorCode, RefrainError};
use sha2::Digest as _;

mod html;
mod office;
mod pdf;

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

/// Read and project one source file. The format is named by the extension
/// and proven by the bytes: a zip container must carry the member its
/// claimed family requires, and a PDF must start with its magic.
pub fn ingest(path: &Path) -> Result<IngestedMaterial, RefrainError> {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let bytes = std::fs::read(path).map_err(|error| {
        RefrainError::new(
            ErrorCode::Io,
            "read a source file",
            path.display().to_string(),
        )
        .with_detail(error.to_string())
    })?;
    let digest = format!("{:x}", sha2::Sha256::digest(&bytes));
    let title = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("material")
        .to_string();
    let (format, text) = match extension.as_str() {
        "pdf" => (SourceFormat::Pdf, pdf::extract(&bytes)?),
        "html" | "htm" => (
            SourceFormat::Html,
            html::extract(&String::from_utf8_lossy(&bytes)),
        ),
        "epub" => (SourceFormat::Epub, office::extract_epub(&bytes)?),
        "docx" => (SourceFormat::Docx, office::extract_docx(&bytes)?),
        "pptx" => (SourceFormat::Pptx, office::extract_pptx(&bytes)?),
        "xlsx" => (SourceFormat::Xlsx, office::extract_xlsx(&bytes)?),
        other => {
            return Err(failure(
                "ingest a material source",
                format!("{other}: pdf / epub / html / docx / pptx / xlsx"),
            ));
        }
    };
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
                u32::from_str_radix(&entity[2..], 16).ok().and_then(char::from_u32)
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
    while lines.first().is_some_and(String::is_empty) {
        lines.remove(0);
    }
    while lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    lines.join("\n")
}
