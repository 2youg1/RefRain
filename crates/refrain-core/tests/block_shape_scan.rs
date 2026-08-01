//! `BlockShape::of` 的代价，以及它与逐字节推进的对拍。
//!
//! 形状是按需从块文本读的，不是随边界扫描产出并存成第二份数组——那样会在每次
//! 结构编辑后与块序列漂移，而漂移是静默的。代价换正确性，所以这个代价要量。
//!
//! 判据是**比值**而非绝对毫秒：绝对值随机器与负载浮动，比值不会。

use std::time::Instant;

use refrain_core::block_shape::{BlockKind, BlockShape, HeadingLevel};

/// 造一份形状分布不均匀的语料：真实稿件是聚集的，不是均匀随机的。
///
/// 用均匀语料会让坏的估计量通过门禁——这是「夹具太仁慈」的一个具体实例。
fn blocks(count: usize) -> Vec<String> {
    (0..count)
        .map(|index| match index % 16 {
            0..=8 => "直骨令的雨落在窗上，他没有回头。".repeat(4),
            9..=11 => "他久久没有说话。".to_owned(),
            12 => "```rust\nlet a = 1;\nlet b = 2;\n```".to_owned(),
            13 => "## 章节".to_owned(),
            _ => "ASCII paragraph that stays narrow for contrast.".to_owned(),
        })
        .collect()
}

/// 被淘汰的写法，留作参照：逐字节 `match` 推进。
///
/// 它有数据依赖（下一个下标取决于当前字节），编译器无法向量化。
///
/// 按行拆开与 `BlockShape::of` 一致——换行符不占显示宽度。第一版我对整块文本
/// 直接算，两边不等，读起来像实现有错；**实际是对拍的两边不是同一件事**。
fn width_by_walking(text: &str) -> u32 {
    let mut units = 0u32;
    for line in text.split('\n') {
        let content = line.strip_suffix('\r').unwrap_or(line).as_bytes();
        let mut index = 0;
        while index < content.len() {
            let byte = content[index];
            let (advance, width) = match byte {
                0x00..=0x7F => (1usize, 1u32),
                0xC0..=0xDF => (2, 1),
                0xE0..=0xEF => (3, 2),
                _ => (4, 2),
            };
            units += width;
            index += advance;
        }
    }
    units
}

#[test]
#[cfg_attr(debug_assertions, ignore = "release-only: debug distorts the ratio")]
fn reading_shapes_is_batched_not_byte_by_byte() {
    let corpus = blocks(60_000);

    // 预热：第一遍要把语料读进缓存，否则成本落在先跑的那一方头上。
    let _ = BlockShape::of(&corpus[0]);

    let mut batched = u128::MAX;
    let mut walking = u128::MAX;
    for _ in 0..5 {
        let started = Instant::now();
        let mut total = 0u64;
        for text in &corpus {
            total += u64::from(BlockShape::of(text).width_units);
        }
        batched = batched.min(started.elapsed().as_micros());
        assert!(total > 0);

        let started = Instant::now();
        let mut reference = 0u64;
        for text in &corpus {
            reference += u64::from(width_by_walking(text));
        }
        walking = walking.min(started.elapsed().as_micros());
        // 两种写法必须给出同一个宽度：换算法就有换错的可能。
        assert_eq!(
            total, reference,
            "the batched width must equal the walked one"
        );
    }

    let ratio = walking as f64 / batched as f64;
    println!("shape_of batched_us={batched} walking_us={walking} speedup={ratio:.2}x");
    assert!(
        ratio > 1.5,
        "reading widths batched was only {ratio:.2}x the byte-by-byte walk; the branch-free \
         form is the reason this is cheap enough to do on demand"
    );
}

#[test]
fn a_shape_read_from_text_matches_what_the_text_says() {
    // 形状按需读，所以它对**任何**块文本都要正确，包括编辑后新生成的块。
    let shape = BlockShape::of("直骨令直骨");
    assert_eq!(shape.width_units, 10, "CJK counts two units each");
    assert_eq!(shape.kind, BlockKind::Paragraph);

    let heading = BlockShape::of("## 章一");
    assert_eq!(
        heading.kind,
        BlockKind::Heading(HeadingLevel::from_level(2).expect("2 is a level")),
        "the scan carries the level, not just the fact that it is a heading"
    );

    let fence = BlockShape::of("```rust\nlet a = 1;\n```");
    assert_eq!(fence.kind, BlockKind::Fence);
    assert_eq!(fence.hard_lines, 2);
    assert_eq!(
        fence.wrapped_lines(4),
        3,
        "code keeps the author's own lines"
    );

    let wrapped = BlockShape::of(&"直骨令".repeat(40));
    assert_eq!(wrapped.width_units, 240);
    assert_eq!(wrapped.wrapped_lines(40), 6);
}
