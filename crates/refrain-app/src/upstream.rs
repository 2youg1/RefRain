// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! 把上游的产出喂进下游刚提升的请求（Follows/Verifies 的另一半）。
//!
//! host 守住次序——下游不许在上游终态之前启动；这个模块守住内容——下游
//! 启动时，它的请求里真的有上游写下的全部字节。次序不是内容：一个排在
//! 后面却什么也没读到的 Run，与一个没有边的 Run 做的是同一件事。
//!
//! 时机在提升之后：冻结的请求是作者授权的东西，一个字都不能动；提升进
//! 工作区的那一份是系统给生产者的，上游一节加在它里面，插在 `# Request`
//! 之前——上游产出挨着这一轮真正要处理的东西。

use refrain_core::upstream_work::{UpstreamRelation, UpstreamWork};
use refrain_core::{ErrorCode, Id, RefrainError};
use refrain_host::host::{AgentHost, FrozenContext};
use refrain_host::run_edge::ResolvedEdge;
use refrain_host::staging::DirectoryContext;
use refrain_store::project::ProjectStore;

use crate::journal::StoreJournal;

/// 把上游一节写进这个 Run 工作区里的请求。没有边的 Run 原样返回。
///
/// # Errors
///
/// Run 不存在、上游产出读不到、请求还没提升进来，都在这里具名拒绝。
pub fn feed_upstream(store: &mut ProjectStore, run_id: Id) -> Result<bool, RefrainError> {
    let state_dir = store.layout().state_dir.clone();
    let host = AgentHost::open(
        StoreJournal { store },
        DirectoryContext::new(state_dir.clone()),
    )
    .map_err(crate::journal::into_domain_host)?;
    let context = DirectoryContext::new(state_dir);

    let run = host
        .runs()
        .iter()
        .find(|candidate| candidate.id == run_id)
        .ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "feed an upstream section",
                "run",
            )
        })?;
    let (upstream_id, relation) = match run.edge {
        Some(ResolvedEdge::Follows { upstream }) => (upstream, UpstreamRelation::Follows),
        Some(ResolvedEdge::Verifies { subject }) => (subject, UpstreamRelation::Verifies),
        // Alternates 与无边的 Run 没有上游可喂：这正是星形默认的含义。
        _ => return Ok(false),
    };
    let upstream = host
        .runs()
        .iter()
        .find(|candidate| candidate.id == upstream_id)
        .ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "feed an upstream section",
                "upstream run",
            )
        })?;

    let artifact = context
        .read_result(&upstream.workspace, upstream_id)
        .map_err(|error| {
            RefrainError::new(
                ErrorCode::Io,
                "read the upstream artifact",
                upstream.workspace.clone(),
            )
            .with_detail(error.to_string())
        })?
        .ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "read the upstream artifact",
                upstream.workspace.clone(),
            )
        })?;
    let artifact = String::from_utf8(artifact).map_err(|error| {
        RefrainError::new(
            ErrorCode::UnsupportedFormat,
            "read the upstream artifact as text",
            upstream.workspace.clone(),
        )
        .with_detail(error.to_string())
    })?;

    let request = context
        .read_workspace_request(&run.workspace)
        .map_err(|error| {
            RefrainError::new(
                ErrorCode::Io,
                "read the promoted request",
                run.workspace.clone(),
            )
            .with_detail(error.to_string())
        })?
        .ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "feed an upstream section before the request is promoted",
                run.workspace.clone(),
            )
        })?;

    let element = UpstreamWork {
        run: upstream_id,
        relation,
        artifact,
    }
    .to_contract_element();
    // `# Request` 是下游自己的那一节；上游贴着它，而不是埋在材料后面。
    let fed = request.replacen("# Request\n", &format!("{element}\n\n# Request\n"), 1);
    context
        .write_workspace_request(&run.workspace, &fed)
        .map_err(|error| {
            RefrainError::new(
                ErrorCode::Io,
                "write the fed request",
                run.workspace.clone(),
            )
            .with_detail(error.to_string())
        })?;
    Ok(true)
}
