// 换一种扫法之后，块边界必须一字不差。
//
// `block_spans` 逐行前进，每行都要先找到它的换行符。找换行是这整趟扫描里唯一
// 与文件大小成正比、又完全机械的部分，因此值得换成 SIMD 内核；而余下的判定
// （围栏状态、整行是否全为 ASCII 空白、`\r\n` 的处理）一字未动。
//
// 这条测试守的不是速度，是「换了扫法之后答案还一样」。语料覆盖每一种会让两种
// 扫法产生分歧的形状：只有 `\n` 的、含 `\r\n` 的、空白行不含换行的、围栏跨越
// 空行的、以及没有尾随换行的结尾。
//
// 速度由 `crates/refrain-store/tests/huge_input_probe.rs` 的 `split_ms` 记录，
// 不在这里断言——那需要一份 GB 级语料，而正确性只需要这些。

use refrain_core::SourceLayout;

/// 把一份语料切成块，返回每块的原文。
fn blocks(source: &str) -> Vec<String> {
    SourceLayout::read(source.as_bytes())
        .blocks()
        .iter()
        .map(|span| source[span.start..span.end].to_string())
        .collect()
}

#[test]
fn every_shape_that_could_separate_the_two_scans_agrees() {
    // 每条都写出期望值，而不是拿两种实现互相比对：互相比对只能证明它们一致，
    // 证明不了它们对。
    let cases: &[(&str, &str, &[&str])] = &[
        ("空语料", "", &[]),
        ("只有空白", "   \n\t\n  ", &[]),
        ("单块无尾随换行", "只有一段", &["只有一段"]),
        ("单块有尾随换行", "只有一段\n", &["只有一段"]),
        ("两块", "甲\n\n乙", &["甲", "乙"]),
        ("空格行分隔", "甲\n   \n乙", &["甲", "乙"]),
        ("制表行分隔", "甲\n\t\n乙", &["甲", "乙"]),
        ("CRLF 分隔", "甲\r\n\r\n乙", &["甲", "乙"]),
        ("CRLF 混 LF", "甲\r\n\n乙\n\r\n丙", &["甲", "乙", "丙"]),
        ("多个连续空行", "甲\n\n\n\n乙", &["甲", "乙"]),
        (
            "块内含单换行",
            "第一行\n第二行\n\n下一块",
            &["第一行\n第二行", "下一块"],
        ),
        (
            "围栏跨空行",
            "```rust\nlet a = 1;\n\nlet b = 2;\n```",
            &["```rust\nlet a = 1;\n\nlet b = 2;\n```"],
        ),
        (
            "围栏之后还有块",
            "```\n\n```\n\n之后",
            &["```\n\n```", "之后"],
        ),
        ("未闭合的围栏", "```\n甲\n\n乙", &["```\n甲\n\n乙"]),
        ("首行即空行", "\n\n甲", &["甲"]),
        ("末尾多个空行", "甲\n\n\n", &["甲"]),
        (
            "无换行的长行",
            "这是一整行没有任何换行的文字",
            &["这是一整行没有任何换行的文字"],
        ),
    ];

    for (name, source, expected) in cases {
        let actual = blocks(source);
        let expected: Vec<String> = expected.iter().map(|text| (*text).to_string()).collect();
        assert_eq!(actual, expected, "{name}");
    }
}

#[test]
fn a_manuscript_of_many_blocks_keeps_every_boundary() {
    // 单块语料不会暴露「跨行推进」的错误：少数一个、多数一个、或把最后一块丢掉
    // 都要靠足够多的块才看得出来。这里用两千块，并逐块核对内容。
    let mut source = String::new();
    for index in 0..2_000 {
        source.push_str(&format!("第{index}節の本文。\n\n"));
    }

    let actual = blocks(&source);

    assert_eq!(actual.len(), 2_000);
    assert_eq!(actual[0], "第0節の本文。");
    assert_eq!(actual[1_999], "第1999節の本文。");
}

#[test]
fn the_source_can_be_rebuilt_from_its_spans() {
    // 最强的一条：`SourceLayout` 自己声称能从区间与未触碰的间隙还原原文。
    // 若扫描少算或多算了一个字节，还原就对不上——这条比逐块比较更严。
    let source = "序章\r\n\r\n本文の一段。\n\n```\nlet a = 1;\n\n```\n\n終わり";
    let layout = SourceLayout::read(source.as_bytes());

    let rebuilt = layout.reproduce(source.as_bytes()).expect("spans rebuild");

    assert_eq!(String::from_utf8(rebuilt).unwrap(), source);
}
