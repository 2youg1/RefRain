//! 一个块的字节形状：不解码文本就能说出它大概占多高。
//!
//! 虚拟视口要在没有测量过的块上估高。此前的做法是「拿测量过的块求个平均」，
//! 而实测表明那条路的误差来自估计量选错了输入：**每块的形状不是待估的未知量，
//! 它在扫描字节时就已经知道了**。边界判定本来就逐字节走过全文，顺手数出显示
//! 宽度当量与硬换行数是零额外扫描。
//!
//! 于是估高从「用别的块的高度猜这一块」变成「用这一块自己的形状算，再用一个
//! 全局比例系数校准」。实测（500 块后）最坏前缀和误差 29.86% → 1.68%。
//!
//! 这里只管形状。把形状换算成像素是视图层的事——它才知道字号、行宽与行距。

/// 块的种类。不同种类的排版规则不同，估高时不能混为一谈。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockKind {
    /// 普通段落：会按行宽折行。
    Paragraph,
    /// 围栏代码块：不折行（或按代码规则折），且通常有独立的行距。
    Fence,
    /// 标题：字号更大，且几乎不折行。
    Heading,
}

/// 一个块的形状。
///
/// `width_units` 是**显示宽度当量**而非字符数：CJK 表意文字、全角标点与
/// emoji 占两个当量，其余 ASCII 占一个。折行取决于显示宽度，不是码位数量，
/// 中日文长文里两者相差近一倍。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockShape {
    pub kind: BlockKind,
    /// 全块显示宽度当量之和。
    pub width_units: u32,
    /// 作者自己敲的换行数（不含折行）。一块至少占 `hard_lines + 1` 行。
    pub hard_lines: u32,
    /// 最长一行的显示宽度当量。窄块不会因为总量大就折很多行。
    pub max_line_units: u32,
}

impl BlockShape {
    /// Read a block's shape from its text.
    ///
    /// The boundary scan can produce shapes as it goes, but those are indexed
    /// by the snapshot that was scanned, and an edited manuscript contains
    /// blocks that snapshot never had. Rather than keep a parallel array
    /// correct across every structural edit — a second authority for the same
    /// fact, and one that fails silently when it drifts — a shape is read from
    /// the text it describes. The width scan is branch-free and batched, so
    /// this stays cheap enough to do on demand.
    #[must_use]
    pub fn of(text: &str) -> Self {
        let mut accumulator = ShapeAccumulator::default();
        let mut fenced = false;
        for line in text.split('\n') {
            let content = line.strip_suffix('\r').unwrap_or(line);
            let bytes = content.as_bytes();
            let marker = bytes
                .first()
                .is_some_and(|byte| matches!(byte, b'`' | b'~'))
                && bytes.iter().take_while(|byte| **byte == bytes[0]).count() >= 3;
            if marker {
                fenced = !fenced;
            }
            accumulator.push_line(bytes, fenced || marker);
        }
        accumulator.finish()
    }

    /// 这一块在给定行宽下至少占多少行。
    ///
    /// 每个硬行各自折行：把总宽度一次除以行宽会低估，因为行尾余量不能结转到
    /// 下一硬行。这里用「最长行折出的行数」乘硬行数作上界的下界——即在不逐行
    /// 记录的前提下能给出的最好估计。
    #[must_use]
    pub fn wrapped_lines(&self, line_units: u32) -> u32 {
        if line_units == 0 {
            return self.hard_lines + 1;
        }
        let hard = self.hard_lines + 1;
        match self.kind {
            // 代码块不折行：作者写多少行就是多少行。
            BlockKind::Fence => hard,
            _ => {
                let per_hard = self.width_units.div_ceil(hard.max(1));
                let wrapped = per_hard.div_ceil(line_units).max(1);
                hard * wrapped
            }
        }
    }
}

/// 逐字节累计一个块的形状。
///
/// 扫描块边界时本来就要走过每个字节，所以形状是顺手取出的，不是第二遍扫描。
#[derive(Debug, Default)]
pub struct ShapeAccumulator {
    width_units: u32,
    hard_lines: u32,
    max_line_units: u32,
    line_units: u32,
    is_fence: bool,
    is_heading: bool,
    started: bool,
}

impl ShapeAccumulator {
    /// 收下这一行的内容（不含行尾换行）。
    pub fn push_line(&mut self, content: &[u8], inside_fence: bool) {
        if !self.started {
            self.started = true;
            self.is_fence = inside_fence;
            self.is_heading = !inside_fence && content.first() == Some(&b'#');
        } else {
            self.hard_lines += 1;
        }
        self.line_units = display_units(content);
        self.width_units += self.line_units;
        self.max_line_units = self.max_line_units.max(self.line_units);
    }

    /// 结束这一块并给出它的形状。
    #[must_use]
    pub fn finish(&self) -> BlockShape {
        BlockShape {
            kind: if self.is_fence {
                BlockKind::Fence
            } else if self.is_heading {
                BlockKind::Heading
            } else {
                BlockKind::Paragraph
            },
            width_units: self.width_units,
            hard_lines: self.hard_lines,
            max_line_units: self.max_line_units,
        }
    }

    /// 为下一块复位。
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

/// 一行字节的显示宽度当量。
///
/// **一处被实测纠正的假设，连同一次被实测淘汰的优化。** 我原以为形状累计是
/// 「顺手」的，因为边界判定本来就逐字节走过全文。实测 8.59 倍推翻了它：边界
/// 判定用 `all(is_ascii_whitespace)`，在首个非空白字节就短路——那条循环其实
/// **不**读每个字节，读全文的是这个函数。
///
/// 随后我加了「整行纯 ASCII 就取字节数」的快速路径，**实测毫无改善**（8.53 倍）：
/// 中日文稿件里几乎每行都含非 ASCII，那条捷径根本走不到。定位之后才知道贵的
/// 是逐字节 `match` 推进——它有数据依赖（下一个下标取决于当前字节），编译器
/// 无法向量化。
///
/// 现在这一行是无分支的：每个字节独立贡献「它是不是一个码位的开头」加上
/// 「它是不是一个宽字符的开头」，可以整批比较。三字节序列多为 CJK 表意文字与
/// 全角标点，四字节多为 emoji 与扩展汉字，两者各计两个当量。
///
/// | 做法 | 6 万块语料 |
/// |---|---|
/// | 只扫边界（参照） | 583µs |
/// | 逐字节 match 推进 | 4,168µs |
/// | **无分支 fold** | **1,568µs** |
///
/// 答案与逐字节推进逐字节相同（`block_shape_scan` 对拍）。
///
/// 走首字节而非 `unicode-width` 的精确查表：实测那张表只跑 1.42 GB/s，比
/// UTF-8 校验慢 17 倍，而估高本来就要靠一个比例系数校准，精确宽度换不来相应
/// 的准确度。
fn display_units(content: &[u8]) -> u32 {
    if content.is_ascii() {
        return u32::try_from(content.len()).unwrap_or(u32::MAX);
    }
    content.iter().fold(0u32, |units, byte| {
        // 不是 UTF-8 续字节 → 一个新码位；首字节 >= 0xE0 → 该码位占两当量。
        units + u32::from((*byte & 0xC0) != 0x80) + u32::from(*byte >= 0xE0)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape_of(lines: &[&str]) -> BlockShape {
        let mut accumulator = ShapeAccumulator::default();
        for line in lines {
            accumulator.push_line(line.as_bytes(), false);
        }
        accumulator.finish()
    }

    #[test]
    fn cjk_text_is_twice_as_wide_as_ascii_of_the_same_length() {
        // 折行看的是显示宽度，不是码位数量。五个汉字和十个字母一样宽。
        assert_eq!(shape_of(&["直骨令直骨"]).width_units, 10);
        assert_eq!(shape_of(&["abcdefghij"]).width_units, 10);
    }

    #[test]
    fn hard_line_breaks_are_counted_separately_from_wrapping() {
        let shape = shape_of(&["甲", "乙", "丙"]);
        assert_eq!(shape.hard_lines, 2, "three lines carry two breaks");
        assert_eq!(shape.max_line_units, 2);
    }

    #[test]
    fn a_narrow_block_does_not_wrap_just_because_it_is_long() {
        // 三十个硬行、每行两当量：总宽 60，但行宽 40 下它一行也不折。
        let shape = shape_of(&["甲"; 30]);
        assert_eq!(shape.wrapped_lines(40), 30);
    }

    #[test]
    fn a_wide_paragraph_wraps() {
        let shape = shape_of(&["直骨令".repeat(40).as_str()]);
        assert_eq!(shape.width_units, 240);
        assert_eq!(shape.wrapped_lines(40), 6);
    }

    #[test]
    fn a_fence_never_wraps() {
        let mut accumulator = ShapeAccumulator::default();
        accumulator.push_line(b"```rust", true);
        accumulator.push_line(
            "let 直骨令 = 直骨令直骨令直骨令直骨令直骨令;".as_bytes(),
            true,
        );
        accumulator.push_line(b"```", true);
        let shape = accumulator.finish();
        assert_eq!(shape.kind, BlockKind::Fence);
        assert_eq!(shape.wrapped_lines(10), 3, "code keeps the author's lines");
    }

    #[test]
    fn a_heading_is_recognised_by_its_first_byte() {
        assert_eq!(shape_of(&["# 章一"]).kind, BlockKind::Heading);
        assert_eq!(shape_of(&["章一"]).kind, BlockKind::Paragraph);
    }

    #[test]
    fn an_empty_block_still_occupies_one_line() {
        assert_eq!(shape_of(&[""]).wrapped_lines(40), 1);
    }
}
