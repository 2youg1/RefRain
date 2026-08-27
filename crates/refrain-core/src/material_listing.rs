// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! What an agent is told about a piece of material, and what it may fetch.
//!
//! # The problem this solves
//!
//! Materials used to enter a request whole. Three 100KB references come to
//! roughly 153,600 tokens by this project's own estimate, and the cost is not
//! merely money — recall *degrades* as the
//! context grows ("context rot"), so pasting everything makes the agent worse
//! at the job, not just more expensive.
//!
//! # Why the outline is not a summary
//!
//! A generated summary would need a model, and this application makes no
//! network calls and ships no model. That constraint turns out to be a
//! benefit rather than a limitation.
//!
//! A summary is one model's reading of the material. An agent handed a
//! summary cannot know what the summary dropped, so it either trusts a
//! paraphrase it cannot check or asks for the whole thing back — which is the
//! original problem plus a round trip. Worse, a summary is a second authority
//! on what the material says, and it goes stale the moment the author edits.
//!
//! What goes in the outline instead is **structure the author wrote**: the
//! headings, verbatim. Measured over the real workspace, 31.7% of blocks are
//! headings — the author's own table of contents, already in the index
//! because finding block boundaries requires deciding block kinds anyway.
//! It cannot mislead, because nothing generated it. This is the same
//! principle `narrate_artifact` follows: state facts, never infer.
//!
//! # Why an excerpt and not a précis
//!
//! An outline of headings says what a material covers but not how it reads —
//! and a material with no headings would say nothing at all. So the entry
//! carries the opening bytes of the text, labelled as an excerpt. It is the
//! author's own first sentences, truncated at a character boundary. A reader
//! can tell an excerpt from a summary at a glance, which is the point.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::block_shape::BlockKind;
use crate::document_format::DocumentFormat;
use crate::role::DocumentRole;
use crate::searchable_block::blocks_of;

/// How much of one material the author lets the agent reach.
///
/// The author's declaration, not the agent's choice. The project's standing
/// position is that a human decides what crosses to a model — the same
/// reasoning that puts a click between a proposal and the manuscript.
///
/// The enum is itself the documentation: an agent reading `OutlineOnly` in a
/// listing knows not to try fetching that body, with no prose telling it so.
/// The guidance for current model generations is explicit that expressive
/// parameters beat worked examples, because examples narrow the space an
/// agent will explore.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum Disclosure {
    /// The listing only. The body is never fetchable.
    OutlineOnly,
    /// Blocks may be retrieved by search or by block range.
    #[default]
    Retrievable,
    /// The whole text may be fetched in one go.
    Full,
}

impl Disclosure {
    /// The wire spelling, in one place so code and protocol cannot drift.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OutlineOnly => "outline-only",
            Self::Retrievable => "retrievable",
            Self::Full => "full",
        }
    }

    /// The stored spelling back into the enum. An unknown value answers
    /// `None` rather than a default: a damaged row must be refused by the
    /// reader, not quietly widened into a reach the author never gave.
    #[must_use]
    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "outline-only" => Some(Self::OutlineOnly),
            "retrievable" => Some(Self::Retrievable),
            "full" => Some(Self::Full),
            _ => None,
        }
    }

    /// Whether a block of this material may be handed over at all.
    #[must_use]
    pub const fn allows_blocks(self) -> bool {
        matches!(self, Self::Retrievable | Self::Full)
    }

    /// Whether the entire text may be handed over in one request.
    #[must_use]
    pub const fn allows_whole_text(self) -> bool {
        matches!(self, Self::Full)
    }
}

/// How many bytes of a material's opening the listing carries.
///
/// Enough to recognise the register and subject; far too little to stand in
/// for the text. Roughly 90 CJK characters at this project's estimate.
const EXCERPT_BYTES: usize = 180;

/// How many headings a listing carries before it stops.
///
/// A reference work with 400 headings would otherwise reintroduce the problem
/// this design exists to remove. The count is reported either way, so an
/// agent can tell a truncated outline from a short one.
const MAX_OUTLINE_HEADINGS: usize = 24;

/// One heading in a material's outline.
///
/// Two fields and no children: a tree of owned nodes would have to be built,
/// serialised, and — the part that decides it — repaired whenever an author
/// skips a level, which authors do constantly (`#` then `###`). A level number
/// per heading carries the same information, survives any skip without
/// interpretation, and renders as indentation at the one place that needs it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OutlineHeading {
    /// The heading text, verbatim, with its `#` markers and surrounding space
    /// removed — those are syntax, and the level field already carries what
    /// they meant.
    pub text: String,
    /// 1..=6, exactly as many `#` as the author wrote.
    pub level: u8,
}

/// One material, as it appears in a request's listing.
///
/// Everything here is derived from the text and the index — nothing is
/// generated, so nothing can be wrong in the way a summary can be wrong.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MaterialListing {
    /// The handle the agent quotes to fetch from this material: its
    /// Root-relative path, which is also what a local agent would open.
    pub path: String,
    /// The title the author gave it.
    pub title: String,
    /// Chapter or material — the same role the catalog records.
    pub role: DocumentRole,
    /// BLAKE3 of the bytes this listing describes. An agent citing a block
    /// against a digest the document no longer has is citing a text that
    /// changed under it.
    pub digest: String,
    pub bytes: u64,
    /// How many indexable blocks it holds. With the ordinal, this is what
    /// makes "read blocks 12 to 18" a request an agent can form unaided.
    pub blocks: u32,
    /// The author's own headings, verbatim, in order, each with the level the
    /// author gave it.
    ///
    /// Flat text was the previous shape, and it failed at exactly the length
    /// where an outline earns its keep: by the fortieth of sixty headings an
    /// agent no longer knows which chapter it is inside, so it asks for the
    /// whole document — the thing the outline exists to avoid.
    pub outline: Vec<OutlineHeading>,
    /// How many headings the material actually has, which may exceed
    /// `outline.len()`. Reported so a truncated outline says it is truncated.
    pub heading_count: u32,
    /// The material's opening bytes, verbatim. Not a summary.
    pub excerpt: String,
    /// What the author permits.
    pub disclosure: Disclosure,
}

impl MaterialListing {
    /// Build a listing from the material's own text.
    ///
    /// Deterministic: the same bytes always produce the same listing, which is
    /// what lets the manifest digest a request and lets a harness cache it.
    ///
    /// The path decides the scan: a plain-text material has no headings, so
    /// its outline is honestly empty rather than full of lines that happen to
    /// start with a hash.
    #[must_use]
    pub fn describe(
        path: &str,
        title: &str,
        role: DocumentRole,
        digest: &str,
        text: &str,
        disclosure: Disclosure,
    ) -> Self {
        let blocks = blocks_of(text, DocumentFormat::of_path(path).block_scan());
        let headings: Vec<OutlineHeading> = blocks
            .iter()
            .filter_map(|block| match block.kind {
                BlockKind::Heading(level) => Some(OutlineHeading {
                    // Strip the markers, not the text. `## 陆沉舟` is the
                    // author's title for that section; the hashes are how
                    // Markdown spells the level, and the level is now a field.
                    text: block
                        .text
                        .trim()
                        .trim_start_matches('#')
                        .trim_start()
                        .to_string(),
                    level: level.get(),
                }),
                // 表格不是标题：它有内容但不标记位置，进大纲会让读者以为
                // 那里开了一节。
                BlockKind::Paragraph | BlockKind::Fence | BlockKind::Table(_) => None,
            })
            .collect();

        Self {
            path: path.to_string(),
            title: title.to_string(),
            role,
            digest: digest.to_string(),
            bytes: text.len() as u64,
            blocks: u32::try_from(blocks.len()).unwrap_or(u32::MAX),
            outline: headings
                .iter()
                .take(MAX_OUTLINE_HEADINGS)
                .cloned()
                .collect(),
            heading_count: u32::try_from(headings.len()).unwrap_or(u32::MAX),
            excerpt: excerpt_of(text),
            disclosure,
        }
    }

    /// This listing as the `<material>` element of the request's `# Context`.
    ///
    /// The name says the output shape rather than repeating the type's own:
    /// a listing renders itself into exactly one contract element, and the
    /// agent-facing contract is where that element's grammar is fixed.
    ///
    /// One material, a handful of lines. This is the whole saving: the same
    /// material used to arrive as its entire text.
    #[must_use]
    pub fn to_contract_element(&self) -> String {
        let mut out = format!(
            "<material path=\"{}\" digest=\"{}\" bytes=\"{}\" blocks=\"{}\" access=\"{}\">\n  <title>{}</title>",
            escape_attribute(&self.path),
            escape_attribute(&self.digest),
            self.bytes,
            self.blocks,
            self.disclosure.as_str(),
            escape_text(&self.title),
        );

        if !self.outline.is_empty() {
            out.push_str("\n  <outline>");
            for heading in &self.outline {
                // Both the attribute and the indentation, on purpose. The
                // attribute is what a parser reads; the indentation is what
                // the model reads, and a flat list of sixty titles is exactly
                // the failure this replaces. Indent depth is level-1 so a
                // document whose headings all sit at `##` does not arrive
                // uniformly indented for no reason.
                out.push_str(&format!(
                    "\n    {}<h level=\"{}\">{}</h>",
                    "  ".repeat(usize::from(heading.level.saturating_sub(1))),
                    heading.level,
                    escape_text(&heading.text)
                ));
            }
            if self.heading_count as usize > self.outline.len() {
                out.push_str(&format!(
                    "\n    <!-- {} more headings; search or read to see them -->",
                    self.heading_count as usize - self.outline.len()
                ));
            }
            out.push_str("\n  </outline>");
        }

        if !self.excerpt.is_empty() && self.disclosure.allows_blocks() {
            out.push_str(&format!(
                "\n  <excerpt>{}</excerpt>",
                escape_text(&self.excerpt)
            ));
        }

        out.push_str("\n</material>");
        out
    }
}

/// The opening of a text, cut at a character boundary.
///
/// Cutting mid-character would produce invalid UTF-8 and, in CJK, a broken
/// glyph at the join — the sort of detail that reads as corruption.
fn excerpt_of(text: &str) -> String {
    let trimmed = text.trim_start();
    if trimmed.len() <= EXCERPT_BYTES {
        return trimmed.to_string();
    }
    let mut end = EXCERPT_BYTES;
    while end > 0 && !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &trimmed[..end])
}

fn escape_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_attribute(text: &str) -> String {
    escape_text(text).replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    const MATERIAL: &str = "# 人物志\n\n\
        这是开篇的一段介绍文字，用来说明这份资料讲的是什么。\n\n\
        ## 陆沉舟\n\n\
        四十二岁，前营销总监。\n\n\
        ## 习惯\n\n\
        习惯在纸上写字。";

    fn described() -> MaterialListing {
        MaterialListing::describe(
            "资料/人物志.md",
            "人物志",
            DocumentRole::Material,
            "abc123",
            MATERIAL,
            Disclosure::Retrievable,
        )
    }

    /// The listing carries the author's headings, exactly as written, each at
    /// the level the author wrote it.
    #[test]
    fn the_outline_is_the_authors_own_headings_verbatim_with_their_levels() {
        let entry = described();
        let outline: Vec<(&str, u8)> = entry
            .outline
            .iter()
            .map(|heading| (heading.text.as_str(), heading.level))
            .collect();
        assert_eq!(
            outline,
            vec![("人物志", 1), ("陆沉舟", 2), ("习惯", 2)],
            "the text loses its markers and keeps everything else"
        );
        assert_eq!(entry.heading_count, 3);
    }

    /// Plan §7's criterion, stated as the test that fails when it stops
    /// holding: every level in the listing equals the number of `#` the author
    /// typed on that line. Checked against the source text rather than against
    /// another copy of the expectation, so the two cannot agree while both
    /// being wrong.
    #[test]
    fn every_outline_level_equals_the_hashes_in_the_source() {
        let source =
            "# 一\n\n正文\n\n## 二\n\n### 三\n\n###### 六\n\n#不是标题\n\n####### 七个也不是\n";
        let entry = MaterialListing::describe(
            "manuscript/深.md",
            "深",
            DocumentRole::Chapter,
            "digest",
            source,
            Disclosure::Full,
        );

        let from_source: Vec<(String, u8)> = source
            .lines()
            .filter_map(|line| {
                let hashes = line.bytes().take_while(|byte| *byte == b'#').count();
                let followed = matches!(line.as_bytes().get(hashes), None | Some(b' '));
                ((1..=6).contains(&hashes) && followed)
                    .then(|| (line[hashes..].trim().to_string(), hashes as u8))
            })
            .collect();

        let from_listing: Vec<(String, u8)> = entry
            .outline
            .iter()
            .map(|heading| (heading.text.clone(), heading.level))
            .collect();

        assert_eq!(from_listing, from_source);
        assert_eq!(
            entry.heading_count, 4,
            "two of the six lines are not headings"
        );
    }

    /// The point of the whole design, measured at the scale it exists for.
    ///
    /// A listing is *not* smaller than a two-line note — it carries headings,
    /// an excerpt and structure, so on a 200-byte material it costs more than
    /// the material. That is a real property and not a defect: this design
    /// targets the 100KB reference, where the ratio is what matters.
    ///
    /// Use a fixture at the target scale instead of shrinking the claim.
    #[test]
    fn a_listing_costs_a_fraction_of_a_real_material() {
        // A reference of the size the author actually ticks: ~100KB.
        let mut big = String::new();
        for section in 0..60 {
            big.push_str(&format!("## 第{section}节\n\n"));
            big.push_str(&"这是一段足够长的正文，用来把这份资料撑到真实尺度。".repeat(30));
            big.push_str("\n\n");
        }
        assert!(big.len() > 90_000, "夹具应达到真实尺度: {}", big.len());

        let entry = MaterialListing::describe(
            "资料/大部头.md",
            "大部头",
            DocumentRole::Material,
            "d",
            &big,
            Disclosure::Retrievable,
        );
        let listing = entry.to_contract_element();
        let ratio = listing.len() as f64 / big.len() as f64;
        assert!(
            ratio < 0.05,
            "目录应远小于材料本身，实为 {:.1}%（{} vs {} 字节）",
            ratio * 100.0,
            listing.len(),
            big.len()
        );
    }

    /// An excerpt is the opening bytes, not a paraphrase — a reader must be
    /// able to check it against the source character for character.
    #[test]
    fn the_excerpt_is_a_verbatim_prefix_of_the_text() {
        let entry = described();
        let trimmed = MATERIAL.trim_start();
        let body = entry.excerpt.trim_end_matches('…');
        assert!(
            trimmed.starts_with(body),
            "excerpt {:?} is not a prefix of the material",
            entry.excerpt
        );
    }

    #[test]
    fn a_long_excerpt_is_cut_on_a_character_boundary() {
        let long = "长".repeat(500);
        let entry = MaterialListing::describe(
            "资料/长.md",
            "长",
            DocumentRole::Material,
            "d",
            &long,
            Disclosure::Retrievable,
        );
        // Valid UTF-8 by construction of the type; the real assertion is that
        // no partial character survived the cut.
        assert!(entry.excerpt.ends_with('…'));
        assert!(
            entry
                .excerpt
                .trim_end_matches('…')
                .chars()
                .all(|c| c == '长')
        );
    }

    /// A truncated outline must say it is truncated, or the agent reads a
    /// partial table of contents as a complete one.
    #[test]
    fn an_outline_past_the_cap_reports_how_many_it_left_out() {
        let many: String = (0..40)
            .map(|index| format!("## 第{index}节\n\n正文。\n\n"))
            .collect();
        let entry = MaterialListing::describe(
            "资料/多.md",
            "多",
            DocumentRole::Material,
            "d",
            &many,
            Disclosure::Retrievable,
        );
        assert_eq!(entry.outline.len(), MAX_OUTLINE_HEADINGS);
        assert_eq!(entry.heading_count, 40);
        assert!(entry.to_contract_element().contains("16 more headings"));
    }

    /// `OutlineOnly` 意味着正文一个字都不许走。摘录是正文的逐字前缀，
    /// 所以它也必须留下——这条测试是被 `context_compiler` 的判据 1-1
    /// 逼出来的：目录表接上去之后，一份标为「不许取正文」的资料仍然把
    /// 开头 180 字节送了出去。权限若不管摘录，它就只是一句空话。
    #[test]
    fn an_outline_only_material_gives_up_no_body_text_at_all() {
        let secret = "# 机密\n\n这段正文一个字都不该出现在请求里。";
        let entry = MaterialListing::describe(
            "资料/机密.md",
            "机密",
            DocumentRole::Material,
            "d",
            secret,
            Disclosure::OutlineOnly,
        );
        let listing = entry.to_contract_element();

        // 标题是作者写的结构，可以给——那正是目录的意义。层级现在是属性，
        // `#` 不再出现在契约里（它是 Markdown 拼写层级的方式，而层级已经
        // 有了自己的字段）。
        assert!(listing.contains("<h level=\"1\">机密</h>"), "{listing}");
        // 正文不行，摘录也是正文。
        assert!(
            !listing.contains("这段正文"),
            "OutlineOnly 的正文泄漏进了目录: {listing}"
        );
        assert!(!listing.contains("<excerpt>"));
    }

    /// The disclosure is stated in the listing, so an agent never has to be
    /// told in prose that some materials are closed.
    #[test]
    fn the_listing_states_what_the_author_permits() {
        for (disclosure, spelling) in [
            (Disclosure::OutlineOnly, "outline-only"),
            (Disclosure::Retrievable, "retrievable"),
            (Disclosure::Full, "full"),
        ] {
            let entry = MaterialListing::describe(
                "资料/x.md",
                "x",
                DocumentRole::Material,
                "d",
                MATERIAL,
                disclosure,
            );
            assert!(
                entry
                    .to_contract_element()
                    .contains(&format!("access=\"{spelling}\"")),
                "{spelling} missing from listing"
            );
        }
    }

    /// Disclosures are a closed question with three answers, and the two
    /// predicates must not drift from the variants.
    #[test]
    fn disclosure_predicates_agree_with_the_variants() {
        assert!(!Disclosure::OutlineOnly.allows_blocks());
        assert!(!Disclosure::OutlineOnly.allows_whole_text());
        assert!(Disclosure::Retrievable.allows_blocks());
        assert!(!Disclosure::Retrievable.allows_whole_text());
        assert!(Disclosure::Full.allows_blocks());
        assert!(Disclosure::Full.allows_whole_text());
    }

    /// A material with no headings still gets a usable listing: the excerpt
    /// is what carries it. This is the case a heading-only design would fail.
    #[test]
    fn a_material_without_headings_still_says_something_true_about_itself() {
        let entry = MaterialListing::describe(
            "资料/无标题.md",
            "无标题",
            DocumentRole::Material,
            "d",
            "就是一段没有任何标题的说明文字，讲了一件事。",
            Disclosure::Retrievable,
        );
        assert!(entry.outline.is_empty());
        let listing = entry.to_contract_element();
        assert!(listing.contains("就是一段没有任何标题"));
    }

    /// A title carrying markup must not be able to close the element early.
    #[test]
    fn markup_in_a_title_cannot_break_out_of_the_listing() {
        let entry = MaterialListing::describe(
            "资料/x.md",
            "</material><injected>",
            DocumentRole::Material,
            "d",
            MATERIAL,
            Disclosure::Retrievable,
        );
        let listing = entry.to_contract_element();
        assert!(!listing.contains("<injected>"));
        assert_eq!(listing.matches("</material>").count(), 1);
    }
}
