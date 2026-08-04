//! 一份稿子改过什么，以及作者在上面留了什么。
//!
//! # 为什么这两件事在一个模块里
//!
//! 它们回答同一个问题的两半：**这份稿子经历过什么**。历史是「谁改的、
//! 什么时候、还在不在」，批注是「作者当时想说什么」。两者都按文档取，
//! 都只读，都要把存储层的行翻成界面画得出的样子。
//!
//! # 这一层做的事
//!
//! 存储层的行带的是领域事实（`Id`、毫秒时间戳、`AnnotationKind`）。
//! 界面要的是**已经判好的东西**：这一条是不是已撤销、这条批注是高亮
//! 还是评论。把判断留给界面，就会出现两个地方各判一次而结论不同。
//!
//! 时间不在这里格式化。「三分钟前」要一个当前时刻，而那属于渲染的那
//! 一刻，不属于读取——在这里算，作者放着不动十分钟，界面上仍写着
//! 「三分钟前」。

use refrain_core::{ErrorCode, Id, Manuscript, RefrainError};
use refrain_store::annotations::{AnnotationKind, AnnotationRow};
use refrain_store::project::ProjectStore;

use crate::journal::{into_domain, into_domain_read};
use crate::scope::{ScopeLocation, locate_scope};

/// 历史面板一次读多少行。
///
/// 作者要看的是「我最近改了什么」，不是整部改动史——一份写了半年的稿子
/// 有上万条记录，而其中有意义的永远是最近那些。
const HISTORY_PAGE: u32 = 50;

/// 一条改动记录在界面上的样子。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    /// 这条记录的稳定身份。
    pub id: String,
    /// 第几次改动，从 1 开始。作者据此说「回到第 12 步」。
    pub ordinal: u32,
    /// 这次改动因何发生：作者自己打的字，还是一次裁决落盘。
    pub cause: String,
    /// 毫秒时间戳。**不在这里格式化**——「三分钟前」要一个当前时刻，
    /// 而那属于渲染的那一刻。
    pub at: u64,
    /// 这一条已经被撤销了吗。
    ///
    /// 已撤销的行仍然显示：它们是作者做过的事，从列表里消失会让他以为
    /// 自己记错了。灰掉而不是删掉。
    pub undone: bool,
}

/// 一条批注在界面上的样子。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationView {
    pub id: String,
    /// 批注挂在哪个块上。块身份稳定，所以作者改了别处它不会漂走。
    pub block_id: String,
    /// 当时被标记的那段原文。
    ///
    /// 存下来而不是每次从稿子里取：作者改过那一段之后，原文就取不到了，
    /// 而一条指着已消失文本的批注仍然要说得出它当初标的是什么。
    pub quote: String,
    /// 高亮还是评论。
    pub comment: bool,
    /// 评论的正文。高亮没有它。
    pub body: String,
}

/// 一份文档最近改过什么，最近的在前。
pub fn recent_history(
    store: &ProjectStore,
    document: &str,
) -> Result<Vec<HistoryEntry>, RefrainError> {
    let rows = store
        .action_history()
        .list_recent(document, HISTORY_PAGE)
        .map_err(into_domain_read("read what this document has changed"))?;
    Ok(rows
        .into_iter()
        .map(|row| HistoryEntry {
            id: row.id.to_string(),
            ordinal: row.ordinal,
            cause: row.cause,
            at: row.created_at,
            undone: row.undone,
        })
        .collect())
}

/// 一份文档上的批注。
pub fn annotations_of(
    store: &ProjectStore,
    document: &str,
) -> Result<Vec<AnnotationView>, RefrainError> {
    let rows = store.annotations(document).map_err(into_domain)?;
    Ok(rows
        .into_iter()
        .map(|row| AnnotationView {
            id: row.id,
            block_id: row.block_id,
            quote: row.quote,
            comment: matches!(row.kind, AnnotationKind::Comment),
            // 高亮没有正文。空串而不是省略这个字段：界面画的是一行，
            // 而一行里少一个可选值会让两种批注的高度不一样。
            body: row.body.unwrap_or_default(),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_undone_action_stays_in_the_list_marked_rather_than_vanishing() {
        // 已撤销的行是作者做过的事。从列表里消失，他会以为自己记错了——
        // 而撤销本身是可以再撤销回来的。
        let entry = HistoryEntry {
            id: "a".to_string(),
            ordinal: 3,
            cause: "native text input".to_string(),
            at: 1,
            undone: true,
        };
        assert!(entry.undone);
        assert_eq!(entry.ordinal, 3, "an undone action keeps its place");
    }

    #[test]
    fn a_highlight_and_a_comment_are_told_apart_by_one_field() {
        // 两者在界面上是不同的行：评论有正文，高亮没有。压成一个「有没有
        // body」来判断，一条正文为空的评论就会被画成高亮。
        let highlight = AnnotationView {
            id: "h".to_string(),
            block_id: "b".to_string(),
            quote: "剑".to_string(),
            comment: false,
            body: String::new(),
        };
        let empty_comment = AnnotationView {
            comment: true,
            ..highlight.clone()
        };
        assert!(!highlight.comment);
        assert!(empty_comment.comment, "an empty comment is still a comment");
    }
}

/// 在选中的一段正文上留一条批注。
///
/// # 定位与派发同源
///
/// 界面给的是「作者框住的那段字」，不是块 id——块身份是这一层查出来的，
/// 与派发走同一条 `locate_scope`。让界面送块 id，等于要求它先知道块怎么
/// 切，而切法随文档格式变。
///
/// 重复出现的原文同样不替作者选：一条落在另一段上的批注，作者要过很久
/// 才会发现——它看起来完全正常，只是标错了地方。
///
/// # 为什么存下原文
///
/// `quote` 存的是当时被标记的那段字。作者改过那一段之后原文就取不到了，
/// 而一条指着已消失文本的批注仍然要说得出它当初标的是什么——否则作者
/// 看到的是一条没有上下文的评论。
pub fn annotate(
    store: &mut ProjectStore,
    manuscript: &Manuscript,
    document: &str,
    selected: &str,
    body: Option<String>,
    now: i64,
) -> Result<String, RefrainError> {
    if selected.trim().is_empty() {
        return Err(RefrainError::new(
            ErrorCode::StateUnavailable,
            "annotate nothing",
            "select the text to annotate first",
        ));
    }
    let blocks = match locate_scope(manuscript, selected) {
        ScopeLocation::Unique(blocks) => blocks,
        ScopeLocation::Moved => {
            return Err(RefrainError::new(
                ErrorCode::StateUnavailable,
                "annotate text that is not in this manuscript",
                selected.chars().take(20).collect::<String>(),
            ));
        }
        ScopeLocation::Ambiguous(candidates) => {
            return Err(RefrainError::new(
                ErrorCode::StateUnavailable,
                "annotate text that appears more than once",
                format!("{} places", candidates.len()),
            ));
        }
    };
    let block_id = blocks.first().copied().ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "annotate a scope with no blocks",
            document.to_string(),
        )
    })?;
    let id = Id::new().to_string();
    store
        .annotation_upsert(&AnnotationRow {
            id: id.clone(),
            document: document.to_string(),
            block_id: block_id.to_string(),
            // 偏移相对块首。跨块的批注锚在第一块上：作者标的是一段连续
            // 文字，而块边界是排版的事，不是他框选时想的事。
            start: 0,
            end: u32::try_from(selected.len()).unwrap_or(u32::MAX),
            quote: selected.to_string(),
            // 有正文就是评论，没有就是高亮。这是两者唯一的差别。
            kind: if body.is_some() {
                AnnotationKind::Comment
            } else {
                AnnotationKind::Highlight
            },
            body,
            created_at: now,
            updated_at: now,
        })
        .map_err(into_domain)?;
    Ok(id)
}
