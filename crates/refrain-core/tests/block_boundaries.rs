// 什么样的一行结束一个块。
//
// 这条边界规则决定了块索引能不能用「找 `\n\n`」这类更快的扫描来加速：
// 若边界只由连续换行构成，`memmem::Finder("\n\n")` 找出的候选就是全集；
// 若含空格或制表符的行也算边界，那种扫描会漏掉它们。
//
// 所以先把规则本身钉住，再谈怎么扫得更快。这些断言直接读 `SourceLayout`，
// 不经过任何加速路径。

use refrain_core::SourceLayout;

fn blocks(source: &str) -> Vec<String> {
    let layout = SourceLayout::read(source.as_bytes());
    layout
        .blocks()
        .iter()
        .map(|span| source[span.start..span.end].to_string())
        .collect()
}

#[test]
fn an_empty_line_ends_a_block() {
    assert_eq!(blocks("甲\n\n乙"), vec!["甲", "乙"]);
}

#[test]
fn a_line_of_spaces_ends_a_block_just_as_an_empty_one_does() {
    // 这是「找 `\n\n`」会漏掉的情形：作者留下的空行里有空格，肉眼看不出来，
    // 而边界判定看的是「整行都是 ASCII 空白」。
    assert_eq!(blocks("甲\n   \n乙"), vec!["甲", "乙"]);
}

#[test]
fn a_line_of_tabs_ends_a_block() {
    assert_eq!(blocks("甲\n\t\n乙"), vec!["甲", "乙"]);
}

#[test]
fn a_crlf_blank_line_ends_a_block() {
    // `\r\n\r\n` 里两个换行之间隔着 `\r`，同样不是连续换行。
    assert_eq!(blocks("甲\r\n\r\n乙"), vec!["甲", "乙"]);
}

#[test]
fn a_blank_line_inside_a_fence_does_not_end_a_block() {
    // 反过来的一面：围栏内的空行**不是**边界。任何只看空白的扫描都会在这里
    // 多切一刀，所以候选之外还必须有围栏状态的判定。
    let fenced = "```rust\nlet a = 1;\n\nlet b = 2;\n```";
    assert_eq!(blocks(fenced), vec![fenced]);
}

#[test]
fn text_without_any_blank_line_is_one_block() {
    assert_eq!(blocks("第一行\n第二行\n第三行"), vec!["第一行\n第二行\n第三行"]);
}
