// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The RefRain Agent protocol (SPEC 8.3b, 8.4).
//!
//! Hand-written scanner, not an XML library: the grammar is a handful of
//! elements wide, while a general parser brings DTDs, entities, namespaces,
//! and external resolution — the exact surface this format exists to refuse.
//!
//! v2 shapes (SPEC 8.4): `replacement` (one per scope, empty deletes),
//! `comments/comment target=`, `memo topic=`, and `material-draft kind= title=`
//! with `basis ref=` children and a CDATA body. Scopes and basis refs are
//! validated against the contract the dispatch was authorised with — an agent
//! cannot address text it was never shown.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Every rejection the protocol can return, in one enum (INV-16: documents
/// enumerate from here, never from memory).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum ArtifactErrorCode {
    MissingRoot,
    TextOutsideRoot,
    DtdForbidden,
    UnsupportedVersion,
    UnknownElement,
    MissingScope,
    DuplicateReplacement,
    Malformed,
    TooDeep,
    UnknownScope,
    UnknownBasis,
    MissingMaterialKind,
    MissingMaterialTitle,
}

impl ArtifactErrorCode {
    /// The complete enumeration, for generated documentation (§8.4).
    pub const ALL: &'static [Self] = &[
        Self::MissingRoot,
        Self::TextOutsideRoot,
        Self::DtdForbidden,
        Self::UnsupportedVersion,
        Self::UnknownElement,
        Self::MissingScope,
        Self::DuplicateReplacement,
        Self::Malformed,
        Self::TooDeep,
        Self::UnknownScope,
        Self::UnknownBasis,
        Self::MissingMaterialKind,
        Self::MissingMaterialTitle,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::MissingRoot => "missing-root",
            Self::TextOutsideRoot => "text-outside-root",
            Self::DtdForbidden => "dtd-forbidden",
            Self::UnsupportedVersion => "unsupported-version",
            Self::UnknownElement => "unknown-element",
            Self::MissingScope => "missing-scope",
            Self::DuplicateReplacement => "duplicate-replacement",
            Self::Malformed => "malformed",
            Self::TooDeep => "too-deep",
            Self::UnknownScope => "unknown-scope",
            Self::UnknownBasis => "unknown-basis",
            Self::MissingMaterialKind => "missing-material-kind",
            Self::MissingMaterialTitle => "missing-material-title",
        }
    }
}

/// A rejection, with the offending detail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactError {
    pub code: ArtifactErrorCode,
    pub detail: String,
}

impl ArtifactError {
    fn new(code: ArtifactErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

/// One proposed replacement. `text: None` deletes the scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentReplacement {
    pub scope: String,
    pub text: Option<String>,
}

/// An observation that changes nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentComment {
    pub target: String,
    pub text: String,
}

/// What the agent chose to remember for next time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentMemo {
    pub text: String,
    pub topic: Option<String>,
}

/// A material draft: only ever a draft until a human saves it (SPEC 8.7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterialDraft {
    pub kind: String,
    pub title: String,
    pub basis: Vec<String>,
    pub body: String,
}

/// A verified artifact: parsed, scope-checked, basis-checked.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct VerifiedArtifact {
    pub replacements: Vec<AgentReplacement>,
    pub comments: Vec<AgentComment>,
    pub memos: Vec<AgentMemo>,
    pub material_drafts: Vec<MaterialDraft>,
}

/// What this dispatch's artifact may address. Built from the authorised
/// manifest, never from the artifact's own claims.
pub struct ArtifactContract<'a> {
    pub scopes: &'a [String],
    pub basis: &'a [String],
}

const REPLY_HEADING: &str = "# Agent reply";
const MAX_DEPTH: usize = 8;
const ROOT_OPEN: &str = "<agent-result";
const ROOT_CLOSE: &str = "</agent-result>";

/// 打印通道的 CLI 爱在产出前叙述一句（「我先读协议。」）。契约对元素外的
/// 文字仍然零容忍——但叙述不携带任何权威：裁掉它不等于采信它，取出的元素
/// 仍要过 `parse` 的每一项校验（scope、版本、嵌套、冻结字节）。
///
/// 只在恰好一个根元素时裁剪：找不到是 `missing-root`，出现第二个开标签说明
/// 产出形状已坏——两种情况都不裁，让 `parse` 的原拒绝原样成立。
pub fn extract_single_root(bytes: &[u8]) -> Option<&[u8]> {
    let text = std::str::from_utf8(bytes).ok()?;
    let open = text.find(ROOT_OPEN)?;
    // ROOT_OPEN/ROOT_CLOSE 都是 ASCII：str::find 给的字节下标可以直接切 bytes。
    if text[open + ROOT_OPEN.len()..].contains(ROOT_OPEN) {
        return None;
    }
    let close = text.rfind(ROOT_CLOSE)?;
    if close < open {
        return None;
    }
    Some(&bytes[open..close + ROOT_CLOSE.len()])
}

/// Parse and verify an artifact. The reply section is taken from `# Agent
/// reply` when the full request file is presented; the whole input is
/// otherwise treated as the reply.
pub fn parse(bytes: &[u8], contract: &ArtifactContract) -> Result<VerifiedArtifact, ArtifactError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| ArtifactError::new(ArtifactErrorCode::Malformed, "not valid UTF-8"))?;
    let reply = text.split(REPLY_HEADING).nth(1).unwrap_or(text);

    // Raw-text checks first: a DTD must never reach a parser, because refusing
    // it after expansion is refusing it too late.
    let lowered = reply.to_lowercase();
    if lowered.contains("<!doctype") || lowered.contains("<!entity") {
        return Err(ArtifactError::new(
            ArtifactErrorCode::DtdForbidden,
            "DTD and entity declarations are not accepted",
        ));
    }

    let Some(open_at) = reply.find(ROOT_OPEN) else {
        return Err(ArtifactError::new(
            ArtifactErrorCode::MissingRoot,
            "no <agent-result> element",
        ));
    };
    let Some(open_end_rel) = reply[open_at..].find('>') else {
        return Err(ArtifactError::new(
            ArtifactErrorCode::Malformed,
            "unterminated <agent-result>",
        ));
    };
    let open_end = open_at + open_end_rel;
    let Some(close_at) = reply[open_end..].find(ROOT_CLOSE).map(|at| open_end + at) else {
        return Err(ArtifactError::new(
            ArtifactErrorCode::MissingRoot,
            "unclosed <agent-result>",
        ));
    };
    let after_close = close_at + ROOT_CLOSE.len();

    let outside = format!("{}{}", &reply[..open_at], &reply[after_close..]);
    if !outside.trim().is_empty() {
        return Err(ArtifactError::new(
            ArtifactErrorCode::TextOutsideRoot,
            "prose outside <agent-result>; use <comment>",
        ));
    }

    let attrs = attributes(&reply[open_at..open_end]);
    if attrs.get("version").map(String::as_str) != Some("2") {
        return Err(ArtifactError::new(
            ArtifactErrorCode::UnsupportedVersion,
            format!(
                "version={}",
                attrs.get("version").map_or("absent", String::as_str)
            ),
        ));
    }

    let body = &reply[open_end + 1..close_at];
    if nesting_depth(body) > MAX_DEPTH {
        return Err(ArtifactError::new(
            ArtifactErrorCode::TooDeep,
            format!("nesting exceeds {MAX_DEPTH}"),
        ));
    }

    let elements = scan(body)?;
    let mut artifact = VerifiedArtifact::default();
    let mut seen_scopes = std::collections::HashSet::new();
    for element in &elements {
        match element.name.as_str() {
            "replacement" => {
                let scope = element.attrs.get("scope").ok_or_else(|| {
                    ArtifactError::new(
                        ArtifactErrorCode::MissingScope,
                        "<replacement> without scope",
                    )
                })?;
                if !contract.scopes.contains(scope) {
                    return Err(ArtifactError::new(
                        ArtifactErrorCode::UnknownScope,
                        format!("scope {scope} was not in this dispatch"),
                    ));
                }
                if !seen_scopes.insert(scope.clone()) {
                    return Err(ArtifactError::new(
                        ArtifactErrorCode::DuplicateReplacement,
                        format!("scope {scope} replaced twice"),
                    ));
                }
                let text = content(&element.body);
                artifact.replacements.push(AgentReplacement {
                    scope: scope.clone(),
                    text: (!text.is_empty()).then_some(text),
                });
            }
            "comments" => {
                for child in scan(&element.body)? {
                    if child.name != "comment" {
                        return Err(ArtifactError::new(
                            ArtifactErrorCode::UnknownElement,
                            format!("<{}>", child.name),
                        ));
                    }
                    let target = child.attrs.get("target").ok_or_else(|| {
                        ArtifactError::new(
                            ArtifactErrorCode::MissingScope,
                            "<comment> without target",
                        )
                    })?;
                    artifact.comments.push(AgentComment {
                        target: target.clone(),
                        text: content(&child.body),
                    });
                }
            }
            "memo" => {
                let text = content(&element.body);
                if !text.is_empty() {
                    artifact.memos.push(AgentMemo {
                        text,
                        topic: element.attrs.get("topic").cloned(),
                    });
                }
            }
            "material-draft" => {
                let kind = element.attrs.get("kind").ok_or_else(|| {
                    ArtifactError::new(
                        ArtifactErrorCode::MissingMaterialKind,
                        "<material-draft> without kind",
                    )
                })?;
                let title = element.attrs.get("title").ok_or_else(|| {
                    ArtifactError::new(
                        ArtifactErrorCode::MissingMaterialTitle,
                        "<material-draft> without title",
                    )
                })?;
                let mut basis = Vec::new();
                let mut body: Option<String> = None;
                for child in scan(&element.body)? {
                    match child.name.as_str() {
                        "basis" => {
                            let reference = child.attrs.get("ref").ok_or_else(|| {
                                ArtifactError::new(
                                    ArtifactErrorCode::UnknownBasis,
                                    "<basis> without ref",
                                )
                            })?;
                            if !contract.basis.contains(reference) {
                                return Err(ArtifactError::new(
                                    ArtifactErrorCode::UnknownBasis,
                                    format!("basis ref {reference} was not in this dispatch"),
                                ));
                            }
                            basis.push(reference.clone());
                        }
                        "body" => {
                            body = Some(content(&child.body));
                        }
                        other => {
                            return Err(ArtifactError::new(
                                ArtifactErrorCode::UnknownElement,
                                format!("<{other}>"),
                            ));
                        }
                    }
                }
                artifact.material_drafts.push(MaterialDraft {
                    kind: kind.clone(),
                    title: title.clone(),
                    basis,
                    body: body.unwrap_or_default(),
                });
            }
            other => {
                return Err(ArtifactError::new(
                    ArtifactErrorCode::UnknownElement,
                    format!("<{other}>"),
                ));
            }
        }
    }
    Ok(artifact)
}

/// One scanned element: name, attributes, raw body.
struct Element {
    name: String,
    attrs: std::collections::HashMap<String, String>,
    body: String,
}

fn attributes(source: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let mut rest = source;
    while let Some(eq) = rest.find('=') {
        let Some(name_end) = rest[..eq].rfind(|c: char| c.is_whitespace() || c == '<') else {
            break;
        };
        let name = rest[name_end + 1..eq].trim();
        let quoted = &rest[eq + 1..];
        if !quoted.starts_with('"') {
            break;
        }
        let Some(close) = quoted[1..].find('"') else {
            break;
        };
        if !name.is_empty() {
            map.insert(name.to_string(), quoted[1..close + 1].to_string());
        }
        rest = &quoted[close + 2..];
    }
    map
}

const CDATA_OPEN: &str = "<![CDATA[";
const CDATA_CLOSE: &str = "]]>";

/// The element scanner. CDATA is consumed as an opaque run so markup inside
/// agent prose never reaches the tag scanner. A closing tag missing its `>`
/// fails fast: the one untrusted input this parser exists to survive is a
/// truncated artifact, and re-scanning it forever once took the host process.
fn scan(source: &str) -> Result<Vec<Element>, ArtifactError> {
    let mut elements = Vec::new();
    let mut cursor = 0;

    while cursor < source.len() {
        let Some(open_rel) = source[cursor..].find('<') else {
            if !source[cursor..].trim().is_empty() {
                return Err(ArtifactError::new(
                    ArtifactErrorCode::TextOutsideRoot,
                    "text between elements",
                ));
            }
            break;
        };
        let open = cursor + open_rel;
        if !source[cursor..open].trim().is_empty() {
            return Err(ArtifactError::new(
                ArtifactErrorCode::TextOutsideRoot,
                format!("stray text: {}", source[cursor..open].trim()),
            ));
        }

        if source[open..].starts_with(CDATA_OPEN) {
            let Some(finish) = source[open + CDATA_OPEN.len()..].find(CDATA_CLOSE) else {
                return Err(ArtifactError::new(
                    ArtifactErrorCode::Malformed,
                    "unterminated CDATA",
                ));
            };
            cursor = open + CDATA_OPEN.len() + finish + CDATA_CLOSE.len();
            continue;
        }

        let Some(close_rel) = source[open..].find('>') else {
            return Err(ArtifactError::new(
                ArtifactErrorCode::Malformed,
                "unterminated tag",
            ));
        };
        let close = open + close_rel;
        let raw = &source[open + 1..close];
        let self_closing = raw.ends_with('/');
        let raw = raw.strip_suffix('/').unwrap_or(raw).trim();
        let name = raw.split_whitespace().next().unwrap_or("").to_string();
        let attrs = attributes(raw);

        if self_closing {
            elements.push(Element {
                name,
                attrs,
                body: String::new(),
            });
            cursor = close + 1;
            continue;
        }

        let closing = format!("</{name}");
        let Some(end_rel) = source[close..].find(&closing) else {
            return Err(ArtifactError::new(
                ArtifactErrorCode::Malformed,
                format!("unclosed <{name}>"),
            ));
        };
        let end = close + end_rel;
        let body = source[close + 1..end].to_string();
        let Some(after_rel) = source[end..].find('>') else {
            return Err(ArtifactError::new(
                ArtifactErrorCode::Malformed,
                format!("unterminated </{name}>"),
            ));
        };
        elements.push(Element { name, attrs, body });
        cursor = end + after_rel + 1;
    }
    Ok(elements)
}

/// CDATA is the only way agent text carries markup; anything else is literal.
fn content(body: &str) -> String {
    let trimmed = body.trim();
    if let Some(inner) = trimmed
        .strip_prefix(CDATA_OPEN)
        .and_then(|rest| rest.strip_suffix(CDATA_CLOSE))
    {
        return inner.to_string();
    }
    trimmed.to_string()
}

fn nesting_depth(source: &str) -> usize {
    let mut depth = 0_usize;
    let mut max = 0_usize;
    let mut rest = source;
    while let Some(open) = rest.find('<') {
        if rest[open..].starts_with(CDATA_OPEN) {
            let Some(finish) = rest[open + CDATA_OPEN.len()..].find(CDATA_CLOSE) else {
                break;
            };
            rest = &rest[open + CDATA_OPEN.len() + finish + CDATA_CLOSE.len()..];
            continue;
        }
        let Some(close) = rest[open..].find('>') else {
            break;
        };
        let raw = rest[open + 1..open + close].trim();
        if raw.starts_with('/') {
            depth = depth.saturating_sub(1);
        } else if !raw.ends_with('/') {
            depth += 1;
            max = max.max(depth);
        }
        rest = &rest[open + close + 1..];
    }
    max
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contract() -> ArtifactContract<'static> {
        ArtifactContract {
            scopes: Box::leak(Box::new(["s1".to_string(), "s2".to_string()])),
            basis: Box::leak(Box::new(["ch01.md@r1".to_string()])),
        }
    }

    fn wrap(body: &str) -> String {
        format!("# Before\n\n原文。\n\n# Request\n\n改写它。\n\n# Agent reply\n\n{body}")
    }

    fn parse_ok(body: &str) -> VerifiedArtifact {
        parse(wrap(body).as_bytes(), &contract()).expect(body)
    }

    fn parse_err(body: &str) -> ArtifactErrorCode {
        parse(wrap(body).as_bytes(), &contract())
            .expect_err(body)
            .code
    }

    #[test]
    fn a_replacement_is_bound_to_its_scope() {
        let artifact = parse_ok(
            r#"<agent-result version="2">
  <replacement scope="s1"><![CDATA[剑没有松。]]></replacement>
</agent-result>"#,
        );
        assert_eq!(
            artifact.replacements,
            vec![AgentReplacement {
                scope: "s1".into(),
                text: Some("剑没有松。".into())
            }]
        );
    }

    #[test]
    fn an_empty_replacement_deletes_the_scope() {
        let artifact =
            parse_ok(r#"<agent-result version="2"><replacement scope="s1" /></agent-result>"#);
        assert_eq!(
            artifact.replacements,
            vec![AgentReplacement {
                scope: "s1".into(),
                text: None
            }]
        );
    }

    #[test]
    fn comments_survive_without_manufacturing_a_proposal() {
        let artifact = parse_ok(
            r#"<agent-result version="2">
  <comments><comment target="s2"><![CDATA[这段的节奏偏慢。]]></comment></comments>
</agent-result>"#,
        );
        assert!(artifact.replacements.is_empty());
        assert_eq!(
            artifact.comments,
            vec![AgentComment {
                target: "s2".into(),
                text: "这段的节奏偏慢。".into()
            }]
        );
    }

    #[test]
    fn cdata_carrying_markup_is_preserved_verbatim() {
        let artifact = parse_ok(
            r#"<agent-result version="2">
  <replacement scope="s1"><![CDATA[他说「<剑>」，然后 a < b && c > d。]]></replacement>
</agent-result>"#,
        );
        assert_eq!(
            artifact.replacements[0].text.as_deref(),
            Some("他说「<剑>」，然后 a < b && c > d。")
        );
    }

    #[test]
    fn markup_inside_cdata_never_reaches_the_scanner() {
        let artifact = parse_ok(
            r#"<agent-result version="2"><memo><![CDATA[不要在正文里写 </replacement> 这种东西]]></memo></agent-result>"#,
        );
        assert!(artifact.memos[0].text.contains("</replacement>"));
    }

    #[test]
    fn a_material_draft_carries_kind_title_basis_and_body() {
        let artifact = parse_ok(
            r#"<agent-result version="2">
  <material-draft kind="chapter-synopsis" title="第三章梗概">
    <basis ref="ch01.md@r1" />
    <body><![CDATA[这一章写河湾起雾。]]></body>
  </material-draft>
</agent-result>"#,
        );
        assert_eq!(artifact.material_drafts.len(), 1);
        assert_eq!(artifact.material_drafts[0].kind, "chapter-synopsis");
        assert_eq!(
            artifact.material_drafts[0].basis,
            vec!["ch01.md@r1".to_string()]
        );
        assert_eq!(artifact.material_drafts[0].body, "这一章写河湾起雾。");
    }

    #[test]
    fn rejections() {
        let cases: &[(&str, ArtifactErrorCode)] = &[
            (
                r#"<!DOCTYPE r [<!ENTITY x "boom">]><agent-result version="2"><replacement scope="s1"><![CDATA[&x;]]></replacement></agent-result>"#,
                ArtifactErrorCode::DtdForbidden,
            ),
            (
                r#"<agent-result version="2"><replacement scope="s1">甲</replacement><replacement scope="s1">乙</replacement></agent-result>"#,
                ArtifactErrorCode::DuplicateReplacement,
            ),
            (
                r#"<agent-result version="2"><exfiltrate destination="x" /></agent-result>"#,
                ArtifactErrorCode::UnknownElement,
            ),
            (
                r#"<agent-result version="2"><replacement><![CDATA[甲]]></replacement></agent-result>"#,
                ArtifactErrorCode::MissingScope,
            ),
            (
                "just prose, no element at all",
                ArtifactErrorCode::MissingRoot,
            ),
            (
                r#"<agent-result version="1"><replacement scope="s1"><![CDATA[甲]]></replacement></agent-result>"#,
                ArtifactErrorCode::UnsupportedVersion,
            ),
            (
                r#"<agent-result version="2"><replacement scope="nope"><![CDATA[甲]]></replacement></agent-result>"#,
                ArtifactErrorCode::UnknownScope,
            ),
            (
                r#"<agent-result version="2"><material-draft kind="custom" title="x"><basis ref="nowhere@r0" /><body>y</body></material-draft></agent-result>"#,
                ArtifactErrorCode::UnknownBasis,
            ),
            (
                r#"<agent-result version="2"><material-draft title="x"><basis ref="ch01.md@r1" /><body>y</body></material-draft></agent-result>"#,
                ArtifactErrorCode::MissingMaterialKind,
            ),
            (
                r#"<agent-result version="2"><material-draft kind="custom"><basis ref="ch01.md@r1" /><body>y</body></material-draft></agent-result>"#,
                ArtifactErrorCode::MissingMaterialTitle,
            ),
            (
                r#"<agent-result version="2"><memo>x</memo</agent-result>"#,
                ArtifactErrorCode::Malformed,
            ),
        ];
        for (body, code) in cases {
            assert_eq!(&parse_err(body), code, "{body}");
        }

        let prose = wrap(
            "Here is my answer:\n\n<agent-result version=\"2\"><replacement scope=\"s1\"><![CDATA[甲]]></replacement></agent-result>",
        );
        assert_eq!(
            parse(prose.as_bytes(), &contract()).unwrap_err().code,
            ArtifactErrorCode::TextOutsideRoot
        );

        let deep = "<a>".repeat(200) + &"</a>".repeat(200);
        assert_eq!(
            parse_err(&format!(
                r#"<agent-result version="2"><replacement scope="s1">{deep}</replacement></agent-result>"#
            )),
            ArtifactErrorCode::TooDeep
        );
    }

    /// 打印通道的开场白：恰好一个根元素时裁剪成立，裁出的元素照常过 parse；
    /// 零个、两个、未闭合的根都不裁。
    #[test]
    fn extract_single_root_trims_only_a_single_well_formed_root() {
        let narrated = "我先读协议。<agent-result version=\"2\"><replacement scope=\"s1\"><![CDATA[甲]]></replacement></agent-result>收工。";
        let span = extract_single_root(narrated.as_bytes()).expect("single root is extracted");
        let artifact = parse(span, &contract()).expect("the extracted element parses");
        assert_eq!(artifact.replacements.len(), 1);

        let two_roots = "<agent-result version=\"2\"></agent-result><agent-result version=\"2\"></agent-result>";
        assert!(extract_single_root(two_roots.as_bytes()).is_none());
        assert!(extract_single_root(b"no element here").is_none());
        assert!(extract_single_root(b"<agent-result version=\"2\">").is_none());
        // 裁剪后再过 parse：零修改空间——span 里的元素仍被逐项校验。
        let bad_scope = "叙述<agent-result version=\"2\"><replacement scope=\"nope\">x</replacement></agent-result>";
        let span = extract_single_root(bad_scope.as_bytes()).expect("extracted");
        assert_eq!(
            parse(span, &contract()).unwrap_err().code,
            ArtifactErrorCode::UnknownScope
        );
    }

    /// The one untrusted input this parser exists to survive: every truncation
    /// and mutation returns inside the budget, none loops.
    #[test]
    fn malformed_mutations_always_return_within_budget() {
        let valid = r#"<agent-result version="2"><replacement scope="s1"><![CDATA[甲<乙>]]></replacement><memo>丙</memo></agent-result>"#;
        let chars: Vec<char> = valid.chars().collect();
        let join = |slice: &[char]| slice.iter().collect::<String>();
        let mut mutations: Vec<String> = (0..=chars.len()).map(|end| join(&chars[..end])).collect();
        let mut seed = 0x5eed_u32;
        let mut next = move || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            seed
        };
        let syntax = ["<", ">", "/", "<![CDATA[", "]]>"];
        for _ in 0..256 {
            let at = (next() as usize) % (chars.len() + 1);
            let token = syntax[(next() as usize) % syntax.len()];
            mutations.push(if next() % 2 == 0 {
                format!("{}{}{}", join(&chars[..at]), token, join(&chars[at..]))
            } else {
                format!(
                    "{}{}",
                    join(&chars[..at]),
                    join(&chars[(at + 1).min(chars.len())..])
                )
            });
        }

        let started = std::time::Instant::now();
        for mutation in &mutations {
            let _ = parse(wrap(mutation).as_bytes(), &contract());
        }
        assert!(started.elapsed() < std::time::Duration::from_millis(100));
    }
}

// ── the full protocol document (§8.4), generated, never hand-kept ─────────

/// The complete protocol document, generated from the same enumeration the
/// parser enforces. SPEC D14: no hand-written Skill copy ships in the repo;
/// `refrain skill` and the documentation gate both read this function, so the
/// document can never explain fewer codes than the parser rejects.
#[must_use]
pub fn skill_doc() -> String {
    String::from(
        r#"# RefRain Agent 协议 v2

你写提案。人点鼠标，文字才进手稿。没有自动合并。

## 架构

```
作者的 .md 文件            ← 唯一正本。你改的是它的 scope
  ├─ .refrain/            ← 应用状态。你的请求与产出在这里
  │    └─ agents/<agent-id>/       ← 你的工作区，跨轮持久
  │         ├─ AGENTS.md           ← 应用生成的身份（含协议指针）
  │         ├─ Memo.md             ← 你的记忆，自己维护
  │         └─ runs/<run-id>/      ← 一轮一个目录
  │              ├─ request.md     ← 发给你的请求
  │              └─ result.md      ← 你写产出到这里
  └─ .refrain-source/     ← 备份原件。永不写入，也不要读它作依据
```

**改写依据只用 `# Before` 里的原文。** 那是应用从正本取的当前字节。
不要去读 `.refrain-source/`：它是旧副本，与正本可能已不同。

## Memo.md

Memo.md 在你的工作区根（`agents/<agent-id>/`，与 AGENTS.md 并排），
跨轮存活。应用不读它、不改它——它是你写给自己的。

- **动工前**：Memo.md 存在就先全文读它。那是你上一轮留下的记忆，
  请求里不会重复。
- **收工前**：更新它。写下一轮需要知道的事：作者的偏好、已定的决定、
  做到了哪里。写打开手稿看不到的事。


## 请求结构

```
# Before        带 scope 注释的原文。改写的对象
# Context       Persona、手稿或 <changes>、材料目录
# Request       作者的要求
# Reply format  本契约
# Agent reply   你写在这里
```

前面的段每轮相同。harness 按前缀匹配缓存。

## 材料

`# Context` 给目录，不给全文：

```xml
<material path="资料/人物志.md" digest="…" bytes="104857" blocks="212" access="retrievable">
  <title>人物志</title>
  <outline>
    <h level="1">人物志</h>
      <h level="2">陆沉舟</h>
  </outline>
  <excerpt>开篇的原文…</excerpt>
</material>
```

`<outline>` 是作者写的标题，逐字。`level` 是作者敲的 `#` 个数（1 到 6），
缩进与它一致——六十条标题平铺时你读到第 40 条已经不知道自己在哪一章，
层级就是为这个带的。`<excerpt>` 是开头的原文。
应用不联网、不带模型，因此它不概括材料。目录里没有生成的内容。

`access` 是作者的授权：

| access | 允许 |
|---|---|
| `outline-only` | 只有目录。不给正文 |
| `retrievable` | 取片段、按块区间读 |
| `full` | 取整篇 |

取材料有两条路：

1. **打开文件。** `path` 是相对 Root 的路径。你在作者机器上跑，可以直接读。
2. **检索。** 你不知道读哪里时用。给词，应用回块：路径、块序号、原文、位置。

块 = 按空行切开的一段。序号从 0 开始。引用材料用「路径 + 块序号」。

不要要求整篇材料。目录加按需取更准。

## 回复

写一个 `<agent-result version="2">` 元素。元素外不要写字。

```xml
<agent-result version="2">
  <replacement scope="SCOPE-ID">改写后的文本</replacement>
  <comments>
    <comment target="SCOPE-ID">只留话，不改</comment>
  </comments>
  <memo topic="标签">下一轮要记住的事</memo>
  <material-draft kind="KIND" title="TITLE">
    <basis ref="DOCUMENT@REVISION" />
    <body><![CDATA[草稿]]></body>
  </material-draft>
</agent-result>
```

规则：

- scope id 从 `# Before` 逐字抄。
- 一个 scope 至多一个 `<replacement>`。
- 空的 `<replacement>` 删除该 scope。
- `<comment>` 用 `target=`，放在 `<comments>` 里。
- 不改就不写 `<replacement>`。只写 `<comment>` 合法。
- `<memo>` 写打开手稿看不到的事：作者的偏好、已定的决定。
- `<material-draft>` 只成草稿。`kind` 取 chapter-synopsis、character-profile、
  concept-explanation 或 custom。`basis ref` 取本轮给你的文档。

## 你的产出如何呈现

应用冻结你的回复成提案，按句切成评审切片。
作者逐片裁决：接受、拒绝、改后接受。作者可以附理由。
并列方案并排显示。作者选一份，另一份保留。
作者裁决完再点合并。此时文字进手稿。

一次回复里部分句子被采纳，部分不被采纳。这是设计。

## 反馈

下一轮 `# Context` 可能含 `<changes>`：

```xml
<changes>
<verdict n="1" ref="p7.s2" kind="accept"><reason>这句改得对</reason></verdict>
<verdict n="2" ref="p7.s5" kind="reject"><reason>不要用设问句结尾</reason></verdict>
<verdict n="3" ref="p7.s8" kind="accept-modified"><final><![CDATA[采用的版本]]></final></verdict>
</changes>
```

`reject` 带的理由是规则。不要再犯同样的错。
`accept-modified` 的 `<final>` 是作者要的样子。对照你写的那版。
`ref` 指切片，不指 scope。

## 源码

要读实现时，从 RefRain 仓库根按相对路径找：

| 你想知道 | 读 |
|---|---|
| 请求怎么编出来 | `crates/refrain-core/src/context_compiler.rs` |
| 本契约与解析器 | `crates/refrain-core/src/agent_protocol.rs` |
| 材料目录怎么生成 | `crates/refrain-core/src/material_listing.rs` |
| 块边界怎么定 | `crates/refrain-core/src/source_layout.rs` |
| Run 与编排 | `crates/refrain-host/src/host.rs` |
"#,
    )
}

/// The error table, for the reference document rather than the request.
///
/// This is deliberately **not** part of what rides on every request. An agent
/// gets no live feedback from the parser: a malformed reply fails the run and
/// the agent never sees the code. A table it cannot act on costs tokens every
/// round and changes no decision it makes.
///
/// It stays generated from the parser's own enum, so `refrain skill` and the
/// documentation gate can still prove the two agree. Someone debugging a
/// failed run reads it; the agent doing the work does not.
#[must_use]
pub fn error_reference() -> String {
    let mut doc = String::from(
        "## 错误码（从解析器枚举生成，与实现逐项一致）\n\n\
         这张表给排查问题的人看。Agent 拿不到实时的解析反馈，所以它不随请求走。\n\n\
         | 错误码 | 含义 |\n|---|---|\n",
    );
    for code in ArtifactErrorCode::ALL {
        let meaning = match code {
            ArtifactErrorCode::MissingRoot => {
                "找不到 <agent-result>；它必须在 # Agent reply 这一节里"
            }
            ArtifactErrorCode::TextOutsideRoot => "元素外面有字——检查开头的客套话和代码围栏",
            ArtifactErrorCode::DtdForbidden => "写了 DOCTYPE 或实体声明；这个格式不接受",
            ArtifactErrorCode::UnsupportedVersion => "version 不是 \"2\"",
            ArtifactErrorCode::UnknownElement => "用了协议之外的标签名",
            ArtifactErrorCode::MissingScope => "<replacement> 少了 scope=",
            ArtifactErrorCode::DuplicateReplacement => "同一个 scope 写了两次 <replacement>",
            ArtifactErrorCode::Malformed => "标签没闭合",
            ArtifactErrorCode::TooDeep => "嵌套超过 8 层",
            ArtifactErrorCode::UnknownScope => "scope 不在本轮发给你的 # Before 里",
            ArtifactErrorCode::UnknownBasis => "basis ref 不在本轮发给你的文档里",
            ArtifactErrorCode::MissingMaterialKind => "<material-draft> 少了 kind=",
            ArtifactErrorCode::MissingMaterialTitle => "<material-draft> 少了 title=",
        };
        doc.push_str(&format!("| `{}` | {} |\n", code.as_str(), meaning));
    }
    doc
}

#[cfg(test)]
mod docs_tests {
    use super::*;

    /// INV-16: every element the parser enforces is explained where the agent
    /// will read it, and every error code is explained where a human debugging
    /// a failed run will read it. `verify:docs-current` runs this target.
    ///
    /// The split is deliberate. The error table used to ride on every request,
    /// and it bought nothing: an agent gets no live parser feedback, so a
    /// malformed reply fails the run and the agent never sees the code it
    /// tripped. Tokens spent every round on a table that changes no decision.
    /// It is still generated from the same enum, so the two cannot drift.
    #[test]
    fn docs_current_covers_every_code_and_element() {
        let doc = skill_doc();
        let errors = error_reference();
        for code in ArtifactErrorCode::ALL {
            assert!(
                errors.contains(code.as_str()),
                "error reference misses {}",
                code.as_str()
            );
        }
        for element in [
            "agent-result",
            "replacement",
            "comments",
            "comment",
            "memo",
            "material-draft",
            "basis",
            "body",
        ] {
            assert!(doc.contains(element), "doc misses <{element}>");
        }
        assert!(doc.contains("version=\"2\""));
    }

    /// The `<outline>` example in the document must be what the renderer
    /// actually produces.
    ///
    /// The test above checks that element *names* appear, which is a real
    /// check and an insufficient one: it passed unchanged when `<outline>`
    /// went from `<h># 人物志</h>` to `<h level="1">人物志</h>`, because the
    /// name `outline` was still in the document. An agent reading that
    /// document would have been taught a syntax the parser no longer emits,
    /// and nothing in the repository would have said so.
    ///
    /// So this compares against the authority rather than against another
    /// example: it renders a listing whose headings match the document's, and
    /// requires the document to contain those exact lines.
    #[test]
    fn the_outline_example_is_what_the_renderer_emits() {
        use crate::material_listing::{Disclosure, MaterialListing};
        use crate::role::DocumentRole;

        let rendered = MaterialListing::describe(
            "资料/人物志.md",
            "人物志",
            DocumentRole::Material,
            "…",
            "# 人物志\n\n开篇的原文…\n\n## 陆沉舟\n\n他的段落。\n",
            Disclosure::Retrievable,
        )
        .to_contract_element();

        let doc = skill_doc();
        let heading_lines: Vec<&str> = rendered
            .lines()
            .filter(|line| line.contains("<h level="))
            .map(str::trim_end)
            .collect();

        // Measured, not assumed: filtering on `<h level=` finds nothing the
        // moment the renderer stops emitting that attribute, and a loop over
        // an empty list passes without executing its body. Renaming the
        // attribute to `depth` made this test green while the document taught
        // a syntax nothing produced — the exact drift it exists to catch. So
        // the sample count is asserted before the samples are.
        assert_eq!(
            heading_lines.len(),
            2,
            "the renderer emitted no `<h level=` lines, so the comparison below \
             would check nothing. Renderer produced:\n{rendered}"
        );

        for line in heading_lines {
            assert!(
                doc.contains(line),
                "the document's outline example is not what the renderer emits.\n\
                 missing line: {line:?}\nrenderer produced:\n{rendered}"
            );
        }
    }
    /// The per-request contract must not carry what the agent cannot act on.
    ///
    /// Two things were cut here and must stay cut: the error table (no live
    /// feedback reaches the agent) and the "three things this software will
    /// not do" section (a statement of principle for a human reader, which
    /// changes no action the agent takes).
    #[test]
    fn the_contract_carries_nothing_the_agent_cannot_act_on() {
        let doc = skill_doc();
        for code in ArtifactErrorCode::ALL {
            assert!(
                !doc.contains(code.as_str()),
                "error code {} is back in the per-request contract",
                code.as_str()
            );
        }
        assert!(!doc.contains("不会做的事"));
        assert!(!doc.contains("YOLO"));
    }

    /// The material listing is what this generation of the protocol is for,
    /// so the contract has to explain how to reach a material's text.
    #[test]
    fn the_contract_explains_how_to_reach_a_materials_text() {
        let doc = skill_doc();
        assert!(doc.contains("<material path="));
        for access in ["outline-only", "retrievable", "full"] {
            assert!(doc.contains(access), "contract misses access={access}");
        }
        // Both ways of fetching. An agent told only one will either guess at
        // paths or never open a file it could have read.
        assert!(doc.contains("打开文件"));
        assert!(doc.contains("检索"));
        // The handle it quotes back.
        assert!(doc.contains("块序号"));
        // Why the listing can be trusted: nothing in it was generated.
        assert!(doc.contains("不概括材料"));
    }

    /// The agent must not mistake the backup for the author's live file.
    ///
    /// `.refrain-source/` is never written to, so it holds whatever the file
    /// was when the Root was adopted. An agent that reads it as the basis for
    /// a rewrite proposes changes against text the author already moved past.
    #[test]
    fn the_contract_separates_the_live_file_from_the_backup() {
        let doc = skill_doc();
        assert!(doc.contains(".refrain-source/"));
        assert!(doc.contains(".refrain/"));
        assert!(
            doc.contains("不要去读 `.refrain-source/`"),
            "契约必须说明备份目录不是依据"
        );
    }

    /// Every source path the contract offers must exist, and must be relative.
    ///
    /// A pointer into the codebase is a promise an agent will act on: it will
    /// open that path. A stale path costs it a failed read and teaches it the
    /// document cannot be trusted. An absolute path is worse — it resolves
    /// only on the machine it was written on, so every other agent fails.
    ///
    /// Recognise every `.rs` token before checking whether it is relative and exists.
    #[test]
    fn every_source_path_the_contract_names_is_relative_and_exists() {
        let doc = skill_doc();
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(std::path::Path::parent)
            .expect("repository root");

        let mut checked = 0;
        for line in doc.lines() {
            for piece in line.split('`') {
                // Anything ending in .rs is a source pointer, however it
                // begins. That is the whole point: the malformed shapes are
                // the ones that do not begin the way the good ones do.
                if !piece.ends_with(".rs") {
                    continue;
                }
                assert!(
                    !piece.starts_with('/') && !piece.contains(":\\"),
                    "{piece} is absolute; it resolves only on one machine"
                );
                assert!(
                    piece.starts_with("crates/") || piece.starts_with("apps/"),
                    "{piece} is not anchored at the repository root"
                );
                assert!(
                    root.join(piece).exists(),
                    "contract points at {piece}, which does not exist"
                );
                checked += 1;
            }
        }
        assert!(checked >= 5, "只核到 {checked} 条路径，扫描没生效");
    }
}
