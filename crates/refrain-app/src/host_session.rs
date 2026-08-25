//! 一次编排会话：打开 `AgentHost`、做一件事、把状态按值取出来。
//!
//! # 接上哪个功能
//!
//! W8「use cases to `AgentHost`」的应用侧。F8 派发与 F9 审阅的每一次编排动作
//! ——执行一条命令、手动发射一条 Run、收取之后扫一遍等待中的下游——都从这里
//! 进；`runner` 的泵也是。
//!
//! # 这一层持有的不变量
//!
//! **host 借着 `&mut ProjectStore` 活，所以它必须在一个块作用域里开、用、放掉。**
//! 喂上游产出要重新拿到 store，锁不嵌套；此前四处调用各自遵守这条次序
//! （`application.rs` 的两条臂、`launch_awaiting_runs`、`runner`），每一处都
//! 抄了同一段注释——现在它只有一份。
//!
//! **发射一条 Run 是三步，缺一不可**：workspace 由 `staging::run_workspace`
//! 唯一算出（不各自 `format!`）、`host.execute(LaunchRun)`、放掉 host 之后
//! `upstream::feed_upstream`。一条只做了前两步的 Run 是「接力上游没读到」
//! 这类缺陷的成因，而它在运行时看起来完全正常。
//!
//! **状态门在 host，不在这里。** 手动发射的 `UpstreamNotTerminal` 与
//! `UpstreamWithoutArtifact` 具名上抛——「等上游」是作者要读到的实话；
//! 只有自动扫描（`launch_awaiting`）吞它们，因为「还没轮到」不是失败。
//!
//! # 能复用什么
//!
//! `launch_awaiting` 的准入判据（[`Admission`]）是两条扫描路径的差别所在：
//! 无条件版本一律 `Launch`，`runner` 那条按「谁伺候它」判三态。被拒的 Run
//! 由 [`Sweep`] 交回调用方落账——host 还借着 store 时写不进去，而落账与喂
//! 上游写的是不同的行，次序不相干。

use refrain_core::{Id, RefrainError};
use refrain_host::host::{
    AgentHost, DispatchAuthorization, HostCommand, HostRefusal, ReviewTask, Run,
};
use refrain_host::staging::DirectoryContext;
use refrain_store::project::ProjectStore;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::journal::{StoreJournal, into_domain_host};
use crate::root::ProjectEntry;

/// 一个 Root 的编排状态，按值取出。
///
/// **接上哪个功能**：步骤 7 的审阅、信箱、派发与 Run。
///
/// **在全局逻辑中负责什么**：`AgentHost` 借着 `ProjectStore` 活，出不了
/// 一次会话的作用域；这是它跨界那一刻的形状。命令的执行仍在
/// `AgentHost::execute`，这里只承载结果。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HostSnapshot {
    pub tasks: Vec<ReviewTask>,
    pub runs: Vec<Run>,
    pub authorizations: Vec<DispatchAuthorization>,
    pub runs_requiring_recovery: Vec<Id>,
    pub runs_awaiting_launch: Vec<Id>,
    /// 这个 Root 上一共有几个 Run，包括为了装进 ABI 而被丢掉的那些。
    ///
    /// **为什么不让界面数 `runs.len()`**：越界时 `truncate_output` 会丢最旧的
    /// Run，于是 `runs` 短于事实。界面数它得到的是「装得下的那些」，而作者
    /// 读成的是「一共这么多」——一个 Run 就此从他的世界里消失且无人报错。
    /// 由快照自己带上真实条数，截断因此变成可见事实而不是静默损失。
    pub run_total: usize,
}

/// 一条等待发射的 Run 该怎么办。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Admission {
    /// 发射它。
    Launch,
    /// 这一轮不发射，也不算失败——它留在 Authorized 等下一次。
    Skip,
    /// 这条 Run 永远不会有人起，具名记失败。
    Refuse { code: String, detail: String },
}

/// 一次扫描的结果：发射出去的，和被判定永远起不来的。
#[derive(Debug, Default)]
pub struct Sweep {
    /// 这一轮真的发射了的 Run。调用方据此分辨哪些 `Launching` 是本会话自己
    /// 提升的——host 每开一次都把账上的 `Launching` 全数放进恢复名单
    /// （§8.2-5），没有这份返回，刚提升的 Run 会被当成上一会话的残骸。
    pub launched: Vec<Id>,
    /// 被准入判据拒绝的 Run 与拒绝的理由，交给调用方落账。
    pub refused: Vec<(Id, String, String)>,
}

/// 在一个项目库上开一次编排。
///
/// # Errors
///
/// host 的状态读不回来（journal 损坏、staging 目录不可用）时具名失败。
pub fn open(
    store: &mut ProjectStore,
) -> Result<AgentHost<StoreJournal<'_>, DirectoryContext>, RefrainError> {
    let context = DirectoryContext::new(store.layout().state_dir.clone());
    AgentHost::open(StoreJournal { store }, context).map_err(into_domain_host)
}

/// 读这个 Root 的编排状态。
///
/// # Errors
///
/// 与 [`open`] 相同。
pub fn snapshot(entry: &mut ProjectEntry) -> Result<HostSnapshot, RefrainError> {
    let host = open(&mut entry.store)?;
    Ok(snapshot_of(&host))
}

/// 执行一条编排命令，交回执行之后的状态。
///
/// `LaunchRun` 多一个后续动作：请求提升之后，把上游产出喂进工作区里的那一份。
/// 只有这一条命令带它——无边的 Run 在 `feed_upstream` 里原样返回。
///
/// # Errors
///
/// host 的具名拒绝原样上抛（作者要读到「为什么不行」），喂上游的失败同理。
pub fn execute(
    entry: &mut ProjectEntry,
    command: HostCommand,
) -> Result<HostSnapshot, RefrainError> {
    let launched = match &command {
        HostCommand::LaunchRun { run_id, .. } => Some(*run_id),
        HostCommand::DraftTask { .. }
        | HostCommand::AuthorizeDispatch { .. }
        | HostCommand::CompleteDispatch { .. }
        | HostCommand::CollectAttempt { .. }
        | HostCommand::FailRun { .. }
        | HostCommand::CancelRun { .. }
        | HostCommand::RetryRun { .. }
        | HostCommand::CloseTask { .. } => None,
    };
    let snapshot = {
        let mut host = open(&mut entry.store)?;
        host.execute(command).map_err(into_domain_host)?;
        snapshot_of(&host)
    };
    // host 先放掉，store 才腾得出来：喂上游要重新打开一份 host 来读边与
    // workspace。它改的是工作区里的 request.md，不是编排状态，快照不受它
    // 影响。喂不进去不装没发生——一个没读到上游的 Follows Run，与没有边的
    // Run 做的是同一件事。
    if let Some(run_id) = launched {
        crate::upstream::feed_upstream(&mut entry.store, run_id)?;
    }
    Ok(snapshot)
}

/// 手动发射一条已授权的 Run（2.11）。
///
/// 与 [`execute`] 分开：那一条要调用方自己拼 workspace，而 workspace 的组成
/// 只有一个权威——界面只点名 run，布局由这里算。
///
/// # Errors
///
/// run 不在册时报 `UnknownRun`；状态门的拒绝（含「等上游」）具名上抛。
pub fn launch_run(entry: &mut ProjectEntry, run_id: Id) -> Result<HostSnapshot, RefrainError> {
    let snapshot = {
        let mut host = open(&mut entry.store)?;
        let Some(agent_id) = agent_of(&host, run_id) else {
            return Err(into_domain_host(HostRefusal::UnknownRun(run_id)));
        };
        let workspace = refrain_host::staging::run_workspace(agent_id, run_id);
        host.execute(HostCommand::LaunchRun { run_id, workspace })
            .map_err(into_domain_host)?;
        snapshot_of(&host)
    };
    crate::upstream::feed_upstream(&mut entry.store, run_id)?;
    Ok(snapshot)
}

/// 扫一遍等待发射的 Run，按准入判据发射。
///
/// 准入判据收 `(run_id, agent_id)`。「上游还没终态／还没有产出」在这里被吞掉
/// ——照常等待，不算失败；其余拒绝如实上抛。没发射成的 Run 留在 awaiting
/// （host 只 retain 成功的）。
///
/// # Errors
///
/// host 打不开、非上游类的拒绝、或喂上游失败时具名失败。
pub fn launch_awaiting(
    entry: &mut ProjectEntry,
    mut admit: impl FnMut(Id, Id) -> Admission,
) -> Result<Sweep, RefrainError> {
    let mut sweep = Sweep::default();
    {
        let mut host = open(&mut entry.store)?;
        // 按值取出再逐个发射：`execute` 要 &mut host，迭代借用不能跨过它。
        let awaiting = host.runs_awaiting_launch().to_vec();
        for run_id in awaiting {
            let Some(agent_id) = agent_of(&host, run_id) else {
                continue;
            };
            match admit(run_id, agent_id) {
                Admission::Launch => {}
                Admission::Skip => continue,
                Admission::Refuse { code, detail } => {
                    // host 还借着 store，落账要等出了这个作用域。
                    sweep.refused.push((run_id, code, detail));
                    continue;
                }
            }
            let workspace = refrain_host::staging::run_workspace(agent_id, run_id);
            match host.execute(HostCommand::LaunchRun { run_id, workspace }) {
                Ok(()) => sweep.launched.push(run_id),
                Err(
                    HostRefusal::UpstreamNotTerminal { .. }
                    | HostRefusal::UpstreamWithoutArtifact { .. },
                ) => {}
                Err(refusal) => return Err(into_domain_host(refusal)),
            }
        }
    }
    for run_id in &sweep.launched {
        crate::upstream::feed_upstream(&mut entry.store, *run_id)?;
    }
    Ok(sweep)
}

/// 这条 Run 归哪个 agent。workspace 的布局要它，准入判据也要它。
fn agent_of(host: &AgentHost<StoreJournal<'_>, DirectoryContext>, run_id: Id) -> Option<Id> {
    host.runs()
        .iter()
        .find(|run| run.id == run_id)
        .map(|run| run.agent_id)
}

/// 快照的形状只有一个权威：读与执行两条路径共用它，加字段时只改到一处。
fn snapshot_of(host: &AgentHost<StoreJournal<'_>, DirectoryContext>) -> HostSnapshot {
    let runs = host.runs().to_vec();
    HostSnapshot {
        tasks: host.tasks().to_vec(),
        // 截断发生在跨界那一层，所以真实条数要在这里记下——那之后
        // 就没人还知道原本有几个了。
        run_total: runs.len(),
        runs,
        authorizations: host.authorizations().to_vec(),
        runs_requiring_recovery: host.runs_requiring_recovery().to_vec(),
        runs_awaiting_launch: host.runs_awaiting_launch().to_vec(),
    }
}
