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
use refrain_host::host::{AgentHost, FrozenContext, HostCommand};
use refrain_host::run_edge::ResolvedEdge;
use refrain_host::staging::DirectoryContext;
use refrain_store::project::ProjectStore;

use crate::journal::{StoreJournal, into_domain, into_domain_host, json_of};
use crate::scope::{ScopeLocation, before_sections, locate_scope, locate_scope_by_identity};

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
        // 派发时作者选中的块 id，随 manifest 一起提升进这个工作区。它是定位的
        // 首选权威：内容寻址分辨不出两段一模一样的文字，身份寻址可以。
        // 缺失（老 Run 的 manifest 没有这一节）不是失败——回落到按原文定位，
        // 那条路本身已经在多处匹配时具名拒绝。
        let identities: HashMap<String, Vec<Id>> = context
            .read_workspace_scopes(&run.workspace)
            .map_err(|error| {
                RefrainError::new(
                    ErrorCode::Io,
                    "read the frozen scope identities",
                    run.workspace.clone(),
                )
                .with_detail(error.to_string())
            })?
            .unwrap_or_default()
            .into_iter()
            .map(|identity| (identity.scope, identity.blocks))
            .collect();
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
            // 身份优先。派发时这个 scope 绑定了哪几个块是一个已经存在的事实，
            // 用它定位，两段一模一样的文字也不会混淆。
            //
            // 找到块之后仍要核对字节：块还在但文本变了，说明作者改了这一段，
            // Agent 读到的已经不是现在的正文，套上去就是覆盖他没让改的字。
            let located = match identities.get(&replacement.scope) {
                Some(frozen_blocks) => {
                    match locate_scope_by_identity(manuscript, frozen_blocks) {
                        Some(blocks) => {
                            let current = blocks
                                .iter()
                                .filter_map(|id| {
                                    manuscript
                                        .head()
                                        .blocks()
                                        .iter()
                                        .find(|block| block.id() == *id)
                                        .map(|block| block.text().to_string())
                                })
                                .collect::<Vec<_>>()
                                .join(manuscript.scan().separator());
                            if current == *before {
                                ScopeLocation::Unique(blocks)
                            } else {
                                // 块还在，字节变了：与「作者改过」是同一件事，
                                // 走同一条具名失败，而不是退回按原文搜一遍——
                                // 那只会在别处找到一段碰巧相同的文字。
                                ScopeLocation::Moved
                            }
                        }
                        // 块不在了（作者删了它们，或它们不再连续）。此时原文
                        // 匹配是仅剩的线索，且只在全文唯一时才可信。
                        None => locate_scope(manuscript, before),
                    }
                }
                // 这个 Run 的 manifest 没有身份（更早的构建派发的）。按原文定位，
                // 多处匹配仍然具名拒绝。
                None => locate_scope(manuscript, before),
            };

            let blocks = match located {
                ScopeLocation::Unique(blocks) => blocks,
                ScopeLocation::Moved => {
                    // 作者在派发之后动过这一段。结果留在盘上，这一次带着原因失败，
                    // 而不是猜一个位置把提案套上去。
                    return fail(
                        &mut host,
                        run_id,
                        "scope-text-moved",
                        &replacement.scope,
                        now,
                    );
                }
                ScopeLocation::Ambiguous(candidates) => {
                    // 这段冻结原文在稿子里逐字出现了好几次，按内容分辨不出是哪一处。
                    // 从前这里默认取第一处，实测会把提案落在另一段上（审计 F-02）。
                    // 候选的块 id 一并交出：作者是唯一知道他当初框的是哪一段的人。
                    let detail = format!(
                        "{} matches {} places in the manuscript: {}",
                        replacement.scope,
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
                    );
                    return fail(&mut host, run_id, "scope-text-ambiguous", &detail, now);
                }
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

        // 批注（M9）：「只留话、不改正文」的产出——验证者的全部工作方式——
        // 此前被解析出来又悄悄丢掉。落在与手写批注同一个面（annotations
        // 表）：目标是本轮冻结 scope 的，锚在那个 scope 的块上，quote 是
        // 冻结的原文（agent 当初读到的那段字，与手写批注存选中文同一条
        // 理由）；目标对不上本轮 scope 的，锚在文稿首块并把目标词写进
        // 正文——批注一条都不丢，但锚错了位置要看得出来。
        let mut comments: Vec<refrain_store::annotations::AnnotationRow> = Vec::new();
        for comment in &artifact.comments {
            let before = before_by_scope.get(&comment.target);
            // 与提案同一条定位（身份优先、原文回落），但不核字节：批注什么
            // 都不改，作者在派发后动过那一段不是丢批注的理由。
            let anchored = before.and_then(|before| {
                identities
                    .get(&comment.target)
                    .filter(|blocks| !blocks.is_empty())
                    .and_then(|frozen| locate_scope_by_identity(manuscript, frozen))
                    .or_else(|| match locate_scope(manuscript, before) {
                        ScopeLocation::Unique(blocks) => Some(blocks),
                        ScopeLocation::Moved | ScopeLocation::Ambiguous(_) => None,
                    })
            });
            let fallback = || manuscript.head().blocks().get(0).map(|block| block.id());
            let Some((block_id, quote, body)) = (match (anchored, before) {
                (Some(blocks), Some(before)) => blocks
                    .first()
                    .map(|id| (*id, before.clone(), comment.text.clone())),
                (None, Some(before)) => {
                    fallback().map(|id| (id, before.clone(), comment.text.clone()))
                }
                (None, None) => fallback().map(|id| {
                    (
                        id,
                        String::new(),
                        format!("[{}] {}", comment.target, comment.text),
                    )
                }),
                // 定位到块却对不上冻结 scope 不可能（anchored 蕴含 before 在
                // 场），但编译器要知道这条臂有名字。
                (Some(blocks), None) => blocks
                    .first()
                    .map(|id| (*id, String::new(), comment.text.clone())),
            }) else {
                // 空文稿没有块可锚。有产出又对不回块的文稿本来走不到这里
                // （scope 校验先拒），批注不构成新的失败源。
                continue;
            };
            comments.push(refrain_store::annotations::AnnotationRow {
                id: Id::new().to_string(),
                document: task.document.clone(),
                block_id: block_id.to_string(),
                start: 0,
                end: u32::try_from(quote.len()).unwrap_or(u32::MAX),
                quote,
                kind: refrain_store::annotations::AnnotationKind::Comment,
                body: Some(body),
                created_at: now as i64,
                updated_at: now as i64,
            });
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
            comments,
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

    // 批注与提案同批落盘：收取成功的那一刻，「只留话」的那部分产出也是
    // 持久事实，不是只在这次调用的返回值里活过。
    for row in &outcome.comments {
        store.annotation_upsert(row).map_err(into_domain)?;
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
    comments: Vec<refrain_store::annotations::AnnotationRow>,
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
