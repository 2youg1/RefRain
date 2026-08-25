//! 裁决台读什么、判什么，以及一条提案从存储行回到领域对象的路。
//!
//! # 接上哪个功能
//!
//! F9「收取、审阅、裁决」的**记账一半**。落盘那一半在 `decide`：
//! 两者分开，因为它们是作者的两个动作——逐条判断，然后一次落盘。
//!
//! # 这一层持有的不变量
//!
//! **一条提案可能要写多条账本行。** 一次改写被切成 `[Delete, Insert]` 两片，
//! 每片各要一条裁决，提交时缺任何一片都会被具名拒绝。切片由领域层
//! （`Proposal::slices()`）说了算，不是这里数出来的。
//!
//! **判过的提案不再往正文上钉印点。** 候选在提交后仍留在表里供审计
//! （SPEC 7.4），所以「还在表里」不等于「还没判」——待裁决的定义是
//! 账本里还没有这个提案的任何裁决行。
//!
//! **提案与批次一起读。** 分两次会让界面在两次答复之间画出「这条判过了」
//! 而提案已经不在的矛盾状态。

use refrain_core::manuscript::{EditScope, Proposal};
use refrain_core::{ErrorCode, Id, RefrainError, SliceKind};
use refrain_store::annotations::AnnotationKind;
use refrain_store::ledger::{VerdictKindName, VerdictRecord};
use refrain_store::project::{ProjectStore, ProposalRow};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::journal::{into_domain, into_domain_store, parse_id};
use crate::native_document::AnchorSource;
use crate::root::ProjectEntry;

/// 一条提案在裁决台上的样子。
///
/// **投影而不是把 `ProposalRow` 直接过河**：那是 store 的行，带着 run 与
/// baseline 这类界面用不上的列；给它加 serde derive 等于让存储层的形状变成
/// 跨界合同，此后每加一列都要想「界面会不会看见」。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProposalView {
    pub id: String,
    /// 这条提案要改的范围（块 id）。
    pub scope: String,
    /// Agent 当时读到的原文。
    pub before_text: String,
    /// Agent 提议的新文本。只留评论的提案没有它。
    pub after_text: Option<String>,
}

impl From<&ProposalRow> for ProposalView {
    fn from(row: &ProposalRow) -> Self {
        Self {
            id: row.id.clone(),
            scope: row.scope.clone(),
            before_text: row.before_text.clone(),
            after_text: row.after_text.clone(),
        }
    }
}

/// 一份文档上待裁决的提案。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectProposals {
    pub proposals: Vec<ProposalView>,
    /// 已经暂存进批次的**提案** id（不是账本行 id）。
    ///
    /// 批次里存的是账本行 id，而界面画的是提案行——直接把账本 id 送过去，
    /// 界面就无法回答「这一条判过了吗」，只能退成「批次空不空」这种整体
    /// 状态。在这里配对一次，界面因此能逐行标记。
    pub staged: Vec<String>,
}

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

/// 这份文档上的提案，投影成界面要的那几列。
///
/// # Errors
///
/// 提案表读不出来时具名失败。
pub fn proposal_views(store: &ProjectStore, path: &str) -> Result<Vec<ProposalView>, RefrainError> {
    Ok(store
        .proposals_for(path)
        .map_err(into_domain)?
        .iter()
        .map(ProposalView::from)
        .collect())
}

/// 这份文档已经暂存进批次的账本行 id。没有批次时是空。
///
/// # Errors
///
/// 审阅会话读不出来、或批次不是一个合法的 JSON 数组时具名失败。
pub fn staged_ids(store: &ProjectStore, path: &str) -> Result<Vec<String>, RefrainError> {
    let Some((_cursor, batch_json)) = store.review_session_get(path).map_err(into_domain)? else {
        return Ok(Vec::new());
    };
    serde_json::from_str(&batch_json).map_err(|error| {
        RefrainError::new(ErrorCode::StateUnavailable, "read a review batch", path)
            .with_detail(error.to_string())
    })
}

/// 这份文档已经判过的**提案** id。
///
/// 批次存的是账本行 id，所以要回账本取每一行对应的 proposal_id。多一次
/// 查询换界面能逐行标记——否则作者看不出自己判到第几条。
///
/// # Errors
///
/// 与 [`staged_ids`] 相同，加上账本读不出来。
pub fn staged_proposal_ids(store: &ProjectStore, path: &str) -> Result<Vec<String>, RefrainError> {
    let batch = staged_ids(store, path)?;
    if batch.is_empty() {
        return Ok(Vec::new());
    }
    Ok(store
        .ledger()
        .find_many(&batch)
        .map_err(into_domain_store)?
        .into_iter()
        .map(|record| record.proposal_id)
        .collect())
}

/// 读一份文档上的提案，连同已经暂存进批次的那些 id。
///
/// # Errors
///
/// 与 [`proposal_views`]、[`staged_proposal_ids`] 相同。
pub fn read(store: &ProjectStore, path: &str) -> Result<ProjectProposals, RefrainError> {
    Ok(ProjectProposals {
        proposals: proposal_views(store, path)?,
        staged: staged_proposal_ids(store, path)?,
    })
}

/// 对一条提案下裁决：记进账本，并把这些账本行暂存进这份文档的批次。
///
/// **记账与提交分开**，因为它们是作者的两个动作：逐条判断，然后一次落盘。
/// 合成一条会让「改主意」变成不可能——账本是只增的。
///
/// # Errors
///
/// 提案不在这份文档上、改写型裁决没带最终正文、或这条提案什么都没改时，
/// 各自具名失败。
pub fn stage_verdict(
    store: &mut ProjectStore,
    path: &str,
    proposal_id: &str,
    kind: VerdictKindName,
    final_text: Option<String>,
    reason: Option<String>,
    now: u64,
) -> Result<ProjectProposals, RefrainError> {
    let row = store
        .proposals_for(path)
        .map_err(into_domain)?
        .into_iter()
        .find(|row| row.id == proposal_id)
        .ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "judge a proposal that is not on this document",
                proposal_id.to_owned(),
            )
        })?;
    // 改写型裁决必须带最终正文：缺了它，提交那一步会指名失败，而作者读到的
    // 是一次没有解释的拒绝。在入口就拒绝，错误离作者的动作最近。
    if kind == VerdictKindName::AcceptModified && final_text.is_none() {
        return Err(RefrainError::new(
            ErrorCode::StateUnavailable,
            "accept a modified proposal without its final text",
            proposal_id.to_owned(),
        ));
    }

    // 切片从领域层重建，不在这里推断：一次改写是两片，一次纯删除是一片，
    // 而「几片」这条规则只有 `Proposal` 知道。
    let proposal = rebuild_proposal(&row)?;
    let mut batch = staged_ids(store, path)?;
    let mut decided = 0u32;
    for slice in proposal.slices() {
        if !slice.kind().is_changed() {
            continue;
        }
        let record = VerdictRecord {
            id: Id::new().to_string(),
            proposal_id: proposal_id.to_owned(),
            slice_id: format!("{}:{}", proposal_id, slice.id().ordinal()),
            kind,
            // 只有插入片承载改写后的正文；删除片带着它会被领域层拒绝。
            final_text: if slice.kind() == SliceKind::Insert {
                final_text.clone()
            } else {
                None
            },
            reason: reason.clone(),
            decided_at: now,
            legacy_baseline: None,
        };
        store.ledger().record(&record).map_err(|error| {
            RefrainError::new(ErrorCode::StateUnavailable, "record a verdict", path)
                .with_detail(error.to_string())
        })?;
        batch.push(record.id);
        decided += 1;
    }
    if decided == 0 {
        return Err(RefrainError::new(
            ErrorCode::StateUnavailable,
            "judge a proposal that changes nothing",
            proposal_id.to_owned(),
        ));
    }

    let batch_json = serde_json::to_string(&batch).map_err(|error| {
        RefrainError::new(ErrorCode::StateUnavailable, "write a review batch", path)
            .with_detail(error.to_string())
    })?;
    store
        .review_session_set(path, 0, &batch_json)
        .map_err(into_domain)?;

    read(store, path)
}

/// 原生表面的锚定来源：这份文档的批注与待裁决提案。
///
/// 待裁决 = 账本里还没有这个提案的任何裁决行。候选在提交后仍留在表里
/// 供审计（SPEC 7.4），所以「还在表里」不等于「还没判」——判过的提案
/// 不该再往正文上钉印点。批注直接读行（要带块内区间，不走
/// `AnnotationView`——那是给名录界面的，丢了 start/end）。
///
/// 解析规则（块没了、原文对不上、候选全落空→省略）在
/// `native_document::DocumentSurface::anchored_ranges`，这里只收集来源。
///
/// # Errors
///
/// 批注表、账本或提案表读不出来时具名失败。
pub fn anchor_sources(
    entry: &ProjectEntry,
    relative: &str,
) -> Result<Vec<AnchorSource>, RefrainError> {
    let mut sources = Vec::new();
    for row in entry.store.annotations(relative).map_err(into_domain)? {
        sources.push(AnchorSource::Annotation {
            id: row.id,
            block_id: row.block_id,
            start: u64::from(row.start),
            end: u64::from(row.end),
            quote: row.quote,
            comment: matches!(row.kind, AnnotationKind::Comment),
        });
    }
    let verdicts = entry
        .store
        .ledger()
        .for_document(relative)
        .map_err(into_domain_store)?;
    let decided: std::collections::HashSet<&str> = verdicts
        .iter()
        .map(|row| row.proposal_id.as_str())
        .collect();
    for row in entry.store.proposals_for(relative).map_err(into_domain)? {
        if decided.contains(row.id.as_str()) {
            continue;
        }
        // scope 是块 id 的 JSON 数组（SPEC 9.7 的冻结格式）；多块提案
        // 只锚第一个块——多块锚定是 v0.3.0 之后的取舍。
        let Ok(scopes) = serde_json::from_str::<Vec<String>>(&row.scope) else {
            continue;
        };
        let Some(block_id) = scopes.into_iter().next() else {
            continue;
        };
        let Ok(proposal) = rebuild_proposal(&row) else {
            continue;
        };
        let candidates = proposal
            .slices()
            .iter()
            .filter(|slice| matches!(slice.kind(), SliceKind::Same | SliceKind::Delete))
            .map(|slice| slice.text().to_string())
            .collect();
        sources.push(AnchorSource::Proposal {
            id: row.id.clone(),
            block_id,
            candidates,
        });
    }
    Ok(sources)
}
