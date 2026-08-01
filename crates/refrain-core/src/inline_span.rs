//! 一行正文里的行内 Markdown 标记：哪一段字节是加粗，哪一段是行内代码。
//!
//! 与 [`crate::block_shape`] 同层：那个说「这一块是什么、有多大」，这个说
//! 「这一块内部哪些字节带着标记」。两者都只读字节，都不知道像素。
//!
//! **这里不做渲染，也不删除任何字节。** 出口是一串字节区间加一个样式名，
//! 视图层拿它给字符上色。标记符（`*`、`` ` ``）本身留在正文里——它们是作者
//! 写下的字节，而字节即正本；视图层把它们画淡，不是把它们摘掉。这条决定的
//! 代价与收益：光标偏移、断行的字符数组、改动着色的区间账本全部不必换算，
//! 因为屏幕上的字符序与源码字节序始终一一对应。
//!
//! 排版不在这里。断行需要版心宽度、字体度量与实际渲染尺寸，那些只有浏览器
//! 知道；Rust 侧若去猜，就会造出第二套与真实渲染漂开的排版。所以分工是
//! **Rust 出结构，视图层出像素**。

/// 一段字节带的样式。
///
/// 只收视图层真的会画的那几种。CommonMark 还有别的行内语法（链接、图片、
/// 自动链接），它们要么改变字符的可见性、要么需要打开外部资源——两件事都
/// 越过了「只上色」这条线，等有明确需求时再各自单独裁定。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InlineStyle {
    /// `**text**` 或 `__text__`。
    Strong,
    /// `*text*` 或 `_text_`。
    Emphasis,
    /// `` `code` ``。
    Code,
    /// `~~text~~`。
    Strikethrough,
}

/// 一段带样式的字节区间，`start..end` 半开。
///
/// 区间**含标记符本身**：`**粗**` 的区间从第一个 `*` 到最后一个 `*`。视图层
/// 需要知道标记符在哪才能把它画淡，而如果这里只给内容区间，视图层就得自己
/// 再解析一次标记符位置——那是同一个事实的第二个权威。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InlineSpan {
    pub start: usize,
    pub end: usize,
    pub style: InlineStyle,
    /// 内容区间（不含标记符），`content_start..content_end`。
    ///
    /// 与 `start..end` 一起给出，因为两个区间的用途不同：外层决定「哪些字节
    /// 属于这个标记」，内层决定「哪些字节要加粗」。让视图层从外层减去标记符
    /// 长度是可以的，但那要求它知道每种样式的标记符有几个字节——那是这里的
    /// 知识，不该外泄。
    pub content_start: usize,
    pub content_end: usize,
}

/// 解析一段正文里的行内标记。
///
/// 返回的区间按 `start` 升序且**互不重叠**——重叠的标记（`**a*b**`）只保留
/// 最外层能配对的那个。视图层据此做扁平切分，不必处理嵌套。
///
/// 输入是块的完整文本（可含换行）。围栏代码块不该走到这里：它整块由
/// [`crate::block_shape::BlockKind::Fence`] 判定并交给语法高亮，行内解析对它
/// 无意义且会把代码里的星号误判为强调。
#[must_use]
pub fn inline_spans(text: &str) -> Vec<InlineSpan> {
    let bytes = text.as_bytes();
    let mut spans: Vec<InlineSpan> = Vec::new();
    let mut index = 0usize;

    while index < bytes.len() {
        let byte = bytes[index];

        // 反引号优先于其余一切。CommonMark §6.1：代码区间的边界先于强调判定，
        // 所以 `*` 落在反引号里就只是一个星号。先扫它才能让这条成立。
        if byte == b'`' {
            let fence = run_length(bytes, index, b'`');
            if let Some(close) = find_run(bytes, index + fence, b'`', fence) {
                spans.push(InlineSpan {
                    start: index,
                    end: close + fence,
                    style: InlineStyle::Code,
                    content_start: index + fence,
                    content_end: close,
                });
                index = close + fence;
                continue;
            }
            // 没有配对的收尾反引号：它就是一个普通字符。
            index += fence;
            continue;
        }

        if byte == b'~' {
            let run = run_length(bytes, index, b'~');
            if run >= 2
                && let Some(close) = find_run(bytes, index + run, b'~', 2)
            {
                spans.push(InlineSpan {
                    start: index,
                    end: close + 2,
                    style: InlineStyle::Strikethrough,
                    content_start: index + 2,
                    content_end: close,
                });
                index = close + 2;
                continue;
            }
            index += run;
            continue;
        }

        if byte == b'*' || byte == b'_' {
            let run = run_length(bytes, index, byte);
            // 两个标记符是强调，三个以上按「最外层两个」处理：`***a***` 在
            // CommonMark 里是 strong 套 emphasis，而这里不做嵌套，取 strong
            // 是因为它是更强的那个信号，作者要的是「非常强调」。
            let want = if run >= 2 { 2 } else { 1 };
            if let Some(close) = find_run(bytes, index + run, byte, want) {
                let style = if want == 2 {
                    InlineStyle::Strong
                } else {
                    InlineStyle::Emphasis
                };
                // 内容不能为空：`****` 不是一个空的加粗，它是四个星号。
                if close > index + run {
                    // 收尾吃掉多少个标记符，取决于收尾那一串真有多少个，而不是
                    // `want`。`***很强***` 的收尾是三个星号，只吃两个会在区间外
                    // 留下一个孤立的 `*`——视图层于是把它当正文画出来，屏幕上
                    // 就多了一个星号。取两侧较小的那个：开头三个收尾两个时，
                    // 只有两个能配对。
                    let closing = run_length(bytes, close, byte).min(run);
                    spans.push(InlineSpan {
                        start: index,
                        end: close + closing,
                        style,
                        content_start: index + run,
                        content_end: close,
                    });
                    index = close + closing;
                    continue;
                }
            }
            index += run;
            continue;
        }

        // 其余字节整体跳过。多字节 UTF-8 的后续字节都 >= 0x80，永远不会等于
        // 上面任何一个 ASCII 标记符，所以逐字节前进不会切进字符中间。
        index += 1;
    }

    spans
}

/// 从 `at` 起连续多少个 `byte`。
fn run_length(bytes: &[u8], at: usize, byte: u8) -> usize {
    let mut length = 0usize;
    while at + length < bytes.len() && bytes[at + length] == byte {
        length += 1;
    }
    length
}

/// 从 `from` 起找到下一处**恰好至少** `want` 个连续 `byte` 的位置。
///
/// 返回那一串的起始下标。找不到返回 `None`。
fn find_run(bytes: &[u8], from: usize, byte: u8, want: usize) -> Option<usize> {
    let mut index = from;
    while index < bytes.len() {
        if bytes[index] == byte {
            let run = run_length(bytes, index, byte);
            if run >= want {
                return Some(index);
            }
            index += run;
        } else {
            index += 1;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{InlineStyle, inline_spans};

    /// 取出每个区间覆盖的原文，连同样式——断言读起来就是「屏幕上会看到什么」。
    fn marked(text: &str) -> Vec<(InlineStyle, &str, &str)> {
        inline_spans(text)
            .into_iter()
            .map(|span| {
                (
                    span.style,
                    &text[span.start..span.end],
                    &text[span.content_start..span.content_end],
                )
            })
            .collect()
    }

    #[test]
    fn 加粗与强调各自认出自己的标记符() {
        assert_eq!(
            marked("这是**粗**也是*斜*"),
            vec![
                (InlineStyle::Strong, "**粗**", "粗"),
                (InlineStyle::Emphasis, "*斜*", "斜"),
            ]
        );
    }

    #[test]
    fn 区间含标记符而内容不含() {
        let spans = inline_spans("a**b**c");
        assert_eq!(spans.len(), 1);
        let span = spans[0];
        // 外层给视图层画淡标记符，内层给它加粗内容。两个用途，两个区间。
        assert_eq!((span.start, span.end), (1, 6));
        assert_eq!((span.content_start, span.content_end), (3, 4));
    }

    #[test]
    fn 反引号里的星号不是强调() {
        // CommonMark §6.1：代码区间的边界先于强调判定。这条是整个扫描顺序的
        // 理由——先扫反引号，`*` 落在里面就只是一个星号。
        assert_eq!(
            marked("`a * b * c`"),
            vec![(InlineStyle::Code, "`a * b * c`", "a * b * c")]
        );
    }

    #[test]
    fn 没有配对的标记符不产生区间() {
        // 作者正在打字，`**` 还没写完的那一刻。此时不该突然有半段变粗。
        assert!(inline_spans("未闭合 **粗").is_empty());
        assert!(inline_spans("反引号 `code").is_empty());
        assert!(inline_spans("一个孤立的 * 星号").is_empty());
    }

    #[test]
    fn 空内容不算标记() {
        // `****` 是四个星号，不是一个空的加粗。
        assert!(inline_spans("****").is_empty());
        assert!(inline_spans("``").is_empty());
    }

    #[test]
    fn 区间互不重叠且按位置升序() {
        let spans = inline_spans("**一** `二` *三* ~~四~~");
        assert_eq!(spans.len(), 4);
        for pair in spans.windows(2) {
            // 视图层据此做扁平切分。重叠会让同一个字节属于两个样式，
            // 而扁平结构表达不了那件事。
            assert!(pair[0].end <= pair[1].start, "区间重叠：{pair:?}");
        }
    }

    #[test]
    fn 三个星号取更强的那个信号() {
        assert_eq!(
            marked("***很强***"),
            vec![(InlineStyle::Strong, "***很强***", "很强")]
        );
    }

    #[test]
    fn 下划线与星号等价() {
        assert_eq!(
            marked("__粗__"),
            vec![(InlineStyle::Strong, "__粗__", "粗")]
        );
        assert_eq!(marked("_斜_"), vec![(InlineStyle::Emphasis, "_斜_", "斜")]);
    }

    #[test]
    fn 删除线要两个波浪号() {
        assert_eq!(
            marked("~~删~~"),
            vec![(InlineStyle::Strikethrough, "~~删~~", "删")]
        );
        // 单个波浪号是普通字符（约等于、范围号）。
        assert!(inline_spans("1~2").is_empty());
    }

    #[test]
    fn 多字节字符不被切开() {
        // 逐字节前进的循环必须不切进 UTF-8 字符中间。区间用来切片，
        // 切错了会直接 panic——所以这条测试是安全性断言，不只是正确性。
        let text = "中文**加粗**日本語の**強調**🎌**emoji**";
        for span in inline_spans(text) {
            assert!(text.is_char_boundary(span.start));
            assert!(text.is_char_boundary(span.end));
            assert!(text.is_char_boundary(span.content_start));
            assert!(text.is_char_boundary(span.content_end));
        }
        assert_eq!(inline_spans(text).len(), 3);
    }

    #[test]
    fn 换行不终止标记() {
        // 块可以含硬换行，标记跨行是合法的。视图层的扁平切分会把它切成
        // 若干片，每片各自带样式。
        let spans = inline_spans("**跨\n行的粗**");
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].style, InlineStyle::Strong);
    }

    #[test]
    fn 区间永远落在文本范围内() {
        // 模糊测试的最小形态：拿一堆容易出错的输入验区间合法性。
        for text in [
            "*",
            "**",
            "***",
            "****",
            "*****",
            "`",
            "``",
            "~",
            "~~",
            "~~~",
            "*`*`*",
            "**`**`**",
            "_*_*_",
            "a*b**c***d",
            "~~*~~*",
        ] {
            for span in inline_spans(text) {
                assert!(span.start < span.end, "{text:?} 区间空或倒置");
                assert!(span.end <= text.len(), "{text:?} 区间越界");
                assert!(span.content_start <= span.content_end, "{text:?} 内容倒置");
                assert!(span.start <= span.content_start, "{text:?} 内容跑到区间外");
                assert!(span.content_end <= span.end, "{text:?} 内容跑到区间外");
            }
        }
    }
}
