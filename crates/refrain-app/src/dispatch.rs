// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! 派发一次改写请求：从作者选中的一段正文，到若干个就绪的 Run。
//!
//! # 为什么是一个用例而不是三条命令
//!
//! 领域层把派发拆成三步：`DraftTask` 起一个任务、`AuthorizeDispatch` 铸出
//! Run、每个 Run 各自 `LaunchRun`。这个拆分是对的——它们各自有不同的拒绝，
//! 而且授权那一步是人类裁决的落点（SPEC 8.2）。
//!
//! 但**界面拼不出这三步**：第二步要第一步生成的 `task_id`，要 Rust 编译出的
//! `DispatchPackage`（含稳定前缀与 manifest），还要一份按位置排列的 agent
//! 列表。让 Zig 侧攒这些，等于把领域顺序复制到界面里，而那正是它每次都会
//! 攒错的地方——一次漏掉 `clicked_digest` 的授权会被具名拒绝，而作者读到的
//! 是「派发按钮没反应」。
//!
//! 所以这里收进来的是**顺序知识**，不是规则：每一条拒绝仍然由领域层给出。
//!
//! # 这里owns的不变量
//!
//! **选中的范围必须在派发那一刻还在稿子里。** 作者选了一段、去改了别处、
//! 再回来点派发——那时冻结下来的原文已经对不上任何块。这一路在编译请求
//! 之前就失败，而不是把一份指向不存在文本的请求送给 agent。

use std::path::{Path, PathBuf};

use refrain_core::context_compiler::{
    BeforeScope, ContractMode, DispatchInput, DispatchPackage, InstalledSkill, SkillStatus, compile,
};
use refrain_core::digest::content_hex;
use refrain_core::manuscript::Manuscript;
use refrain_core::material_listing::MaterialListing;
use refrain_core::persona::Persona;
use refrain_core::{Block, ErrorCode, Id, RefrainError};
use refrain_host::adapters::{channel, channel_skill_bytes, channel_skill_path};
use refrain_host::host::{AgentHost, HostCommand};
use refrain_host::run_edge::RunEdge;
use refrain_host::staging::DirectoryContext;
use refrain_store::config::{AdapterKind, Config};
use refrain_store::ledger::{VerdictKindName, VerdictRecord};
use refrain_store::project::ProjectStore;

use crate::journal::{StoreJournal, into_domain, into_domain_host};
use crate::root::ProjectEntry;
use crate::scope::{ScopeLocation, locate_scope};

/// 作者要派发的一段：正文的原文，以及它在稿子里的位置。
///
/// 两种指法，**给了块段就以块为准**（`before` 此时被忽略，界面送空串）：
///
/// - 文本路径（`blocks` 缺席）：只带原文而不带块 id。作者是在界面上框一段
///   文字，块身份是 Rust 这边定位出来的。让界面送块 id 等于要求它先知道
///   块怎么切——那是 `source_layout` 的事，而且它切的方式会随格式变。
/// - 块段路径（`blocks` 在场）：界面引用的是 **Rust 自己切好的块**——
///   `ReadBlocks` 清单给出的块 id，不是界面猜的切法。整章与大跨度派发靠
///   它越过 12KB 的 ABI：原文不必过河，河这边按 id 取块、自己拼回原文。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DispatchScope {
    /// 作者给这一段起的名字，出现在请求里当位置标签。
    pub label: String,
    /// 选中的原文，逐字节。块段路径下被忽略（界面送空串）。
    pub before: String,
    /// 块段：从第几块起（ordinal）、取几块。在场就以块为准，`before` 被忽略。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocks: Option<ScopeSpan>,
}

/// 一段按块指名的范围：起始块的 ordinal 与块数。
///
/// 用 ordinal 不用块 id：界面手上的就是行号，而 id 是清单行的携带物——
/// 跨页勾选时起始行的 id 未必还在当前页上， ordinal 永远可指。序号漂移
/// （清单列出后作者又改了稿子）由「预览必经 + digest 核对」兜住：预览
/// 按当前稿子编译，预览的原文展开就是给作者核对范围的。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ScopeSpan {
    /// 起始块的 ordinal（`ReadBlocks` 清单的行号，从 0 起）。
    pub from: u32,
    /// 从起始块起取几块。剩余不足就取到末尾；0 被具名拒绝。
    pub count: u32,
}

/// 这一轮的身份走哪条路。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum DispatchChannel {
    /// 有 harness：身份在 `AGENTS.md`，请求里不带。
    Harness,
    /// 手动往返：没有自动规则文件，身份随请求走。
    Manual,
}

/// 多个 agent 之间怎么排。
///
/// 三种排法对应 `RunEdge` 的三种边，但这里是**作者的选择**而不是边本身：
/// 边按位置指向另一个 Run，而作者说的是「他们并列」「后一个读前一个」
/// 「后一个检查前一个」。位置留给用例去算，界面因此不必知道 Run 会以
/// 什么顺序铸出来。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum Orchestration {
    /// 各写各的，互相看不见。多个 agent 时的默认。
    Alternates,
    /// 排成一串：后一个读前一个的完整产出。
    ///
    /// 作者的用例是「先列提纲，再照着写」。下游必须看见上游的**全部**产出
    /// 而不是摘要，否则它是在完成一个自己没读过的判断。
    Follows,
    /// 第一个写，其余检查它——只能出批注，不能改正文。
    Verifies,
}

/// 这一轮带不带稿子、怎么带（v0.2.4 的带稿模式）。
///
/// **默认是 `None`，不是 `Diff`**：增量是界面替作者选的默认，不是线协议
/// 的默认——旧载荷没有这个词，反序列化出来的必须是旧行为（什么都不带），
/// 否则一个没升级的对端会突然开始收到它从未要求的增量。
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize, specta::Type,
)]
#[serde(rename_all = "kebab-case")]
pub enum CarryMode {
    /// 增量：上一轮以来的裁决行进 `<changes>`。
    Diff,
    /// 全文：整份稿子的文本进 `# Context`。
    Full,
    /// 什么都不带：旧行为。
    #[default]
    None,
}

impl CarryMode {
    /// 线协议默认（不带）。默认态不落进 JSON：旧形状的请求逐字节成立
    /// （与 `materials`／`agent` 同一条 default + skip 纪律）。
    fn is_none(&self) -> bool {
        matches!(self, Self::None)
    }
}

/// 一次派发要什么。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRequest {
    /// 派发哪一份稿子。
    pub document: String,
    /// 作者写给 agent 的话，逐字进入请求。
    pub prompt: String,
    /// 要改的那些段，按稿子顺序。
    pub scopes: Vec<DispatchScope>,
    /// 派给几个 agent。多于一个时由 `orchestration` 决定他们怎么排。
    pub agents: usize,
    /// 这几个 agent 之间怎么排。一个 agent 时无意义，忽略。
    pub orchestration: Orchestration,
    /// 作者给这个 Agent 的身份。
    ///
    /// **这份身份走哪条路由 `channel` 决定，不由这里决定（D14）。**
    pub persona: Option<Persona>,
    /// 这一轮走哪条通道。
    ///
    /// **两条路不得同时携带身份全文**：Harness 通道的身份由 `AGENTS.md`
    /// 承载（`ensure_agent_files` 写它，harness CLI 自行发现），请求里
    /// 一个字也不带；L0 手动往返没有自动规则文件，才把身份写进请求。
    /// 两边都带，同一份身份就投递了两次——而它们此后各自漂移，作者
    /// 改了设置却发现 Agent 还在按旧身份说话。
    pub channel: DispatchChannel,
    /// 产出写到哪里（写进请求的短契约里给 agent 看）。
    pub result_path: String,
    /// 产出的字节上限（同上）。
    pub max_bytes: u64,
    /// 这一轮带不带稿子、怎么带。缺席 = 不带（旧载荷 = 旧行为）。
    #[serde(default, skip_serializing_if = "CarryMode::is_none")]
    pub carry: CarryMode,
    /// 作者为本轮勾选的资料，Root 相对路径。
    ///
    /// **只有路径过河，档位不随请求走**：`documents.disclosure` 是档位的
    /// 唯一权威（`SetDisclosure` 写它）。请求自带档位会让同一份资料的
    /// 权限有两个说法，而界面那份可以说得比名录那份更宽。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub materials: Vec<String>,
    /// 这次派发挂在哪个 Agent 名下（Config 里 `AgentProfile` 的 id）。
    ///
    /// `None` 保持旧行为：每个 Run 铸一个新身份，接续轮与协议装载都不
    /// 发生。具名之后 Run 落在 `.refrain/agents/<id>/` 下，同一 Agent 的
    /// 第二轮起 `has_agent_memo` 才有意义——每轮换一个新 id 等于每次都
    /// 以新身份相见。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<Id>,
    /// 送前核对：预览答复里的那份 digest。带上它时，编译出的包与它不一致
    /// 就具名拒绝（预览之后稿子或资料变了）；`None` 是不经预览的旧路径
    /// （测试与脚本），领域不替作者省掉这一步的说理。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_digest: Option<String>,
}

/// 一次派发的结果：铸出了哪些 Run，以及那份请求有多稳定。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Dispatched {
    /// 铸出来的 Run，顺序与 `agents` 一致。
    pub runs: Vec<Id>,
    /// 这一份请求的摘要，收取时按它核对。
    pub digest: String,
    /// 稳定前缀有多少字节（D14）。报字节而不报「已命中」——命中由 provider
    /// 决定，而这个进程不出网。
    pub prefix_bytes: u32,
}

/// 一轮派发从环境里读出的事实：接续、协议装载与勾选的资料。
///
/// 与 `DispatchRequest` 分开：请求装的是作者点的，这些是应用从名录、
/// Config 与工作区里查出来的。两者在派发这一刻汇合，此后一起冻结进
/// 请求包。
#[derive(Debug, Clone, Default)]
pub struct RoundFacts {
    /// 作者勾选的资料，已按名录解析成目录条目（档位取自名录）。
    pub materials: Vec<MaterialListing>,
    /// 这个 Agent 的工作区里已有它自己维护的 Memo.md：本轮是接续轮。
    pub resumed: bool,
    /// 本轮连接的协议装载状态。`None` 是「没装过」或「说不上装没装」——
    /// 两种情况下请求都照旧背协议全文，指针只在说得出文件在哪时才出现。
    pub installed_skill: Option<InstalledSkill>,
    /// 上一轮以来的裁决行：增量带稿（`CarryMode::Diff`）的 payload。
    /// 由装配层从账本填（`verdict_changes`），其余带稿模式下是空。
    pub changes: Vec<refrain_core::ChangeEntry>,
}

/// 把作者勾选的资料路径解析成目录条目。
///
/// 名录（`documents` 表）是唯一权威：路径必须在册（与 `set_disclosure`
/// 同一条具名拒绝），档位取名录里的那一档，`None` 读作枚举默认——请求
/// 里说的不算。正文从磁盘现读，摘要随这次读取重算：目录描述的是这一次
/// 读到的字节，不是名录记忆里的一份。
///
/// # Errors
///
/// 路径不在册、读不到、或不是 UTF-8 文本，各自具名拒绝。
pub fn resolve_materials(
    store: &mut ProjectStore,
    paths: &[String],
) -> Result<Vec<MaterialListing>, RefrainError> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let catalog = store.documents()?;
    paths
        .iter()
        .map(|path| {
            let row = catalog
                .iter()
                .find(|row| &row.path == path)
                .ok_or_else(|| {
                    RefrainError::new(
                        ErrorCode::StateUnavailable,
                        "attach a material that is not registered",
                        path.clone(),
                    )
                })?;
            let opened = store.open_document(path).map_err(into_domain)?;
            let text = String::from_utf8(opened.bytes).map_err(|error| {
                RefrainError::new(
                    ErrorCode::UnsupportedFormat,
                    "read a material as text",
                    path.clone(),
                )
                .with_detail(error.to_string())
            })?;
            Ok(MaterialListing::describe(
                path,
                title_of(path),
                row.role,
                &opened.stamp.digest,
                &text,
                row.disclosure.unwrap_or_default(),
            ))
        })
        .collect()
}

/// 目录条目上的标题：文件主名。名录不存标题——`资料/人物志.md` 的标题
/// 就是「人物志」，另存一份只会与文件名漂移。
fn title_of(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.strip_suffix(".md").unwrap_or(name)
}

/// 查出这一轮的事实：Agent 的接续状态，连接的协议装载状态。
///
/// `materials` 由 `resolve_materials` 先解析好——两个函数分开，是因为
/// 资料要碰 store，而这里只读 Config 与工作区。
///
/// # Errors
///
/// 请求具名了一个 Config 里不存在的 Agent，或那个 Agent 指着一条不存在
/// 的连接，具名拒绝——替它匿名派发会让 Run 落进一个与作者选择不同的
/// 身份下。
pub fn round_facts(
    config: &Config,
    context: &DirectoryContext,
    request: &DispatchRequest,
    materials: Vec<MaterialListing>,
) -> Result<RoundFacts, RefrainError> {
    let installed_skill = installed_skill_for(config, request, std::env::home_dir().as_deref())?;
    // Memo.md 是接续轮的唯一事实来源：它是 Agent 自己的记忆，应用不写也
    // 不读，只问它在不在。
    let resumed = request
        .agent
        .is_some_and(|agent| context.has_agent_memo(agent));
    Ok(RoundFacts {
        materials,
        resumed,
        installed_skill,
        // 裁决行由装配层填：`round_facts` 只读 Config 与工作区，账本查询
        // 要碰 store（与 `materials` 先由 `resolve_materials` 解析同一条分工）。
        changes: Vec::new(),
    })
}

/// 账本行映射成 `<changes>` 的裁决行：四态一一对应。
///
/// `Countermanded` 不进包：它是一笔已合并裁决的冲销，那笔决定已经不在
/// 正文里——把它当成一条「改动」送给 agent，等于让它参考一次已经撤销的
/// 决定。账本只增，冲销与原裁决都留在账上，而请求只带还成立的那些。
#[must_use]
pub fn verdict_changes(records: &[VerdictRecord]) -> Vec<refrain_core::ChangeEntry> {
    records
        .iter()
        .filter_map(|record| {
            let kind = match record.kind {
                VerdictKindName::Accept => refrain_core::ChangeKind::Accept,
                VerdictKindName::AcceptModified => refrain_core::ChangeKind::AcceptModified,
                VerdictKindName::Reject => refrain_core::ChangeKind::Reject,
                VerdictKindName::CommentOnly => refrain_core::ChangeKind::CommentOnly,
                VerdictKindName::Countermanded => return None,
            };
            Some(refrain_core::ChangeEntry {
                reference: record.slice_id.clone(),
                kind,
                reason: record.reason.clone(),
                final_text: record.final_text.clone(),
            })
        })
        .collect()
}

/// 本轮连接的协议装载状态，从 Config 的 `skill_digest` 读出。
///
/// 摘要登记者是本应用：`Some` 是「上次装载写的是这些字节」，与「那个
/// 文件此刻还在不在、被谁动过」无关——后者是状态徽章的事，它读文件
/// 本身。拿登记的摘要与本构建会写出的字节对一遍：相等才是 `Current`。
/// 协议随版本演进，上一版装的那份今天就是 `Stale`——那时请求明说并
/// 照旧背全文，而不是悄悄信任漂移过的字节。
fn installed_skill_for(
    config: &Config,
    request: &DispatchRequest,
    home: Option<&Path>,
) -> Result<Option<InstalledSkill>, RefrainError> {
    let Some(agent_id) = request.agent else {
        return Ok(None);
    };
    let profile = config
        .agents
        .iter()
        .find(|agent| agent.id == agent_id)
        .ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "dispatch under an agent that is not configured",
                agent_id.to_string(),
            )
        })?;
    // L0 文件通道没有可装载的协议。
    let Some(connection_id) = profile.connection_id else {
        return Ok(None);
    };
    let connection = config
        .harness_connections
        .iter()
        .find(|connection| connection.id == connection_id)
        .ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "dispatch on a connection that is not configured",
                connection_id.to_string(),
            )
        })?;
    let Some(recorded) = &connection.skill_digest else {
        return Ok(None);
    };
    // 指不出协议文件在哪（连 home 都不可得），指针就无处可指——背全文。
    let Some(home) = home else { return Ok(None) };
    let Some((path, bytes)) = skill_surface(&connection.adapter, home) else {
        return Ok(None);
    };
    let status = if *recorded == content_hex(&bytes) {
        SkillStatus::Current
    } else {
        SkillStatus::Stale
    };
    Ok(Some(InstalledSkill {
        path: path.display().to_string(),
        status,
    }))
}

/// 一种 harness 的协议装载处：skill 目录里的目标路径，与本构建会写出的
/// 字节。没有适配器的连接种类没有装载处——它们的 `skill_digest` 因此
/// 也总是 `None`。
fn skill_surface(kind: &AdapterKind, home: &Path) -> Option<(PathBuf, Vec<u8>)> {
    let channel = channel(adapter_channel_id(kind)?)?;
    Some((
        channel_skill_path(home, channel),
        channel_skill_bytes(channel),
    ))
}

/// 适配器种类 → 注册通道 id：新通道在 adapters 注册表加一行，这里自动跟随。
///
/// 派发（skill 装载）与 runner（启动生产者）共用这一份映射——两处各写一份，
/// 新种类就要在两个地方同时想起它。L0 没有 skill 目录；Codex／Hermes 还没有
/// 通道。
pub(crate) fn adapter_channel_id(kind: &AdapterKind) -> Option<&'static str> {
    match kind {
        AdapterKind::KimiCode => Some("kimi-print"),
        AdapterKind::ClaudeCode => Some("claude-print"),
        AdapterKind::Pi => Some("pi-print"),
        AdapterKind::L0 | AdapterKind::Codex | AdapterKind::Hermes => None,
    }
}

/// 派发一次改写请求：从一个开着的项目出发。
///
/// **资料、接续与装载的事实都要在 host 借走 store 之前查完。** 接续与协议
/// 装载住在 Config 与工作区里，不在请求里：请求只带作者点的东西（范围、
/// 要求、勾选的资料路径）。
///
/// 派发要把选中的原文对回块 id，而块 id 只存在于打开着的那份稿子里——与收取
/// 同一条理由。稿子没打开就具名拒绝，而不是拿磁盘上的字节顶替。
///
/// # Errors
///
/// 稿子没打开、资料解析不出来、host 拒绝，以及 [`dispatch_round`] 的全部
/// 拒绝。
pub fn dispatch(
    entry: &mut ProjectEntry,
    config: &Config,
    request: &DispatchRequest,
) -> Result<Dispatched, RefrainError> {
    let manuscript = manuscript_of(entry, &request.document, "dispatch")?;
    let materials = resolve_materials(&mut entry.store, &request.materials)?;
    let context = DirectoryContext::new(entry.store.layout().state_dir.clone());
    let mut round = round_facts(config, &context, request, materials)?;
    // 增量带稿的裁决行也在借走之前查：它读的是账本。
    round.changes = carry_changes(&entry.store, request)?;
    let mut host = crate::host_session::open(&mut entry.store)?;
    dispatch_round(&mut host, &manuscript, request, &round)
}

/// 预览一次派发：与 [`dispatch`] 同一批事实、同一份装配，但不碰编排状态
/// ——预览不铸 Run。作者送出时把这份 digest 带回（`expected_digest`），
/// 对不上就是预览之后稿子或资料变了，派发具名拒绝。
///
/// # Errors
///
/// 与 [`dispatch`] 相同，不含 host 的拒绝。
pub fn preview(
    entry: &mut ProjectEntry,
    config: &Config,
    request: &DispatchRequest,
) -> Result<DispatchPackage, RefrainError> {
    let manuscript = manuscript_of(entry, &request.document, "preview a dispatch on")?;
    let materials = resolve_materials(&mut entry.store, &request.materials)?;
    let context = DirectoryContext::new(entry.store.layout().state_dir.clone());
    let mut round = round_facts(config, &context, request, materials)?;
    // 与 [`dispatch`] 同一份装配：预览看到的包与送出的是同一条规则算出来的，
    // 增量带稿的裁决行也不例外。
    round.changes = carry_changes(&entry.store, request)?;
    preview_round(&manuscript, request, &round)
}

/// 要改的那份稿子，按值取出。没打开就具名拒绝：磁盘上那份可能已经被
/// 别处改过，而块 id 只在打开着的稿子上成立。
fn manuscript_of(
    entry: &ProjectEntry,
    document: &str,
    action: &str,
) -> Result<Manuscript, RefrainError> {
    entry.manuscripts.get(document).cloned().ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            format!("{action} a manuscript that is not open"),
            document.to_owned(),
        )
    })
}

/// 增量带稿（`CarryMode::Diff`）的裁决行：这份文档账本里还成立的裁决，
/// 按决定先后排。其余带稿模式是空——旧载荷旧行为。
fn carry_changes(
    store: &ProjectStore,
    request: &DispatchRequest,
) -> Result<Vec<refrain_core::ChangeEntry>, RefrainError> {
    if request.carry != CarryMode::Diff {
        return Ok(Vec::new());
    }
    let records = store
        .ledger()
        .for_document(&request.document)
        .map_err(crate::journal::into_domain_store)?;
    Ok(verdict_changes(&records))
}

/// 派发的三步本身：轮一级的缝，收一份已经查好的 [`RoundFacts`]。
///
/// 三步都在这里发生，但每一步的拒绝都来自领域层：范围对不上是这里的
/// `ScopeMoved`／`ScopeAmbiguous`，其余（任务已关闭、Run 不可授权）由
/// `HostRefusal` 给出。
///
/// 与 [`dispatch`] 分开是因为两者回答不同的问题：那一条是「从一个开着的项目
/// 出发」，这一条是「三步的次序与它们的拒绝」——后者是 `tests/dispatch.rs`
/// 逐条问的那个缝，不需要一个真实的项目。
///
/// # Errors
///
/// agent 数为零、范围为空、范围对不上、digest 不匹配，以及 host 的拒绝。
pub fn dispatch_round(
    host: &mut AgentHost<StoreJournal<'_>, DirectoryContext>,
    manuscript: &Manuscript,
    request: &DispatchRequest,
    round: &RoundFacts,
) -> Result<Dispatched, RefrainError> {
    if request.agents == 0 {
        return Err(RefrainError::new(
            ErrorCode::StateUnavailable,
            "dispatch to nobody",
            "a dispatch needs at least one agent",
        ));
    }
    if request.scopes.is_empty() {
        return Err(RefrainError::new(
            ErrorCode::StateUnavailable,
            "dispatch without a scope",
            "select the text to be rewritten first",
        ));
    }

    let package = prepare_package(manuscript, request, round)?;
    // 送前核对：预览答复里的 digest 与刚编译出来的不一致，就是预览之后
    // 稿子或资料变了——具名拒绝，让作者重新预览，而不是把过期的那一份
    // 送出去花掉一次真实调用。
    if let Some(expected) = &request.expected_digest
        && *expected != package.digest
    {
        return Err(RefrainError::new(
            ErrorCode::StateUnavailable,
            "dispatch with a stale preview",
            format!(
                "previewed {}, but the package now digests as {}",
                expected, package.digest
            ),
        ));
    }

    // 基线是提案冻结时的文本头（revision id），不是第一块的 id：提交裁决时
    // 校验的就是 `proposal.baseline() != head.id`——用块 id 做基线，派发→
    // 收取→提交的全链在提交处必被 StaleProposal 拒（k3_full_flow 抓出）。
    let baseline = manuscript.head().id();
    host.execute(HostCommand::DraftTask {
        baseline,
        document: request.document.clone(),
        prompt: request.prompt.clone(),
        context_digest: package.digest.clone(),
    })
    .map_err(into_domain_host)?;
    let task_id = host
        .tasks()
        .last()
        .ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "authorize a dispatch",
                "the task did not open",
            )
        })?
        .id;

    let runs_before = host.runs().len();
    // 具名 Agent 的 Run 全部挂在它自己的目录下：Memo.md 与 AGENTS.md 按
    // agent id 找，每轮换一个新 id 等于每次都以新身份相见，接续轮永远
    // 不发生。一次派发多个 Run 时它们是同一个 Agent 的几路——身份只有
    // 一份，所以 id 也只有一份。
    let agents: Vec<Id> = match request.agent {
        Some(agent) => vec![agent; request.agents],
        None => (0..request.agents).map(|_| Id::new()).collect(),
    };
    // 并列的 Run 之间没有边：它们读同一份请求、各写各的产出，谁先谁后
    // 不改变结果。其余两种排法把边算出来——位置由这里定，界面因此不必
    // 知道 Run 会以什么顺序铸出来。
    let edges = edges_for(request.orchestration, request.agents);
    let digest = package.digest.clone();
    let prefix_bytes = package.prefix_bytes;
    authorize(host, task_id, agents, edges, package, &digest)?;

    let runs: Vec<Id> = host
        .runs()
        .iter()
        .skip(runs_before)
        .map(|run| run.id)
        .collect();
    Ok(Dispatched {
        runs,
        digest,
        prefix_bytes,
    })
}

/// 预览的编译本身：定位范围、编译请求包，不动编排状态。轮一级的缝，
/// 与 [`dispatch_round`] 成对。
///
/// 与 [`dispatch_round`] 共用同一份顺序知识（`prepare_package`）——预览看到的
/// digest 与送出时核对的 digest 因此必然是同一条规则算出来的。这正是
/// 「送前核对」的读法：清单（各节名字/来源/字节/token）加 digest 前 12 位。
///
/// # Errors
///
/// 范围为空、范围对不上（`ScopeMoved`／`ScopeAmbiguous`）与资料不在册都在这里
/// 失败——这些拒绝发生在花掉一次真实调用之前。
pub fn preview_round(
    manuscript: &Manuscript,
    request: &DispatchRequest,
    round: &RoundFacts,
) -> Result<DispatchPackage, RefrainError> {
    if request.scopes.is_empty() {
        return Err(RefrainError::new(
            ErrorCode::StateUnavailable,
            "preview a dispatch without a scope",
            "select the text to be rewritten first",
        ));
    }
    prepare_package(manuscript, request, round)
}

/// 定位一个派发范围：块段在场按块 id 取，缺席走文本定位。
///
/// 两条路径的拒绝各自具名：文本路径的 Moved/Ambiguous 与块段路径的
/// 「起始块没了」是不同的事实，作者要做的事不一样。
fn resolve_scope(
    manuscript: &Manuscript,
    scope: &DispatchScope,
) -> Result<BeforeScope, RefrainError> {
    if let Some(span) = &scope.blocks {
        return block_span_scope(manuscript, scope, span);
    }
    let blocks = match locate_scope(manuscript, &scope.before) {
        ScopeLocation::Unique(blocks) => blocks,
        ScopeLocation::Moved => {
            return Err(RefrainError::new(
                ErrorCode::StateUnavailable,
                "dispatch a scope that is no longer in the manuscript",
                scope.label.clone(),
            ));
        }
        // 重复段落不替作者选。默认第一处会把提案落在另一段上（F-02），
        // 而两段逐字相同，界面上分辨不出选错了。
        ScopeLocation::Ambiguous(candidates) => {
            return Err(RefrainError::new(
                ErrorCode::StateUnavailable,
                "dispatch a scope whose text appears more than once",
                format!("{}: {} places", scope.label, candidates.len()),
            ));
        }
    };
    Ok(BeforeScope {
        scope: scope.label.clone(),
        text: scope.before.clone(),
        blocks,
    })
}

/// 块段路径：从起始块起取连续 `count` 块，id 与拼回的原文一起进
/// `BeforeScope`。原文由 Rust 拼——界面送的是空串，它引用的只是块 id。
fn block_span_scope(
    manuscript: &Manuscript,
    scope: &DispatchScope,
    span: &ScopeSpan,
) -> Result<BeforeScope, RefrainError> {
    if span.count == 0 {
        return Err(RefrainError::new(
            ErrorCode::StateUnavailable,
            "dispatch a scope of zero blocks",
            scope.label.clone(),
        ));
    }
    let blocks = manuscript.head().blocks();
    // 起始序号越出稿子与序号漂移落在同一句拒绝上：对作者都是同一件事——
    // 手上的清单过期了，重读一次 ReadBlocks 再指。
    let start = span.from as usize;
    if start >= blocks.len() {
        return Err(RefrainError::new(
            ErrorCode::StateUnavailable,
            "dispatch a scope whose start block is no longer in the manuscript",
            scope.label.clone(),
        ));
    }
    // 剩余不足 count 就取到末尾：作者指名的是「从这里起的这些块」，
    // 不是「必须恰好这么多块」。
    let taken: Vec<&Block> = blocks
        .iter()
        .skip(start)
        .take(span.count as usize)
        .collect();
    Ok(BeforeScope {
        scope: scope.label.clone(),
        text: join_block_texts(manuscript, taken.iter().copied()),
        blocks: taken.iter().map(|block| block.id()).collect(),
    })
}

/// 整份稿子的文本：块按这份稿子自己的分隔符拼回。
///
/// `TextHead::text()` 不能复用——它写死散文分隔符（两个换行），纯文本
/// 稿子会被拼出它从未有过的字节。分隔符知识归 `scan().separator()`
/// （与 `locate_scope` 同一来源），这里不再造一份。
fn full_text(manuscript: &Manuscript) -> String {
    join_block_texts(manuscript, manuscript.head().blocks().iter())
}

/// 块文本按这份稿子自己的分隔符拼接。
fn join_block_texts<'a>(
    manuscript: &Manuscript,
    blocks: impl Iterator<Item = &'a Block>,
) -> String {
    let join = manuscript.scan().separator();
    let mut out = String::new();
    for (index, block) in blocks.enumerate() {
        if index > 0 {
            out.push_str(join);
        }
        out.push_str(block.text());
    }
    out
}

/// 定位范围并编译请求包：预览与送出共用的前半程。
fn prepare_package(
    manuscript: &Manuscript,
    request: &DispatchRequest,
    round: &RoundFacts,
) -> Result<DispatchPackage, RefrainError> {
    // 先定位，再编译。顺序是规则：一份指向不存在文本的请求，agent 会照着
    // 改，而收取时才发现对不上——那时它已经花掉了一次真实的调用。
    let mut scopes = Vec::with_capacity(request.scopes.len());
    for scope in &request.scopes {
        scopes.push(resolve_scope(manuscript, scope)?);
    }

    Ok(compile(&DispatchInput {
        // 身份只在手动通道下进请求。Harness 通道靠 `AGENTS.md`——那边
        // 已经有全文，这边再带一份就是两个会漂移的权威。
        persona: match request.channel {
            DispatchChannel::Manual => request.persona.as_ref().map(|p| p.body().to_string()),
            DispatchChannel::Harness => None,
        },
        installed_skill: round.installed_skill.clone(),
        resumed: round.resumed,
        // 带稿模式：Full 带全文、Diff 带裁决行、None 都不带（旧行为）。
        manuscript: match request.carry {
            CarryMode::Full => Some(full_text(manuscript)),
            CarryMode::Diff | CarryMode::None => None,
        },
        changes: match request.carry {
            CarryMode::Diff => round.changes.clone(),
            CarryMode::Full | CarryMode::None => Vec::new(),
        },
        materials: round.materials.clone(),
        // 上游产出不进冻结包：授权那一刻上游多半还没跑完，它有的写才有
        // 的喂。它在提升之后经 `feed_upstream` 进工作区里的那一份。
        upstream: Vec::new(),
        request: request.prompt.clone(),
        scopes,
        result_path: request.result_path.clone(),
        max_bytes: request.max_bytes,
        contract_mode: match request.channel {
            // L0 没有会话：短契约随每轮走，接续与装载都与它无关（§8.4）。
            DispatchChannel::Manual => ContractMode::Short,
            DispatchChannel::Harness => match (&round.installed_skill, round.resumed) {
                // 已装载的接续轮：协议在 skill 目录、记忆在 Memo.md，都在
                // Agent 自己那边，请求只带一行指针。
                (Some(_), true) => ContractMode::Pointer,
                // 已装载的首轮：Full 档读到 Current 的装载会自己收成一行
                // 指向协议文件的话（协议装载，SPEC 8.4）。
                (Some(_), false) => ContractMode::Full,
                // 未装载：维持既有规则，短契约照旧随轮走。
                (None, _) => ContractMode::Short,
            },
        },
    }))
}

/// 作者选的排法，铺成一串按位置的边。
///
/// 位置是「这一批新铸的 Run 里的第几个」，不是 Run id——铸出来之前它们
/// 还没有 id，这也是 `AuthorizeDispatch` 收位置而不收 id 的原因。
///
/// 三种排法各自的形状：
///
/// - `Alternates`：一条边也没有。「他们看不见彼此」正是没有边的含义。
/// - `Follows`：排成一串，第 n 个读第 n−1 个。第一个没有上游。
/// - `Verifies`：第一个写，其余都检查它——而不是排成一串检查链，
///   那会让第三个检查第二个的批注，而批注不是被检查的对象。
fn edges_for(orchestration: Orchestration, agents: usize) -> Vec<Option<RunEdge>> {
    (0..agents)
        .map(|position| match orchestration {
            Orchestration::Alternates => None,
            // 第一个总是没有上游：它得先写出点什么，别人才有得读。
            _ if position == 0 => None,
            Orchestration::Follows => Some(RunEdge::Follows {
                upstream: position - 1,
            }),
            Orchestration::Verifies => Some(RunEdge::Verifies { subject: 0 }),
        })
        .collect()
}

/// 授权那一步单独一个函数：它是人类裁决的落点，参数多而语义单一。
fn authorize(
    host: &mut AgentHost<StoreJournal<'_>, DirectoryContext>,
    task_id: Id,
    new_agents: Vec<Id>,
    edges: Vec<Option<RunEdge>>,
    package: DispatchPackage,
    clicked_digest: &str,
) -> Result<(), RefrainError> {
    host.execute(HostCommand::AuthorizeDispatch {
        task_id,
        new_agents,
        retry_runs: Vec::new(),
        edges,
        package,
        clicked_digest: clicked_digest.to_string(),
        // 授权时刻由调用方的时钟给。这里用 0 会让所有派发看起来同时发生，
        // 而 Run 的顺序正是靠它排的。
        authorized_at: now_seconds(),
    })
    .map_err(into_domain_host)
}

fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}
