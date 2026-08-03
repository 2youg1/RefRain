//! `locate_scope` 必须在唯一命中时与它替换掉的那个实现逐字等价，
//! 并且在原文重复时拒绝而不是挑一处。
//!
//! 早先的实现把「每个起点都重新拼接一遍」换成一次线性扫描加偏移二分，那次换的
//! 是性能，行为一字不变，所以这里留了一份朴素实现做随机对照。
//!
//! 这一版换的是行为：重复原文从「取第一处」变成「具名拒绝并交出全部候选」。
//! 对照因此只在唯一命中时成立——朴素实现遇到重复会返回第一处，那正是被废掉的
//! 那个答案。凡是对照，都显式限定在唯一命中上，不把旧行为偷偷当成基准。

use refrain_app::scope::{ScopeLocation, before_sections, locate_scope};
use refrain_core::{BlockScan, Id, Lineage, Manuscript, SourceSnapshot};

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

/// 朴素实现在整份稿子里能找到几处。对照唯一性判断用它，而不用它的第一个答案。
fn naive_match_count(manuscript: &Manuscript, before: &str) -> usize {
    let blocks = manuscript.head().blocks();
    let mut count = 0;
    for start in 0..blocks.len() {
        let mut text = String::new();
        for block in blocks.iter().skip(start) {
            if !text.is_empty() {
                text.push_str("\n\n");
            }
            text.push_str(block.text());
            if text == before {
                count += 1;
            }
            if text.len() >= before.len() {
                break;
            }
        }
    }
    count
}

fn manuscript_of(paragraphs: &[&str]) -> Manuscript {
    let snapshot = SourceSnapshot::read(paragraphs.join("\n\n").into_bytes());
    let count = snapshot.block_count();
    Manuscript::open(snapshot, Lineage::fresh(count)).expect("a manuscript")
}

/// 唯一命中时取出块 id，其余结局当场炸开并说出实际是什么。
fn unique(location: ScopeLocation) -> Vec<Id> {
    match location {
        ScopeLocation::Unique(blocks) => blocks,
        other => panic!("expected exactly one match, got {other:?}"),
    }
}

#[test]
fn a_single_block_scope_is_found() {
    let manuscript = manuscript_of(&["第一段。", "第二段。", "第三段。"]);
    let found = unique(locate_scope(&manuscript, "第二段。"));
    assert_eq!(found.len(), 1);
    assert_eq!(found, naive(&manuscript, "第二段。").unwrap());
}

#[test]
fn a_multi_block_scope_is_found() {
    let manuscript = manuscript_of(&["第一段。", "第二段。", "第三段。"]);
    let target = "第二段。\n\n第三段。";
    let found = unique(locate_scope(&manuscript, target));
    assert_eq!(found.len(), 2);
    assert_eq!(found, naive(&manuscript, target).unwrap());
}

#[test]
fn text_that_starts_inside_a_block_is_not_a_scope() {
    let manuscript = manuscript_of(&["整段落在这里。", "另一段。"]);
    assert_eq!(locate_scope(&manuscript, "整段落在"), ScopeLocation::Moved);
}

#[test]
fn text_the_author_has_edited_is_not_found() {
    let manuscript = manuscript_of(&["原来的话。", "另一段。"]);
    assert_eq!(
        locate_scope(&manuscript, "改过的话。"),
        ScopeLocation::Moved
    );
}

#[test]
fn repeated_paragraphs_are_refused_with_every_candidate() {
    // 这条测试取代了 `repeated_paragraphs_resolve_to_the_first_occurrence`。
    //
    // 那条断言「新旧实现都选第一处」，把一个缺陷钉成了预期：审计 F-02 实测
    // 复现的正是它——两段逐字相同时，冲销改掉了作者没有要求回退的那一段。
    // 按内容定位无法分辨重复文本，这不是实现挑错了处，是问题本身没有唯一解。
    // 所以正确的结果不是「选得更好」，是「不替作者选」。
    let manuscript = manuscript_of(&["重复。", "中间。", "重复。"]);

    let ScopeLocation::Ambiguous(candidates) = locate_scope(&manuscript, "重复。") else {
        panic!("two identical paragraphs must not resolve to one place");
    };

    // 两处都要交出来，作者才有得选；只报「有歧义」而不给候选，他无从下手。
    assert_eq!(candidates.len(), 2);
    let blocks = manuscript.head().blocks();
    assert_eq!(candidates[0], vec![blocks[0].id()]);
    assert_eq!(candidates[1], vec![blocks[2].id()]);

    // 候选必须是两处不同的块——同一处报两遍是另一种错。
    assert_ne!(candidates[0], candidates[1]);
}

#[test]
fn the_scan_does_not_stop_at_the_first_match() {
    // 唯一性只有看完整份稿子才能断言。若扫描在第一处命中就返回，重复原文会被
    // 报成 Unique，而这正是被废掉的旧行为。三处相同时候选必须是三个。
    let manuscript = manuscript_of(&["副歌。", "一。", "副歌。", "二。", "副歌。"]);
    let ScopeLocation::Ambiguous(candidates) = locate_scope(&manuscript, "副歌。") else {
        panic!("three identical paragraphs must be ambiguous");
    };
    assert_eq!(candidates.len(), 3);
}

#[test]
fn a_repeated_multi_block_range_is_also_ambiguous() {
    // 歧义不只发生在单块上：连着的两段整体重复时，同样分辨不出是哪一处。
    let manuscript = manuscript_of(&["甲。", "乙。", "丙。", "甲。", "乙。"]);
    let ScopeLocation::Ambiguous(candidates) = locate_scope(&manuscript, "甲。\n\n乙。") else {
        panic!("a repeated two-block range must be ambiguous");
    };
    assert_eq!(candidates.len(), 2);
    assert_eq!(candidates[0].len(), 2);
    assert_eq!(candidates[1].len(), 2);
}

#[test]
fn a_plain_text_manuscript_refuses_repeated_lines() {
    // 纯文本按单个换行分块，于是代码文件里的 `}` 每一行都是一个块。本仓库实测
    // 代码文件 30.2% 的块有逐字相同的同伴，96.1% 的文件至少含一处——「取第一处」
    // 在这种分布上不是边角取舍。这条用最小的形状钉住它。
    //
    // 夹具必须显式要 `BlockScan::Plain`：`SourceSnapshot::read` 走的是散文规则
    // （空行分段），拿它读一段代码只会得到**一个**块，于是 `}` 一处也找不到。
    // 第一版就是这样写的，红的是夹具不是产品——探针打出 block_count = 1 才看清。
    let snapshot = SourceSnapshot::read_with(
        "fn a() {\n}\nfn b() {\n}\n".as_bytes().to_vec(),
        BlockScan::Plain,
    );
    let count = snapshot.block_count();
    let manuscript = Manuscript::open(snapshot, Lineage::fresh(count)).expect("a manuscript");

    let ScopeLocation::Ambiguous(candidates) = locate_scope(&manuscript, "}") else {
        panic!("a repeated closing brace must be ambiguous, not the first one");
    };
    assert_eq!(candidates.len(), 2);
}

#[test]
fn the_whole_manuscript_can_be_one_scope() {
    let manuscript = manuscript_of(&["一。", "二。", "三。"]);
    let whole = "一。\n\n二。\n\n三。";
    let found = unique(locate_scope(&manuscript, whole));
    assert_eq!(found, naive(&manuscript, whole).unwrap());
    assert_eq!(found.len(), 3);
}

#[test]
fn an_empty_query_matches_nothing() {
    let manuscript = manuscript_of(&["一。", "二。"]);
    assert_eq!(locate_scope(&manuscript, ""), ScopeLocation::Moved);
    assert_eq!(naive(&manuscript, ""), None);
}

#[test]
fn the_two_implementations_agree_wherever_the_match_is_unique() {
    // 穷举而不是抽样：块数小的时候全部走一遍最省事，也最不会漏掉边界。
    // 语料各段互不相同，所以每个连续区间都唯一命中，对照才有意义。
    let paragraphs = ["甲。", "乙乙。", "丙丙丙。", "丁。", "戊戊。"];
    let manuscript = manuscript_of(&paragraphs);
    for from in 0..paragraphs.len() {
        for to in from..paragraphs.len() {
            let target = paragraphs[from..=to].join("\n\n");
            assert_eq!(naive_match_count(&manuscript, &target), 1, "{target:?}");
            assert_eq!(
                unique(locate_scope(&manuscript, &target)),
                naive(&manuscript, &target).unwrap(),
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
            locate_scope(&manuscript, probe),
            ScopeLocation::Moved,
            "probe {probe:?} should not be a range"
        );
        assert_eq!(naive(&manuscript, probe), None, "probe {probe:?} disagreed");
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
