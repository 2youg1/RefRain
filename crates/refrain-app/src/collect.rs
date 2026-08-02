//! 收取一次派发的产出。
//!
//! 这条流程要读回派发时冻结的请求、按契约校验回来的结果、把每个范围对回当前
//! 稿子的块，再分三步写进 host 与 store。它此前是 `lib.rs` 里一个 182 行的命令
//! 体——所有这些判断都只能靠开一个 Tauri 窗口来验证。
//!
//! 搬到这里之后，下面每一条规则都能被单独问一次：
//!
//! - 契约只来自冻结的请求字节，不采信结果文件自己声称改了什么（SPEC 8.4）。
//! - 作者若在派发之后动过某个范围，这一路失败并说明原因，不把提案套在它从未
//!   读过的文本上。
//! - 先校验、再完成、最后冻结提案（SPEC 8.4b）——顺序本身是规则。
//! - Material 草稿只作为草稿入世（SPEC 8.7）。

use std::collections::HashMap;

use refrain_core::Manuscript;
use refrain_core::manuscript::{EditScope, Proposal};
use refrain_core::{ErrorCode, Id, RefrainError, agent_protocol, digest::content_hex};
use refrain_host::host::{AgentHost, HostCommand};
use refrain_host::run_edge::ResolvedEdge;
use refrain_host::staging::DirectoryContext;
use refrain_store::project::ProjectStore;

use crate::journal::{StoreJournal, into_domain, into_domain_host, json_of};
use crate::scope::{before_sections, find_scope_blocks};

/// 收取的三种结局。
///
/// 与 Tauri 的 DTO 分开：装配层要怎么把它讲给前端是另一回事，而这里三种结局的
/// 区别是领域事实——还没有结果、收下了、这一次失败了。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Collected {
    /// 结果文件还没出现，什么都没动。
    Waiting,
    Completed {
        proposals: u32,
        memos: u32,
        drafts: u32,
    },
    /// 这一次派发失败。`code` 是失败的种类，会写进 host 的 Run 记录。
    Failed { code: String, detail: String },
}

/// 收取一次尝试。
///
/// `manuscripts` 是当前打开的稿子，按文档路径取——收取要把冻结的原文对回块 id，
/// 而块 id 只存在于打开着的那份稿子里。
pub fn collect_attempt(
    store: &mut ProjectStore,
    manuscripts: &HashMap<String, Manuscript>,
    run_id: Id,
    now: u64,
) -> Result<Collected, RefrainError> {
    // host 会消耗掉一个 context，而结果与请求还要从同一个目录读，所以先留路径。
    let state_dir = store.layout().state_dir.clone();

    // 契约的依据在 host 打开之前取：journal 会借走 store。
    let basis: Vec<String> = store
        .documents()?
        .iter()
        .filter_map(|row| {
            row.current_head
                .as_ref()
                .map(|head| format!("{}@{}", row.path, head))
        })
        .collect();

    // host 借着 store 走完编排的这一段；提案要等它归还之后才写。
    let outcome = {
        let mut host = AgentHost::open(
            StoreJournal { store },
            DirectoryContext::new(state_dir.clone()),
        )
        .map_err(into_domain_host)?;
        let run = host
            .runs()
            .iter()
            .find(|run| run.id == run_id)
            .ok_or_else(|| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "collect a run this project does not have",
                    run_id.to_string(),
                )
            })?
            .clone();

        let context = DirectoryContext::new(state_dir);
        let Some(bytes) = context
            .read_result(&run.workspace, run_id)
            .map_err(|error| {
                RefrainError::new(
                    ErrorCode::Io,
                    "read the run's result",
                    run.workspace.clone(),
                )
                .with_detail(error.to_string())
            })?
        else {
            return Ok(Collected::Waiting);
        };

        let request = context
            .read_workspace_request(&run.workspace)
            .map_err(|error| {
                RefrainError::new(
                    ErrorCode::Io,
                    "read the frozen request",
                    run.workspace.clone(),
                )
                .with_detail(error.to_string())
            })?
            .ok_or_else(|| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "read the frozen request",
                    "the promoted request is missing",
                )
            })?;

        // 契约来自生产者当初读到的字节，永远不来自结果文件自己的声称（SPEC 8.4）。
        let scopes = before_sections(&request);
        let scope_ids: Vec<String> = scopes.iter().map(|(id, _)| id.clone()).collect();
        let contract = agent_protocol::ArtifactContract {
            scopes: &scope_ids,
            basis: &basis,
        };

        let artifact = match agent_protocol::parse(&bytes, &contract) {
            Ok(artifact) => artifact,
            Err(error) => {
                // 打印通道的 CLI 常在产出前叙述一句。叙述不携带权威，所以恰好
                // 一个根元素时裁剪重试一次——元素本身仍按冻结请求逐项校验；
                // 其他错误（含零个/多个根）保持原样的具名拒绝。
                let salvaged = (error.code.as_str() == "text-outside-root")
                    .then(|| agent_protocol::extract_single_root(&bytes))
                    .flatten()
                    .and_then(|span| agent_protocol::parse(span, &contract).ok());
                match salvaged {
                    Some(artifact) => artifact,
                    None => {
                        return fail(&mut host, run_id, error.code.as_str(), &error.detail, now);
                    }
                }
            }
        };

        // 判据 2-3：验证者只出批注，不出改写。
        //
        // `Verifies` 的全部意思是「这一轮读另一份产出并报告」。一个给了
        // 改写的验证者做的是作者没有授权的那件事，所以整份产出被拒——
        // 不是留下批注、丢掉改写。丢掉等于替作者裁掉了他会想看到的东西，
        // 也让下一轮的验证者以为越界是可以的。
        //
        // 依据是 Run 上的边，不是产出自己的声称：产出说自己是什么，从来
        // 不构成它是什么的证据（与契约永远取自冻结请求同一条理由）。
        if matches!(run.edge, Some(ResolvedEdge::Verifies { .. }))
            && !artifact.replacements.is_empty()
        {
            let scopes: Vec<&str> = artifact
                .replacements
                .iter()
                .map(|replacement| replacement.scope.as_str())
                .collect();
            return fail(
                &mut host,
                run_id,
                "verifier-proposed-edit",
                &scopes.join(", "),
                now,
            );
        }

        let task = host
            .tasks()
            .iter()
            .find(|task| task.id == run.task_id)
            .ok_or_else(|| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "collect into a task the host does not have",
                    run.task_id.to_string(),
                )
            })?
            .clone();
        let manuscript = manuscripts.get(&task.document).ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "collect into a document that is not open",
                task.document.clone(),
            )
        })?;

        let before_by_scope: HashMap<String, String> = scopes.into_iter().collect();
        let mut proposals: Vec<(Proposal, Vec<Id>)> = Vec::new();
        for replacement in &artifact.replacements {
            let Some(before) = before_by_scope.get(&replacement.scope) else {
                return fail(&mut host, run_id, "unknown-scope", &replacement.scope, now);
            };
            let Some(blocks) = find_scope_blocks(manuscript, before) else {
                // 作者在派发之后动过这一段。结果留在盘上，这一次带着原因失败，
                // 而不是猜一个位置把提案套上去。
                return fail(
                    &mut host,
                    run_id,
                    "scope-text-moved",
                    &replacement.scope,
                    now,
                );
            };
            let scope = EditScope::new(blocks.clone()).map_err(|error| {
                RefrainError::new(
                    ErrorCode::Io,
                    "build a proposal scope",
                    task.document.clone(),
                )
                .with_detail(error.to_string())
            })?;
            proposals.push((
                Proposal::new(
                    run_id,
                    task.baseline,
                    scope,
                    before.clone(),
                    replacement.text.clone(),
                ),
                blocks,
            ));
        }

        // SPEC 8.4b：先校验，再完成，最后冻结提案。顺序是规则的一部分——提案若
        // 先于完成落盘，一次中断会留下没有归属的提案。
        host.execute(HostCommand::CollectAttempt {
            run_id,
            artifact_digest: content_hex(&bytes),
            at: now,
        })
        .map_err(into_domain_host)?;

        Frozen {
            document: task.document,
            proposals,
            memos: artifact.memos.len() as u32,
            drafts: artifact.material_drafts,
        }
    };

    for (proposal, blocks) in &outcome.proposals {
        store
            .proposal_insert(&refrain_store::project::ProposalRow {
                id: proposal.id().to_string(),
                run: run_id.to_string(),
                baseline: proposal.baseline().to_string(),
                document_path: outcome.document.clone(),
                scope: json_of(blocks, "proposal scope")?,
                before_text: proposal.before().to_string(),
                after_text: proposal.after().map(str::to_string),
                created_at: now,
            })
            .map_err(into_domain)?;
    }

    // Material 草稿只作为草稿入世（SPEC 8.7）：只有一次人的 Material Action
    // 才能让它成为 Material。
    for draft in &outcome.drafts {
        store
            .material_draft_insert(&refrain_store::materials::MaterialDraftRow {
                id: Id::new().to_string(),
                run_id: run_id.to_string(),
                document: outcome.document.clone(),
                kind: draft.kind.clone(),
                title: draft.title.clone(),
                basis: json_of(&draft.basis, "material basis")?,
                body: draft.body.clone(),
                created_at: now,
            })
            .map_err(into_domain)?;
    }

    Ok(Collected::Completed {
        proposals: outcome.proposals.len() as u32,
        memos: outcome.memos,
        drafts: outcome.drafts.len() as u32,
    })
}

/// host 归还 store 时带出来的东西：已经校验过、等着落盘的那一批。
struct Frozen {
    document: String,
    proposals: Vec<(Proposal, Vec<Id>)>,
    memos: u32,
    drafts: Vec<refrain_core::agent_protocol::MaterialDraft>,
}

/// 记下这一次失败，并把同一个原因交回调用方。
///
/// 失败必须先写进 host 再返回：Run 的历史是产品要展示的事实，不能只活在一次
/// 函数调用的返回值里。
fn fail(
    host: &mut AgentHost<StoreJournal<'_>, DirectoryContext>,
    run_id: Id,
    code: &str,
    detail: &str,
    now: u64,
) -> Result<Collected, RefrainError> {
    host.execute(HostCommand::FailRun {
        run_id,
        failure: code.to_string(),
        at: now,
    })
    .map_err(into_domain_host)?;
    Ok(Collected::Failed {
        code: code.to_string(),
        detail: detail.to_string(),
    })
}
