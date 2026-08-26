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

/// 翻完一整篇的代价与篇幅成正比，不与篇幅的平方成正比。
///
/// 旧写法从块 0 起走全部块、靠 `continue` 跳过游标之前的那些，于是翻到第 n 页
/// 要走过前面 n 页的每一块。一篇两万块的稿子按每页 100 块翻完是两百页，
/// 两千万次多余的树下降——而这条路径正是派遣台的块清单每次翻页都要走的。
///
/// 断言的是形状不是数字：篇幅翻四倍，翻完一整篇的耗时不该翻十六倍。上界给到
/// 八倍，留出常数因子与这台机器的噪声，仍然把平方级挡在外面。
///
/// 装置直接用 `Manuscript`：`list_blocks` 收 `ProjectEntry` 只为了取出那一份
/// 稿子（`entry.manuscripts.get(path)`），而这条测试量的是取出之后的那段走法。
/// 两种走法都写在这里逐字对照，与本文件顶上的 `naive` 同一条纪律。
#[test]
#[cfg_attr(debug_assertions, ignore = "release-only performance gate")]
fn paging_through_a_whole_document_stays_linear_in_its_length() {
    /// 被替换掉的那一段：从 0 起枚举，靠 `continue` 跳过游标之前的行。
    fn paged_from_zero(manuscript: &Manuscript, after: Option<u32>, count: usize) -> Vec<u32> {
        let blocks = manuscript.head().blocks();
        let mut rows = Vec::with_capacity(count);
        for (ordinal, _block) in blocks.iter().enumerate() {
            let ordinal = ordinal as u32;
            if after.is_some_and(|after| ordinal < after) {
                continue;
            }
            if rows.len() == count {
                break;
            }
            rows.push(ordinal);
        }
        rows
    }

    /// 现在这一段：起点直接寻址，只走这一页要画的那些行。
    fn paged_from_cursor(manuscript: &Manuscript, after: Option<u32>, count: usize) -> Vec<u32> {
        let blocks = manuscript.head().blocks();
        let start = after.unwrap_or(0) as usize;
        let mut rows = Vec::with_capacity(count);
        for offset in 0..count {
            let ordinal = match start.checked_add(offset) {
                Some(value) => value,
                None => break,
            };
            if blocks.get(ordinal).is_none() {
                break;
            }
            rows.push(ordinal as u32);
        }
        rows
    }

    fn walk(
        manuscript: &Manuscript,
        page: fn(&Manuscript, Option<u32>, usize) -> Vec<u32>,
    ) -> std::time::Duration {
        let total = manuscript.head().blocks().len();
        let started = Instant::now();
        let mut after: Option<u32> = None;
        loop {
            let rows = page(manuscript, after, 100);
            let Some(last) = rows.last().copied() else {
                break;
            };
            if last as usize + 1 >= total {
                break;
            }
            after = Some(last + 1);
        }
        started.elapsed()
    }

    let small = manuscript_with_blocks(5_000);
    let large = manuscript_with_blocks(20_000);

    // 两种走法交出的页必须一字不差，否则下面的计时比的是两件不同的事。
    for after in [None, Some(0), Some(1), Some(4_950), Some(9_999)] {
        assert_eq!(
            paged_from_zero(&small, after, 100),
            paged_from_cursor(&small, after, 100),
            "the two walks disagree at cursor {after:?}"
        );
    }

    let small_now = walk(&small, paged_from_cursor);
    let large_now = walk(&large, paged_from_cursor);
    let small_before = walk(&small, paged_from_zero);
    let large_before = walk(&large, paged_from_zero);
    eprintln!(
        "paging 5,000 → 20,000 blocks: from the cursor {small_now:?} → {large_now:?};          from zero {small_before:?} → {large_before:?}"
    );
    assert!(
        large_now < small_now.saturating_mul(8),
        "paging from the cursor grew faster than the manuscript: {small_now:?} → {large_now:?}"
    );
}

fn manuscript_with_blocks(blocks: usize) -> Manuscript {
    let source = (0..blocks)
        .map(|index| format!("第{index}块，够长到能画出一行预览。"))
        .collect::<Vec<_>>()
        .join(
            "

",
        )
        .into_bytes();
    let snapshot = SourceSnapshot::read(source);
    let lineage = Lineage::fresh(snapshot.block_count());
    Manuscript::open(snapshot, lineage).unwrap()
}
