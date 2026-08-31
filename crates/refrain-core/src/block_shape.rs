// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

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
    /// GFM 表格：整块按列对齐排版，不按行宽折行。
    ///
    /// 载荷是列数。它与标题的层级同性质——**结构信息，扫描时顺带得到**：
    /// 边界判定本来就逐字节走过首行，顺手数竖线是零额外扫描，而让视图层
    /// 重新解析一遍就会有第二个权威。
    ///
    /// 表格不需要 `SourceLayout` 做任何改动：块由空行分隔，而 GFM 表格内部
    /// 没有空行，所以它天然已经是一个完整的块（实测）。
    Table(TableShape),
    /// 标题：字号更大，且几乎不折行。
    ///
    /// 载荷是层级（`#` 的个数，1..=6）。它不是排版信息而是**结构信息**：
    /// agent 拿到六十条标题的平铺清单时，读到第 40 条已经不知道自己在哪一章。
    /// 层级带在这里而不是让上层重新解析字节，是因为边界判定本来就逐字节走过
    /// 首行、顺手数 `#` 是零额外扫描；让上层再解析一遍就会有第二个权威，
    /// 而两份判定漂开时没有任何东西会报错。
    Heading(HeadingLevel),
}

impl BlockKind {
    /// 这一种块在线上与索引库里的名字。
    ///
    /// 名字与种类是同一件事，所以它们住在同一处；这里与 [`Self::from_wire`]
    /// 是一对往返，改一边就要改另一边。先例是 `DocumentFormat::wire_code` 与
    /// `Role::from_wire`：线上拼写的家在 L0。
    ///
    /// **没有兑底臂**：新增一个 `BlockKind` 必须逼出一个命名决定，而不是静默
    /// 落进恰好写在那里的那一臂。
    ///
    /// **层级进名字，列数不进**。层级**就是**它是哪一级标题，而列数是关于
    /// 这一块的另一个事实（这张表有几列）；把列数塞进去会让 `table:3` 与
    /// `table:4` 读作两种块，而排序、大纲、索引没有一处需要区分它们。层级
    /// 走后缀而不开新列，是因为新列要一次 schema 迁移加一个默认值，而后缀
    /// 两样都不要：改动之前写下的行读作普通 `heading`，走 [`Self::from_wire`]
    /// 的兑底。
    #[must_use]
    pub fn wire_name(self) -> String {
        match self {
            Self::Paragraph => "paragraph".to_owned(),
            Self::Heading(level) => format!("heading:{}", level.get()),
            Self::Fence => "fence".to_owned(),
            Self::Table(_) => "table".to_owned(),
        }
    }

    /// 从线名读回一种块。[`Self::wire_name`] 的另一半。
    ///
    /// 三条兑底，每一条都是故意的：
    ///
    /// - 损坏或越界的层级后缀读作一级。一个坏后缀该让大纲丢掉缩进，
    ///   不该让作者丢掉搜索索引。
    /// - 没带层级的 `"heading"` 读作一级：它是后缀之前写下的行。
    /// - 本构建不认得的名字读作正文。那是诚实的地板：按它的词排名，
    ///   而不声称一种本构建看不见的结构。
    ///
    /// 列数在写入时就没存，反解因此给一个最小的合法形状；索引只用 kind 做
    /// 排序权重，真要排版时视图层拿块文本重新识别，那才是权威。
    #[must_use]
    pub fn from_wire(name: &str) -> Self {
        if let Some(level) = name.strip_prefix("heading:") {
            let parsed = level.parse::<u8>().ok().and_then(HeadingLevel::from_level);
            return Self::Heading(parsed.unwrap_or(HeadingLevel::ONE));
        }
        match name {
            "heading" => Self::Heading(HeadingLevel::ONE),
            "fence" => Self::Fence,
            "table" => Self::Table(TableShape::minimal()),
            _ => Self::Paragraph,
        }
    }
}

/// 表格的形状：列数与对齐。
///
/// 只记排版需要的那两件事。单元格内容不在这里——那是文本，视图层拿块文本
/// 自己切；把内容复制进形状会造出第二个权威，而两份漂开时没有任何东西会报错。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TableShape {
    /// 列数，取自分隔行。至少 1。
    columns: u8,
    /// 数据行数（不含表头与分隔行）。
    rows: u16,
}

impl TableShape {
    /// GFM 表格允许的最大列数。
    ///
    /// 超过这个数的「表格」几乎必然是作者在正文里画了一串竖线，而不是真的
    /// 要排一张 33 列的表。把它当表格排会得到一张挤成一团的东西，当段落排
    /// 反而是作者想要的。
    pub const MAX_COLUMNS: u8 = 32;

    /// 一张 1 列 0 行的表。
    ///
    /// 给的是**从持久化索引读回**这条路径：写入时只存了「这是表格」，列数
    /// 当时就没存（索引不需要它）。读回时给一个最小合法形状而不是 `Option`，
    /// 因为调用方要的是「这块是不是表格」，让每个使用点各自去想「列数为空
    /// 意味着什么」只会把一个不存在的问题散播出去。真要排版时视图层拿块
    /// 文本重新识别，那才是权威。
    #[must_use]
    pub fn minimal() -> Self {
        Self {
            columns: 1,
            rows: 0,
        }
    }

    #[must_use]
    pub fn columns(self) -> usize {
        self.columns as usize
    }

    #[must_use]
    pub fn rows(self) -> usize {
        self.rows as usize
    }

    /// 从整块文本识别 GFM 表格。不是表格返回 `None`。
    ///
    /// 判据取 GFM §4.10 的核心三条，不做完整实现：
    ///
    /// 1. 至少两行——表头与分隔行。只有表头的不是表格。
    /// 2. 第二行是分隔行：只由 `|`、`-`、`:`、空白组成，且至少有一个 `-`。
    /// 3. 分隔行的列数与表头一致。
    ///
    /// 第 3 条是刻意的严格：GFM 允许数据行列数不一致（多余的截断、缺的补空），
    /// 但**表头与分隔行不一致时整块不是表格**。这条挡住了正文里的竖线：
    /// 「他说|我说|大家说」下一行恰好是「----」时，列数对不上就不会被误判。
    #[must_use]
    pub fn of(text: &str) -> Option<Self> {
        let mut lines = text.lines();
        let header = lines.next()?;
        let delimiter = lines.next()?;

        let columns = cell_count(header)?;
        if columns != cell_count(delimiter)? {
            return None;
        }
        if !is_delimiter_row(delimiter) {
            return None;
        }

        let rows = lines.filter(|line| !line.trim().is_empty()).count();
        Some(Self {
            columns: columns as u8,
            // 行数只用于估高，饱和即可——一张 65535 行的表在屏幕上已经是
            // 「很长」，多出来的部分不改变任何排版决定。
            rows: u16::try_from(rows).unwrap_or(u16::MAX),
        })
    }
}

/// 一行有几个单元格。首尾的竖线是可选的，两种写法都要数出同一个数。
fn cell_count(line: &str) -> Option<usize> {
    let trimmed = line.trim();
    let inner = trimmed
        .strip_prefix('|')
        .unwrap_or(trimmed)
        .strip_suffix('|')
        .unwrap_or_else(|| trimmed.strip_prefix('|').unwrap_or(trimmed));
    if !trimmed.contains('|') {
        return None;
    }
    let count = inner.split('|').count();
    if count == 0 || count > TableShape::MAX_COLUMNS as usize {
        return None;
    }
    Some(count)
}

/// 这一行是不是分隔行：只由 `|`、`-`、`:`、空白组成，且至少有一个 `-`。
fn is_delimiter_row(line: &str) -> bool {
    let mut saw_dash = false;
    for character in line.chars() {
        match character {
            '-' => saw_dash = true,
            '|' | ':' | ' ' | '\t' => {}
            _ => return false,
        }
    }
    saw_dash
}

#[cfg(test)]
mod table_tests {
    use super::{BlockKind, BlockShape, TableShape};

    #[test]
    fn 认出标准的三列表格() {
        let shape =
            TableShape::of("| 甲 | 乙 | 丙 |\n|---|---|---|\n| 1 | 2 | 3 |").expect("这是一张表");
        assert_eq!(shape.columns(), 3);
        assert_eq!(shape.rows(), 1);
    }

    #[test]
    fn 首尾竖线可省() {
        // GFM 两种写法都合法，列数必须数成同一个。
        let with = TableShape::of("| 甲 | 乙 |\n|---|---|\n| 1 | 2 |").expect("有边框");
        let without = TableShape::of("甲 | 乙\n---|---\n1 | 2").expect("无边框");
        assert_eq!(with.columns(), without.columns());
    }

    #[test]
    fn 对齐冒号不影响识别() {
        let shape =
            TableShape::of("| 左 | 中 | 右 |\n|:---|:---:|---:|\n| a | b | c |").expect("带对齐");
        assert_eq!(shape.columns(), 3);
    }

    #[test]
    fn 只有表头不是表格() {
        assert!(TableShape::of("| 甲 | 乙 |").is_none());
    }

    #[test]
    fn 分隔行必须含横线() {
        // `| : | : |` 全是合法字符但没有横线，不是分隔行。
        assert!(TableShape::of("| 甲 | 乙 |\n| : | : |\n| 1 | 2 |").is_none());
    }

    #[test]
    fn 正文里的竖线不被误判为表格() {
        // 这条是整组测试的目的。作者在正文里用竖线分隔词语、下一行恰好是
        // 破折号时，列数对不上就不该变成一张表。
        assert!(TableShape::of("他说|我说|大家说\n----").is_none());
        // 列数一致但第二行不是分隔行（有正文字符）。
        assert!(TableShape::of("甲 | 乙\n丙 | 丁").is_none());
    }

    #[test]
    fn 超过列数上限的按段落处理() {
        // 33 根竖线几乎必然是作者在画分隔线，不是要排一张 33 列的表。
        let many = "|".repeat(40);
        let text = format!("{many}\n{}", "-|".repeat(40));
        assert!(TableShape::of(&text).is_none());
    }

    #[test]
    fn 块形状把表格认成表格而不是段落() {
        let shape = BlockShape::of("| 甲 | 乙 |\n|---|---|\n| 1 | 2 |");
        assert!(matches!(shape.kind, BlockKind::Table(_)));
    }

    #[test]
    fn 表格不折行() {
        // 表格按列对齐排版，一行就是一行。此前 `wrapped_lines` 用 `_` 兜底，
        // 表格会落进折行分支被估成十几行高，虚拟视口据此留白。
        let shape = BlockShape::of("| 很长的一列标题 | 另一列也不短 |\n|---|---|\n| a | b |");
        // 三个硬行，窄版心下仍是三行。
        assert_eq!(shape.wrapped_lines(4), 3);
    }

    #[test]
    fn 围栏里的竖线不是表格() {
        // 围栏先判定，表格识别只在段落上试。
        let shape = BlockShape::of("```\n| 甲 | 乙 |\n|---|---|\n```");
        assert!(matches!(shape.kind, BlockKind::Fence));
    }
}

/// 标题层级：`#` 的个数。
///
/// Markdown 只到六级，第七个 `#` 不再是标题。用一个具名类型而不是裸 `u8`，
/// 是因为「层级 0」与「层级 9」都不存在，而裸整数会让每个使用点各自去想
/// 该不该防这两个值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct HeadingLevel(u8);

impl HeadingLevel {
    /// Markdown 的层级上限。第七个 `#` 起不再是标题。
    pub const MAX: u8 = 6;

    /// 一级标题。
    ///
    /// 四处调用方知道自己要的就是一级：索引反解读到损坏后缀时的兑底值、
    /// 没带层级的 `"heading"` 行、以及两处测试。它们原本各自写
    /// `from_level(1)` 再在运行期断言一次「1 是一个层级」。写成常量后，
    /// 那句断言由编译器说，而且只说一次。
    pub const ONE: Self = Self(1);

    /// 从首行字节数出 `#`。非标题（或超过六个 `#`）返回 `None`。
    #[must_use]
    pub fn of_line(content: &[u8]) -> Option<Self> {
        let hashes = content.iter().take_while(|byte| **byte == b'#').count();
        // `#foo` 不是标题——CommonMark 要求 `#` 之后是空白或行尾。这条不是
        // 挑剔：井号在正文里做话题标签很常见，把 `#今天` 当成一级标题会让
        // 大纲多出作者没写过的一章。
        let followed_by_space = matches!(content.get(hashes), None | Some(b' ') | Some(b'\t'));
        if hashes == 0 || hashes > Self::MAX as usize || !followed_by_space {
            return None;
        }
        Some(Self(hashes as u8))
    }

    /// 从层级数字构造。超出 1..=6 返回 `None`。
    ///
    /// `of_line` 面向扫描器，这一个面向已经知道层级的调用方（测试、反序列化、
    /// 从别处读回的结构）。两条路都收口在同一个类型上，所以「层级 0」和
    /// 「层级 9」在系统里任何地方都构造不出来。
    #[must_use]
    pub const fn from_level(level: u8) -> Option<Self> {
        if level == 0 || level > Self::MAX {
            return None;
        }
        Some(Self(level))
    }

    /// 层级本身，1..=6。
    #[must_use]
    pub const fn get(self) -> u8 {
        self.0
    }
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
        let shape = accumulator.finish();
        // 表格识别放在这里而不是累加器里：判据要看**整块**（表头与分隔行的
        // 列数是否一致），而累加器是逐行推进的，它手里从来没有完整的两行。
        //
        // 只在段落上试：围栏里的竖线是代码，标题里的竖线是标题文字。
        if shape.kind == BlockKind::Paragraph
            && let Some(table) = TableShape::of(text)
        {
            return BlockShape {
                kind: BlockKind::Table(table),
                ..shape
            };
        }
        shape
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
            // 表格同理：它按列对齐排版，一行就是一行。此前这里是 `_` 兜底，
            // 表格会落进折行分支被当成一大段连续文本——那会把一张宽表估成
            // 十几行高，虚拟视口据此留白，作者滚动时看到一大片空。
            //
            // 这正是 catch-all 的代价：加一个变体不会报错，只会静默算错。
            BlockKind::Table(_) => hard,
            BlockKind::Paragraph | BlockKind::Heading(_) => {
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
    heading: Option<HeadingLevel>,
    started: bool,
}

impl ShapeAccumulator {
    /// 收下这一行的内容（不含行尾换行）。
    pub fn push_line(&mut self, content: &[u8], inside_fence: bool) {
        if !self.started {
            self.started = true;
            self.is_fence = inside_fence;
            self.heading = if inside_fence {
                None
            } else {
                HeadingLevel::of_line(content)
            };
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
            kind: match (self.is_fence, self.heading) {
                (true, _) => BlockKind::Fence,
                (false, Some(level)) => BlockKind::Heading(level),
                (false, None) => BlockKind::Paragraph,
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
/// This branchless fold lets each byte independently contribute whether it starts a code point
/// and whether it starts a wide character. A stateful byte-by-byte match prevents vectorisation.
///
/// 每个字节独立贡献「它是不是一个码位的开头」加上
/// 「它是不是一个宽字符的开头」，可以整批比较。三字节序列多为 CJK 表意文字与
/// 全角标点，四字节多为 emoji 与扩展汉字，两者各计两个当量。
///
/// | 做法 | 6 万块语料 |
/// |---|---|
/// | 只扫边界（参照） | 583µs |
/// | 逐字节 match 推进 | 4,168µs |
/// | **无分支 fold** | **1,568µs** |
///
/// `block_shape_scan` verifies byte-for-byte equivalence with the stateful implementation.
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

    /// 线名往返：写出去的名字读回来仍是同一种块。
    ///
    /// 两个索引库与一条线上通道共用这对函数，而它们之前是两份逐字节相同的
    /// 镜像。往返只在它们同住一处时才能被一条断言盯住；列数不在名字里，所以
    /// 表格的往返只到 kind 为止。
    #[test]
    fn a_block_kind_survives_the_round_trip_through_its_wire_name() {
        for level in 1..=HeadingLevel::MAX {
            let heading =
                BlockKind::Heading(HeadingLevel::from_level(level).expect("1..=6 is a level"));
            assert_eq!(BlockKind::from_wire(&heading.wire_name()), heading);
        }
        for kind in [BlockKind::Paragraph, BlockKind::Fence] {
            assert_eq!(BlockKind::from_wire(&kind.wire_name()), kind);
        }
        let table = BlockKind::Table(TableShape::minimal());
        assert_eq!(BlockKind::from_wire(&table.wire_name()), table);
    }

    /// 三条兑底各一条断言。
    ///
    /// 这些是从磁盘上真实读到的名字：`"heading"` 是后缀之前写下的行，
    /// `"heading:9"` 与 `"heading:x"` 是损坏的行，`"diagram"` 是更新的构建
    /// 写下的行。三种都不得让一次读取失败。
    #[test]
    fn a_wire_name_this_build_cannot_parse_costs_structure_not_the_read() {
        let one = BlockKind::Heading(HeadingLevel::ONE);
        assert_eq!(BlockKind::from_wire("heading"), one);
        assert_eq!(BlockKind::from_wire("heading:9"), one);
        assert_eq!(BlockKind::from_wire("heading:x"), one);
        assert_eq!(BlockKind::from_wire("diagram"), BlockKind::Paragraph);
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
    fn a_heading_carries_the_level_the_author_wrote() {
        let level = |line: &str| match shape_of(&[line]).kind {
            BlockKind::Heading(level) => Some(level.get()),
            _ => None,
        };
        assert_eq!(level("# 章一"), Some(1));
        assert_eq!(level("### 第三层"), Some(3));
        assert_eq!(level("###### 第六层"), Some(6));
        assert_eq!(level("章一"), None);
    }

    #[test]
    fn a_hash_that_is_not_a_heading_stays_a_paragraph() {
        // Both of these appear in real manuscripts, and both used to become
        // headings: the old rule was "first byte is #". A topic tag then added
        // a chapter the author never wrote, and seven hashes did the same.
        assert_eq!(shape_of(&["#今天"]).kind, BlockKind::Paragraph);
        assert_eq!(shape_of(&["####### 七个"]).kind, BlockKind::Paragraph);
    }

    #[test]
    fn an_empty_block_still_occupies_one_line() {
        assert_eq!(shape_of(&[""]).wrapped_lines(40), 1);
    }
}
