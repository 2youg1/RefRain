//! host 的实体与 store 的行之间的翻译。
//!
//! host 用领域类型思考（ReviewTask、Run、DispatchAuthorization），store 存的是带索引列的
//! 行。两者中间需要一层翻译：把实体序列化进 `entity` 列、把用于查询的字段提到
//! 独立列上、读回来时再还原。
//!
//! 这一簇此前住在 `lib.rs`，于是「编排状态怎么落库」这件事只能连着一个 Tauri
//! 窗口一起验证。它既不属于 host（host 不认识数据库）也不属于 store（store 不
//! 认识 ReviewTask），正是用例层该拥有的接缝。
//!
//! 检验方案：`tests/journal.rs` 用一个内存 store 走完整轮回——写进去再读回来，
//! 断言实体逐字段相同、索引列与实体内部的值一致（两者不一致时查询会指向错的
//! 行，而实体本身看起来完全正常，这是最难靠肉眼发现的那种错）。

use refrain_core::{ErrorCode, RefrainError};
use refrain_host::host::{
    DispatchAuthorization, HostJournal, HostRefusal, HostState, ReviewTask, Run, RunProgress,
    TaskProgress,
};
use refrain_store::orchestration::{AuthorizationRow, RunRow, TaskRow};
use refrain_store::project::{ProjectFailure, ProjectStore};
use serde::Serialize;

/// store 的失败翻译成统一的领域错误。
///
/// 放在这里而不是桥上：这是 store 与领域之间的翻译，桥只是它最大的消费者。
/// 逐字来自原实现——凭记忆重写会漏分支，实测漏过一次（把 IdentityChanged 写成
/// 一个不存在的错误码，且少了 ChangedUnderneath / NotADocument / Io / Store 四支）。
#[must_use]
pub fn into_domain(failure: ProjectFailure) -> RefrainError {
    match failure {
        ProjectFailure::Domain(error) => error,
        ProjectFailure::RootMissing(path) => RefrainError::new(
            ErrorCode::NotADirectory,
            "adopt a Root",
            path.display().to_string(),
        ),
        ProjectFailure::IdentityChanged {
            path,
            stored,
            found,
        } => RefrainError::new(
            ErrorCode::StateUnavailable,
            "adopt a Root whose identity moved",
            path.display().to_string(),
        )
        .with_detail(format!("stored {stored}, found {found}")),
        ProjectFailure::ChangedUnderneath(_) => RefrainError::new(
            ErrorCode::StateUnavailable,
            "report a conflict as an error (a defect: conflicts are data)",
            "save",
        ),
        ProjectFailure::NotADocument(path) => RefrainError::new(
            ErrorCode::UnsupportedFormat,
            "open as a document",
            path.display().to_string(),
        ),
        ProjectFailure::Io { path, source } => {
            RefrainError::new(ErrorCode::Io, "file I/O", path.display().to_string())
                .with_detail(source.to_string())
        }
        ProjectFailure::Store(error) => RefrainError::new(
            ErrorCode::StateUnavailable,
            "project database",
            "refrain.db",
        )
        .with_detail(error.to_string()),
    }
}

/// host 的拒绝翻译成统一的领域错误。
#[must_use]
pub fn into_domain_host(refusal: HostRefusal) -> RefrainError {
    RefrainError::new(
        ErrorCode::StateUnavailable,
        "orchestrate a dispatch",
        refusal.to_string(),
    )
}

/// 把一个编排实体写成 JSON。失败是 Io：这一步不该发生，发生了就是磁盘或内存出事。
pub fn json_of<T: Serialize>(value: &T, what: &str) -> Result<String, RefrainError> {
    serde_json::to_string(value).map_err(|error| {
        RefrainError::new(ErrorCode::Io, "serialise orchestration state", what)
            .with_detail(error.to_string())
    })
}

/// 从 `entity` 列读回一个编排实体。
pub fn entity_of<T: serde::de::DeserializeOwned>(raw: &str, what: &str) -> Result<T, RefrainError> {
    serde_json::from_str(raw).map_err(|error| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "read orchestration state",
            what,
        )
        .with_detail(error.to_string())
    })
}

/// 任务进度的名字。
///
/// 一个权威、两个消费者：store 用它做查询索引列，桥用它投影给界面。分成两份写
/// 的话，索引里的 "open" 与界面上的 "open" 迟早会漂开。
#[must_use]
pub fn task_kind(progress: &TaskProgress) -> &'static str {
    match progress {
        TaskProgress::Draft => "draft",
        TaskProgress::Open { .. } => "open",
        TaskProgress::Closed { .. } => "closed",
    }
}

/// 一路进度的名字。同上：一个权威，store 与界面共用。
#[must_use]
pub fn run_kind(progress: &RunProgress) -> &'static str {
    match progress {
        RunProgress::Queued => "queued",
        RunProgress::Authorized { .. } => "authorized",
        RunProgress::Launching { .. } => "launching",
        RunProgress::Dispatched { .. } => "dispatched",
        RunProgress::Completed { .. } => "completed",
        RunProgress::Failed { .. } => "failed",
        RunProgress::Cancelled => "cancelled",
    }
}

pub fn task_row(task: &ReviewTask) -> Result<TaskRow, RefrainError> {
    Ok(TaskRow {
        id: task.id.to_string(),
        baseline: task.baseline.to_string(),
        progress_kind: task_kind(&task.progress).to_string(),
        entity: json_of(task, "task")?,
    })
}

pub fn run_row(run: &Run) -> Result<RunRow, RefrainError> {
    Ok(RunRow {
        id: run.id.to_string(),
        task_id: run.task_id.to_string(),
        agent_id: run.agent_id.to_string(),
        progress_kind: run_kind(&run.progress).to_string(),
        retry_of: run.retry_of.map(|id| id.to_string()),
        entity: json_of(run, "run")?,
    })
}

pub fn authorization_row(
    authorization: &DispatchAuthorization,
) -> Result<AuthorizationRow, RefrainError> {
    Ok(AuthorizationRow {
        id: authorization.id.to_string(),
        manifest_digest: authorization.manifest_digest.clone(),
        authorized_at: i64::try_from(authorization.authorized_at).unwrap_or(i64::MAX),
        entity: json_of(authorization, "authorization")?,
    })
}

/// refrain.db 上的日志接缝。
///
/// 新的一路与被重新授权的一路按「是否已存在」预先分开送到 store：store 会拒绝
/// 覆盖式插入，也会拒绝更新一条不存在的行，所以这个划分必须诚实——分错了不会
/// 悄悄写坏，而是当场失败。
pub struct StoreJournal<'a> {
    pub store: &'a mut ProjectStore,
}

impl HostJournal for StoreJournal<'_> {
    type Error = RefrainError;

    fn load(&self) -> Result<HostState, RefrainError> {
        let rows = self.store.host_rows().map_err(into_domain)?;
        Ok(HostState {
            tasks: rows
                .tasks
                .iter()
                .map(|row| entity_of(&row.entity, "task"))
                .collect::<Result<Vec<_>, _>>()?,
            runs: rows
                .runs
                .iter()
                .map(|row| entity_of(&row.entity, "run"))
                .collect::<Result<Vec<_>, _>>()?,
            authorizations: rows
                .authorizations
                .iter()
                .map(|row| entity_of(&row.entity, "authorization"))
                .collect::<Result<Vec<_>, _>>()?,
        })
    }

    fn append_task(&mut self, task: &ReviewTask) -> Result<(), RefrainError> {
        self.store
            .host_task_append(&task_row(task)?)
            .map_err(into_domain)
    }

    fn record_authorization(
        &mut self,
        task: &ReviewTask,
        runs: &[Run],
        authorization: &DispatchAuthorization,
    ) -> Result<(), RefrainError> {
        let mut new_runs = Vec::new();
        let mut reauthorized = Vec::new();
        for run in runs {
            if self
                .store
                .host_run_known(&run.id.to_string())
                .map_err(into_domain)?
            {
                reauthorized.push(run_row(run)?);
            } else {
                new_runs.push(run_row(run)?);
            }
        }
        self.store
            .host_authorization_record(
                &task_row(task)?,
                &new_runs,
                &reauthorized,
                &authorization_row(authorization)?,
            )
            .map_err(into_domain)
    }

    fn update_task(&mut self, task: &ReviewTask) -> Result<(), RefrainError> {
        self.store
            .host_task_update(&task_row(task)?)
            .map_err(into_domain)
    }

    fn update_run(&mut self, run: &Run) -> Result<(), RefrainError> {
        self.store
            .host_run_update(&run_row(run)?)
            .map_err(into_domain)
    }

    fn append_run(&mut self, run: &Run) -> Result<(), RefrainError> {
        self.store
            .host_run_append(&run_row(run)?)
            .map_err(into_domain)
    }
}
