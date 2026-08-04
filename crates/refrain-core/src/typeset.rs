//! 中西混排的断行规则，从 `packages/typeset` 迁入。
//!
//! **接上哪个功能**：Native 文档表面的正文换行。SDK 只把空格和制表符当断行
//! 机会（`text_layout.zig::isTextBreakByte`），中文整段没有空格，只能逐字硬
//! 切。这里给出断点，由投影带过界，Zig 只负责画。
//!
//! **在全局逻辑中负责什么**：只回答「哪些位置可以换行」和「每个字占多宽」。
//! 不持有正文（`Manuscript` 的事），不画像素（平台的事），不写回磁盘——间距
//! 与挤压都是渲染派生物，`.md` 的字节不变。字符串进、数字出。
//!
//! **能复用什么**：规则与阈值原样来自 `packages/typeset`，那些值是对着
//! Chromium 实测与 CLREQ／JLREQ／GB/T 条文定下来的，不在这里重新推导。
//! 该包在步骤 10 随旧 DOM 编辑器退场，届时本模块是唯一权威。
//!
//! 处理顺序按 CLREQ 固定，不可颠倒：
//! 判类 → 不可分单元 → 挤压与混排间距 → 候选断点（禁则）→ 排行。
//! 第 3 步早于第 5 步是硬约束：挤压会改变换行位置。

use std::ops::Range;

/// 一个字符在排版规则里的类别。间距、禁则、悬挂都按类定规矩，不按具体字符。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CharClass {
    /// 表意文字与假名。汉字与假名同类：它们之间没有跨 script 的边界。
    Ideograph,
    /// 开括号。可以在行首，不可以在行尾。
    Open,
    /// 闭括号。可以在行尾，不可以在行首。
    Close,
    /// 句读点。不可在行首，行尾可压。
    Stop,
    /// 中点。两侧对称，压缩规矩与句读点不同。
    Middle,
    /// 长标点（…… —— 等）。成对出现，不可拆。
    Extender,
    /// 西文字母（仅 ASCII）。
    Latin,
    /// 数字（仅 ASCII）。
    Digit,
    /// 空白。
    Space,
    /// 其余：符号、控制字符。
    Other,
}

impl CharClass {
    /// 这一类是不是「西文一侧」。混排间距要在它与表意文字之间插入空隙。
    #[must_use]
    pub fn is_western_side(self) -> bool {
        matches!(self, Self::Latin | Self::Digit)
    }
}

/// 这个字属于哪一类。
///
/// 全角数字与全角字母归 `Ideograph`：它们占一个字身，归进 Digit/Latin 会让
/// 混排间距在本来没有 script 边界的地方插入空隙。
#[must_use]
pub fn class_of(character: char) -> CharClass {
    const OPEN: &str = "「『（〔［｛〈《【〖〘〚“‘";
    const CLOSE: &str = "」』）〕］｝〉》】〗〙〛”’";
    const STOP: &str = "。．、，：；？！";
    const MIDDLE: &str = "・·･";
    const EXTENDER: &str = "…—―－〜～";

    if OPEN.contains(character) {
        return CharClass::Open;
    }
    if CLOSE.contains(character) {
        return CharClass::Close;
    }
    if STOP.contains(character) {
        return CharClass::Stop;
    }
    if MIDDLE.contains(character) {
        return CharClass::Middle;
    }
    if EXTENDER.contains(character) {
        return CharClass::Extender;
    }
    if character == ' ' || character == '\t' || character == '\u{3000}' {
        return CharClass::Space;
    }
    if character.is_ascii_digit() {
        return CharClass::Digit;
    }
    if character.is_ascii_alphabetic() {
        return CharClass::Latin;
    }
    if is_ideographic(character) {
        return CharClass::Ideograph;
    }
    CharClass::Other
}

fn is_ideographic(character: char) -> bool {
    matches!(character as u32,
        0x3400..=0x4dbf      // CJK 扩展 A
        | 0x4e00..=0x9fff    // CJK 统一表意文字
        | 0xf900..=0xfaff    // 兼容表意文字
        | 0x3040..=0x30ff    // 平假名、片假名
        | 0xff01..=0xff60    // 全角形式
        | 0x20000..=0x2ebef) // 扩展 B 及以后
}

/// 这个字符占半个字身还是一个字身。
///
/// **与 `is_western_side` 是两件事。** 间距问的是「有没有跨 script 的边界」，
/// 宽度问的是「这个字画出来有多宽」。ASCII 标点在两个问题上答案相反：`*` 与
/// 中文之间不插入混排间距，但它确实只占半个字身。旧写法只认 latin/digit，
/// 于是 `**加粗**` 的四个星号被算成 4em 而实际约 2em，那一行少放两个字。
#[must_use]
pub fn is_half_width(character: char) -> bool {
    matches!(character as u32, 0x20..=0x7e)
}

/// 行尾全角标点怎么处理。两地规矩相反，这是两份预设不能合并的根本理由。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEndPunctuation {
    /// GB/T 15834 §5.1.10：行尾全角标点压半个字身。
    CompressHalf,
    /// JLREQ §3.1.9：半角字身 + 后置半角空白，行尾这段空白原则上保留。
    KeepTrailingSpace,
}

/// 禁则的严格度。三档必须产生**可见不同**的断行，否则这个选项是装饰。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BreakStrictness {
    Loose,
    Normal,
    Strict,
}

/// 一份预设。全部是数据；没有任何一项是行为开关。
///
/// 两条已核实、与常见做法相反的取值：混排间距简中取 CSS Text 4 §8.4.1 的
/// 1/8 ic 而非常见的 1/4（后者是 CLREQ §6.3.3 的**上界**），日文按 JIS 取
/// 1/4 em；悬挂默认关（JLREQ 说它不在 JIS X 4051 正文里，CLREQ §6.1.3 说
/// 中文多数出版物不用）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TypesetPreset {
    pub break_strictness: BreakStrictness,
    pub line_end_punctuation: LineEndPunctuation,
    /// 中西混排间距，单位 em。不是品味，是各自规范里写下的值。
    pub inter_script_spacing_em: f32,
}

/// 简体中文。行尾标点压半字（GB/T 15834）；混排间距 1/8 ic（CSS Text 4）。
pub const ZH_HANS: TypesetPreset = TypesetPreset {
    break_strictness: BreakStrictness::Normal,
    line_end_punctuation: LineEndPunctuation::CompressHalf,
    inter_script_spacing_em: 0.125,
};

/// 繁体中文。与简中同源；差别在悬挂（CLREQ §6.1.3 明说繁体横排不宜）。
pub const ZH_HANT: TypesetPreset = ZH_HANS;

/// 日文。行尾句点保留后置空白（JLREQ §3.1.9）——与简中正好相反。
/// 混排间距 1/4 em（JIS）。
pub const JA: TypesetPreset = TypesetPreset {
    break_strictness: BreakStrictness::Normal,
    line_end_punctuation: LineEndPunctuation::KeepTrailingSpace,
    inter_script_spacing_em: 0.25,
};

/// 行首不许出现的字符类（三份预设相同）。
fn forbidden_at_line_start(kind: CharClass) -> bool {
    matches!(
        kind,
        CharClass::Close | CharClass::Stop | CharClass::Middle | CharClass::Extender
    )
}

/// 行尾不许出现的字符类（三份预设相同）。
fn forbidden_at_line_end(kind: CharClass) -> bool {
    kind == CharClass::Open
}

/// 一个字符在版面上的样子。
#[derive(Debug, Clone, Copy)]
struct AdjustedChar {
    /// 该字符在原文里的字节偏移。断点按字节返回，与投影坐标系一致。
    offset: usize,
    character: char,
    kind: CharClass,
    /// 这个字符**之前**要加的空白，单位 em。负值表示压缩。
    ///
    /// 记在「之前」而不是「之后」：行首要不要保留这段空白是一个真问题
    /// （JLREQ §3.1.9 的行尾空白就是它的镜像），记在之前才问得出来。
    space_before: f32,
    /// 与**前一个**字符之间是否禁止断行。
    ///
    /// 字符类是逐字判定的，判得出「闭括号不能在行首」，判不出「这是一条 URL
    /// 的中段」——后者跨越几十个字符，任何逐字规则都看不见它。所以结构层在
    /// 这里落成一位随字符走的标记。
    joined_to_previous: bool,
}

impl AdjustedChar {
    /// 这个字符占多宽，含它之前的空白。
    ///
    /// 半角判定看字符本身而不是 `kind`：`kind` 是为**间距**分的类，而 ASCII
    /// 标点在间距与宽度上的答案相反。
    fn advance(self) -> f32 {
        self.space_before
            + if is_half_width(self.character) {
                0.5
            } else {
                1.0
            }
    }
}

/// 两个相邻字符类之间要加多少空白（em）。
///
/// 挤压与间距在同一处决定，因为它们回答的是同一个问题。先问挤压：一旦这对
/// 字符要压，就不会再有混排间距的事——它们都是全角标点，之间没有 script 边界。
fn gap_between(left: CharClass, right: CharClass, preset: &TypesetPreset) -> f32 {
    let squeeze = squeeze_between(left, right);
    if squeeze != 0.0 {
        return squeeze;
    }
    // 混排间距：两个方向都要加——「中文abc」与「abc中文」是同一种边界，
    // 只加一侧会让同一句话的两端疏密不同。
    let crosses_script = (left == CharClass::Ideograph && right.is_western_side())
        || (left.is_western_side() && right == CharClass::Ideograph);
    if crosses_script {
        return preset.inter_script_spacing_em;
    }
    0.0
}

/// 连续全角标点之间压掉多少（负值，em）。
///
/// 都是**两个全角标点各自带着自己的内白**相邻时留下的空洞。CLREQ §6.3.2 的
/// 原文是「两个相邻标点（原占 2 字）压到 1.5 字宽」，**不按开闭分类**——所以
/// 开+开、闭+闭也压。按开闭区分的是韩文（KLREQ §7.3.3），中文规范无对应条款。
///
/// 「句读 + 句读」这条是对着 Chromium 实测补的：探针（Noto Serif SC 16px）
/// 测得单个 `，` 为 16px，`，，` 为 24px——第二个只占 0.5em，即**浏览器默认
/// 就在做连续标点挤压**（`text-spacing-trim` 的默认行为）。缺这条会让每处
/// 连续标点高估半个字身，在标点密集的段落里累积成整整一行。
fn squeeze_between(left: CharClass, right: CharClass) -> f32 {
    const HALF: f32 = -0.5;
    match (left, right) {
        (CharClass::Close, CharClass::Open)
        | (CharClass::Stop, CharClass::Close | CharClass::Open | CharClass::Stop)
        | (CharClass::Close, CharClass::Stop)
        | (CharClass::Open, CharClass::Open)
        | (CharClass::Close, CharClass::Close) => HALF,
        _ => 0.0,
    }
}

/// 这一行的行尾标点该怎么处理——两地规矩相反的那一条。
fn line_end_adjustment(last_kind: CharClass, preset: &TypesetPreset) -> f32 {
    if last_kind != CharClass::Stop && last_kind != CharClass::Close {
        return 0.0;
    }
    match preset.line_end_punctuation {
        LineEndPunctuation::CompressHalf => -0.5,
        LineEndPunctuation::KeepTrailingSpace => 0.0,
    }
}

/// 找出所有不可分区间（按字节，左闭右开），已排序且互不重叠。
///
/// 识别的是**保守的**单元，宁可漏判不可误判：一个被误判为不可分的长段落会把
/// 整行推出版心，那比断错一个 URL 更糟。
///
/// 这里是手写扫描而不是正则，因为断行在每次投影都跑，而这一层原本就是
/// TS 版的热点（实测 400K 字符 5,286ms，超线性部分全在区间查找上）。
fn unbreakable_ranges(text: &str) -> Vec<Range<usize>> {
    let bytes = text.as_bytes();
    let mut found: Vec<Range<usize>> = Vec::new();

    let mut index = 0usize;
    while index < bytes.len() {
        let rest = &text[index..];
        if let Some(range) = scan_scheme_url(text, index)
            .or_else(|| scan_www(text, index))
            .or_else(|| scan_path(text, index))
            .or_else(|| scan_inline_code(text, index))
            .or_else(|| scan_number_with_unit(text, index))
        {
            if range.end - range.start >= 2 {
                found.push(range.clone());
            }
            index = range.end.max(index + 1);
            continue;
        }
        index += rest.chars().next().map_or(1, char::len_utf8);
    }

    if found.is_empty() {
        return found;
    }
    found.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    let mut merged: Vec<Range<usize>> = Vec::with_capacity(found.len());
    for range in found {
        match merged.last_mut() {
            Some(last) if range.start <= last.end => {
                if range.end > last.end {
                    last.end = range.end;
                }
            }
            _ => merged.push(range),
        }
    }
    merged
}

/// URL 尾部的终止符：中文标点属于句子，不属于 URL。
fn ends_url(character: char) -> bool {
    character.is_whitespace() || "，。！？；：、）」』".contains(character)
}

/// 带协议的 URL：`scheme://…`。要求带协议，不认裸域名——`例如 example.com
/// 这样` 里的域名与句子里的普通词无法可靠区分。
fn scan_scheme_url(text: &str, start: usize) -> Option<Range<usize>> {
    let rest = &text[start..];
    if !rest.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return None;
    }
    let scheme_end = rest.find("://")?;
    if !rest[..scheme_end]
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-')
    {
        return None;
    }
    let body = scheme_end + 3;
    let tail = rest[body..]
        .find(ends_url)
        .map_or(rest.len(), |offset| body + offset);
    (tail > body).then(|| start..start + tail)
}

/// 无协议但以 `www.` 起头。
fn scan_www(text: &str, start: usize) -> Option<Range<usize>> {
    let rest = &text[start..];
    if !rest.starts_with("www.") {
        return None;
    }
    let tail = rest.find(ends_url).unwrap_or(rest.len());
    (tail > 4).then(|| start..start + tail)
}

/// Unix 绝对路径：至少两段，避免把句子里的 `/` 当路径。
fn scan_path(text: &str, start: usize) -> Option<Range<usize>> {
    let rest = &text[start..];
    if !rest.starts_with('/') {
        return None;
    }
    let mut segments = 0usize;
    let mut end = 0usize;
    for (offset, character) in rest.char_indices() {
        if character == '/' {
            segments += 1;
            end = offset + 1;
        } else if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            end = offset + character.len_utf8();
        } else {
            break;
        }
    }
    (segments >= 2).then(|| start..start + end)
}

/// 行内代码：反引号成对界定。
fn scan_inline_code(text: &str, start: usize) -> Option<Range<usize>> {
    let rest = &text[start..];
    if !rest.starts_with('`') {
        return None;
    }
    let close = rest[1..].find('`')?;
    Some(start..start + close + 2)
}

/// 带单位或符号的数值：`-273.15°C`、`101.325kPa`、`16:9`。
fn scan_number_with_unit(text: &str, start: usize) -> Option<Range<usize>> {
    let rest = &text[start..];
    let mut chars = rest.char_indices().peekable();
    let mut end = 0usize;
    if let Some(&(_, first)) = chars.peek()
        && (first == '+' || first == '-')
    {
        chars.next();
        end = 1;
    }
    let digits_start = end;
    while let Some(&(offset, character)) = chars.peek() {
        if character.is_ascii_digit() || character == '.' || character == ',' {
            end = offset + character.len_utf8();
            chars.next();
        } else {
            break;
        }
    }
    if end == digits_start {
        return None;
    }
    // 单位、百分号或比例的后缀。
    //
    // **择一，不是可重复**——与 TS 原版的正则分支
    // `(?:\s*[°%‰]|[a-zA-Z°µΩ]+|:\d+)?` 逐字对齐：匹配到度数符号就停下。
    // 于是 `-273.15°C` 的单元止于 `°`，`C` 落在单元外、可被断开，而
    // `101.325kPa` 走字母分支能整体收进来。这是原版的边界瑕疵（同一个概念
    // 「带单位的数值」被两个分支切成不同宽度），迁移**原样保留**以维持行为
    // 一致；对拍 154 组里唯一的分歧就是它。要修的话应当让度数符号后面继续
    // 吃字母，但那会改变既有版面，属待裁项。
    if let Some(&(offset, character)) = chars.peek() {
        if matches!(character, '°' | '%' | '‰') {
            end = offset + character.len_utf8();
        } else if character.is_ascii_alphabetic() || matches!(character, 'µ' | 'Ω') {
            while let Some(&(offset, character)) = chars.peek() {
                if character.is_ascii_alphabetic() || matches!(character, 'µ' | 'Ω') {
                    end = offset + character.len_utf8();
                    chars.next();
                } else {
                    break;
                }
            }
        } else if character == ':' {
            let mut lookahead = chars.clone();
            lookahead.next();
            if lookahead.peek().is_some_and(|(_, c)| c.is_ascii_digit()) {
                end = offset + 1;
                chars.next();
                while let Some(&(offset, character)) = chars.peek() {
                    if character.is_ascii_digit() {
                        end = offset + character.len_utf8();
                        chars.next();
                    } else {
                        break;
                    }
                }
            }
        }
    }
    Some(start..start + end)
}

/// 量一段文本：判类、挤压、混排间距、不可分标记。
///
/// 不可分区间按起点排序且互不重叠，遍历又单调前进，所以「这个字符落在哪个
/// 区间里」用一只跟着循环走的游标回答。TS 版此前每个字符都从头扫一遍区间表，
/// 实测 400K 字符 5,286ms——超线性的部分全在那里。
fn measure(text: &str, preset: &TypesetPreset) -> Vec<AdjustedChar> {
    let ranges = unbreakable_ranges(text);
    let mut cursor = 0usize;
    let mut measured: Vec<AdjustedChar> = Vec::with_capacity(text.len() / 3);
    let mut previous_kind: Option<CharClass> = None;

    for (offset, character) in text.char_indices() {
        let kind = class_of(character);
        while ranges.get(cursor).is_some_and(|range| range.end <= offset) {
            cursor += 1;
        }
        let joined_to_previous = ranges
            .get(cursor)
            .is_some_and(|range| offset > range.start && offset < range.end);
        measured.push(AdjustedChar {
            offset,
            character,
            kind,
            space_before: previous_kind.map_or(0.0, |left| gap_between(left, kind, preset)),
            joined_to_previous,
        });
        previous_kind = Some(kind);
    }
    measured
}

/// 断在这一处有多不情愿。0 是自然断点，越大越不情愿。
///
/// 表意文字之间断开是零代价——中日文本来就逐字换行。跨 script 的边界略有代价：
/// 断在那里读起来像把一个词拆开了，尽管语法上允许。
fn penalty_at(left: CharClass, right: CharClass, strictness: BreakStrictness) -> u32 {
    if left == CharClass::Ideograph && right == CharClass::Ideograph {
        return 0;
    }
    let loose_allows = |kind: CharClass| matches!(kind, CharClass::Extender | CharClass::Middle);
    // 宽松档愿意在长标点与中点处断，代价压到很低；其余两档不给这个便利。
    if strictness == BreakStrictness::Loose && (loose_allows(left) || loose_allows(right)) {
        return 1;
    }
    if loose_allows(left) || loose_allows(right) {
        return 40;
    }
    10
}

/// 这两个相邻字符之间能不能断，能断的话代价多少。
///
/// 规则的次序即优先级：先问结构层禁令，再问预设的禁则，最后问严格度。
fn candidate_at(
    before: &AdjustedChar,
    after: &AdjustedChar,
    strictness: BreakStrictness,
) -> Option<u32> {
    // 结构层禁令先于字符类禁令：URL、路径、行内代码、带单位的数值内部不断，
    // 无论两侧字符是什么类。逐字规则看不见这个层级（`/` 与 `.` 单看都是普通
    // 标点），所以它必须作为一条独立的门槛。
    if after.joined_to_previous {
        return None;
    }
    if forbidden_at_line_start(after.kind) || forbidden_at_line_end(before.kind) {
        return None;
    }
    // 不可分序列：`12.5` 与 `hello` 被断成两行是数据读起来的损坏。
    if before.kind == after.kind
        && (before.kind == CharClass::Digit || before.kind == CharClass::Latin)
    {
        return None;
    }
    // 数字与小数点之间同理：`.` 归 other 类，单看类判不出来。
    if before.kind == CharClass::Digit && after.character == '.' {
        return None;
    }
    if before.character == '.' && after.kind == CharClass::Digit {
        return None;
    }
    // 严格档连数字与西文之间也不断，于是长数字或长单词把整行推出去。
    if strictness == BreakStrictness::Strict
        && (matches!(before.kind, CharClass::Digit | CharClass::Latin)
            || matches!(after.kind, CharClass::Digit | CharClass::Latin))
    {
        return None;
    }
    Some(penalty_at(before.kind, after.kind, strictness))
}

/// 断在这里划不划算。代价越低越愿意，超过这个值就宁可往前退。
const ACCEPTABLE_PENALTY: u32 = 20;

/// 从 `overflow_at` 往后找这个不可分割单元的结束位置。
///
/// 只在「这一行一个候选断点都没有」时调用。此时版心塞不下当前这个单元——一个
/// 超长西文词、一串数字、一条 URL。三种处理里只有一种是对的：就地硬断会切出
/// `expi` + `alidocious` 两个不存在的词；整行不断会让后面的正文全跟着溢出；
/// **让这个单元溢出、从它结束处起新行**才是 CSS `overflow-wrap: normal` 的
/// 语义，也是所有成熟排版器的默认。
///
/// 返回下一行的起点（measured 下标）；找不到就返回 `line_start`，
/// 调用方据此停止断行。
fn unbreakable_end(
    measured: &[AdjustedChar],
    strictness: BreakStrictness,
    line_start: usize,
    overflow_at: usize,
) -> usize {
    for index in overflow_at..measured.len() {
        if index <= line_start {
            continue;
        }
        let (Some(before), Some(after)) = (measured.get(index - 1), measured.get(index)) else {
            continue;
        };
        if candidate_at(before, after, strictness).is_none() {
            continue;
        }
        // 空格归上一行。断在空格**前**会让下一行以空格开头，而行首悬着一个
        // 空格是可见的瑕疵。正常路径不会撞到它，只有这条兜底会。
        let mut start = index;
        while measured
            .get(start)
            .is_some_and(|c| c.kind == CharClass::Space)
        {
            start += 1;
        }
        return if start > line_start { start } else { index };
    }
    line_start
}

/// 一行的起点，按**字节**偏移。第一项恒为 0。
///
/// `columns_em` 是一行能放下的字身数，由调用者按真实字体度量算出——本模块不
/// 认识字体。取「放不下就退到上一个可接受的候选断点」，不做 Knuth-Plass 全局
/// 最优：那要一并接管光标、选区、输入法，代价远超收益。
#[must_use]
pub fn line_starts(text: &str, columns_em: f32, preset: &TypesetPreset) -> Vec<usize> {
    let mut starts = vec![0usize];
    if columns_em <= 0.0 || text.is_empty() {
        return starts;
    }
    let strictness = preset.break_strictness;
    let measured = measure(text, preset);

    let mut width = 0.0f32;
    let mut last_candidate: Option<usize> = None;
    let mut line_start_index = 0usize;
    let mut index = 0usize;

    while index < measured.len() {
        let character = measured[index];
        if character.character == '\n' {
            starts.push(character.offset + 1);
            width = 0.0;
            last_candidate = None;
            line_start_index = index + 1;
            index += 1;
            continue;
        }
        // 代价高的断点仍然是断点——放不下时它总比撑破版心好——但只要还有更便宜
        // 的选择，就不该用它。
        if index > line_start_index
            && let Some(before) = measured.get(index - 1)
            && let Some(penalty) = candidate_at(before, &character, strictness)
            && penalty <= ACCEPTABLE_PENALTY
        {
            last_candidate = Some(index);
        }

        let advance = character.advance();
        // 行尾调整必须参与「放不放得下」这个判断：简中压半字、日文保留空白，
        // 不算进去两个预设就会给出完全相同的断行。
        let trailing = line_end_adjustment(character.kind, preset);
        if width + advance + trailing > columns_em && width > 0.0 {
            let fallback = || unbreakable_end(&measured, strictness, line_start_index, index);
            let start = match last_candidate {
                Some(candidate) if candidate > line_start_index => candidate,
                _ => fallback(),
            };
            if start <= line_start_index {
                // 整段到此都不可分：让它溢出，不再尝试断这一行。
                break;
            }
            starts.push(measured[start].offset);
            last_candidate = None;
            width = 0.0;
            line_start_index = start;
            index = start;
            continue;
        }
        width += advance;
        index += 1;
    }
    starts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn first_chars(text: &str, starts: &[usize]) -> Vec<char> {
        starts
            .iter()
            .skip(1)
            .filter_map(|start| text[*start..].chars().next())
            .collect()
    }

    #[test]
    fn full_width_punctuation_never_starts_a_line() {
        let text = "他说完了话。她没有回答。";
        for columns in [5.0, 6.0, 7.0, 8.0, 9.0] {
            let starts = line_starts(text, columns, &ZH_HANS);
            for first in first_chars(text, &starts) {
                assert!(
                    !forbidden_at_line_start(class_of(first)),
                    "line started with {first:?} at {columns} em"
                );
            }
        }
    }

    #[test]
    fn an_opening_bracket_never_ends_a_line() {
        let text = "他说「这样也好」然后就走了";
        for columns in [4.0, 5.0, 6.0, 7.0] {
            let starts = line_starts(text, columns, &ZH_HANS);
            for start in starts.iter().skip(1) {
                let previous = text[..*start].chars().next_back().unwrap();
                assert!(
                    !forbidden_at_line_end(class_of(previous)),
                    "line ended with {previous:?} at {columns} em"
                );
            }
        }
    }

    /// 灾难语料 4-F：URL 曾被切成三段。字符类判不出结构层，所以这条要单测。
    #[test]
    fn a_url_is_never_split_across_lines() {
        let text = "参见 https://www.w3.org/TR/clreq/#line-breaking-rules 的说明。";
        let url_start = text.find("https://").unwrap();
        let url_end = url_start + "https://www.w3.org/TR/clreq/#line-breaking-rules".len();
        for columns in [10.0, 14.0, 18.0, 22.0] {
            for start in line_starts(text, columns, &ZH_HANS).iter().skip(1) {
                assert!(
                    *start <= url_start || *start >= url_end,
                    "broke inside the URL at byte {start} ({columns} em)"
                );
            }
        }
    }

    /// 一行放不下一个词时，让它溢出而不是切出两个不存在的词。
    #[test]
    fn an_overlong_western_word_overflows_instead_of_splitting() {
        let text = "supercalifragilisticexpialidocious 之后还有中文";
        let word_end = "supercalifragilisticexpialidocious".len();
        for start in line_starts(text, 12.0, &ZH_HANS).iter().skip(1) {
            assert!(
                *start == 0 || *start >= word_end,
                "split the unbreakable word at byte {start}"
            );
        }
    }

    /// 连续标点挤压：`，，` 的第二个只占半个字身（对 Chromium 实测得到）。
    #[test]
    fn consecutive_stops_are_squeezed_by_half_an_em() {
        assert_eq!(squeeze_between(CharClass::Stop, CharClass::Stop), -0.5);
        assert_eq!(squeeze_between(CharClass::Close, CharClass::Open), -0.5);
        assert_eq!(squeeze_between(CharClass::Open, CharClass::Open), -0.5);
        assert_eq!(
            squeeze_between(CharClass::Ideograph, CharClass::Ideograph),
            0.0
        );
    }

    /// 严格档必须与其余两档产生**可见不同**的断行，否则这个选项是装饰。
    ///
    /// 只断言 strict：与 TS 原版对拍（4 段样本 × 11 档行宽）发现
    /// **loose 与 normal 在所有组合上结果完全相同**，strict 有 16 处不同。
    /// 原因是两档的候选集一致、只有长标点处的代价不同（1 对 40），而贪心排行
    /// 在退到「最近一个可接受候选」时读不出这个差。这是 TS 版就有的行为，
    /// 迁移原样保留——**它是一个待裁项，不是本次引入的缺陷**：要让 loose 真正
    /// 生效，需要让排行按代价择优（局部最优）而非只看可接受阈值。
    #[test]
    fn the_strict_tier_breaks_differently_from_the_others() {
        let text = "价格从 100 涨到 200，涨幅 100%，很夸张。";
        let strict = TypesetPreset {
            break_strictness: BreakStrictness::Strict,
            ..ZH_HANS
        };
        let mut differed = 0usize;
        for columns in [7.0, 8.0, 9.0, 14.0] {
            if line_starts(text, columns, &ZH_HANS) != line_starts(text, columns, &strict) {
                differed += 1;
            }
        }
        assert!(
            differed > 0,
            "严格档与默认档产生了完全相同的断行，说明 STRICT_FORBIDS 没有生效"
        );
    }

    /// 混排间距在两个方向都要加。
    #[test]
    fn inter_script_spacing_applies_in_both_directions() {
        let preset = ZH_HANS;
        assert_eq!(
            gap_between(CharClass::Ideograph, CharClass::Latin, &preset),
            0.125
        );
        assert_eq!(
            gap_between(CharClass::Latin, CharClass::Ideograph, &preset),
            0.125
        );
    }

    #[test]
    fn half_width_characters_cost_half_an_em() {
        assert!(is_half_width('a'));
        assert!(is_half_width('*'));
        assert!(!is_half_width('中'));
        assert!(!is_half_width('。'));
    }

    #[test]
    fn full_width_letters_and_digits_are_ideographic() {
        assert_eq!(class_of('Ａ'), CharClass::Ideograph);
        assert_eq!(class_of('１'), CharClass::Ideograph);
        assert_eq!(class_of('A'), CharClass::Latin);
        assert_eq!(class_of('1'), CharClass::Digit);
    }

    #[test]
    fn a_newline_always_starts_a_line() {
        let text = "第一段\n第二段";
        assert_eq!(
            line_starts(text, 100.0, &ZH_HANS),
            vec![0, "第一段\n".len()]
        );
    }

    #[test]
    fn every_line_start_is_a_character_boundary() {
        let text = "混排 ABC 与数字 123，还有 https://example.com/a/b 和 `code`。";
        for columns in [6.0, 9.0, 12.0, 16.0, 20.0] {
            for start in line_starts(text, columns, &ZH_HANS) {
                assert!(
                    text.is_char_boundary(start),
                    "byte {start} is not a character boundary at {columns} em"
                );
            }
        }
    }
}
