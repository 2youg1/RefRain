//! 冻结请求与当前稿子之间的对照。
//!
//! 派发出去的那一刻，请求里写下了每个范围的原文。结果回来时要回答两个问题：
//! 请求当初给出的是哪几段原文，以及这几段原文现在还在稿子的什么位置。两个问题
//! 都只读文本，不碰数据库，也不认识 host——所以它们在这里，可以被单独问清楚。

use refrain_core::{Id, Manuscript};

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
            .trim_end_matches('\n')
            .to_string();
        out.push((id.trim().to_string(), text));
    }
    out
}

/// 找出哪一段连续的块，其正文恰好就是冻结下来的那段原文。
///
/// 逐字节相同才算找到：作者若在派发之后动过这一段，这里就找不到，于是这一路
/// 会诚实地失败，而不是把提案套在它从未读过的文本上。
///
/// 实现上不逐个起点重新拼接——那样每个起点都要把后续块再拷一遍，一章上千块时
/// 是平方级的分配。改为一次线性扫描：块之间用这份稿子自己的分隔符相连（散文
/// 两个换行、纯文本一个），于是每个块在拼接后的全文里都有一个确定的起始偏移；
/// 把冻结原文当作一个待匹配串，只在「原文长度恰好落在某个块的末尾」处比较一次。
#[must_use]
pub fn find_scope_blocks(manuscript: &Manuscript, before: &str) -> Option<Vec<Id>> {
    let blocks = manuscript.head().blocks();
    // Blocks join with the manuscript's own separator: two newlines in prose,
    // one in plain text. A scope read that joins with the wrong separator
    // compares against bytes the document never had, and every scope misses.
    let join = std::str::from_utf8(manuscript.scan().separator()).expect("separators are ASCII");

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
            return Some(
                blocks
                    .iter()
                    .skip(start_index)
                    .take(end_index - start_index + 1)
                    .map(refrain_core::Block::id)
                    .collect(),
            );
        }
    }
    None
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
