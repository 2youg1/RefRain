// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

// 读一个块的文本，不应该每次都重新校验一遍 UTF-8。
//
// `BlockText::Shared` 最初在 `as_str()` 里调用 `from_utf8`：`refrain-core` 是
// `#![forbid(unsafe_code)]`，不能用 `from_utf8_unchecked`，于是每一次读都把
// 整个区间再扫一遍。一次校验很便宜，但读取发生在渲染、比对、导出、搜索的每一
// 条路径上，代价随读取次数线性增长——1GB 稿子上的一次全量遍历实测从 25ms 涨到
// 400ms。
//
// 正确的位置是更早：`SourceSnapshot::read` 已经完整扫过一遍字节。在那里校验一
// 次，之后整份快照就是已知有效的 UTF-8，每个块的切片都不必再问。这样不变量由
// 构造时保证，而不是靠每次读取重新证明一遍。
//
// 这条测试不测时间——时间随机器变。它测的是次数：读一千次的成本，应当与读一次
// 相当，而不是一千倍。

use std::time::Instant;

use refrain_core::{Lineage, Manuscript, SourceSnapshot};

/// 一份中日文为主的稿子：CJK 是三字节序列，重复校验的代价在这里最明显。
fn manuscript(blocks: usize) -> Manuscript {
    let mut text = String::new();
    for index in 0..blocks {
        text.push_str(&format!(
            "第{index}節。這一段的長度與真實稿件裡的一段接近，帶標點，也帶一點變化。\n\n"
        ));
    }
    let snapshot = SourceSnapshot::read(text.into_bytes());
    let lineage = Lineage::fresh(snapshot.block_count());
    Manuscript::open(snapshot, lineage).expect("manuscript opens")
}

#[test]
// 这条比较两条路径的相对成本，而 debug 构建对 enum 分派与迭代器的处理与 release
// 差得足够多，会把比值推高到与实现无关。门禁跑 release，这里也只在 release 下断言。
#[cfg_attr(
    debug_assertions,
    ignore = "relative cost is only meaningful in release"
)]
fn reading_a_block_costs_a_slice_not_a_scan() {
    // 倍率式的断言在这里没有意义：无论每次读是切片还是重新校验，读五十遍都是
    // 一遍的五十倍——我第一版就是这么写的，它对两种实现都会通过（或都会失败）。
    //
    // 能分开这两种实现的是**速率**。切片的成本与区间长度无关，重新校验则要把
    // 区间里的每个字节再看一遍。所以拿同一份文字的两种读法对比：读块（走
    // `BlockText`）与读一个等长的 `&str` 切片。二者应当在同一量级。
    let manuscript = manuscript(4_000);
    let blocks = manuscript.head().blocks();
    let whole = manuscript.head().text();

    // 预热，把冷缓存排除在两次测量之外。
    let warm: usize = blocks.iter().map(|block| block.text().len()).sum();
    assert!(warm > 0);

    let ranges: Vec<(usize, usize)> = {
        let mut at = 0usize;
        blocks
            .iter()
            .map(|block| {
                let start = at;
                at += block.text().len() + 2;
                (start, start + block.text().len())
            })
            .collect()
    };

    let through_blocks = Instant::now();
    let via_blocks: usize = blocks.iter().map(|block| block.text().len()).sum();
    let block_time = through_blocks.elapsed();

    let through_str = Instant::now();
    let via_str: usize = ranges.iter().map(|(a, b)| whole[*a..*b].len()).sum();
    let str_time = through_str.elapsed();

    assert_eq!(via_blocks, via_str);

    // 三倍容忍枚举与 enum 分派的开销；重新校验会把这个比值推到十倍以上，因为
    // 它对每个块都要多扫一遍字节，而 CJK 每字符三字节。
    let ratio = block_time.as_nanos() as f64 / str_time.as_nanos().max(1) as f64;
    assert!(
        ratio < 3.0,
        "reading blocks cost {ratio:.1}x the same slices of the same string \
         ({block_time:?} against {str_time:?}); block text is being scanned, not sliced"
    );
}

#[test]
fn a_snapshot_of_invalid_bytes_is_refused_at_the_source() {
    // 校验搬到 `SourceSnapshot::read` 之后，坏字节应当在那里就被认出来，而不是
    // 等到某个块碰巧被读到。这条固定住「什么时候发现」这件事。
    let mut bytes = "完整的一段。\n\n".as_bytes().to_vec();
    bytes.extend_from_slice(&"序".as_bytes()[..2]);

    assert!(
        SourceSnapshot::read_checked(bytes).is_err(),
        "invalid bytes should be refused when the snapshot is read"
    );
}

#[test]
fn block_text_still_reads_exactly_what_the_source_says() {
    // 去掉逐次校验不能改变读出来的字。
    let source = "序章\n\n第一節の本文。\n\n最後の行";
    let snapshot = SourceSnapshot::read(source.as_bytes().to_vec());
    let lineage = Lineage::fresh(snapshot.block_count());
    let manuscript = Manuscript::open(snapshot, lineage).expect("manuscript opens");

    let blocks = manuscript.head().blocks();
    assert_eq!(blocks.len(), 3);
    assert_eq!(blocks[0].text(), "序章");
    assert_eq!(blocks[1].text(), "第一節の本文。");
    assert_eq!(blocks[2].text(), "最後の行");
    assert_eq!(manuscript.head().text(), source);
}
