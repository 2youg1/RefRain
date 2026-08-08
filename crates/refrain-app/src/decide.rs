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
    EditorAction, EditorChange, ErrorCode, Id, Manuscript, RecoveryStep, RefrainError, Replacement,
    TextCommand, TextRefusal, TextTransition,
};
use refrain_store::ledger::{VerdictKindName, VerdictRecord};
use refrain_store::project::{DocumentCommit, FileStamp, ProjectFailure, ProjectStore};

use crate::journal::into_domain;

/// 裁决走完之后，这次动作留在磁盘上的事实。
///
/// 三态而不是「成功/失败」二值，因为有三种不同的世界，作者要做的事各不相同：
/// 正文与派生状态都落了盘、正文落了盘但派生状态待修、以及磁盘在作者不知情时
/// 被别人改过。把它们压进一个错误通道，就是 F-03 的成因——重试会被自己判成
/// 外部冲突。
#[derive(Debug)]
pub enum DecisionOutcome {
    /// 正文与派生状态全部落盘。`stamp` 是这次写入之后的新戳。
    Durable {
        transition: TextTransition,
        stamp: FileStamp,
    },
    /// 正文已落盘，continuity/history 待修复。**带着新 stamp**：重试要用它，
    /// 否则重试会拿旧戳去比对自己刚写下的字节，把自己判成外部冲突。
    BodyDurable {
        transition: TextTransition,
        stamp: FileStamp,
        detail: String,
    },
    /// 磁盘上的字节不是作者盖戳时看到的那一份。真正的外部改动，不能覆盖。
    Conflict { on_disk: Vec<u8>, stamp: FileStamp },
}

/// 提交一份暂存的裁决批次。
///
/// `manuscript` 是这份文稿当前打开的那一份——裁决落地要改它的文本，块 id 也只
/// 在它身上成立。
///
/// `expected` 是作者盖过戳的那一份磁盘状态。**裁决即落盘**：裁决是档案性动作，
/// 它写进 Ledger，所以账本说「已接受」的那一刻磁盘必须同真，不能把「按保存」
/// 留给作者（F-01）。落盘走的是同一个 compare-and-swap，因为裁决没有比手工
/// 保存更多的权力去覆盖别人的改动。
///
/// # Errors
///
/// 批次为空、账本行与当前提案对不上、slice id 格式不对、修改型裁决缺少正文，
/// 都在这里拒绝并说明是哪一行。外部改动不是错误，它是 `Conflict` 那一态。
pub fn commit_decision_batch(
    store: &mut ProjectStore,
    manuscript: &mut Manuscript,
    path: &str,
    expected: Option<FileStamp>,
) -> Result<DecisionOutcome, RefrainError> {
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

    // 裁决即落盘（D1）：账本说「已接受」的那一刻磁盘必须同真（F-01）。
    persist_manuscript(store, manuscript, path, expected, transition)
}

/// 把改动后的稿子按同一个 compare-and-swap 落盘，并同步派生状态。
///
/// commit 与 countermand 共用这一条：两条路都是账本先记了事实，所以磁盘
/// 必须同真——F-01 的分裂对两个方向同样成立。落盘用与手工保存同一个
/// compare-and-swap，因为裁决没有比作者按保存更多的权力去覆盖别人的改动。
///
/// 派生状态失败时正文**已经在盘上**了，所以报 `BodyDurable` 而不是
/// 「保存失败」——那会让作者重来，而重来会拿旧戳比对自己刚写下的字节，
/// 把自己判成外部冲突（F-03）。
fn persist_manuscript(
    store: &mut ProjectStore,
    manuscript: &Manuscript,
    path: &str,
    expected: Option<FileStamp>,
    transition: TextTransition,
) -> Result<DecisionOutcome, RefrainError> {
    let bytes = manuscript.materialize().map_err(|error| {
        RefrainError::new(ErrorCode::Io, "materialise a manuscript", path.to_owned())
            .with_detail(error.to_string())
    })?;
    let committed = match store.commit(&DocumentCommit {
        path: path.to_owned(),
        bytes,
        expected,
    }) {
        Ok(outcome) => outcome,
        Err(ProjectFailure::ChangedUnderneath(conflict)) => {
            return Ok(DecisionOutcome::Conflict {
                on_disk: conflict.on_disk,
                stamp: conflict.stamp,
            });
        }
        Err(other) => return Err(into_domain(other)),
    };

    // 派生状态跟在正文后面。
    let live: Vec<Id> = manuscript
        .actions()
        .iter()
        .map(refrain_core::TextAction::id)
        .collect();
    let head = manuscript.head().id().to_string();
    let lineage = match serde_json::to_string(&manuscript.lineage_ids()) {
        Ok(lineage) => lineage,
        Err(error) => {
            return Ok(DecisionOutcome::BodyDurable {
                transition,
                stamp: committed.stamp,
                detail: error.to_string(),
            });
        }
    };
    if let Err(error) = store.save_continuity(path, &head, &lineage) {
        return Ok(DecisionOutcome::BodyDurable {
            transition,
            stamp: committed.stamp,
            detail: error.to_string(),
        });
    }
    if let Err(error) = store.action_history().sync_chain(path, &live) {
        return Ok(DecisionOutcome::BodyDurable {
            transition,
            stamp: committed.stamp,
            detail: error.to_string(),
        });
    }

    Ok(DecisionOutcome::Durable {
        transition,
        stamp: committed.stamp,
    })
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
        // 冲销记录由逆向裁决自己写入，永远不会被暂存进一个待合并的批次。
        // 真的走到这里，是批次里混进了不属于它的行——说出来，别悄悄映射成
        // 另一种裁决。
        VerdictKindName::Countermanded => {
            return Err(RefrainError::new(
                ErrorCode::StateUnavailable,
                "stage a countermand record into a decision batch",
                row.id.clone(),
            ));
        }
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

// ── 逆向裁决（countermanding verdict）──────────────────────────────────────
//
// 对已合并的提案下冲销：账本 append 一条 countermanded 记录（不删旧记录），
// 文本回退到该提案的冻结前字节。锚定复用冻结字节核对——当前文本里找不到
// 当初合并进去的那一段，整体拒绝，一段都不动。
//
// 与「撤销」的分工：撤销吃掉会话里最后一个动作，而合并动作携带裁决、按
// 设计不可撤销（账本已是事实）。逆向裁决不碰历史，它写一条新的裁决，
// 让文本与账本各自保持真实。

/// 一次冲销记录使用的 slice id：冲销针对整个提案，不针对切片。写法与
/// `<proposal>:<ordinal>` 同格但占位词不是序号，重建切片的路径不会把它
/// 误读成一条切片裁决。
fn countermand_slice_id(proposal: &str) -> String {
    format!("{proposal}:countermand")
}

/// 对一组已合并的提案下冲销，落成**一次** Text Action（一次撤销全部还原）。
///
/// 全部锚定核对在任何文本移动之前完成：任何一个提案找不到当初合并进去
/// 的字节，整批拒绝，账本也不写——半个冲销既丢审计也丢文本的一致性。
///
/// 落盘与 commit 同一条纪律（D1）：账本记下「已冲销」的那一刻磁盘必须
/// 同真，否则重载后正文带着一笔已冲销的合并，而账本说它已经不在——
/// 那是同一个 F-01，只是方向相反。`expected` 是作者盖过戳的磁盘状态，
/// 走同一个 compare-and-swap。
///
/// `decided_at` 由调用方给（与 host 同一纪律：这里没有钟）。
///
/// # Errors
///
/// 提案不存在、从未被合并（拒绝或仅批注）、合并不留字节（删除型）、
/// 或冻结字节已不再匹配当前文本，都在这里具名拒绝。
pub fn countermand_proposals(
    store: &mut ProjectStore,
    manuscript: &mut Manuscript,
    path: &str,
    proposal_ids: &[String],
    expected: Option<FileStamp>,
    decided_at: u64,
) -> Result<DecisionOutcome, RefrainError> {
    if proposal_ids.is_empty() {
        return Err(RefrainError::new(
            ErrorCode::StateUnavailable,
            "countermand an empty set",
            path.to_owned(),
        ));
    }

    let proposals = store
        .proposals_for(path)
        .map_err(into_domain)?
        .iter()
        .map(crate::review::rebuild_proposal)
        .collect::<Result<Vec<_>, _>>()?;
    let ledger_rows = store
        .ledger()
        .for_document(path)
        .map_err(crate::journal::into_domain_store)?;

    let mut changes = Vec::with_capacity(proposal_ids.len());
    let mut reversals = Vec::with_capacity(proposal_ids.len());
    for raw in proposal_ids {
        let wanted = crate::journal::parse_id(raw, "proposal")?;
        let proposal = proposals
            .iter()
            .find(|candidate| candidate.id() == wanted)
            .ok_or_else(|| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "countermand a proposal that is not here",
                    raw.clone(),
                )
            })?;

        // 合并过才有得冲：账本里这个提案的接受类裁决。拒绝与仅批注从未
        // 进过正文，对它们「冲销」是假装有一段可回退的文本。
        let merged_rows: Vec<&VerdictRecord> = ledger_rows
            .iter()
            .filter(|row| {
                row.proposal_id == *raw
                    && matches!(
                        row.kind,
                        VerdictKindName::Accept | VerdictKindName::AcceptModified
                    )
            })
            .collect();
        if merged_rows.is_empty() {
            return Err(RefrainError::new(
                ErrorCode::StateUnavailable,
                "countermand a proposal that was never merged",
                raw.clone(),
            ));
        }

        let proposal_at: HashMap<Id, &Proposal> = [(proposal.id(), proposal)].into_iter().collect();
        let verdicts = merged_rows
            .iter()
            .map(|row| verdict_of(row, &proposal_at))
            .collect::<Result<Vec<_>, _>>()?;

        // 锚定物是「当初合并进正文的那一段」，由合并时同一套重建规则算出。
        // 两份代码各算一份的日子，就是冲销与合并对某一条裁决理解不同的那天。
        let landed = refrain_core::manuscript::merged_text(proposal, &verdicts);
        if landed.is_empty() {
            return Err(RefrainError::new(
                ErrorCode::StateUnavailable,
                "countermand a merge that deleted its scope",
                raw.clone(),
            )
            .with_detail(
                "the merge left no bytes in the text, so there is no anchor to find and reverse",
            ));
        }
        let blocks = match crate::scope::locate_scope(manuscript, &landed) {
            crate::scope::ScopeLocation::Unique(blocks) => blocks,
            // 与提案过期同一类事实：作者后来动过这一段。交还当初合并进去
            // 的原文，他是唯一知道该怎么办的人。
            crate::scope::ScopeLocation::Moved => {
                return Err(RefrainError::new(
                    ErrorCode::StaleProposal,
                    "countermand a proposal whose merged text has moved",
                    path.to_owned(),
                )
                .with_detail(landed.clone())
                .with_recovery(vec![
                    RecoveryStep::CompareWithFrozenText,
                    RecoveryStep::SendAgain,
                ]));
            }
            // 当初合并进去的字节在稿子里出现了好几处，逐字都相同。
            //
            // 这正是审计 F-02 实测复现的那一幕：从前默认取第一处，于是冲销
            // 改掉了另一段——作者看到的是他没有要求回退的文字被回退了，而
            // 他真正想回退的那一段原封不动。两处都是他的字，改错一处就是丢字。
            //
            // 整批拒绝而不是猜：冲销已经是一次「把正文改回去」的写入，在不
            // 确定改哪一处时写入，比不写入坏得多。
            crate::scope::ScopeLocation::Ambiguous(candidates) => {
                return Err(RefrainError::new(
                    ErrorCode::StaleProposal,
                    "countermand a proposal whose merged text appears more than once",
                    path.to_owned(),
                )
                .with_detail(format!(
                    "{} places in the manuscript hold these exact bytes: {}",
                    candidates.len(),
                    candidates
                        .iter()
                        .map(|blocks| blocks
                            .iter()
                            .map(ToString::to_string)
                            .collect::<Vec<_>>()
                            .join("+"))
                        .collect::<Vec<_>>()
                        .join(", ")
                ))
                .with_recovery(vec![RecoveryStep::CompareWithFrozenText]));
            }
        };

        changes.push(EditorChange::Replace(
            Replacement::new(blocks, Some(proposal.before().to_string())).map_err(|error| {
                RefrainError::new(ErrorCode::Io, "build a countermand", raw.clone())
                    .with_detail(error.to_string())
            })?,
        ));
        reversals.push(raw.clone());
    }

    let base = manuscript.head().id();
    let transition = manuscript
        .execute(TextCommand::Editor(EditorAction::new(
            base,
            changes,
            "countermand",
        )))
        .map_err(|error| {
            RefrainError::new(ErrorCode::Io, "countermand proposals", path.to_owned())
                .with_detail(error.to_string())
        })?;

    // 文本已回退，账本 append 冲销记录——顺序与 commit 相同：先落地事实，
    // 再写账本，账本记的是已经发生的事，不是意图。
    for raw in &reversals {
        store
            .ledger()
            .record(&VerdictRecord {
                id: Id::new().to_string(),
                proposal_id: raw.clone(),
                slice_id: countermand_slice_id(raw),
                kind: VerdictKindName::Countermanded,
                final_text: None,
                reason: None,
                decided_at,
                legacy_baseline: None,
            })
            .map_err(crate::journal::into_domain_store)?;
    }
    // 账本已记下「已冲销」，磁盘必须同真（D1／F-01，方向相反，同一个分裂）。
    persist_manuscript(store, manuscript, path, expected, transition)
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
