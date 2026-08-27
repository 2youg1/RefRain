// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 取消一次 Run。
//!
//! 这条流程的重量在一个判断：**这个 Run 现在能不能被取消**。答案取决于它当下
//! 处在哪一步，而每一种「不能」都是产品要对作者讲清的事实——正在启动的进程还
//! 没有句柄可以打断；已经派发出去但本机没有句柄的（应用重启过），要走恢复而不
//! 是假装取消成功。
//!
//! 它此前是 `lib.rs` 里一个 108 行的命令体，其中「执行取消并取回这条 Run」整段
//! 重复了两次——有活进程走一遍，没有走另一遍。重复的是同一件事，不同的只是它
//! 前面那道判断。

use refrain_core::{ErrorCode, Id, RefrainError};
use refrain_host::host::{
    AgentHost, FrozenContext, HostCommand, HostJournal, HostRefusal, Run, RunProgress,
};

use crate::journal::into_domain_host;

/// 一个不在活动表里的 Run 是否还能被取消。
///
/// 活动表里有它，说明本机正握着那个进程的句柄，取消总是成立的；这里回答的是
/// 另一半——表里没有它的时候。
///
/// # Errors
///
/// 正在启动、或已派发而本机没有句柄，都在这里拒绝并说明作者该做什么。
pub fn refuse_cancel_without_handle(progress: &RunProgress) -> Result<(), RefrainError> {
    match progress {
        RunProgress::Launching { .. } => Err(RefrainError::new(
            ErrorCode::StateUnavailable,
            "cancel a Run while its producer is starting",
            "try again after the launch settles",
        )),
        RunProgress::Dispatched { .. } => Err(RefrainError::new(
            ErrorCode::StateUnavailable,
            "cancel a Run without a live process handle",
            "the app may have restarted; recovery is required",
        )),
        RunProgress::Queued
        | RunProgress::Authorized { .. }
        | RunProgress::Completed { .. }
        | RunProgress::Failed { .. }
        | RunProgress::Cancelled => Ok(()),
    }
}

/// 在账本上把这个 Run 记为已取消，并取回它。
///
/// 取消之后必须能重新读到这条 Run：写下去而读不回来，说明账本与领域对不上，
/// 那是状态不可用而不是「取消成功」。
///
/// # Errors
///
/// host 拒绝这条命令，或写入之后找不回这条 Run。
pub fn cancel_and_read_back<J: HostJournal, C: FrozenContext>(
    host: &mut AgentHost<J, C>,
    run_id: Id,
    at: u64,
) -> Result<Run, RefrainError> {
    host.execute(HostCommand::CancelRun { run_id, at })
        .map_err(into_domain_host)?;
    host.runs()
        .iter()
        .find(|run| run.id == run_id)
        .cloned()
        .ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "find a cancelled run",
                run_id.to_string(),
            )
        })
}

/// 读出一个 Run 当前的进度，用来回答「它能不能被取消」。
///
/// # Errors
///
/// 这个 id 在账本上不存在。
pub fn progress_of<J: HostJournal, C: FrozenContext>(
    host: &AgentHost<J, C>,
    run_id: Id,
) -> Result<RunProgress, RefrainError> {
    host.runs()
        .iter()
        .find(|run| run.id == run_id)
        .map(|run| run.progress.clone())
        .ok_or_else(|| into_domain_host(HostRefusal::UnknownRun(run_id)))
}
