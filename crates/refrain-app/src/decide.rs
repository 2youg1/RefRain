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
use refrain_core::{ErrorCode, Id, Manuscript, RefrainError, TextCommand, TextTransition};
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

    let base = manuscript.head().id();
    let transition = manuscript
        .execute(TextCommand::CommitDecisionBatch(DecisionBatch::new(
            base, proposals, verdicts,
        )))
        .map_err(|error| {
            RefrainError::new(ErrorCode::Io, "commit a decision batch", path.to_owned())
                .with_detail(error.to_string())
        })?;

    // 批次与游标清空；候选留着供审计（SPEC 7.4）。
    store
        .review_session_set(path, 0, "[]")
        .map_err(into_domain)?;
    Ok(transition)
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
