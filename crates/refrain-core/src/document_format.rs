//! What one document's bytes are.
//!
//! # Why this exists
//!
//! The workbench edits Markdown prose and a fixed set of plain-text formats
//! (code, markup, configuration) with the same promise: the file on disk is
//! the only original, and a save writes the same format back. Which of the
//! two editing modes a document gets is decided once, here, from its
//! extension — the boundary where the file enters.
//!
//! # Why an exhaustive enum
//!
//! Every dispatch point matches on this enum without a catch-all arm. Adding
//! a format then fails compilation at each place that must decide something
//! for it: how bytes divide into blocks, whether the search index strips
//! inline markers, which embedded grammar highlights the whole document.
//! A format that slips through silently would be mangled by the Markdown
//! rules instead of refused by the compiler.

use crate::source_layout::BlockScan;

/// What one document's bytes are: Markdown prose, or one of the plain-text
/// formats the workbench edits natively.
///
/// The wire form is the lowercase name, which is also what the surface shows
/// and what the editor maps onto its embedded grammars.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize, specta::Type,
)]
#[serde(rename_all = "lowercase")]
pub enum DocumentFormat {
    /// Prose with Markdown structure: headings, fences, tables, inline marks.
    Markdown,
    /// LaTeX source (`.tex`).
    Latex,
    /// TypeScript source (`.ts`).
    TypeScript,
    /// Rust source (`.rs`).
    Rust,
    /// Python source (`.py`).
    Python,
    /// Go source (`.go`).
    Go,
    /// Lean 4 source (`.lean`).
    Lean,
    /// A stylesheet (`.css`).
    Css,
    /// HTML source (`.html`, `.htm`), edited as text and never rendered.
    Html,
    /// XML source (`.xml`).
    Xml,
    /// TOML configuration (`.toml`).
    Toml,
    /// YAML configuration (`.yaml`, `.yml`).
    Yaml,
}

/// The extension table: the one place the mapping from a file name to a
/// format lives. Admission (`of_extension`), the chooser's filter list
/// (`extensions`), and classification (`of_path`) all read this table, so the
/// three can never disagree about which names the workbench edits.
const TABLE: &[(&[&str], DocumentFormat)] = &[
    (
        &["md", "markdown", "mdown", "txt"],
        DocumentFormat::Markdown,
    ),
    (&["tex"], DocumentFormat::Latex),
    (&["ts"], DocumentFormat::TypeScript),
    (&["rs"], DocumentFormat::Rust),
    (&["py"], DocumentFormat::Python),
    (&["go"], DocumentFormat::Go),
    (&["lean"], DocumentFormat::Lean),
    (&["css"], DocumentFormat::Css),
    (&["html", "htm"], DocumentFormat::Html),
    (&["xml"], DocumentFormat::Xml),
    (&["toml"], DocumentFormat::Toml),
    (&["yaml", "yml"], DocumentFormat::Yaml),
];

impl DocumentFormat {
    /// The format one extension names, if the workbench edits it.
    ///
    /// Matching ignores case: a `CHAPTER.MD` and a `chapter.md` are the same
    /// document kind, which is the behaviour the walk and the Source Backup
    /// always had.
    #[must_use]
    pub fn of_extension(extension: &str) -> Option<Self> {
        TABLE.iter().find_map(|(extensions, format)| {
            extensions
                .iter()
                .any(|known| extension.eq_ignore_ascii_case(known))
                .then_some(*format)
        })
    }

    /// The format one Root-relative path names. An extension this table does
    /// not know reads as Markdown — the behaviour every unknown name had
    /// before formats existed, kept so a stray file is mangled by nothing
    /// new.
    #[must_use]
    pub fn of_path(path: &str) -> Self {
        let extension = path.rsplit('/').next().unwrap_or(path);
        extension
            .rsplit_once('.')
            .and_then(|(_, extension)| Self::of_extension(extension))
            .unwrap_or(Self::Markdown)
    }

    /// Every extension the workbench edits, for the file chooser's filter.
    /// Read from the same table admission reads.
    #[must_use]
    pub fn extensions() -> Vec<&'static str> {
        TABLE
            .iter()
            .flat_map(|(extensions, _)| extensions.iter().copied())
            .collect()
    }

    /// How this format's bytes divide into blocks.
    #[must_use]
    pub fn block_scan(self) -> BlockScan {
        match self {
            Self::Markdown => BlockScan::Markdown,
            Self::Latex
            | Self::TypeScript
            | Self::Rust
            | Self::Python
            | Self::Go
            | Self::Lean
            | Self::Css
            | Self::Html
            | Self::Xml
            | Self::Toml
            | Self::Yaml => BlockScan::Plain,
        }
    }
    // 格式 → 高亮语法的唯一权威在 `packages/editor/src/code-highlight.ts`
    // （DOCUMENT_LANGUAGE）：着色是编辑器的事，核心不背第二份映射。HTML 按
    // 设计用 XML 语法（真 html 语法静态拉入 247KB JS，实测记录在案）。
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_listed_extension_resolves_to_its_format() {
        let expected: &[(&str, DocumentFormat)] = &[
            ("md", DocumentFormat::Markdown),
            ("markdown", DocumentFormat::Markdown),
            ("mdown", DocumentFormat::Markdown),
            ("txt", DocumentFormat::Markdown),
            ("tex", DocumentFormat::Latex),
            ("ts", DocumentFormat::TypeScript),
            ("rs", DocumentFormat::Rust),
            ("py", DocumentFormat::Python),
            ("go", DocumentFormat::Go),
            ("lean", DocumentFormat::Lean),
            ("css", DocumentFormat::Css),
            ("html", DocumentFormat::Html),
            ("htm", DocumentFormat::Html),
            ("xml", DocumentFormat::Xml),
            ("toml", DocumentFormat::Toml),
            ("yaml", DocumentFormat::Yaml),
            ("yml", DocumentFormat::Yaml),
        ];
        for (extension, format) in expected {
            assert_eq!(DocumentFormat::of_extension(extension), Some(*format));
        }
        // Case is not part of the name.
        assert_eq!(
            DocumentFormat::of_extension("RS"),
            Some(DocumentFormat::Rust)
        );
        // What the table does not know, it does not admit.
        assert_eq!(DocumentFormat::of_extension("docx"), None);
        assert_eq!(DocumentFormat::of_extension("pdf"), None);
    }

    #[test]
    fn the_filter_list_and_admission_read_one_table() {
        let listed = DocumentFormat::extensions();
        assert!(!listed.is_empty());
        for extension in &listed {
            assert!(DocumentFormat::of_extension(extension).is_some());
        }
    }

    #[test]
    fn classification_defaults_to_markdown_for_unknown_names() {
        assert_eq!(DocumentFormat::of_path("src/main.rs"), DocumentFormat::Rust);
        assert_eq!(
            DocumentFormat::of_path("資料/年表.md"),
            DocumentFormat::Markdown
        );
        assert_eq!(
            DocumentFormat::of_path("strange.bmp"),
            DocumentFormat::Markdown
        );
        assert_eq!(
            DocumentFormat::of_path("no-extension"),
            DocumentFormat::Markdown
        );
    }

    #[test]
    fn only_markdown_scans_markdown_structure() {
        for format in [
            DocumentFormat::Markdown,
            DocumentFormat::Latex,
            DocumentFormat::TypeScript,
            DocumentFormat::Rust,
            DocumentFormat::Python,
            DocumentFormat::Go,
            DocumentFormat::Lean,
            DocumentFormat::Css,
            DocumentFormat::Html,
            DocumentFormat::Xml,
            DocumentFormat::Toml,
            DocumentFormat::Yaml,
        ] {
            let expected = if format == DocumentFormat::Markdown {
                BlockScan::Markdown
            } else {
                BlockScan::Plain
            };
            assert_eq!(format.block_scan(), expected, "{format:?}");
        }
    }
}
