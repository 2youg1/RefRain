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
