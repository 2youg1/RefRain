//! The Context Compiler (SPEC 8.3b, 8.5) and the narration layer (§8.4a).
//!
//! One authority for what crosses to the agent: the request file's four
//! sections in cache-stable order — everything stable first, everything that
//! changes per round last. The manifest lists every section with source,
//! digest, byte count, and a token estimate state; tokens are three-stated
//! (`actual / estimated / unknown`), never billed (INV-3).
//!
//! Narration is the deterministic, fact-only translation of machine artifacts
//! into the author's language. It never infers, never evaluates.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::Id;
use crate::digest::content_hex;
use crate::material_listing::MaterialListing;
use crate::upstream_work::UpstreamWork;

/// A token count, three-stated (SPEC 2.3). `Unknown` is a first-class value
/// and never serialised as zero (INV-3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum Tokens {
    Actual(u32),
    Estimated(u32),
    Unknown,
}

/// One Edit Scope in the `# Before` section: a scope id, the original text
/// the agent must address with it, byte for byte, and the blocks that text
/// came from.
///
/// `scope` is the label the agent reads and copies back (`ch01:b3`). It is a
/// *position*, so it says nothing durable: insert a paragraph above and the
/// same label points at different text. `blocks` carries the identities the
/// author actually selected at dispatch, which survive edits elsewhere in the
/// document. Locating a returned scope by identity is exact; locating it by
/// text alone cannot tell two identical paragraphs apart (审计 F-02).
///
/// Both travel because they answer different questions. The label is what the
/// agent can read and reproduce; the ids are how this application finds the
/// scope again. Sending ids to the agent instead would make the request harder
/// for a human to read and much easier for a model to mistype.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct BeforeScope {
    pub scope: String,
    pub text: String,
    /// The blocks this scope was cut from, in document order.
    pub blocks: Vec<Id>,
}

/// One verdict from a previous round, as it serialises into `<changes>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeEntry {
    pub reference: String,
    pub kind: ChangeKind,
    pub reason: Option<String>,
    pub final_text: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    Accept,
    AcceptModified,
    Reject,
    CommentOnly,
}

/// Whether the protocol file installed on the harness's own machine still
/// matches what this build would install (SPEC 8.4, 协议装载). `None` says no
/// installed copy answered — never that the copy is "fine".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum SkillStatus {
    /// No installed copy found at the harness's skill path.
    None,
    /// The installed copy hashes to the current generated protocol.
    Current,
    /// A copy exists but differs: an older protocol, or bytes someone else
    /// changed. Either way the request falls back to carrying the full text.
    Stale,
}

/// The installed protocol copy a harness holds, as one round needs to know
/// it: where it is, and whether it still says what this build would say.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkill {
    /// The file the harness should read, as installed on this machine.
    pub path: String,
    pub status: SkillStatus,
}

/// Everything the compiler needs for one request file.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DispatchInput {
    /// The author's persona for the agent, if one travels this round.
    pub persona: Option<String>,
    /// The protocol copy installed for this round's connection, if any. Only
    /// the `Full` tier reads it: a current copy replaces the embedded
    /// protocol with one pointer line; a stale copy says so and carries the
    /// full text anyway.
    pub installed_skill: Option<InstalledSkill>,
    /// The agent's workspace already holds its Memo.md, so this round resumes
    /// work rather than starting it. The request says so out loud: a resumed
    /// round has no session context, and pretending otherwise reads as if
    /// nothing were missing.
    pub resumed: bool,
    /// The manuscript (full text) when the round carries it.
    pub manuscript: Option<String>,
    /// Previous rounds' verdicts, in decision order.
    pub changes: Vec<ChangeEntry>,
    /// The materials the author ticked for this round.
    ///
    /// Listings, not texts. A material used to enter the request whole —
    /// three 100KB references came to roughly 153,600 tokens by this
    /// project's own estimate, and the cost was not only money: recall
    /// degrades as a context fills, so pasting everything made the agent
    /// worse at the work as well as more expensive.
    ///
    /// What travels now is `MaterialListing::to_contract_element` — the author's own
    /// headings, an excerpt of the opening bytes, the size, the digest, and
    /// what the author permits. Nothing is generated, so nothing can be
    /// wrong the way a summary can be wrong. The agent fetches blocks it
    /// decides it needs; see `agent_protocol` for the two actions it has.
    pub materials: Vec<MaterialListing>,
    /// 这一轮要读的上游产出，若这个 Run 带 `Follows` 或 `Verifies` 的边。
    ///
    /// 边只排出执行次序，内容要靠这里流过来：一个排在后面却什么也没读到的 Run，
    /// 与一个没有边的 Run 做的是同一件事。整份逐字进入，不截断（判据 2-5）——
    /// 一个被截断的产出会让验证者对它没读到的部分保持沉默，而那种沉默读起来与
    /// 「没有问题」完全一样。
    pub upstream: Vec<UpstreamWork>,
    /// The author's request, verbatim.
    pub request: String,
    /// The Edit Scopes, in manuscript order.
    pub scopes: Vec<BeforeScope>,
    /// Where the artifact must be written (shown in the short contract).
    pub result_path: String,
    /// Byte cap for the artifact body (shown in the short contract).
    pub max_bytes: u64,
    /// How much protocol the request itself carries.
    pub contract_mode: ContractMode,
}

/// The contract tier a request carries (§8.4): the parser is
/// the only authority; these are presentation frequencies per channel, never
/// a protocol fork.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ContractMode {
    /// L0's channel has no session: the short contract rides every request.
    #[default]
    Short,
    /// A harness's first round: the full generated protocol document.
    Full,
    /// Later rounds on a harness that already holds the full text: one line.
    Pointer,
}

/// One manifest row: a section, its source, its digest, its size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub section: String,
    pub source: String,
    pub digest: String,
    pub bytes: u32,
    pub tokens: Tokens,
}

/// The compiled package: the request file and its manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DispatchPackage {
    pub request_md: String,
    pub manifest: Vec<ManifestEntry>,
    pub digest: String,
    /// Each Edit Scope's durable identity, carried alongside the request so
    /// collection can find the scope by block id rather than by matching its
    /// text. The request file shows the agent only a position label; identity
    /// travels here. See `BeforeScope`.
    pub scopes: Vec<BeforeScope>,
    /// 稳定前缀有多少字节：缓存最多能覆盖到这里。
    ///
    /// **为什么报字节而不报「已命中」**：命中与否由 provider 决定，而 RefRain
    /// 的应用进程不出网（INV）。只有 Harness 回传 `cached_tokens` 时命中才是
    /// 事实；在那之前这个数说的是「我把多少字节排在了变化点之前」，
    /// 是我方能保证的那一半（D14）。
    pub prefix_bytes: u32,
}

fn digest_of(text: &str) -> String {
    content_hex(text.as_bytes())
}

/// Rough token estimate for CJK-heavy prose. It is an estimate and says so;
/// the only honest alternatives are the harness's own count or unknown.
fn estimate_tokens(bytes: u32) -> Tokens {
    // CJK prose runs near 2 bytes per token in modern tokenisers; the estimate
    // is rounded to the nearest ten so it never reads as a measurement.
    let estimated = ((f64::from(bytes)) / 2.0).round() as u32 / 10 * 10;
    Tokens::Estimated(estimated.max(10))
}

fn entry(section: &str, source: &str, text: &str) -> ManifestEntry {
    ManifestEntry {
        section: section.to_string(),
        source: source.to_string(),
        digest: digest_of(text),
        bytes: text.len() as u32,
        tokens: estimate_tokens(text.len() as u32),
    }
}

// ── escaping (xml.ts, owned here since C9) ────────────────────────────────

fn xml_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn xml_attribute(text: &str) -> String {
    xml_text(text).replace('"', "&quot;")
}

/// CDATA is the only channel that may carry markup; a `]]>` inside the text
/// cannot survive one pair, so it is split across two (SPEC 8.4: CDATA 唯一通道).
fn cdata(text: &str) -> String {
    format!("<![CDATA[{}]]>", text.replace("]]>", "]]]]><![CDATA[>"))
}

/// The verdicts of previous rounds as the `<changes>` stream, `n` stable.
pub fn serialize_changes(changes: &[ChangeEntry]) -> String {
    let mut out = String::from("<changes>");
    for (index, change) in changes.iter().enumerate() {
        let kind = match change.kind {
            ChangeKind::Accept => "accept",
            ChangeKind::AcceptModified => "accept-modified",
            ChangeKind::Reject => "reject",
            ChangeKind::CommentOnly => "comment-only",
        };
        out.push_str(&format!(
            "\n<verdict n=\"{}\" ref=\"{}\" kind=\"{}\">",
            index + 1,
            xml_attribute(&change.reference),
            kind,
        ));
        if let Some(final_text) = &change.final_text {
            out.push_str(&format!("\n  <final>{}</final>", cdata(final_text)));
        }
        if let Some(reason) = &change.reason {
            out.push_str(&format!("\n  <reason>{}</reason>", xml_text(reason)));
        }
        out.push_str("\n</verdict>");
    }
    out.push_str("\n</changes>");
    out
}

/// The per-request short contract (§8.4), generated from the protocol shape —
/// the same source the parser and the full documentation read, so the three
/// can never disagree about an element or a code.
pub fn short_contract(_input: &DispatchInput) -> String {
    SHORT_CONTRACT_RULES.to_string()
}

/// 合同里与本轮无关的那一段：协议形状与不变的规矩。
///
/// **为什么单独拿出来**：它是请求里最大的一块稳定字节。与 scope 名字、结果路径
/// 混在一起时，正文一改整段都失效——实测公共前缀从 1,652 掉到 720 字节。
/// 拆开之后这一段进稳定前缀，本轮细节留在它后面（D14）。
const SHORT_CONTRACT_RULES: &str =
    "Reply with one <agent-result version=\"2\"> element and nothing else — no
preamble, no closing remark, no code fence. Text outside the element is
rejected and the run fails.

<agent-result version=\"2\">
  <replacement scope=\"SCOPE-ID\">the rewritten text</replacement>
  <comments>
    <comment target=\"SCOPE-ID\">an observation that changes nothing</comment>
  </comments>
  <memo topic=\"optional label\">what you want to still know next time</memo>
  <material-draft kind=\"KIND\" title=\"TITLE\">
    <basis ref=\"DOCUMENT@REVISION\" />
    <body><![CDATA[the draft]]></body>
  </material-draft>
</agent-result>

Rules:
- One <replacement> per scope at most. Repeating a scope fails the run.
- An empty <replacement> deletes that scope's text.
- Every <comment> goes inside <comments>, and uses target= rather than scope=.
- <material-draft> becomes a draft only; nothing it says reaches the manuscript.
- You are writing a proposal, not the manuscript. A human reads every change
  and decides. Nothing you write reaches the text without that decision.

Materials listed under \"# Context\" arrive as listings, not as text. To read
one, open the file at its path, or search it — the listing's access= says
which is permitted, and blocks= says how many blocks it has. Quote a block
by its ordinal. Never read `.refrain-source/`: that is the backup taken when
the Root was adopted, not what the author is writing now.";

/// 合同里随本轮变的三件事：这一轮有哪些 scope、写到哪、最多多少字节。
///
/// 它们必须排在稳定规则之后——每一个都带着本轮的身份（scope 名、含 Run id
/// 的结果路径），放在前面会让整份合同失去缓存资格。
fn round_contract(input: &DispatchInput) -> String {
    let scopes = input
        .scopes
        .iter()
        .map(|scope| format!("<!-- scope {} -->", scope.scope))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "- Use the scope ids marked in \"# Before\" below, exactly as written:\n{scopes}\n\
         - Write the artifact to: {result}\n\
         - The artifact body must not exceed {max} bytes.",
        scopes = scopes,
        result = input.result_path,
        max = input.max_bytes,
    )
}

/// The `Full` tier's body: the whole generated protocol, unless the harness
/// already holds a current installed copy — then one line naming the file to
/// read first replaces the embedded text (协议装载: 安装即注册，首轮省下的
/// 是每一轮都要付的字节). A stale copy is said out loud and the full text
/// rides anyway: silently trusting bytes that drifted would teach the agent
/// a protocol this build no longer speaks.
fn full_contract(input: &DispatchInput) -> String {
    match &input.installed_skill {
        Some(InstalledSkill {
            path,
            status: SkillStatus::Current,
        }) => format!(
            "协议已安装到 {path}：动工前先全文读它，它就是本契约。回复从 <agent-result> 的第一个字符开始——不要开场白，不要叙述。"
        ),
        Some(InstalledSkill {
            path,
            status: SkillStatus::Stale,
        }) => format!(
            "{path} 里的协议副本已过期，以本契约为准（安装/更新协议后可省掉这一段）。\n\n{}",
            crate::agent_protocol::skill_doc()
        ),
        Some(InstalledSkill {
            status: SkillStatus::None,
            ..
        })
        | None => crate::agent_protocol::skill_doc(),
    }
}

/// Compile one request package (§8.3b): four sections, stable order.
pub fn compile(input: &DispatchInput) -> DispatchPackage {
    let mut sections: Vec<(&'static str, String, String)> = Vec::new();

    let mut before = String::from("# Before");
    for scope in &input.scopes {
        before.push_str(&format!(
            "\n\n<!-- scope {} -->\n{}",
            scope.scope, scope.text
        ));
    }
    // 本轮的合同细节接在这里：scope 名、结果路径与字节上限都随本轮变，
    // 与它们指涉的 scope 同处一节，而不是把整份合同拖出缓存前缀（D14）。
    before.push_str("\n\n");
    before.push_str(&round_contract(input));
    sections.push(("before", "edit-scopes".to_string(), before));

    // Context 内部也要分层（D14）：persona 与材料是 P1（作者改它们才动），
    // changes 与 upstream 每轮都变。混在一起时，一次裁决就会让整段材料
    // 掉出缓存前缀——而材料恰恰是最大的一块。
    let mut context_parts: Vec<(String, String)> = Vec::new();
    // 接续轮要写在纸面上：这个 Agent 的工作区里已有它自己维护的 Memo.md，
    // 而本轮请求不带任何会话上下文。不说，它会把「没有上文」读成「本来就没有」。
    if input.resumed {
        context_parts.push((
            "resumption".to_string(),
            "此为接续轮：无完整上下文，先全文读 Memo.md。".to_string(),
        ));
    }
    if let Some(persona) = &input.persona {
        context_parts.push(("persona".to_string(), persona.clone()));
    }
    if let Some(manuscript) = &input.manuscript {
        context_parts.push(("manuscript".to_string(), manuscript.clone()));
    }
    for material in &input.materials {
        context_parts.push((
            format!("material:{}", material.path),
            material.to_contract_element(),
        ));
    }
    // 这一段起每轮都变，所以排在全部 P1 之后：上一轮的裁决与上游产出。
    // 上游排在裁决之后——它是这一轮真正要处理的东西，挨着 `# Request`
    // 更容易被读到。
    let stable_context_count = context_parts.len();
    if !input.changes.is_empty() {
        context_parts.push(("changes".to_string(), serialize_changes(&input.changes)));
    }
    for work in &input.upstream {
        context_parts.push((format!("upstream:{}", work.run), work.to_contract_element()));
    }
    let context = if context_parts.is_empty() {
        String::new()
    } else {
        format!(
            "# Context\n\n{}",
            context_parts
                .iter()
                .map(|(_, content)| content.clone())
                .collect::<Vec<_>>()
                .join("\n\n")
        )
    };

    // Context 里 P1 那一段在整份请求里到哪个字节为止。
    // 直接从拼好的文本上量，而不是另写一个加法——加法与拼接一定会漂开。
    let stable_context_bytes = if context.is_empty() || stable_context_count == 0 {
        0
    } else {
        let stable_only = context_parts
            .iter()
            .take(stable_context_count)
            .map(|(_, content)| content.clone())
            .collect::<Vec<_>>()
            .join("\n\n");
        // `\n\n` 是它与前一节（合同）之间的分隔。
        "\n\n# Context\n\n".len() + stable_only.len()
    };

    let request = format!("# Request\n\n{}", input.request);
    let contract_body = match input.contract_mode {
        ContractMode::Short => short_contract(input),
        ContractMode::Full => full_contract(input),
        ContractMode::Pointer => "按 RefRain 兼容格式输出。".to_string(),
    };
    let contract = format!("# Reply format\n\n{contract_body}");
    let reply =
        "# Agent reply\n\n<!-- Your <agent-result> element replaces this comment. -->".to_string();

    // D14 的排序：稳定的在前，每轮变的在后。
    //
    // **为什么这个顺序是承重的**：provider 的 prompt cache 按 exact prefix
    // 匹配，所以任何一层放错位置，它后面的全部字节都缓存不到。实测（examples/
    // prefix_probe.rs）：把 `# Before` 放在第一节时，改一段正文之后 3,034 字节
    // 的请求只剩 33 字节公共前缀——身份、格式合同这些全程不变的层一个都没活下来。
    //
    // 反转之后：身份与格式合同是 P0（Persona/协议版本变才动），Context 的材料与
    // 上游是 P1，`# Before` 的正文与 `# Request` 是 S0（每轮都变）。
    // 缓存边界因此落在 S0 之前，而不是文件开头。
    //
    // `# Agent reply` 仍在最末：它是给 Agent 写回复的位置标记，必须在它读完
    // 全部输入之后。
    let stable = vec![contract.clone()];
    let mut parts = stable.clone();
    if !context.is_empty() {
        parts.push(context.clone());
    }
    parts.push(sections[0].2.clone());
    parts.push(request.clone());
    parts.push(reply.clone());
    let request_md = parts.join("\n\n");

    // 稳定前缀到哪为止：合同的稳定规则 + Context 里的 P1 部分（persona、
    // 材料）。它之后是每轮都变的裁决、上游、正文与请求。
    // 报这个边界而不是宣称「已优化」——命中与否只有 Harness 回传 usage
    // 时才知道（D14）。
    let stable_contract_bytes = match input.contract_mode {
        ContractMode::Short => "# Reply format\n\n".len() + SHORT_CONTRACT_RULES.len(),
        // Full 与 Pointer 的合同整段不含本轮身份，所以整段都稳定。
        ContractMode::Full | ContractMode::Pointer => contract.len(),
    };
    let prefix_bytes = (stable_contract_bytes + stable_context_bytes) as u32;

    let mut manifest = vec![entry("reply-format", "protocol-schema", &contract)];
    for (source, content) in &context_parts {
        manifest.push(entry("context", source, content));
    }
    manifest.push(entry("before", "edit-scopes", &sections[0].2));
    manifest.push(entry("request", "author", &request));

    DispatchPackage {
        digest: digest_of(&request_md),
        request_md,
        manifest,
        prefix_bytes,
        // Identity travels with the package, not inside the request text: the
        // agent never needs a block id, and putting one in the file it reads
        // only invites it to copy the wrong thing back.
        scopes: input.scopes.clone(),
    }
}

// ── narration (§8.4a) ─────────────────────────────────────────────────────

use crate::agent_protocol::VerifiedArtifact;

/// One narration: fact-only sentences in the author's language, as structured
/// JSON for the CLI and the UI alike.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Narration {
    pub sentences: Vec<String>,
}

/// 「Agent 对第 3 段给了一个改写，对第 4 段只留了一条批注没有改；另写了一条工作备忘（主题：语气）。」
#[must_use]
pub fn narrate_artifact(artifact: &VerifiedArtifact) -> Narration {
    let mut sentences = Vec::new();
    for replacement in &artifact.replacements {
        sentences.push(match &replacement.text {
            Some(_) => format!("对 {} 给了一个改写", replacement.scope),
            None => format!("对 {} 提议删除", replacement.scope),
        });
    }
    for comment in &artifact.comments {
        sentences.push(format!("对 {} 只留了一条批注没有改", comment.target));
    }
    if !sentences.is_empty() {
        let head = sentences.join("，");
        sentences = vec![format!("Agent {head}。")];
    }
    for memo in &artifact.memos {
        sentences.push(match &memo.topic {
            Some(topic) => format!("另写了一条工作备忘（主题:{topic}）。"),
            None => "另写了一条工作备忘。".to_string(),
        });
    }
    for draft in &artifact.material_drafts {
        sentences.push(format!(
            "另起草了一份资料「{}」（只成草稿，未落盘）。",
            draft.title
        ));
    }
    if sentences.is_empty() {
        sentences.push("Agent 没有给出任何改动或批注。".to_string());
    }
    Narration { sentences }
}

/// 「这次发送把第三章全文（1.2 万字）与你上一轮的 12 条裁决交给 Agent 甲，产生 1 个 Run。」
#[must_use]
pub fn narrate_manifest(manifest: &[ManifestEntry]) -> Narration {
    let total_bytes: u64 = manifest.iter().map(|entry| u64::from(entry.bytes)).sum();
    let sections = manifest
        .iter()
        .map(|entry| match entry.section.as_str() {
            "before" => format!("选中的原文（{} 字节）", entry.bytes),
            "request" => "你的要求".to_string(),
            "reply-format" => "回复契约".to_string(),
            "context" => format!("上下文（{}，{} 字节）", entry.source, entry.bytes),
            other => other.to_string(),
        })
        .collect::<Vec<_>>()
        .join("、");
    let tokens = match manifest.iter().find_map(|entry| match entry.tokens {
        Tokens::Actual(value) => Some(format!("token 实报 {value}")),
        Tokens::Estimated(value) => Some(format!("token 预估约 {value}")),
        Tokens::Unknown => None,
    }) {
        Some(text) => format!("；{text}"),
        None => "；token 未知".to_string(),
    };
    Narration {
        sentences: vec![format!(
            "这次发送把 {sections} 交给 Agent，共 {total_bytes} 字节{tokens}。"
        )],
    }
}

/// 「上一轮 20 条裁决：接受 11、拒绝 6（其中 4 条附理由）、改后接受 3。」
#[must_use]
pub fn narrate_changes(changes: &[ChangeEntry]) -> Narration {
    let count = |kind: ChangeKind| changes.iter().filter(|entry| entry.kind == kind).count();
    let reasons = changes
        .iter()
        .filter(|entry| entry.reason.is_some())
        .count();
    Narration {
        sentences: vec![format!(
            "上一轮 {} 条裁决：接受 {}、拒绝 {}（其中 {} 条附理由）、改后接受 {}。",
            changes.len(),
            count(ChangeKind::Accept),
            count(ChangeKind::Reject),
            reasons,
            count(ChangeKind::AcceptModified),
        )],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Id;
    use crate::agent_protocol::{ArtifactContract, parse};
    use crate::upstream_work::{UpstreamRelation, UpstreamWork};

    fn scopes() -> Vec<BeforeScope> {
        vec![
            BeforeScope {
                scope: "ch01:b3".to_string(),
                text: "这里是第三段的原文。".to_string(),
                blocks: vec![Id::new()],
            },
            BeforeScope {
                scope: "ch01:b4".to_string(),
                text: "这里是第四段的原文。".to_string(),
                blocks: vec![Id::new()],
            },
        ]
    }

    fn input() -> DispatchInput {
        DispatchInput {
            persona: Some("你是一位克制的编辑。".to_string()),
            installed_skill: None,
            resumed: false,
            manuscript: None,
            changes: vec![ChangeEntry {
                reference: "p7.s2".to_string(),
                kind: ChangeKind::Reject,
                reason: Some("不要用设问句结尾".to_string()),
                final_text: None,
            }],
            materials: vec![],
            upstream: Vec::new(),
            request: "把这两段的语气改得更克制。".to_string(),
            scopes: scopes(),
            result_path: ".refrain/runs/r1/attempts/a1/result.md".to_string(),
            max_bytes: 65_536,
            contract_mode: ContractMode::Short,
        }
    }

    /// 判据 1-2：token 账真实下降，读数取自 manifest 自己记的 bytes。
    ///
    /// Stage6-Plan 明确要求这一项是**实测对拍**而非公式估算，理由是本项目
    /// 已经栽过同类跟头：建索引 22 秒的真因不在任何一段，而在段与段之间的
    /// 提交语义。所以这里不写「按每 token 2 字节算能省多少」，而是编两份
    /// 请求——一份把材料整篇塞进去（改造前的形状），一份走目录表——
    /// 然后读 `ManifestEntry.bytes`，那是应用自己记的账。
    #[test]
    fn materials_travel_as_listings_and_the_manifest_shows_the_saving() {
        // 三份真实尺度的资料：作者一次勾选三份 100KB 参考并不罕见。
        let bodies: Vec<String> = (0..3)
            .map(|which| {
                let mut text = format!("# 资料{which}\n\n");
                for section in 0..50 {
                    text.push_str(&format!("## 第{section}节\n\n"));
                    text.push_str(&"这是一段足够长的正文，用来把这份资料撑到真实尺度。".repeat(30));
                    text.push_str("\n\n");
                }
                text
            })
            .collect();
        let whole_text_bytes: usize = bodies.iter().map(String::len).sum();
        assert!(
            whole_text_bytes > 250_000,
            "三份资料应达到真实尺度: {whole_text_bytes}"
        );

        let mut with_listings = input();
        with_listings.materials = bodies
            .iter()
            .enumerate()
            .map(|(which, text)| {
                MaterialListing::describe(
                    &format!("资料/第{which}份.md"),
                    &format!("资料{which}"),
                    crate::role::DocumentRole::Material,
                    "digest",
                    text,
                    crate::material_listing::Disclosure::Retrievable,
                )
            })
            .collect();

        let package = compile(&with_listings);
        let material_bytes: u32 = package
            .manifest
            .iter()
            .filter(|entry| entry.source.starts_with("material:"))
            .map(|entry| entry.bytes)
            .sum();

        assert_eq!(
            package
                .manifest
                .iter()
                .filter(|entry| entry.source.starts_with("material:"))
                .count(),
            3,
            "三份资料应各记一行账"
        );

        // 改造前这一节的字节数就是三份全文之和。
        assert!(
            (material_bytes as usize) < whole_text_bytes / 20,
            "材料节应降到全文的 5% 以下：实测 {material_bytes} vs 全文 {whole_text_bytes}（{:.1}%）",
            material_bytes as f64 / whole_text_bytes as f64 * 100.0
        );

        // 而且请求里确实没有材料正文——只有目录。
        for text in &bodies {
            let body_line = "这是一段足够长的正文，用来把这份资料撑到真实尺度。".repeat(30);
            assert!(
                !package.request_md.contains(&body_line),
                "材料正文不应出现在请求里"
            );
            assert!(text.contains(&body_line));
        }
        // 目录本身要在。
        assert!(
            package
                .request_md
                .contains("<material path=\"资料/第0份.md\"")
        );
        assert!(package.request_md.contains("## 第0节"));
    }

    /// 作者不许取正文的材料，其权限必须写在目录里，不靠一句说明文字。
    #[test]
    fn the_request_states_each_materials_permission() {
        let mut restricted = input();
        restricted.materials = vec![MaterialListing::describe(
            "资料/机密.md",
            "机密",
            crate::role::DocumentRole::Material,
            "d",
            "# 机密\n\n不该被取走的正文。",
            crate::material_listing::Disclosure::OutlineOnly,
        )];
        let package = compile(&restricted);
        assert!(package.request_md.contains("access=\"outline-only\""));
        assert!(
            !package.request_md.contains("不该被取走的正文"),
            "OutlineOnly 的材料正文不得进入请求"
        );
    }

    #[test]
    fn the_four_sections_hold_in_stable_order() {
        let package = compile(&input());
        let before = package.request_md.find("# Before").unwrap();
        let context = package.request_md.find("# Context").unwrap();
        let request = package.request_md.find("# Request").unwrap();
        let format = package.request_md.find("# Reply format").unwrap();
        let reply = package.request_md.find("# Agent reply").unwrap();
        // D14：稳定的在前，每轮变的在后。格式合同（协议版本变才动）领先于
        // Context（作者改材料才动），后者领先于 `# Before` 与 `# Request`
        // （每轮都变）。`# Agent reply` 是写回复的位置，必须在最末。
        assert!(format < context && context < before && before < request && request < reply);

        assert!(package.request_md.contains("<!-- scope ch01:b3 -->"));
        assert!(
            package
                .request_md
                .contains("<verdict n=\"1\" ref=\"p7.s2\" kind=\"reject\">")
        );
        assert!(
            package
                .request_md
                .contains("<reason>不要用设问句结尾</reason>")
        );
        assert!(package.request_md.contains("version=\"2\""));
    }

    /// D14：改一轮正文之后，稳定前缀必须整段活下来。
    ///
    /// 这条守的是排序本身，而不是某一个字节数。实测过反例：`# Before` 排第一
    /// 时，3,034 字节的请求在改一段正文后只剩 33 字节公共前缀——身份与格式
    /// 合同一个都没活下来，而两份请求单看都完全正确。近失手因此是「顺序错了
    /// 但内容全对」，只有量公共前缀才能读出来。
    #[test]
    fn the_stable_prefix_survives_a_changed_round() {
        let first = compile(&input());
        let mut changed = input();
        changed.scopes = vec![BeforeScope {
            scope: "ch01:b3".to_string(),
            blocks: Vec::new(),
            text: "这一轮作者把这一段整个改掉了。".to_string(),
        }];
        changed.request = "换一个完全不同的请求。".to_string();
        let second = compile(&changed);

        let shared = first
            .request_md
            .as_bytes()
            .iter()
            .zip(second.request_md.as_bytes())
            .take_while(|(a, b)| a == b)
            .count();

        assert!(
            shared >= first.prefix_bytes as usize,
            "稳定前缀 {} 字节必须整段存活，实际只剩 {shared}",
            first.prefix_bytes
        );
        // 前缀不能是空的：报一个 0 等于说「什么都缓存不到」而不报错。
        assert!(first.prefix_bytes > 0);
        // 存活还不够——Context 里的 P1 部分（persona、材料）也必须落在变化点
        // 之前。反例实测：把每轮变的裁决排在 persona 与材料之前，上面那条仍然
        // 成立（合同整段还在），但一次裁决就会把整段材料推出缓存前缀，
        // 而材料恰恰是最大的一块。这里断言 persona 的原文在前缀之内。
        let persona = input().persona.expect("persona");
        assert!(
            first.request_md[..first.prefix_bytes as usize].contains(&persona),
            "persona 是 P0，必须落在稳定前缀之内：前缀 {} 字节，persona 在 {:?}",
            first.prefix_bytes,
            first.request_md.find(&persona)
        );
    }

    #[test]
    fn the_manifest_carries_source_digest_bytes_and_three_stated_tokens() {
        let package = compile(&input());
        assert!(package.manifest.len() >= 3);
        for entry in &package.manifest {
            assert_eq!(entry.digest.len(), 64);
            assert!(entry.bytes > 0);
            assert!(!matches!(entry.tokens, Tokens::Actual(0)));
        }
        assert_eq!(package.digest.len(), 64);
    }

    #[test]
    fn the_short_contract_mentions_every_scope_once() {
        let package = compile(&input());
        // 本轮的合同细节（scope 名、结果路径）现在住在 `# Before` 节——它们
        // 随本轮变，与稳定的协议规则分开，好让后者留在缓存前缀里（D14）。
        let at = package.request_md.find("# Before").expect("before section");
        let before = &package.request_md[at..];
        assert_eq!(before.matches("<!-- scope ch01:b3 -->").count(), 2);
        assert_eq!(before.matches("<!-- scope ch01:b4 -->").count(), 2);
        assert!(before.contains(".refrain/runs/r1/attempts/a1/result.md"));
    }

    /// 每轮携带的那一份契约，必须说清怎么读材料。
    ///
    /// `skill_doc()` 一直说得清，并且有测试守着——但那是 **Full** 档，而每轮请求
    /// 实际携带的是 **Short**。探针实测发现 Short 里一个字都没有：材料目录给了
    /// `access=` 与 `blocks=`，Agent 却无从知道怎么把一段原文取回来。
    ///
    /// 材料改成目录制的全部立意就是「按需取回」。给了目录不给取法，等于让它
    /// 要么猜路径、要么放着不读——而两种都不会报错，作者只会觉得这个 Agent
    /// 没看材料。
    ///
    /// 断言逐项对应 Agent 要回答的问题，而不是断言一整段文本相等：后者会在
    /// 任何一次措辞调整时变红，而它并没有在守任何东西。
    #[test]
    fn the_short_contract_says_how_to_reach_a_material() {
        let package = compile(&input());
        let contract = package
            .request_md
            .split("# Reply format")
            .nth(1)
            .expect("reply format");

        // 两条取法都要给：只说一条，Agent 要么猜路径要么永远不打开它本可以读的文件。
        assert!(contract.contains("open the file"), "没说可以直接打开");
        assert!(contract.contains("search it"), "没说可以检索");
        // 目录上那两个属性要能被用起来，否则它们只是占字节。
        assert!(contract.contains("access="), "没说 access= 决定哪一条可用");
        assert!(contract.contains("blocks="), "没说 blocks= 是什么");
        // 取回来之后引用的把手。
        assert!(contract.contains("ordinal"), "没说用块序号引用");
        // 备份目录不是依据：读了它就是拿作者早已改过的字去提改写。
        assert!(
            contract.contains(".refrain-source/"),
            "没有把备份目录与实时文件区分开"
        );
    }

    /// 判据 2-5 后半：`Follows` 的下游请求里，上游产出一个字节都不少。
    ///
    /// 断言的是**字节相等**，不是「包含开头一段」或「长度差不多」。理由是这条
    /// 判据要防的正是「差不多」：一个被截断的产出会让下游对它没读到的部分保持
    /// 沉默，而那种沉默读起来与「读过了，没有问题」完全一样——作者无从区分。
    ///
    /// 语料刻意取一份大到会诱使任何人加上限的产出（20 万字节量级）。这条测试
    /// 因此真正守的是「将来有人在这条路径上加 max_bytes 时会当场变红」。
    #[test]
    fn a_follows_request_carries_the_whole_upstream_artifact() {
        let artifact = "他握着剑，没有说话。".repeat(8_000);
        let mut with_upstream = input();
        with_upstream.upstream = vec![UpstreamWork {
            run: Id::new(),
            relation: UpstreamRelation::Follows,
            artifact: artifact.clone(),
        }];

        let package = compile(&with_upstream);

        assert!(
            package.request_md.contains(&artifact),
            "上游产出必须逐字出现在下游请求里"
        );
        // 逐字包含还不够：出现两次半段也能满足 contains。数一遍字节。
        // 从 `# Context` 起找，跳过合同模板里那段示例 CDATA——D14 把合同排到
        // 了 Context 之前，所以文件里第一个 `<body><![CDATA[` 是示例而非上游。
        let context_at = package.request_md.find("# Context").unwrap();
        let body = &package.request_md[context_at..];
        let opened = body.find("<body><![CDATA[").unwrap() + "<body><![CDATA[".len();
        let closed = body[opened..].find("]]></body>").unwrap();
        assert_eq!(
            closed,
            artifact.len(),
            "请求里那一节的字节数必须等于上游产出全长"
        );
    }

    /// 两种边在请求里长得不一样。
    ///
    /// 同一份字节配错措辞，就是让验证者去续写、让续写者去挑错。这条测试问的是
    /// 「配错了会不会被发现」。
    #[test]
    fn a_verifier_is_told_it_is_reviewing_not_continuing() {
        let mut verifying = input();
        verifying.upstream = vec![UpstreamWork {
            run: Id::new(),
            relation: UpstreamRelation::Verifies,
            artifact: "他握着刀。".to_string(),
        }];
        let package = compile(&verifying);

        assert!(package.request_md.contains("<under-review"));
        assert!(package.request_md.contains("报告问题"));
        assert!(
            package.request_md.contains("不接受 <replacement>"),
            "验证者必须被告知这一轮不接受改写——领域层会拒绝它，请求里就该说清楚"
        );
    }

    /// 没有边的一轮，请求里不该多出任何一节。
    ///
    /// 与上面两条配对：只测「有上游时它在」的话，一个无条件插入空节的实现也会
    /// 全绿，而那会让每个普通发送都多付几十字节并多一段读不懂的话。
    #[test]
    fn a_round_without_an_edge_carries_no_upstream_section() {
        let package = compile(&input());

        assert!(!package.request_md.contains("<under-review"));
        assert!(!package.request_md.contains("<upstream"));
    }

    #[test]
    fn contract_tiers_are_presentation_frequencies_not_a_fork() {
        let short = compile(&input());
        assert!(
            short
                .request_md
                .contains("One <replacement> per scope at most")
        );

        let mut full_input = input();
        full_input.contract_mode = ContractMode::Full;
        let full = compile(&full_input);
        // The full tier is the generated protocol document. Its evidence is
        // what only that document carries — the material listing shape and
        // the draft element — not the error table, which was removed from
        // every tier: an agent gets no live parser feedback, so a code it
        // cannot read changes no decision it makes.
        assert!(full.request_md.contains("<material path="));
        assert!(full.request_md.contains("<material-draft>"));

        let mut pointer_input = input();
        pointer_input.contract_mode = ContractMode::Pointer;
        let pointer = compile(&pointer_input);
        let body = pointer
            .request_md
            .split("# Reply format\n\n")
            .nth(1)
            .expect("reply format");
        assert_eq!(body.lines().next(), Some("按 RefRain 兼容格式输出。"));
        assert!(
            !pointer
                .request_md
                .contains("One <replacement> per scope at most")
        );

        // Same input, different tier: the digest must move (INV-14).
        assert_ne!(short.digest, full.digest);
        assert_ne!(short.digest, pointer.digest);
    }

    /// 首轮省 token：协议副本是新的，请求就只带一行指针，不再背整份契约。
    ///
    /// 断言两方向都要在：指针行在（带安装路径），而 Full 档独有的内容
    /// （材料目录形状）不在——少断言任何一边，一个「什么都没换」或「换过头」
    /// 的实现都会全绿。
    #[test]
    fn a_current_installed_skill_turns_the_full_tier_into_one_pointer_line() {
        let mut installed = input();
        installed.contract_mode = ContractMode::Full;
        installed.installed_skill = Some(InstalledSkill {
            path: "/home/a/.kimi-code/skills/refrain/SKILL.md".to_string(),
            status: SkillStatus::Current,
        });
        let package = compile(&installed);

        assert!(
            package.request_md.contains(
                "协议已安装到 /home/a/.kimi-code/skills/refrain/SKILL.md：动工前先全文读它"
            )
        );
        assert!(
            !package.request_md.contains("<material path="),
            "副本是新的时，Full 档的正文不该再随请求走"
        );
    }

    /// 副本过期要诚实地说出来，同时全文契约照样随请求走——信过期的字节，
    /// 等于教 Agent 说一套这个版本已经不讲的话。
    #[test]
    fn a_stale_installed_skill_is_named_and_the_full_text_rides_anyway() {
        let mut stale = input();
        stale.contract_mode = ContractMode::Full;
        stale.installed_skill = Some(InstalledSkill {
            path: "/home/a/.claude/skills/refrain/SKILL.md".to_string(),
            status: SkillStatus::Stale,
        });
        let package = compile(&stale);

        assert!(
            package
                .request_md
                .contains("/home/a/.claude/skills/refrain/SKILL.md 里的协议副本已过期")
        );
        assert!(
            package.request_md.contains("<material path="),
            "副本过期时回退到 Full：完整契约必须随请求走"
        );
    }

    /// 接续轮写在 `# Context` 开头：这个 Agent 的工作区已有 Memo.md，本轮
    /// 没有完整上下文——断了就诚实断在纸面上。
    #[test]
    fn a_resumed_round_says_so_at_the_head_of_context() {
        let mut resumed = input();
        resumed.resumed = true;
        let package = compile(&resumed);

        let context = package
            .request_md
            .split("# Context\n\n")
            .nth(1)
            .expect("a resumed round still carries a Context section");
        assert!(
            context.starts_with("此为接续轮：无完整上下文，先全文读 Memo.md。"),
            "接续轮标记必须是 # Context 的第一行: {context}"
        );
        // Persona 排在其后——标记是这一轮的事实，先于一切背景。
        assert!(context.contains("你是一位克制的编辑。"));

        let fresh = compile(&input());
        assert!(
            !fresh.request_md.contains("此为接续轮"),
            "首轮没有这个标记：写了就是把新工作区说成旧的"
        );
    }

    #[test]
    fn changes_serialise_with_stable_n_and_escaped_reasons() {
        let xml = serialize_changes(&[
            ChangeEntry {
                reference: "p7.s2".to_string(),
                kind: ChangeKind::Accept,
                reason: None,
                final_text: None,
            },
            ChangeEntry {
                reference: "p7.s5".to_string(),
                kind: ChangeKind::Reject,
                reason: Some("引用里有个「引号」和 <标签>".to_string()),
                final_text: None,
            },
        ]);
        assert!(xml.contains("<verdict n=\"1\" ref=\"p7.s2\" kind=\"accept\">"));
        assert!(xml.contains("<verdict n=\"2\" ref=\"p7.s5\" kind=\"reject\">"));
        assert!(xml.contains("「引号」和 &lt;标签&gt;"));
    }

    #[test]
    fn narration_of_an_artifact_is_fact_only() {
        let artifact = parse(
            r#"<agent-result version="2">
  <replacement scope="s1"><![CDATA[改写后的第三段。]]></replacement>
  <comments><comment target="s2">引文出处无法核实。</comment></comments>
  <memo topic="语气">这位作者不接受设问句结尾。</memo>
</agent-result>"#
                .as_bytes(),
            &ArtifactContract {
                scopes: &["s1".to_string(), "s2".to_string()],
                basis: &[],
            },
        )
        .unwrap();
        let narration = narrate_artifact(&artifact);
        assert_eq!(
            narration.sentences[0],
            "Agent 对 s1 给了一个改写，对 s2 只留了一条批注没有改。"
        );
        assert_eq!(narration.sentences[1], "另写了一条工作备忘（主题:语气）。");
    }

    #[test]
    fn narration_of_a_manifest_names_sections_and_unknown_tokens() {
        let package = compile(&input());
        let narration = narrate_manifest(&package.manifest);
        assert!(narration.sentences[0].contains("选中的原文"));
        assert!(
            narration.sentences[0].contains("token 预估约")
                || narration.sentences[0].contains("token 未知")
        );
    }

    #[test]
    fn narration_of_changes_counts_each_kind_and_reasoned() {
        let narration = narrate_changes(&[
            ChangeEntry {
                reference: "a".into(),
                kind: ChangeKind::Accept,
                reason: None,
                final_text: None,
            },
            ChangeEntry {
                reference: "b".into(),
                kind: ChangeKind::Accept,
                reason: None,
                final_text: None,
            },
            ChangeEntry {
                reference: "c".into(),
                kind: ChangeKind::Reject,
                reason: Some("太长".into()),
                final_text: None,
            },
            ChangeEntry {
                reference: "d".into(),
                kind: ChangeKind::AcceptModified,
                reason: None,
                final_text: Some("改后".into()),
            },
        ]);
        assert_eq!(
            narration.sentences[0],
            "上一轮 4 条裁决：接受 2、拒绝 1（其中 1 条附理由）、改后接受 1。"
        );
    }
}
