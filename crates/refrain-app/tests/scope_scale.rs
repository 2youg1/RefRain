//! 大稿子上，找一个范围要多久。
//!
//! 被替换掉的实现对每个起点都把后续块重新拼接一遍，是平方级的分配；新实现只做
//! 一次线性扫描加一次二分。这条测试同时跑两者并断言新的确实更快——不是为了追一
//! 个具体数字，而是防止将来有人「顺手」改回逐段拼接。

use std::time::Instant;

use refrain_app::scope::{ScopeLocation, locate_scope};
use refrain_core::{Id, Lineage, Manuscript, SourceSnapshot};

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

#[test]
#[cfg_attr(debug_assertions, ignore = "release-only performance gate")]
fn finding_a_late_scope_in_a_long_chapter_stays_linear() {
    const BLOCKS: usize = 4_000;
    let paragraphs: Vec<String> = (0..BLOCKS)
        .map(|index| format!("第 {index} 段的正文，长度适中，用来撑出一章的规模。"))
        .collect();
    let snapshot = SourceSnapshot::read(paragraphs.join("\n\n").into_bytes());
    let count = snapshot.block_count();
    let manuscript = Manuscript::open(snapshot, Lineage::fresh(count)).unwrap();

    // 找靠后的一个范围：这是最坏情况，前面每个起点都要被试过。
    let target = paragraphs[BLOCKS - 3..BLOCKS - 1].join("\n\n");

    let fresh_started = Instant::now();
    let fresh = locate_scope(&manuscript, &target);
    let fresh_elapsed = fresh_started.elapsed();

    let naive_started = Instant::now();
    let old = naive(&manuscript, &target);
    let naive_elapsed = naive_started.elapsed();

    // 先是同一个答案，再谈快慢。这份语料每段都带自己的序号，所以答案必然唯一；
    // 拿 Unique 解包也顺带钉住了这一点——若扫描开始把不同的段落看成同一段，
    // 这里会当场炸开，而不是悄悄比较两个 None。
    let ScopeLocation::Unique(fresh_blocks) = &fresh else {
        panic!("a corpus of distinct paragraphs must locate uniquely, got {fresh:?}");
    };
    assert_eq!(
        Some(fresh_blocks.clone()),
        old,
        "the two implementations disagreed"
    );
    assert_eq!(fresh_blocks.len(), 2);

    println!(
        "scope_scale blocks={BLOCKS} fresh_us={} naive_us={}",
        fresh_elapsed.as_micros(),
        naive_elapsed.as_micros()
    );
    assert!(
        fresh_elapsed * 4 < naive_elapsed,
        "the linear scan lost its advantage: fresh {fresh_elapsed:?}, naive {naive_elapsed:?}"
    );
}
