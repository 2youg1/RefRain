// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 一份稿子上「哪一段」的三个问题：请求当初框了什么、它现在在哪、
//! 以及界面能拿什么来指名一段。
//!
//! 派发出去的那一刻，请求里写下了每个范围的原文。结果回来时要回答两个问题：
//! 请求当初给出的是哪几段原文，以及这几段原文现在还在稿子的什么位置。两个问题
//! 都只读文本，不碰数据库，也不认识 host——所以它们在这里，可以被单独问清楚。
//!
//! 第三个问题是派发台的：作者要勾选范围，就得先看见一份可指名的块清单。
//! 清单与定位在同一个模块，因为它们说的是同一件事——**块 id 只在打开着的
//! 那份稿子上成立**。界面按清单里的 id 指名范围，不自己猜切法。

use refrain_core::block_shape::{BlockKind, BlockShape};
use refrain_core::{BlockScan, ErrorCode, Id, Manuscript, RefrainError};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::root::ProjectEntry;

/// 块清单的一行：派发台块段按 `id` 指名范围。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocumentBlockRow {
    /// 块 id（36 字节 uuid）。
    pub id: String,
    /// 第几块，从 0 起。
    pub ordinal: u32,
    /// 块种类线名，与索引库存的是同一个（`heading:N`／`fence`／`table`／
    /// `paragraph`），由 `BlockKind::wire_name` 唯一决定。
    pub kind: String,
    /// 前 60 个字符的行预览（char 边界安全），不是截断的正文。
    pub peek: String,
    /// 正文的字符数。
    pub chars: u32,
}

/// 一份稿子的块清单，分页给出。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocumentBlocks {
    pub blocks: Vec<DocumentBlockRow>,
    /// 还有剩余时，下一页从这个 ordinal 起（本页末行 ordinal+1）。
    pub next: Option<u32>,
}

/// 一份打开着的稿子的块清单，按 ordinal 分页。
///
/// 列的是**活 Manuscript**（正在写的那份），不是磁盘字节：磁盘那份可能已经
/// 被别处改过，而块 id 只在打开着的稿子上成立（与派发同一条理由）。空块也
/// 在行里——清单的职责是让界面能按 id 指名任何一个块，与搜索索引「空块不
/// 占行」的取舍不同。
///
/// `after` 是上一页 `next` 给出的游标：下一页**从它起（含）**；`next` 只在
/// 还有剩余时给出。`count` 夹到 1..=100。
///
/// # Errors
///
/// 稿子没打开时具名拒绝，而不是拿磁盘上的字节顶替。
pub fn list_blocks(
    entry: &ProjectEntry,
    path: &str,
    after: Option<u32>,
    count: u32,
) -> Result<DocumentBlocks, RefrainError> {
    let manuscript = entry.manuscripts.get(path).ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "list blocks of a document that is not open",
            path.to_owned(),
        )
    })?;
    let count = count.clamp(1, 100) as usize;
    let scan = manuscript.scan();
    let blocks = manuscript.head().blocks();
    // 翻页游标是「从这里起（含）」，所以迭代也从那里起。
    //
    // 旧写法从 0 起走全部块、靠 `continue` 跳过游标之前的那些，于是翻到
    // 第 n 页要走过前面 n 页的每一块；翻完一篇是 O(n²)。`skip` 在 `Blocks`
    // 上同样是逐个前进，所以起点用 `get` 直接寻：一次下降一个块，与这一页
    // 要画的行数成正比，与它前面有多少块无关。
    let start = after.unwrap_or(0) as usize;
    let mut rows: Vec<DocumentBlockRow> = Vec::with_capacity(count);
    for offset in 0..count {
        let Some(ordinal) = start.checked_add(offset) else {
            break;
        };
        let Some(block) = blocks.get(ordinal) else {
            break;
        };
        let text = block.text();
        rows.push(DocumentBlockRow {
            id: block.id().to_string(),
            ordinal: ordinal as u32,
            kind: block_kind_wire_name(scan, text),
            // 前 60 个字符：按 char 取，永远不会截在半个字上。
            peek: text.chars().take(60).collect(),
            chars: text.chars().count() as u32,
        });
    }
    // 还有剩余时，下一页从本页末行的下一个 ordinal 起。空页没有下一页。
    let next = rows
        .last()
        .and_then(|last| (last.ordinal as usize + 1 < blocks.len()).then_some(last.ordinal + 1));
    Ok(DocumentBlocks { blocks: rows, next })
}

/// 这一块的线名：Markdown 扫描按字节判形状，Plain 扫描下一切是段落。
///
/// 词汇的唯一权威是 `BlockKind::wire_name`——`#`、栅栏、表格行在 Plain
/// 扫描下都是文字，所以判形状这一步归这里，命名那一步归 L0。判法与
/// `searchable_block` 是同一条规则。
fn block_kind_wire_name(scan: BlockScan, text: &str) -> String {
    match scan {
        BlockScan::Markdown => BlockShape::of(text).kind,
        BlockScan::Plain => BlockKind::Paragraph,
    }
    .wire_name()
}

/// 冻结请求里 `# Before` 那一节列出的范围：范围 id 与它当初的原文。
///
/// 只认这一节。结果文件自己声称改了什么不作数——契约来自生产者当初读到的字节
/// （SPEC 8.4）。
#[must_use]
pub fn before_sections(request: &str) -> Vec<(String, String)> {
    let Some(after_heading) = request.split("# Before").nth(1) else {
        return vec![];
    };
    let section = after_heading.split("\n# ").next().unwrap_or(after_heading);
    let mut out = Vec::new();
    for chunk in section.split("<!-- scope ").skip(1) {
        let Some((id, rest)) = chunk.split_once(" -->") else {
            continue;
        };
        let text = rest
            .strip_prefix('\n')
            .unwrap_or(rest)
            // 编译器的合同尾巴从这一行开始（`context_compiler::round_contract`，
            // D14 把它并入 before 段以保住缓存前缀）：它不是冻结原文，收进去
            // 会让「原文对不上」——块文本比对必挂。解析器与编译器是一对，
            // 改合同行文必须同步这里（near-miss：删掉这行截断，k3_full_flow
            // 立即红）。
            .split("\n- Use the scope ids")
            .next()
            .unwrap_or(rest)
            .trim_end_matches('\n')
            .to_string();
        out.push((id.trim().to_string(), text));
    }
    out
}

/// 冻结原文在当前稿子里的定位结果。
///
/// 用枚举而不是 `Option`，是因为「找不到」与「找到好几处」是两件不同的事实，
/// 作者要做的也是两件不同的事：前者是他改过那一段，后者是这段文字在文中重复，
/// 而定位只按内容做时无从分辨。压成一个 `None` 会让调用方只能报一种原因，
/// 于是重复段落的失败会被当成「作者改过」——那是一句假话。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScopeLocation {
    /// 恰好一处。这是唯一可以据以落地的结果。
    Unique(Vec<Id>),
    /// 冻结原文在这份稿子里一处也没有：作者动过它。
    Moved,
    /// 冻结原文出现多处，逐字都相同。
    ///
    /// 携带全部候选，因为只有作者知道他当初框的是哪一处。默认选第一处曾经是
    /// 这里的行为，实测会把提案落在另一段上（审计 F-02）。
    Ambiguous(Vec<Vec<Id>>),
}

/// 找出哪一段连续的块，其正文恰好就是冻结下来的那段原文。
///
/// 逐字节相同才算找到：作者若在派发之后动过这一段，这里就找不到，于是这一路
/// 会诚实地失败，而不是把提案套在它从未读过的文本上。
///
/// **重复的原文不选第一处。** 副歌、`}`、空行这样的文本在同一份文件里反复出现，
/// 而按内容定位无从分辨它们。本仓库实测：散文 3.4% 的块有逐字相同的同伴，
/// 代码 30.2%（96.1% 的文件至少含一处），配置 52.6%。在这种分布上「默认第一处」
/// 不是一个边角取舍，它是把改错段做成常态。所以多处匹配返回全部候选，由作者定。
///
/// 实现上不逐个起点重新拼接——那样每个起点都要把后续块再拷一遍，一章上千块时
/// 是平方级的分配。改为一次线性扫描：块之间用这份稿子自己的分隔符相连（散文
/// 两个换行、纯文本一个），于是每个块在拼接后的全文里都有一个确定的起始偏移；
/// 把冻结原文当作一个待匹配串，只在「原文长度恰好落在某个块的末尾」处比较一次。
#[must_use]
pub fn locate_scope(manuscript: &Manuscript, before: &str) -> ScopeLocation {
    let blocks = manuscript.head().blocks();
    // Blocks join with the manuscript's own separator: two newlines in prose,
    // one in plain text. A scope read that joins with the wrong separator
    // compares against bytes the document never had, and every scope misses.
    let join = manuscript.scan().separator();

    // 每个块在拼接全文里的起始偏移。ends[i] 是第 i 块结束处的偏移。
    let mut starts = Vec::with_capacity(blocks.len());
    let mut ends = Vec::with_capacity(blocks.len());
    let mut cursor = 0usize;
    for block in blocks.iter() {
        starts.push(cursor);
        cursor += block.text().len();
        ends.push(cursor);
        cursor += join.len();
    }

    let mut found: Vec<Vec<Id>> = Vec::new();
    for (start_index, &start) in starts.iter().enumerate() {
        let finish = start + before.len();
        // 冻结原文必须正好在某个块的末尾结束，否则它跨在块中间，不是一个范围。
        // ends 单调递增而 finish >= start，所以命中的下标必然不小于 start_index；
        // 注入实验证实过：加一条 end_index < start_index 的守卫删掉也没有任何测试
        // 变红，那是一条永远为真的检查，留着只会让读者以为这里有别的可能。
        let Ok(end_index) = ends.binary_search(&finish) else {
            continue;
        };
        if joined_equals(blocks, start_index, end_index, before, join) {
            found.push(
                blocks
                    .iter()
                    .skip(start_index)
                    .take(end_index - start_index + 1)
                    .map(refrain_core::Block::id)
                    .collect(),
            );
        }
    }

    // 扫描不提前退出：要判断唯一，就必须看完。多花的是一次线性扫描，
    // 换来的是「唯一」这个词名副其实。
    match found.len() {
        0 => ScopeLocation::Moved,
        1 => ScopeLocation::Unique(found.remove(0)),
        _ => ScopeLocation::Ambiguous(found),
    }
}

/// 冻结请求当初绑定的那几个块，现在还在不在这份稿子里。
///
/// 这是「按身份寻址」：派发时作者选中的块 id 已经是一个事实，把它带到收取时
/// 用，定位就不再依赖文本内容。内容寻址的正确率随重复率下降（本仓库实测代码
/// 文件 30.2% 的块有逐字相同的同伴），身份寻址不受影响——两段一模一样的文字
/// 仍然是两个不同的块。
///
/// 返回值只回答「这几个块是否仍然连续地存在」。**它不检查文本有没有变**：
/// 那是调用方的事，而且两种失败要说不同的话——块没了是作者删了它，块还在但
/// 字节变了是作者改了它，作者要做的事不一样。
#[must_use]
pub fn locate_scope_by_identity(manuscript: &Manuscript, blocks: &[Id]) -> Option<Vec<Id>> {
    if blocks.is_empty() {
        return None;
    }
    let present = manuscript.head().blocks();
    let mut positions = Vec::with_capacity(blocks.len());
    for wanted in blocks {
        let position = present.iter().position(|block| block.id() == *wanted)?;
        positions.push(position);
    }
    // 必须仍然连续且保持原序：一个 Edit Scope 是一段连续的正文，中间被插进
    // 新段落后，把首尾之间的新内容一并替换掉是作者没有要求的事。
    if positions.windows(2).any(|pair| pair[1] != pair[0] + 1) {
        return None;
    }
    Some(blocks.to_vec())
}

/// 比较 `[from, to]` 这几块连起来是否逐字节等于 `expected`，不做任何分配。
fn joined_equals(
    blocks: &refrain_core::BlockSequence,
    from: usize,
    to: usize,
    expected: &str,
    join: &str,
) -> bool {
    let mut rest = expected.as_bytes();
    for index in from..=to {
        if index > from {
            let Some(tail) = rest.strip_prefix(join.as_bytes()) else {
                return false;
            };
            rest = tail;
        }
        let text = blocks[index].text().as_bytes();
        let Some(tail) = rest.strip_prefix(text) else {
            return false;
        };
        rest = tail;
    }
    rest.is_empty()
}
