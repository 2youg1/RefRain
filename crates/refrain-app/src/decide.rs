//! 把暂存的裁决落成一次 Text Action（SPEC 7.4）。
//!
//! 这条流程的重量在「从存储行重建裁决」：账本里存的是行——proposal id、
//! slice id、裁决种类、修改后的正文——而领域要的是 `Verdict`，它必须绑定到
//! 一个真实存在的 `Proposal` 与一个格式正确的 `ReviewSliceId`。中间每一步都
//! 可能对不上，而每一种对不上都是产品要讲清的事实。
//!
//! 它此前是 `lib.rs` 里一个 129 行的命令体，这些重建规则只能靠开一个 Tauri
//! 窗口来验证。

use std::collections::HashMap;

use refrain_core::manuscript::{DecisionBatch, Proposal, ReviewSliceId, Verdict, VerdictKind};
use refrain_core::{
    ErrorCode, Id, Manuscript, RecoveryStep, RefrainError, TextCommand, TextRefusal, TextTransition,
};
use refrain_store::ledger::{VerdictKindName, VerdictRecord};
use refrain_store::project::ProjectStore;

use crate::journal::into_domain;

/// 提交一份暂存的裁决批次。
///
/// `manuscript` 是这份文稿当前打开的那一份——裁决落地要改它的文本，块 id 也只
/// 在它身上成立。
///
/// # Errors
///
/// 批次为空、账本行与当前提案对不上、slice id 格式不对、修改型裁决缺少正文，
/// 都在这里拒绝并说明是哪一行。
pub fn commit_decision_batch(
    store: &mut ProjectStore,
    manuscript: &mut Manuscript,
    path: &str,
) -> Result<TextTransition, RefrainError> {
    let batch_ids = staged_batch(store, path)?;
    let rows = store
        .ledger()
        .find_many(&batch_ids)
        .map_err(crate::journal::into_domain_store)?;

    let proposals = store
        .proposals_for(path)
        .map_err(into_domain)?
        .iter()
        .map(crate::review::rebuild_proposal)
        .collect::<Result<Vec<_>, _>>()?;
    let proposal_at: HashMap<Id, &Proposal> = proposals
        .iter()
        .map(|proposal| (proposal.id(), proposal))
        .collect();

    let verdicts = rows
        .iter()
        .map(|row| verdict_of(row, &proposal_at))
        .collect::<Result<Vec<_>, _>>()?;

    // 冻结文本按 id 留一份：提案随即被 move 进批次，而拒绝时要把 Agent
    // 当时读到的原文交还给作者。
    let frozen: HashMap<Id, String> = proposals
        .iter()
        .map(|proposal| (proposal.id(), proposal.before().to_string()))
        .collect();

    let base = manuscript.head().id();
    let transition = manuscript
        .execute(TextCommand::CommitDecisionBatch(DecisionBatch::new(
            base, proposals, verdicts,
        )))
        .map_err(|error| stale_or_io(error, path, &frozen))?;

    // 批次与游标清空；候选留着供审计（SPEC 7.4）。
    store
        .review_session_set(path, 0, "[]")
        .map_err(into_domain)?;
    Ok(transition)
}

/// 把领域的拒绝翻译成作者能行动的错误。
///
/// 「提案过期」不是一次 I/O 失败，它是作者自己改了那一段——把它压成
/// `ErrorCode::Io` 加一句英文，作者看到的是读不懂的技术消息，而他其实
/// 是唯一知道该怎么办的人。
///
/// **`detail` 带上 Agent 当时读到的原文**（SPEC 7.4 与「四区·边缘情况 3」）：
/// 默默套用是丢作者的字，直接丢弃是丢 Agent 的活，两者都不能替他决定。
/// 恢复步骤给的是「对照冻结原文」与「按现状重发」，因为除了他没人能判断
/// 那条建议对现在的文本还成不成立。
fn stale_or_io(error: TextRefusal, path: &str, frozen: &HashMap<Id, String>) -> RefrainError {
    if let TextRefusal::StaleProposal { proposal } = error {
        let failure = RefrainError::new(
            ErrorCode::StaleProposal,
            "commit a decision batch",
            path.to_owned(),
        )
        .with_recovery(vec![
            RecoveryStep::CompareWithFrozenText,
            RecoveryStep::SendAgain,
        ]);
        return match frozen.get(&proposal) {
            Some(before) => failure.with_detail(before.clone()),
            // 查不到冻结文本是个软件缺陷，不是作者的处境：批次里的每个
            // 提案都来自上面那张表。如实说出来，别假装有原文可看。
            None => failure
                .with_detail(format!("proposal {proposal} has no frozen text"))
                .with_recovery(vec![RecoveryStep::ReportDefect]),
        };
    }
    RefrainError::new(ErrorCode::Io, "commit a decision batch", path.to_owned())
        .with_detail(error.to_string())
}

/// 读出暂存的批次，空批次在这里就拒绝。
fn staged_batch(store: &ProjectStore, path: &str) -> Result<Vec<String>, RefrainError> {
    let empty = || {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "commit an empty batch",
            path.to_owned(),
        )
    };

    let (_cursor, batch_json) = store
        .review_session_get(path)
        .map_err(into_domain)?
        .ok_or_else(empty)?;
    let ids: Vec<String> = serde_json::from_str(&batch_json).map_err(|error| {
        RefrainError::new(ErrorCode::StateUnavailable, "read a batch", path.to_owned())
            .with_detail(error.to_string())
    })?;
    if ids.is_empty() {
        return Err(empty());
    }
    Ok(ids)
}

/// 把还在批次里的裁决退回未读：批次与账本同时移除。
///
/// 只认批次里的 id——批次在提交时清空，所以「在批次里」就是「尚未合并进
/// 正文」唯一可靠的证据。不在批次里的裁决可能已经落地，删它会同时毁掉
/// 审计与事实，那条路（撤销合并）需要按冻结原文反向落地，不在这里。
pub fn revert_verdicts(
    store: &mut ProjectStore,
    path: &str,
    verdict_ids: &[String],
) -> Result<usize, RefrainError> {
    let (cursor, batch_json) = store
        .review_session_get(path)
        .map_err(into_domain)?
        .unwrap_or((0, "[]".to_string()));
    let batch: Vec<String> = serde_json::from_str(&batch_json).map_err(|error| {
        RefrainError::new(ErrorCode::StateUnavailable, "read a batch", path.to_owned())
            .with_detail(error.to_string())
    })?;
    let staged: std::collections::HashSet<&str> = batch.iter().map(String::as_str).collect();
    let outside: Vec<&str> = verdict_ids
        .iter()
        .map(String::as_str)
        .filter(|id| !staged.contains(id))
        .collect();
    if !outside.is_empty() {
        return Err(RefrainError::new(
            ErrorCode::StateUnavailable,
            "recall a verdict that already left the batch",
            path.to_owned(),
        )
        .with_detail(format!("not in the staged batch: {}", outside.join(", "))));
    }

    let kept: Vec<&String> = batch
        .iter()
        .filter(|id| !verdict_ids.contains(id))
        .collect();
    store
        .review_session_set(
            path,
            cursor,
            &serde_json::to_string(&kept).unwrap_or_else(|_| "[]".to_string()),
        )
        .map_err(into_domain)?;
    store
        .ledger()
        .forget(verdict_ids)
        .map_err(crate::journal::into_domain_store)
}

/// 把账本里的一行重建成一个绑定到真实提案的裁决。
fn verdict_of(
    row: &VerdictRecord,
    proposal_at: &HashMap<Id, &Proposal>,
) -> Result<Verdict, RefrainError> {
    let proposal_id = crate::journal::parse_id(&row.proposal_id, "verdict proposal")?;
    let proposal = proposal_at.get(&proposal_id).ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "judge a candidate that is not here",
            row.proposal_id.clone(),
        )
    })?;

    let kind = match row.kind {
        VerdictKindName::Accept => VerdictKind::Accept,
        // 修改型裁决的正文就是作者写下的那句话；没有它，这条裁决无从落地。
        VerdictKindName::AcceptModified => {
            VerdictKind::AcceptModified(row.final_text.clone().ok_or_else(|| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "apply a modified verdict without its final text",
                    row.id.clone(),
                )
            })?)
        }
        VerdictKindName::Reject => VerdictKind::Reject,
        VerdictKindName::CommentOnly => VerdictKind::CommentOnly,
    };

    Verdict::new(proposal, slice_of(&row.slice_id)?, kind, row.reason.clone()).map_err(|error| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "rebuild a verdict",
            row.id.clone(),
        )
        .with_detail(error.to_string())
    })
}

/// slice id 的写法是 `<proposal uuid>:<序号>`。
fn slice_of(raw: &str) -> Result<ReviewSliceId, RefrainError> {
    let (proposal, ordinal) = raw.rsplit_once(':').ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "read a slice id",
            raw.to_owned(),
        )
    })?;
    let ordinal = ordinal.parse::<u32>().map_err(|error| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "read a slice ordinal",
            raw.to_owned(),
        )
        .with_detail(error.to_string())
    })?;
    Ok(ReviewSliceId::new(
        crate::journal::parse_id(proposal, "slice proposal")?,
        ordinal,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 提案过期不是一次 I/O 失败。
    ///
    /// 它此前被压成 `ErrorCode::Io` 加一句英文技术文本，而作者是唯一知道
    /// 该怎么办的人——那一段是他自己改的。这几条钉住他拿得到的东西。
    #[test]
    fn a_stale_proposal_hands_back_the_text_the_agent_read() {
        let proposal = Id::new();
        let mut frozen = HashMap::new();
        frozen.insert(proposal, "原来的第二句话。".to_owned());

        let failure = stale_or_io(
            TextRefusal::StaleProposal { proposal },
            "第三章.md",
            &frozen,
        );

        assert_eq!(failure.code, ErrorCode::StaleProposal);
        // 冻结原文是整件事的核心：没有它，「过期了」只是一句无从行动的通知。
        assert_eq!(failure.detail.as_deref(), Some("原来的第二句话。"));
        // 两条路都给，不替他选。
        assert_eq!(
            failure.recovery,
            vec![RecoveryStep::CompareWithFrozenText, RecoveryStep::SendAgain]
        );
    }

    #[test]
    fn a_missing_frozen_text_is_reported_as_our_defect_not_the_authors_problem() {
        // 批次里的每个提案都来自那张表，取不到是软件缺陷。如实说出来，
        // 而不是假装有原文可看——给一条对照不存在文本的出路更糟。
        let failure = stale_or_io(
            TextRefusal::StaleProposal {
                proposal: Id::new(),
            },
            "第三章.md",
            &HashMap::new(),
        );

        assert_eq!(failure.code, ErrorCode::StaleProposal);
        assert_eq!(failure.recovery, vec![RecoveryStep::ReportDefect]);
    }

    #[test]
    fn other_refusals_stay_io() {
        // 只认过期这一种。别的失败该由懂它的地方去说，硬认会让它们说错话。
        let failure = stale_or_io(
            TextRefusal::OverlappingScopes { block: Id::new() },
            "第三章.md",
            &HashMap::new(),
        );
        assert_eq!(failure.code, ErrorCode::Io);
    }
}
