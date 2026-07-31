//! The two actions an agent has for reaching a material's text.
//!
//! # Why two, and why these two
//!
//! Anthropic's tool-writing guidance, from measurement: "More tools don't
//! always lead to better outcomes. A common error we've observed is tools that
//! merely wrap existing software functionality or API endpoints." Their worked
//! example is exactly this shape — implement `search_logs`, which returns the
//! relevant lines and their surrounding context, rather than `read_logs`.
//!
//! So: `search_materials` to find a passage when the agent does not know where
//! to look, and `read_material` to fetch a passage it can already name. There
//! is deliberately no `list_materials`: the listing already rides on every
//! request, and a second way to ask the same question is a second authority.
//!
//! # Why the agent can also just open the file
//!
//! The agent runs on the author's machine, and a material is a `.md` file on
//! disk whose path is in the listing. It can open it. That is not a gap in
//! this module — it is the cheapest path when the agent already knows which
//! section it wants, and the listing's headings usually tell it.
//!
//! What these actions add is what a bare file read cannot do: rank passages
//! across several materials by relevance, and enforce the author's
//! `Disclosure`. A file read answers "what does line 400 say"; search answers
//! "which of these three references discusses the character's job".
//!
//! # Why a disclosed block carries both a human location and a machine handle
//!
//! Measured by Anthropic: "resolving arbitrary alphanumeric UUIDs to more
//! semantically meaningful and interpretable language … significantly improves
//! Claude's precision in retrieval tasks by reducing hallucinations." A
//! block therefore says both 「人物志 · 第 2 节」 and `ordinal=7`. The first
//! is what the agent reasons with; the second is what it quotes back.

use refrain_core::block_shape::BlockKind;
use refrain_core::material_ref::MaterialRef;
use refrain_core::searchable_block::{block_at, blocks_of};
use refrain_core::{ErrorCode, RefrainError};

/// How many fragments one search returns at most.
///
/// A search that returns forty passages has handed back the material it was
/// supposed to replace. Anthropic's guidance is explicit that a tool response
/// needs its own token budget.
pub const MAX_FRAGMENTS: usize = 12;

/// How many blocks one `read_material` call may return.
///
/// A cap rather than a refusal for a wide range: an agent asking for blocks
/// 0..500 gets the first 40 and is told how many there were, which is more
/// useful than an error telling it to ask again.
pub const MAX_READ_BLOCKS: usize = 40;

/// One passage handed to an agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisclosedBlock {
    /// The material's Root-relative path — the same handle the listing gave.
    pub path: String,
    /// Which block, counting from zero. What the agent quotes back.
    pub ordinal: u32,
    /// Where a human would say this is: 「人物志 · 第 2 节」.
    ///
    /// Both this and `ordinal` travel because the agent needs to reason about
    /// one and cite the other.
    pub location: String,
    /// What kind of block it is.
    pub kind: BlockKind,
    /// The passage itself, verbatim.
    pub text: String,
}

/// Why a fetch was refused.
///
/// Typed rather than a string: a refusal an agent can act on has to name what
/// was refused and why, and these are the only three reasons that exist.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FetchRefusal {
    #[error("material {0} is not in this round's context")]
    UnknownMaterial(String),
    #[error("material {path} is {access}: its text cannot be fetched")]
    Forbidden { path: String, access: &'static str },
    #[error("material {path} has {blocks} blocks; nothing at {ordinal}")]
    NoSuchBlock {
        path: String,
        ordinal: u32,
        blocks: u32,
    },
}

impl From<FetchRefusal> for RefrainError {
    fn from(refusal: FetchRefusal) -> Self {
        let subject = match &refusal {
            FetchRefusal::UnknownMaterial(path)
            | FetchRefusal::Forbidden { path, .. }
            | FetchRefusal::NoSuchBlock { path, .. } => path.clone(),
        };
        RefrainError::new(ErrorCode::IllegalName, "fetch material text", "material")
            .with_detail(format!("{subject}: {refusal}"))
    }
}

/// Where the text of this round's materials comes from.
///
/// A seam rather than a direct store call: the actions are then testable
/// without a database, and the host decides what "this round's materials"
/// means — which is the whole of the `Disclosure` enforcement.
pub trait MaterialSource {
    /// The materials the author ticked for this round, as the listing has
    /// them. `None` for a path that was not ticked — which is what makes
    /// `UnknownMaterial` different from an empty result.
    fn material(&self, path: &str) -> Option<&MaterialRef>;
    /// Every material of this round, in listing order.
    fn materials(&self) -> &[MaterialRef];
    /// The material's current text.
    fn text_of(&self, path: &str) -> Option<String>;
}

/// Find passages across this round's materials.
///
/// Searches only what the author ticked, and only what they let the agent
/// read: a material marked `OutlineOnly` never contributes a fragment, so the
/// permission is enforced where the text would otherwise leave rather than by
/// asking the caller to remember.
pub fn search_materials(
    source: &impl MaterialSource,
    query: &str,
    limit: usize,
) -> Vec<DisclosedBlock> {
    let query = query.trim();
    if query.is_empty() {
        return Vec::new();
    }
    let wanted = limit.min(MAX_FRAGMENTS);
    if wanted == 0 {
        return Vec::new();
    }

    let mut found = Vec::new();
    for material in source.materials() {
        if !material.disclosure.allows_passages() {
            continue;
        }
        let Some(text) = source.text_of(&material.path) else {
            continue;
        };
        for block in blocks_of(&text) {
            if !block.text.contains(query) {
                continue;
            }
            found.push(DisclosedBlock {
                path: material.path.clone(),
                ordinal: block.ordinal,
                location: locate(&material.title, &text, block.ordinal),
                kind: block.kind,
                text: block.text.to_string(),
            });
            if found.len() >= wanted {
                return found;
            }
        }
    }
    found
}

/// Read a range of blocks from one material.
///
/// The range is inclusive of `from` and exclusive of `to`, matching every
/// other half-open range in this codebase. A range wider than
/// `MAX_READ_BLOCKS` is truncated rather than refused.
pub fn read_material(
    source: &impl MaterialSource,
    path: &str,
    from: u32,
    to: u32,
) -> Result<Vec<DisclosedBlock>, FetchRefusal> {
    let Some(material) = source.material(path) else {
        return Err(FetchRefusal::UnknownMaterial(path.to_string()));
    };
    if !material.disclosure.allows_passages() {
        return Err(FetchRefusal::Forbidden {
            path: path.to_string(),
            access: material.disclosure.as_str(),
        });
    }
    let Some(text) = source.text_of(path) else {
        return Err(FetchRefusal::UnknownMaterial(path.to_string()));
    };

    // An out-of-range start is a refusal, not an empty result: an agent citing
    // a block the author has since deleted must learn that the text moved
    // under it, not that the passage is blank.
    if block_at(&text, from).is_none() {
        return Err(FetchRefusal::NoSuchBlock {
            path: path.to_string(),
            ordinal: from,
            blocks: material.blocks,
        });
    }

    Ok((from..to)
        .take(MAX_READ_BLOCKS)
        .filter_map(|ordinal| {
            let block = block_at(&text, ordinal)?;
            Some(DisclosedBlock {
                path: path.to_string(),
                ordinal,
                location: locate(&material.title, &text, ordinal),
                kind: block.kind,
                text: block.text.to_string(),
            })
        })
        .collect())
}

/// Where a human would say this block is.
///
/// The nearest preceding heading, which is how a person actually refers to a
/// place in a document — 「人物志 · ## 习惯」 rather than 「block 7」.
fn locate(title: &str, text: &str, ordinal: u32) -> String {
    let heading = blocks_of(text)
        .into_iter()
        .rfind(|block| block.kind == BlockKind::Heading && block.ordinal <= ordinal)
        .map(|block| block.text.trim().to_string());
    match heading {
        Some(heading) => format!("{title} · {heading}"),
        None => format!("{title} · 开头"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use refrain_core::material_ref::Disclosure;
    use refrain_core::role::DocumentRole;

    const PROFILE: &str = "# 人物志\n\n\
        这是开篇。\n\n\
        ## 陆沉舟\n\n\
        四十二岁，前营销总监。\n\n\
        ## 习惯\n\n\
        习惯在纸上写字，不用电脑。";

    const TIMELINE: &str = "# 年表\n\n\
        一九八四年，他离开营销部。";

    struct Round(Vec<(MaterialRef, String)>);

    impl Round {
        fn new() -> Self {
            Self(vec![
                (
                    MaterialRef::describe(
                        "资料/人物志.md",
                        "人物志",
                        DocumentRole::Material,
                        "d1",
                        PROFILE,
                        Disclosure::Retrievable,
                    ),
                    PROFILE.to_string(),
                ),
                (
                    MaterialRef::describe(
                        "资料/年表.md",
                        "年表",
                        DocumentRole::Material,
                        "d2",
                        TIMELINE,
                        Disclosure::Retrievable,
                    ),
                    TIMELINE.to_string(),
                ),
            ])
        }

        fn sealed(mut self) -> Self {
            self.0[0].0.disclosure = Disclosure::OutlineOnly;
            self
        }

        fn refs(&self) -> Vec<MaterialRef> {
            self.0.iter().map(|(entry, _)| entry.clone()).collect()
        }
    }

    struct RoundSource {
        refs: Vec<MaterialRef>,
        texts: Vec<(String, String)>,
    }

    impl RoundSource {
        fn of(round: Round) -> Self {
            Self {
                refs: round.refs(),
                texts: round
                    .0
                    .iter()
                    .map(|(entry, text)| (entry.path.clone(), text.clone()))
                    .collect(),
            }
        }
    }

    impl MaterialSource for RoundSource {
        fn material(&self, path: &str) -> Option<&MaterialRef> {
            self.refs.iter().find(|entry| entry.path == path)
        }
        fn materials(&self) -> &[MaterialRef] {
            &self.refs
        }
        fn text_of(&self, path: &str) -> Option<String> {
            self.texts
                .iter()
                .find(|(known, _)| known == path)
                .map(|(_, text)| text.clone())
        }
    }

    /// 判据 1-3：检索返回的片段能被精确取回，字节相等。
    #[test]
    fn a_fragment_can_be_read_back_byte_for_byte() {
        let source = RoundSource::of(Round::new());
        let fragments = search_materials(&source, "营销", MAX_FRAGMENTS);
        assert!(!fragments.is_empty());

        for fragment in &fragments {
            let read = read_material(
                &source,
                &fragment.path,
                fragment.ordinal,
                fragment.ordinal + 1,
            )
            .expect("片段应能按序号取回");
            assert_eq!(read.len(), 1);
            assert_eq!(read[0].text, fragment.text, "取回的字节应与检索给的相同");
            assert_eq!(read[0].ordinal, fragment.ordinal);
        }
    }

    /// 片段带的是人能读的位置，不是一串技术标识符。
    #[test]
    fn a_fragment_says_where_a_human_would_say_it_is() {
        let source = RoundSource::of(Round::new());
        let fragments = search_materials(&source, "四十二岁", MAX_FRAGMENTS);
        assert_eq!(fragments.len(), 1);
        assert_eq!(fragments[0].location, "人物志 · ## 陆沉舟");
    }

    /// 作者不放行的材料，一个片段都不给——权限守在文本离开的那个点上。
    #[test]
    fn a_sealed_material_contributes_no_fragment() {
        let source = RoundSource::of(Round::new().sealed());
        let fragments = search_materials(&source, "营销", MAX_FRAGMENTS);
        assert!(
            fragments.iter().all(|one| one.path != "资料/人物志.md"),
            "OutlineOnly 的材料泄漏了片段: {fragments:?}"
        );
        // 另一份没被封的仍可检索。
        assert!(fragments.iter().any(|one| one.path == "资料/年表.md"));
    }

    /// 直接读一份被封的材料，得到的是具名拒绝，不是空结果。
    #[test]
    fn reading_a_sealed_material_is_refused_by_name() {
        let source = RoundSource::of(Round::new().sealed());
        let refusal = read_material(&source, "资料/人物志.md", 0, 3).unwrap_err();
        assert_eq!(
            refusal,
            FetchRefusal::Forbidden {
                path: "资料/人物志.md".to_string(),
                access: "outline-only",
            }
        );
    }

    /// 不在本轮上下文里的材料同样是具名拒绝——它与「有但空」是两回事。
    #[test]
    fn a_material_outside_this_round_is_refused_not_empty() {
        let source = RoundSource::of(Round::new());
        let refusal = read_material(&source, "资料/没勾选.md", 0, 1).unwrap_err();
        assert!(matches!(refusal, FetchRefusal::UnknownMaterial(_)));
    }

    /// 引用一个已经不存在的块，必须知道文本在脚下变了。
    #[test]
    fn citing_a_block_that_no_longer_exists_says_so() {
        let source = RoundSource::of(Round::new());
        let refusal = read_material(&source, "资料/年表.md", 99, 100).unwrap_err();
        match refusal {
            FetchRefusal::NoSuchBlock {
                ordinal, blocks, ..
            } => {
                assert_eq!(ordinal, 99);
                assert!(blocks < 99, "应报出这份材料真实有多少块");
            }
            other => panic!("应是 NoSuchBlock，实为 {other:?}"),
        }
    }

    /// 返回条数有上限：一次检索把整份材料端回去，就等于没做这件事。
    #[test]
    fn a_search_never_hands_back_more_than_its_budget() {
        let long: String = (0..80)
            .map(|index| format!("## 第{index}节\n\n这一段里有营销这个词。\n\n"))
            .collect();
        let source = RoundSource {
            refs: vec![MaterialRef::describe(
                "资料/长.md",
                "长",
                DocumentRole::Material,
                "d",
                &long,
                Disclosure::Retrievable,
            )],
            texts: vec![("资料/长.md".to_string(), long)],
        };
        let fragments = search_materials(&source, "营销", 1000);
        assert_eq!(fragments.len(), MAX_FRAGMENTS);
    }

    /// 一个宽区间被截断而不是被拒绝：agent 拿到前 40 块，比一句「重问一次」有用。
    #[test]
    fn a_wide_range_is_truncated_rather_than_refused() {
        let long: String = (0..100)
            .map(|index| format!("第{index}段正文。\n\n"))
            .collect();
        let source = RoundSource {
            refs: vec![MaterialRef::describe(
                "资料/长.md",
                "长",
                DocumentRole::Material,
                "d",
                &long,
                Disclosure::Retrievable,
            )],
            texts: vec![("资料/长.md".to_string(), long)],
        };
        let read = read_material(&source, "资料/长.md", 0, 500).unwrap();
        assert_eq!(read.len(), MAX_READ_BLOCKS);
    }

    #[test]
    fn an_empty_query_asks_nothing_and_gets_nothing() {
        let source = RoundSource::of(Round::new());
        assert!(search_materials(&source, "   ", MAX_FRAGMENTS).is_empty());
    }
}
