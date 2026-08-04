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

use refrain_core::context_compiler::{
    BeforeScope, ContractMode, DispatchInput, DispatchPackage, compile,
};
use refrain_core::manuscript::Manuscript;
use refrain_core::persona::Persona;
use refrain_core::{ErrorCode, Id, RefrainError};
use refrain_host::host::{AgentHost, HostCommand};
use refrain_host::run_edge::RunEdge;
use refrain_host::staging::DirectoryContext;

use crate::journal::{StoreJournal, into_domain_host};
use crate::scope::{ScopeLocation, locate_scope};

/// 作者要派发的一段：正文的原文，以及它在稿子里的位置。
///
/// 只带原文而不带块 id：作者是在界面上框一段文字，块身份是 Rust 这边定位
/// 出来的。让界面送块 id 等于要求它先知道块怎么切——那是 `source_layout`
/// 的事，而且它切的方式会随格式变。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DispatchScope {
    /// 作者给这一段起的名字，出现在请求里当位置标签。
    pub label: String,
    /// 选中的原文，逐字节。
    pub before: String,
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

/// 派发一次改写请求。
///
/// 三步都在这里发生，但每一步的拒绝都来自领域层：范围对不上是这里的
/// `ScopeMoved`／`ScopeAmbiguous`，其余（任务已关闭、Run 不可授权）由
/// `HostRefusal` 给出。
pub fn dispatch(
    host: &mut AgentHost<StoreJournal<'_>, DirectoryContext>,
    manuscript: &Manuscript,
    request: &DispatchRequest,
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

    // 先定位，再编译。顺序是规则：一份指向不存在文本的请求，agent 会照着
    // 改，而收取时才发现对不上——那时它已经花掉了一次真实的调用。
    let mut scopes = Vec::with_capacity(request.scopes.len());
    for scope in &request.scopes {
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
        scopes.push(BeforeScope {
            scope: scope.label.clone(),
            text: scope.before.clone(),
            blocks,
        });
    }

    let package = compile(&DispatchInput {
        // 身份只在手动通道下进请求。Harness 通道靠 `AGENTS.md`——那边
        // 已经有全文，这边再带一份就是两个会漂移的权威。
        persona: match request.channel {
            DispatchChannel::Manual => request.persona.as_ref().map(|p| p.body().to_string()),
            DispatchChannel::Harness => None,
        },
        installed_skill: None,
        resumed: false,
        manuscript: None,
        changes: Vec::new(),
        materials: Vec::new(),
        upstream: Vec::new(),
        request: request.prompt.clone(),
        scopes,
        result_path: request.result_path.clone(),
        max_bytes: request.max_bytes,
        contract_mode: ContractMode::Short,
    });

    let baseline = manuscript
        .head()
        .blocks()
        .get(0)
        .map(|block| block.id())
        .unwrap_or_default();
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
    let agents: Vec<Id> = (0..request.agents).map(|_| Id::new()).collect();
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
