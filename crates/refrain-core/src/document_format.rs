// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

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

    /// The number this format travels as across the C ABI.
    ///
    /// Written out rather than derived from the enum's declaration order: the
    /// order is an editing convenience, and reordering the variants for
    /// readability would silently repaint every open document in the wrong
    /// grammar. A new format takes the next free number and never reuses one.
    #[must_use]
    pub fn wire_code(self) -> u32 {
        match self {
            Self::Markdown => 0,
            Self::Latex => 1,
            Self::TypeScript => 2,
            Self::Rust => 3,
            Self::Python => 4,
            Self::Go => 5,
            Self::Lean => 6,
            Self::Css => 7,
            Self::Html => 8,
            Self::Xml => 9,
            Self::Toml => 10,
            Self::Yaml => 11,
        }
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
    /// 这份格式按代码排还是按散文排。
    ///
    /// **接上哪个功能**：投影的断行分流（P3.7）——代码走等宽硬切
    /// （`typeset::line_starts_code`），散文走禁则与候选（`line_starts`）。
    ///
    /// **拥有什么全局不变量**：判据是「作者在这里写的是代码还是散文」。
    /// LaTeX 虽然以 ASCII 为主，但它是写作格式（正文夹在源码里），禁则与
    /// 行尾调整对它仍正确——中文注释与公式文字按散文排。Markdown 同理。
    pub fn is_code(self) -> bool {
        !matches!(self, Self::Markdown | Self::Latex)
    }

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
    // 这里只回答「这个扩展名是什么格式、按哪种规则分块」，不回答「怎么着色」。
    //
    // 着色曾由旧 DOM 表面负责，两份映射分居两处是有意的：核心不背第二份。
    // 那一层随步骤 10 退场，所以**当前没有任何着色实现**——格式识别与逐字节
    // 往返不受影响，它们本来就在这一侧。
    //
    // 原生表面接上代码阅读时，着色映射仍应住在表面一侧（Native SDK 的 `code`
    // 部件自带受限着色），而不是搬进核心。
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_format_travels_as_a_distinct_stable_number() {
        // 这些数字是跨界契约：Zig 的 `document_language.syntaxOf` 按它们查表。
        // 写死在这里而不是从声明顺序推导，所以有人为了可读性重排枚举时，
        // 变红的是这条测试，而不是用户打开一份 Rust 文件却看到 Python 的颜色。
        let expected: &[(DocumentFormat, u32)] = &[
            (DocumentFormat::Markdown, 0),
            (DocumentFormat::Latex, 1),
            (DocumentFormat::TypeScript, 2),
            (DocumentFormat::Rust, 3),
            (DocumentFormat::Python, 4),
            (DocumentFormat::Go, 5),
            (DocumentFormat::Lean, 6),
            (DocumentFormat::Css, 7),
            (DocumentFormat::Html, 8),
            (DocumentFormat::Xml, 9),
            (DocumentFormat::Toml, 10),
            (DocumentFormat::Yaml, 11),
        ];
        for (format, code) in expected {
            assert_eq!(
                format.wire_code(),
                *code,
                "{format:?} changed its wire code"
            );
        }
        // 两种格式共用一个号，界面就会把其中一种用另一种的语法上色，
        // 而两侧单看都自洽。
        let mut codes: Vec<u32> = expected.iter().map(|(_, code)| *code).collect();
        codes.sort_unstable();
        let count = codes.len();
        codes.dedup();
        assert_eq!(codes.len(), count, "two formats share a wire code");
    }

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

    /// 近失手：把 LaTeX 当代码排会切错中文注释（硬切在词中间断），
    /// 把 Markdown 当代码排会让散文失去禁则——两种都钉住。
    #[test]
    fn prose_formats_are_markdown_and_latex_only() {
        assert!(!DocumentFormat::Markdown.is_code());
        assert!(!DocumentFormat::Latex.is_code());
        for format in [
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
            assert!(format.is_code(), "{format:?} must break as code");
        }
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
