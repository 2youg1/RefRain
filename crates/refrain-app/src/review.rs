//! 存储行与评审领域对象之间的翻译。

use refrain_core::manuscript::{EditScope, Proposal};
use refrain_core::{ErrorCode, Id, RefrainError};
use refrain_store::project::ProposalRow;

use crate::journal::parse_id;

/// 把一行提案读回领域里的 `Proposal`。
///
/// # Errors
///
/// 范围列存的是 JSON 数组；读不出或它不构成一个合法的编辑范围时，
/// 拒绝并点名是哪一条提案。
pub fn rebuild_proposal(row: &ProposalRow) -> Result<Proposal, RefrainError> {
    let unreadable = |detail: String| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "read a proposal scope",
            row.id.clone(),
        )
        .with_detail(detail)
    };

    let scope_ids: Vec<Id> =
        serde_json::from_str(&row.scope).map_err(|error| unreadable(error.to_string()))?;
    let scope = EditScope::new(scope_ids).map_err(|error| unreadable(error.to_string()))?;

    Ok(Proposal::with_id(
        parse_id(&row.id, "proposal")?,
        parse_id(&row.run, "run")?,
        parse_id(&row.baseline, "baseline")?,
        scope,
        row.before_text.clone(),
        row.after_text.clone(),
    ))
}
