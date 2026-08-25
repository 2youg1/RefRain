//! 生产者 runner（M9）：把已授权的 Run 一路推进到收取完成。
//!
//! # 为什么是泵（pump）而不是后台线程
//!
//! 原生宿主是同步 C ABI：界面每 2.5 秒经 `ReadHost` 轮询一次编排快照，正确性
//! 不许依赖任何必须存在的后台线程。所以 runner 的全部驱动都在一次泵里完成——
//! 非阻塞地把每条活动 Run 推进一步：
//!
//! 1. **发射**：`launch_servable_awaiting` 提升轮到的、且 runner 能伺候的
//!    已授权 Run（有连接、有通道的），`feed_upstream` 由它调用。L0 与匿名
//!    agent 留在 Authorized 等作者手动发射——手动往返的起点不变。
//! 2. **派发**：`Launching` 的 Run 按 Config 解析出连接，经 `HarnessAdapter::
//!    dispatch` 起进程，`CompleteDispatch` 记下回执。
//! 3. **扫状态**：本机握着句柄、账上却已离开 `Dispatched` 的 Run（作者取消
//!    了它）——杀整棵进程树。
//! 4. **收尾**：观察线程已结束的 Run，落 `result.md`（`land_result`，整字节
//!    重命名），再走与手动路径完全相同的 `collect_attempt`。收取条件暂不
//!    成立（文档没打开）的登记进 `pending_collect`，Run 留在 `Dispatched`
//!    等下一泵——它没失败，只是还没到收的时候。
//! 5. **重试**：`pending_collect` 里的 Run 每泵经同一条收取路重试。
//! 6. **清孤**：上游失败/取消且没留下产出时，它的 Follows／Verifies 下游永远
//!    等不到能发射的那天——记为 Failed 并写明原因，链条传递直到收敛。每泵
//!    都扫：上游也可能经 `HostCommand` 死掉，那条路不经过 runner。
//!
//! 线程只出现在一处：每条 Dispatched Run 的 `observe` 独占一个观察线程。它是
//! 实现细节而不是正确性支柱——进程崩溃或应用退出后，journal 里的 `Dispatched`
//! 由 §8.2-5 的恢复路径接管，与没有 runner 的世界一样。
//!
//! # 活动表
//!
//! `cancel.rs` 的「活动表」就是这里的 `in_flight`：本机握着句柄的 Run。表外的
//! `Dispatched`（重启后）走恢复，表内的取消在下一泵扫到状态时杀整棵树。

use std::collections::{HashMap, HashSet};
use std::io;
use std::thread::JoinHandle;

use refrain_core::{ErrorCode, Id, RefrainError};
use refrain_host::adapters::{
    DispatchSpec, HarnessAdapter, PrintAdapter, ProducerOutcome, channel,
};
use refrain_host::host::{FrozenContext, HostCommand, RunProgress};
use refrain_host::process::ProcessCancel;
use refrain_host::run_edge::ResolvedEdge;
use refrain_host::staging::DirectoryContext;
use refrain_store::config::Config;
use refrain_store::project::ProjectStore;

use crate::collect::Collected;
use crate::host_session::{self, Admission};
use crate::journal::into_domain_host;
use crate::root::ProjectEntry;

/// 一条 Run 的现场观察：观察线程，以及杀整棵进程树的凭据。
struct InFlight {
    observer: JoinHandle<io::Result<ProducerOutcome>>,
    cancel: ProcessCancel,
}

/// 一个 Root 的 runner 状态。
#[derive(Default)]
struct RootRunner {
    /// 活动表：本机握着句柄的 Run。`cancel.rs` 说的「活动表」就是这份。
    in_flight: HashMap<Id, InFlight>,
    /// 本会话自己提升（`LaunchRun`）过的 Run。host 每开一次都把账上的
    /// `Launching` 全数放进恢复名单（§8.2-5）——那名单说的是「上一会话
    /// 留下的」，而这份说的是「我放进那个状态的」，派发只跳过前者。
    launched: HashSet<Id>,
    /// 产出已落盘、但收取的结构条件当时不成立的 Run（典型：那份文档没
    /// 打开——块 id 只活在打开着的稿子里）。Run 留在 `Dispatched`，每泵
    /// 经同一条 `collect_attempt` 重试；文档重新打开的那一泵自然收下。
    /// 不记失败——它没失败，只是还没到收的时候。
    pending_collect: HashSet<Id>,
}

/// runner 的活动表，按 Root 再按 Run 索引。
///
/// 按 Root 分桶：一次泵只收尾自己 Root 的 Run——句柄是全局唯一的 id 索引，
/// 但收尾要写那个 Root 的 store，跨桶收尾等于拿甲项目的账本记乙项目的事。
#[derive(Default)]
pub struct Runner {
    roots: HashMap<String, RootRunner>,
}

/// 一次泵做过的事。Application 按它发 KARA 的安静事件，界面不直接读它。
#[derive(Debug, Default)]
pub struct PumpReport {
    /// 这一泵起进程并记下回执的 Run。
    pub dispatched: Vec<Id>,
    /// 收取完成的 Run 与它带来的提案数（KARA 的两种分量由它分辨）。
    pub completed: Vec<(Id, u32)>,
    /// 这一泵记为失败的 Run（派发失败、观察失败、收取失败、清孤）。
    pub failed: Vec<Id>,
}

/// 启动工厂：从 Config 与一个 agent 解析出它的启动通道。`None` 是 L0；
/// `(code, detail)` 是「这条 Run 永远不会有人起」的具名失败。
pub type ChannelFactory = dyn Fn(&Config, Id) -> Result<Option<LaunchChannel>, (String, String)>;

/// 一个 Run 的启动通道：适配器，加上连接与 agent 各自的额外 argv。
///
/// argv 与适配器一起从工厂出来：合并次序（连接在前、agent 在后，具体者赢）
/// 是 adapters 的规则，但两份原料来自 Config 的两张表——工厂把「从 Config
/// 到一次启动」的整条解析收成一处，测试因此能整体换掉它。
pub struct LaunchChannel {
    pub adapter: Box<dyn HarnessAdapter + Send>,
    pub connection_argv: Vec<String>,
    pub agent_argv: Vec<String>,
}

/// 从 Config 解析一个 agent 的启动通道。`None` 是 L0 文件通道：没有进程可
/// 起，作者手动往返——runner 不碰它，收取路径原样工作。匿名 agent（不在
/// Config 里的 id）同样是 L0：它从来不在名册上，本来就是手动往返的那
/// 一路，不是配置丢了。
///
/// 配置残缺的具名失败只留给「配过却配不上」的：agent 指向的连接不在名册、
/// 连接的适配器种类还没有通道。这种 Run 永远不会有人起，具名失败而不是
/// 永远占着 Authorized。
fn configured_channel(
    config: &Config,
    agent_id: Id,
) -> Result<Option<LaunchChannel>, (String, String)> {
    let Some(profile) = config.agents.iter().find(|agent| agent.id == agent_id) else {
        return Ok(None);
    };
    let Some(connection_id) = profile.connection_id else {
        return Ok(None);
    };
    let Some(connection) = config
        .harness_connections
        .iter()
        .find(|connection| connection.id == connection_id)
    else {
        return Err((
            "connection-unconfigured".to_string(),
            format!("connection {connection_id} is not in the config"),
        ));
    };
    let Some(channel_id) = crate::dispatch::adapter_channel_id(&connection.adapter) else {
        return Err((
            "channel-unsupported".to_string(),
            format!("adapter kind {:?} has no channel", connection.adapter),
        ));
    };
    let Some(channel) = channel(channel_id) else {
        return Err((
            "channel-unknown".to_string(),
            format!("no adapter registered as {channel_id}"),
        ));
    };
    Ok(Some(LaunchChannel {
        adapter: Box::new(PrintAdapter::for_connection(
            channel,
            connection.executable.clone(),
            &connection.env_allow,
        )),
        connection_argv: connection.argv.clone(),
        agent_argv: profile.argv.clone(),
    }))
}

/// 把一次失败记进 Run 的历史。失败先写进 host 再返回（与 collect 的 `fail`
/// 同一条纪律）：Run 的历史是产品要展示的事实，不能只活在返回值里。
fn record_failure(
    store: &mut ProjectStore,
    run_id: Id,
    code: &str,
    detail: &str,
    now: u64,
) -> Result<(), RefrainError> {
    let failure = if detail.is_empty() {
        code.to_string()
    } else {
        format!("{code}: {detail}")
    };
    host_session::open(store)?
        .execute(HostCommand::FailRun {
            run_id,
            failure,
            at: now,
        })
        .map_err(into_domain_host)
}

/// 推进这个 Root 的全部活动 Run 一步。非阻塞：起进程与收尾都只做能做的
/// 部分，做不完的留给下一泵。
///
/// # Errors
///
/// store 与 host 的结构性失败照常上抛；单个 Run 的失败记进它自己的历史
/// （`Failed`），不拖垮同泵的其他 Run。
pub fn pump(
    root_id: &str,
    entry: &mut ProjectEntry,
    runner: &mut Runner,
    config: &Config,
    now: u64,
) -> Result<PumpReport, RefrainError> {
    pump_with(root_id, entry, runner, config, now, &configured_channel)
}

/// 与 `pump` 同一台泵，启动通道由调用方给——测试用脚本化的适配器走完
/// 整条状态机，不依赖真 harness。
pub fn pump_with(
    root_id: &str,
    entry: &mut ProjectEntry,
    runner: &mut Runner,
    config: &Config,
    now: u64,
    channel_for: &ChannelFactory,
) -> Result<PumpReport, RefrainError> {
    let mut report = PumpReport::default();
    let state_dir = entry.store.layout().state_dir.clone();

    // 1. 发射轮到的、且本泵能伺候的已授权 Run（有连接、有通道的）。L0 与
    //    匿名 agent 留在 Authorized 等作者——手动往返的起点与 runner 出现
    //    之前相同。返回的这一批登记进 launched：它们进 `Launching` 是本会
    //    话放的，不属于恢复名单管的那一半。
    let newly_launched = launch_servable_awaiting(entry, config, channel_for, now, &mut report)?;

    let bucket = runner.roots.entry(root_id.to_string()).or_default();
    bucket.launched.extend(newly_launched);

    // 2. 派发：Launching、不在恢复名单（或虽是名单上的、却是本会话自己
    //    提升的）、本机还没握着句柄的 Run。
    let launching: Vec<(Id, Id, String)> = {
        let host = host_session::open(&mut entry.store)?;
        let recovery: Vec<Id> = host.runs_requiring_recovery().to_vec();
        host.runs()
            .iter()
            .filter(|run| {
                matches!(run.progress, RunProgress::Launching { .. })
                    && (!recovery.contains(&run.id) || bucket.launched.contains(&run.id))
                    && !bucket.in_flight.contains_key(&run.id)
            })
            .map(|run| (run.id, run.agent_id, run.workspace.clone()))
            .collect()
    };
    for (run_id, agent_id, workspace) in launching {
        let launch = match channel_for(config, agent_id) {
            Ok(Some(launch)) => launch,
            // L0：没有进程可起，作者手动往返。
            Ok(None) => continue,
            Err((code, detail)) => {
                record_failure(&mut entry.store, run_id, &code, &detail, now)?;
                report.failed.push(run_id);
                continue;
            }
        };
        let context = DirectoryContext::new(state_dir.clone());
        let request_md = context
            .read_workspace_request(&workspace)
            .map_err(|error| {
                RefrainError::new(
                    ErrorCode::Io,
                    "read the promoted request",
                    workspace.clone(),
                )
                .with_detail(error.to_string())
            })?;
        let Some(request_md) = request_md else {
            record_failure(
                &mut entry.store,
                run_id,
                "request-missing",
                "the promoted request is gone",
                now,
            )?;
            report.failed.push(run_id);
            continue;
        };
        let spec = DispatchSpec {
            run_id,
            workspace: state_dir.join(&workspace),
            request_md,
            connection_argv: launch.connection_argv,
            agent_argv: launch.agent_argv,
        };
        match launch.adapter.dispatch(&spec) {
            Ok(receipt) => {
                // 回执先落账（Launching → Dispatched），句柄才交给观察线程：
                // 顺序与 §8.2-3 一致，崩在中间留下的是恢复路径认得的状态。
                let cancel = receipt.handle.cancel_token();
                let receipt_id = receipt.receipt.clone();
                host_session::open(&mut entry.store)?
                    .execute(HostCommand::CompleteDispatch {
                        run_id,
                        receipt: receipt_id,
                    })
                    .map_err(into_domain_host)?;
                let adapter = launch.adapter;
                let observer = std::thread::spawn(move || adapter.observe(receipt));
                bucket
                    .in_flight
                    .insert(run_id, InFlight { observer, cancel });
                report.dispatched.push(run_id);
            }
            Err(error) => {
                record_failure(
                    &mut entry.store,
                    run_id,
                    "dispatch-failed",
                    &error.to_string(),
                    now,
                )?;
                report.failed.push(run_id);
            }
        }
    }

    // 3. 扫状态：本机握着句柄、账本上却已离开 Dispatched 的 Run（作者经
    //    HostCommand 取消了它）——杀整棵树，句柄丢出活动表。观察线程随
    //    EOF 自行结束，JoinHandle 丢弃即分离：正确性从不依赖它。
    let stale: Vec<Id> = {
        let host = host_session::open(&mut entry.store)?;
        bucket
            .in_flight
            .keys()
            .filter(|run_id| {
                !matches!(
                    host.runs()
                        .iter()
                        .find(|run| run.id == **run_id)
                        .map(|run| &run.progress),
                    Some(RunProgress::Dispatched { .. })
                )
            })
            .copied()
            .collect()
    };
    for run_id in stale {
        if let Some(flight) = bucket.in_flight.remove(&run_id) {
            // 取消不成立也要继续扫：Run 的账本状态已经是事实，树杀不掉是
            // 进程侧的事，不反过来改账。
            drop(flight.cancel.cancel_tree());
        }
    }

    // 4. 收尾：观察线程已结束的 Run。落 result.md → 与手动路径完全相同
    //    的 collect_attempt——收取的权威只有一处，runner 不长第二份判断。
    let finished: Vec<Id> = bucket
        .in_flight
        .iter()
        .filter(|(_, flight)| flight.observer.is_finished())
        .map(|(run_id, _)| *run_id)
        .collect();
    for run_id in finished {
        let Some(flight) = bucket.in_flight.remove(&run_id) else {
            continue;
        };
        // 收尾前再看一眼账本：观察跑着的时候作者可能取消了这条 Run。
        let still_dispatched = {
            let host = host_session::open(&mut entry.store)?;
            matches!(
                host.runs()
                    .iter()
                    .find(|run| run.id == run_id)
                    .map(|run| &run.progress),
                Some(RunProgress::Dispatched { .. })
            )
        };
        if !still_dispatched {
            continue;
        }
        let outcome = match flight.observer.join() {
            Ok(outcome) => outcome,
            Err(_) => {
                record_failure(
                    &mut entry.store,
                    run_id,
                    "observer-panicked",
                    "the observe thread panicked",
                    now,
                )?;
                report.failed.push(run_id);
                continue;
            }
        };
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => {
                record_failure(
                    &mut entry.store,
                    run_id,
                    "observe-failed",
                    &error.to_string(),
                    now,
                )?;
                report.failed.push(run_id);
                continue;
            }
        };
        if outcome.reply_text.is_empty() {
            record_failure(
                &mut entry.store,
                run_id,
                "producer-exited",
                &format!("exit code {:?} and no reply", outcome.exit_code),
                now,
            )?;
            report.failed.push(run_id);
        } else {
            let workspace = {
                let host = host_session::open(&mut entry.store)?;
                host.runs()
                    .iter()
                    .find(|run| run.id == run_id)
                    .map(|run| run.workspace.clone())
                    .ok_or_else(|| {
                        into_domain_host(refrain_host::host::HostRefusal::UnknownRun(run_id))
                    })?
            };
            let context = DirectoryContext::new(state_dir.clone());
            context
                .land_result(&workspace, run_id, outcome.reply_text.as_bytes())
                .map_err(|error| {
                    RefrainError::new(
                        ErrorCode::Io,
                        "land the producer's reply",
                        workspace.clone(),
                    )
                    .with_detail(error.to_string())
                })?;
            // 收取要把冻结原文对回块 id，而块 id 只活在打开着的稿子里——
            // 与 CollectRun 同一条理由，送当前打开的全部稿子。
            collect_landed(entry, bucket, run_id, now, &mut report)?;
        }
    }

    // 5. 重试待收取：产出早已落盘、收取条件当时不成立的 Run。账本先行——
    //    作者等不及取消了的，从名单拿掉；还收不下的留在名单里等下一泵。
    let pending: Vec<Id> = bucket.pending_collect.iter().copied().collect();
    for run_id in pending {
        let still_dispatched = {
            let host = host_session::open(&mut entry.store)?;
            matches!(
                host.runs()
                    .iter()
                    .find(|run| run.id == run_id)
                    .map(|run| &run.progress),
                Some(RunProgress::Dispatched { .. })
            )
        };
        if !still_dispatched {
            bucket.pending_collect.remove(&run_id);
            continue;
        }
        collect_landed(entry, bucket, run_id, now, &mut report)?;
    }

    // 6. 清孤每泵都扫，不只跟着 runner 自己的终态走：上游也可能经
    //    HostCommand（作者的取消/界面的命令）死掉，那条路不经过这里。
    //    函数本身幂等——没有新孤儿时它就是一次读。
    resolve_orphans(&mut entry.store, now, &mut report)?;

    Ok(report)
}

/// 收取一条产出已落盘的 Run，并在收下之后发射下游、清孤。
///
/// 收取的结构失败（文档没打开之类）不上抛：Run 没失败，只是还没到收的
/// 时候——登记进 `pending_collect`，它留在 `Dispatched` 等下一泵，账上
/// 不多一条失败记录。
fn collect_landed(
    entry: &mut ProjectEntry,
    bucket: &mut RootRunner,
    run_id: Id,
    now: u64,
    report: &mut PumpReport,
) -> Result<(), RefrainError> {
    let manuscripts = entry.manuscripts.clone();
    match crate::collect::collect_attempt(&mut entry.store, &manuscripts, run_id, now) {
        Ok(Collected::Completed { proposals, .. }) => {
            bucket.pending_collect.remove(&run_id);
            report.completed.push((run_id, proposals));
        }
        Ok(Collected::Failed { .. }) => {
            bucket.pending_collect.remove(&run_id);
            report.failed.push(run_id);
        }
        // 刚落盘的 result.md 立刻读不到：目录状态与账本对不上。
        Ok(Collected::Waiting) => {
            bucket.pending_collect.remove(&run_id);
            record_failure(
                &mut entry.store,
                run_id,
                "result-lost",
                "the landed result reads back as missing",
                now,
            )?;
            report.failed.push(run_id);
        }
        Err(_) => {
            bucket.pending_collect.insert(run_id);
            return Ok(());
        }
    }
    // 一条 Run 到了终态：等它的下游现在可能轮到。用无条件版本——与手动
    // `CollectRun` 收取成功后的那一发逐字对齐（2.2 回迁）：L0 下游被提升
    // 后等作者的手工产出，那是手动收取时本就有的形状。
    //
    // 这里发射的下游同样要登记进 launched：它与第一步发射的处在同一个
    // `Launching`，下一泵的恢复名单会把两者都装进去。
    let downstream = host_session::launch_awaiting(entry, |_run, _agent| Admission::Launch)?;
    bucket.launched.extend(downstream.launched);
    Ok(())
}

/// 发射轮到的、且 runner 能伺候的已授权 Run：解析得出启动通道的。
///
/// 次序纪律（host 判条件、吞「等上游」、发射成功才喂上游）在
/// `host_session::launch_awaiting`；这里只多一道**谁伺候它**的准入判：
///
/// - `Ok(Some)`：runner 起进程的，提升进 `Launching`，下一泵派发。
/// - `Ok(None)`：L0（无连接，含匿名 agent）。留在 Authorized 等作者手动
///   发射——`ProjectInput::LaunchRun` 那条臂是它的起点，runner 不代劳。
/// - `Err`：配过却配不上的（连接删了、种类没通道）。这条 Run 永远不会
///   有人起，具名记 Failed，不永远占着 Authorized。
///
/// 下游的自动发射不走这里：收取成功后的那一发（`collect_landed`）用无条件
/// 准入，与手动 `CollectRun` 的既有行为逐字对齐（2.2 回迁）——L0 下游被
/// 提升后等作者的手工产出，那是手动收取时本就有的形状。
fn launch_servable_awaiting(
    entry: &mut ProjectEntry,
    config: &Config,
    channel_for: &ChannelFactory,
    now: u64,
    report: &mut PumpReport,
) -> Result<Vec<Id>, RefrainError> {
    let sweep = host_session::launch_awaiting(entry, |_run, agent_id| {
        match channel_for(config, agent_id) {
            Ok(Some(_)) => Admission::Launch,
            Ok(None) => Admission::Skip,
            Err((code, detail)) => Admission::Refuse { code, detail },
        }
    })?;
    for (run_id, code, detail) in sweep.refused {
        record_failure(&mut entry.store, run_id, &code, &detail, now)?;
        report.failed.push(run_id);
    }
    Ok(sweep.launched)
}

/// 清孤：上游死了且没留下产出，等它的下游永远等不到发射那天。
///
/// 与 `LaunchRun` 的入口判同一条规则：上游 Failed／Cancelled 但留下了可读
/// 产出时，下游照常能发射（host 允许），不是孤儿；只有上游没留下任何字
/// 节时，下游才确定被搁浅。孤儿记为 Failed 并写明原因——Failed 不关闭
/// Task，重试还是收尾仍是作者的裁决。
///
/// 链条是传递的（C 跟 B、B 跟 A）：一遍清完 B 之后 C 才成为孤儿，所以
/// 循环到没有新孤儿为止。
fn resolve_orphans(
    store: &mut ProjectStore,
    now: u64,
    report: &mut PumpReport,
) -> Result<(), RefrainError> {
    loop {
        let orphans: Vec<(Id, String)> = {
            let context = DirectoryContext::new(store.layout().state_dir.clone());
            let host = host_session::open(store)?;
            let mut found = Vec::new();
            for run in host.runs() {
                let upstream_id = match run.edge {
                    Some(ResolvedEdge::Follows { upstream })
                    | Some(ResolvedEdge::Verifies { subject: upstream }) => upstream,
                    // Alternates 与无边的 Run 没有上游：星形默认的含义。
                    _ => continue,
                };
                let terminal = matches!(
                    run.progress,
                    RunProgress::Completed { .. }
                        | RunProgress::Failed { .. }
                        | RunProgress::Cancelled
                );
                if terminal {
                    continue;
                }
                let Some(upstream) = host
                    .runs()
                    .iter()
                    .find(|candidate| candidate.id == upstream_id)
                else {
                    continue;
                };
                let reason = match &upstream.progress {
                    RunProgress::Failed { failure } => format!("upstream-failed: {failure}"),
                    RunProgress::Cancelled => "upstream-cancelled".to_string(),
                    _ => continue,
                };
                // 与 LaunchRun 同一条判据：有产出的上游不算死。
                let artifact = context
                    .read_result(&upstream.workspace, upstream_id)
                    .map_err(|error| {
                        RefrainError::new(
                            ErrorCode::Io,
                            "read the upstream artifact",
                            upstream.workspace.clone(),
                        )
                        .with_detail(error.to_string())
                    })?;
                if artifact.is_some_and(|bytes| !bytes.is_empty()) {
                    continue;
                }
                found.push((run.id, reason));
            }
            found
        };
        if orphans.is_empty() {
            return Ok(());
        }
        let mut host = host_session::open(store)?;
        for (run_id, reason) in orphans {
            host.execute(HostCommand::FailRun {
                run_id,
                failure: reason,
                at: now,
            })
            .map_err(into_domain_host)?;
            report.failed.push(run_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 活动表按 Root 分桶：泵只收尾自己 Root 的 Run。
    #[test]
    fn the_live_table_is_scoped_per_root() {
        let mut runner = Runner::default();
        runner.roots.entry("root-a".to_string()).or_default();
        runner.roots.entry("root-b".to_string()).or_default();
        assert_eq!(runner.roots.len(), 2);
    }
}
