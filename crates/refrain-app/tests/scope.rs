//! `find_scope_blocks` 的新实现必须与它替换掉的那个逐字等价。
//!
//! 新实现把「每个起点都重新拼接一遍」换成一次线性扫描加偏移二分。这是为了让
//! 一章上千块时不再是平方级的分配——但换算法就有换错的可能，所以这里既钉住
//! 具体行为，也拿一份朴素实现做随机对照。

use refrain_app::scope::{before_sections, find_scope_blocks};
use refrain_core::{Id, Lineage, Manuscript, SourceSnapshot};

/// 被替换掉的那个实现，一字不改地留在这里当参照。
fn naive(manuscript: &Manuscript, before: &str) -> Option<Vec<Id>> {
    let blocks = manuscript.head().blocks();
    for start in 0..blocks.len() {
        let mut text = String::new();
        for (offset, block) in blocks.iter().skip(start).enumerate() {
            if !text.is_empty() {
                text.push_str("\n\n");
            }
            text.push_str(block.text());
            if text == before {
                return Some(
                    blocks
                        .iter()
                        .skip(start)
                        .take(offset + 1)
                        .map(|block| block.id())
                        .collect(),
                );
            }
            if text.len() > before.len() {
                break;
            }
        }
    }
    None
}

fn manuscript_of(paragraphs: &[&str]) -> Manuscript {
    let snapshot = SourceSnapshot::read(paragraphs.join("\n\n").into_bytes());
    let count = snapshot.block_count();
    Manuscript::open(snapshot, Lineage::fresh(count)).expect("a manuscript")
}

#[test]
fn a_single_block_scope_is_found() {
    let manuscript = manuscript_of(&["第一段。", "第二段。", "第三段。"]);
    let found = find_scope_blocks(&manuscript, "第二段。").expect("found");
    assert_eq!(found.len(), 1);
    assert_eq!(found, naive(&manuscript, "第二段。").unwrap());
}

#[test]
fn a_multi_block_scope_is_found_with_every_block_in_order() {
    let manuscript = manuscript_of(&["甲。", "乙。", "丙。", "丁。"]);
    let target = "乙。\n\n丙。";
    let found = find_scope_blocks(&manuscript, target).expect("found");
    assert_eq!(found.len(), 2);
    assert_eq!(found, naive(&manuscript, target).unwrap());
}

#[test]
fn text_that_stops_inside_a_block_is_not_a_scope() {
    let manuscript = manuscript_of(&["整段落在这里。", "下一段。"]);
    assert!(find_scope_blocks(&manuscript, "整段落在").is_none());
    assert!(naive(&manuscript, "整段落在").is_none());
}

#[test]
fn text_the_author_has_edited_is_not_found() {
    let manuscript = manuscript_of(&["原来的话。", "另一段。"]);
    assert!(find_scope_blocks(&manuscript, "改过的话。").is_none());
}

#[test]
fn repeated_paragraphs_resolve_to_the_first_occurrence() {
    // 同一句话出现两次时，两个实现必须选同一处，否则提案会落在另一段上。
    let manuscript = manuscript_of(&["重复。", "中间。", "重复。"]);
    assert_eq!(
        find_scope_blocks(&manuscript, "重复。"),
        naive(&manuscript, "重复。")
    );
}

#[test]
fn the_whole_manuscript_can_be_one_scope() {
    let manuscript = manuscript_of(&["一。", "二。", "三。"]);
    let whole = "一。\n\n二。\n\n三。";
    assert_eq!(
        find_scope_blocks(&manuscript, whole),
        naive(&manuscript, whole)
    );
    assert_eq!(find_scope_blocks(&manuscript, whole).unwrap().len(), 3);
}

#[test]
fn an_empty_query_matches_nothing_in_either_implementation() {
    let manuscript = manuscript_of(&["一。", "二。"]);
    assert_eq!(find_scope_blocks(&manuscript, ""), naive(&manuscript, ""));
}

#[test]
fn the_two_implementations_agree_on_every_contiguous_range() {
    // 穷举而不是抽样：块数小的时候全部走一遍最省事，也最不会漏掉边界。
    let paragraphs = ["甲。", "乙乙。", "丙丙丙。", "丁。", "戊戊。"];
    let manuscript = manuscript_of(&paragraphs);
    for from in 0..paragraphs.len() {
        for to in from..paragraphs.len() {
            let target = paragraphs[from..=to].join("\n\n");
            assert_eq!(
                find_scope_blocks(&manuscript, &target),
                naive(&manuscript, &target),
                "range {from}..={to} disagreed"
            );
        }
    }
}

#[test]
fn the_two_implementations_agree_on_text_that_is_not_a_range() {
    let manuscript = manuscript_of(&["甲。", "乙。", "丙。"]);
    for probe in [
        "甲",
        "甲。\n",
        "甲。\n\n",
        "甲。乙。",
        "甲。\n\n丙。",
        "乙。\n\n丙。\n\n",
        "不存在。",
    ] {
        assert_eq!(
            find_scope_blocks(&manuscript, probe),
            naive(&manuscript, probe),
            "probe {probe:?} disagreed"
        );
    }
}

#[test]
fn before_sections_reads_only_the_before_heading() {
    let request = "# Request\n\n无关。\n\n# Before\n\n<!-- scope ch01:b3 -->\n原文一。\n\n# After\n\n<!-- scope ch01:b9 -->\n不该被读到。\n";
    let sections = before_sections(request);
    assert_eq!(sections.len(), 1);
    assert_eq!(sections[0].0, "ch01:b3");
    assert_eq!(sections[0].1, "原文一。");
}

#[test]
fn a_request_without_a_before_heading_lists_nothing() {
    assert!(before_sections("# Request\n\n没有 Before。\n").is_empty());
}
