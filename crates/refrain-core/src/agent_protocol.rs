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
    let mut doc = String::from(
        r#"# RefRain Agent 协议（v2，由 schema 运行时生成）

你写的是提案，不是正文。你的每一个字都要经过那个人点一次鼠标才会进入手稿。没有自动接受，没有后台合并。

## 一分钟版本

1. 只回一个 `<agent-result version="2">` 元素，前后不能有任何字。
2. scope id 从 `# Before` 里逐字照抄。
3. 一个 scope 最多一个 `<replacement>`，重复即整轮失败。
4. 不想改就别写 `<replacement>`；只写 `<comment>` 是合法的。
5. `<material-draft>` 只成草稿——它永远不直接进手稿。

## 请求怎么来

```
# Before      ← 应用生成：带 scope 注释的原文
# Context     ← 应用生成：Persona、手稿或变更、上一轮 <changes>、勾选的材料
# Request     ← 应用生成：作者的要求原文
# Reply format← 应用生成：本轮的短契约（本文件的精简版）
# Agent reply ← 你的：只有你的
```

稳定的在前，每轮变的在后：harness 按前缀逐字节匹配缓存。

## 你必须怎么回

一个 `<agent-result version="2">` 元素，含以下子元素（每个都可省）：

- `<replacement scope="SCOPE-ID">改写后文本</replacement>`——一个 scope 至多一条；空元素表示删除该 scope。
- `<comments><comment target="SCOPE-ID">只留话，不改动</comment></comments>`——comment 用 target= 不用 scope=，且必须包在 comments 里。
- `<memo topic="可选标签">写给下一轮（可能是压缩后的你）的工作备忘</memo>`——打开手稿能看见的别写。
- `<material-draft kind="KIND" title="TITLE"><basis ref="DOCUMENT@REVISION" /><body><![CDATA[草稿正文]]></body></material-draft>`——kind 为 chapter-synopsis / character-profile / concept-explanation / custom 之一；basis ref 必须来自本轮发给你的文档；body 是唯一可带标记的通道（CDATA）。

version 必须是 "2"。被测过的多数失败恰好是模型的默认行为：裸散文、包代码块、客套开头、漏 version、猜错元素名。

## 人会看到什么

你的回复被冻结成提案，按句切成评审切片（相邻删+增在呈现上合并为一个评审单元，账本仍记原粒度）。作者逐片裁决：接受 / 拒绝 / 改后接受，可附理由；同题竞争的提案并排呈现，选一份不删另一份。全部判完再点一次合并，文字才真正进入手稿。

## 你会收到什么反馈

下一轮请求的 `# Context` 里可能有 `<changes>`：

```xml
<changes>
<verdict n="1" ref="p7.s2" kind="accept"><reason>这句改得对</reason></verdict>
<verdict n="2" ref="p7.s5" kind="reject"><reason>不要用设问句结尾</reason></verdict>
<verdict n="3" ref="p7.s8" kind="accept-modified"><final><![CDATA[他最后采用的版本]]></final><reason>意思对，但太长</reason></verdict>
</changes>
```

reject+理由是规则不是意见；accept-modified 的 final 是他真正想要的；ref 指向切片不是 scope。

## 三件这个软件不会做的事

不联网（模型调用只发生在用户自己的 harness）；不替你算钱（token 按 harness 原样转述，报不出就显示未知）；不自动合并（没有 YOLO 模式）。

## 错误码表（从解析器枚举生成，与实现逐项一致）

| 错误码 | 你做错了 |
|---|---|
"#,
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
            ArtifactErrorCode::Malformed => "标签没闭合——逐字检查每个 >",
            ArtifactErrorCode::TooDeep => "嵌套超过 8 层",
            ArtifactErrorCode::UnknownScope => "scope 不在本轮发给你的 # Before 里",
            ArtifactErrorCode::UnknownBasis => "basis ref 不在本轮发给你的文档里",
            ArtifactErrorCode::MissingMaterialKind => "<material-draft> 少了 kind=",
            ArtifactErrorCode::MissingMaterialTitle => "<material-draft> 少了 title=",
        };
        doc.push_str(&format!("| `{}` | {} |\n", code.as_str(), meaning));
    }
    doc.push_str("\n出错时整个 run 作废，那一轮的 token 白花。回复之前把你写的最后一个字符看一遍——它必须是 `<agent-result>` 的那个 `>`。\n");
    doc
}

#[cfg(test)]
mod docs_tests {
    use super::*;

    /// INV-16: the generated document covers every error code and every
    /// element the parser enforces. `verify:docs-current` runs this target.
    #[test]
    fn docs_current_covers_every_code_and_element() {
        let doc = skill_doc();
        for code in ArtifactErrorCode::ALL {
            assert!(doc.contains(code.as_str()), "doc misses {}", code.as_str());
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
}
