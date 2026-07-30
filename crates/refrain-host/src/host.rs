//! The AgentHost state machine (SPEC 8.1, 8.2, 8.4b).
//!
//! One writer for every orchestration fact (INV-12): ReviewTask, Run,
//! DispatchAuthorization. The dispatch protocol is intent-atomic, not
//! external-effect-atomic: a partially dispatched Task never rolls back the
//! Runs already outside (§8.2-4). An adapter returns Receipt/Outcome facts;
//! it never writes a Run.
//!
//! Two seams, each a trait because two implementations exist: the store's
//! journal in production and an in-memory one in these tests (AGENTS: a trait
//! requires a second existing implementation).
//!
//! Ordering the protocol enforces (§8.2):
//!
//! 1. **Pre-check**: the digest the author clicked equals the digest of the
//!    package the command layer re-compiled at click time — drift kills the
//!    authorization before any Run exists (INV-14).
//! 2. **Staging**: the manifest snapshot and one frozen request per Run land
//!    in the host-private directory, fsync'd, producer-invisible.
//! 3. **Atomic authorization**: one journal call records the authorization,
//!    every Run `Queued→Authorized`, and the Task transition — one Store
//!    transaction in production.
//! 4. **Per-Run launch**: `Authorized→Launching` persists first, then the
//!    staged request is promoted into the Run workspace (atomic rename), then
//!    the adapter is called. Failure lands as `Failed` with its reason; no
//!    rollback of anything already outside.
//! 5. **Restart recovery**: `Authorized` runs await the author (continue or
//!    cancel — continuing re-verifies the staged request, missing blocks);
//!    `Launching`/`Dispatched` are reported as recovery-required; terminal
//!    states never regress; nothing auto-resumes.
//!
//! Task closure: a Task closes `RunsTerminal` when every Run is `Completed`
//! or `Cancelled`. A `Failed` Run never closes its Task — it waits for the
//! author's retry-or-close judgment, and retry is always a new Run, a new
//! workspace, and a new authorization (§8.4b).

use refrain_core::Id;
use refrain_core::context_compiler::DispatchPackage;
use serde::{Deserialize, Serialize};

/// Which Runs an authorization covers.
///
/// Minted Runs are new and open their Task; retried Runs already exist and
/// their Task is already Open. Both halves stage, journal, and record an
/// authorization identically — only the Run bookkeeping differs, and saying so
/// as two variants keeps the two paths from drifting the way they had.
enum Authorized {
    Minted(Vec<Id>),
    Retried(Vec<Id>),
}

impl Authorized {
    fn ids(&self) -> &[Id] {
        match self {
            Self::Minted(ids) | Self::Retried(ids) => ids,
        }
    }
}

/// The token the compiler leaves where each Run's own id belongs (the result
/// path inside the Reply-format section). Staging substitutes it, byte-exact,
/// before the request is frozen.
pub const RUN_ID_PLACEHOLDER: &str = "<run-id>";

/// What a Task is: the author's one dispatched collaboration, baseline-pinned
/// at enqueue (Q27). No agentId — a Task is shared by every Run of its round.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewTask {
    pub id: Id,
    pub baseline: Id,
    /// The document this collaboration addresses (Root-relative path).
    pub document: String,
    pub prompt: String,
    pub context_digest: String,
    pub progress: TaskProgress,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "kind", content = "value")]
pub enum TaskProgress {
    Draft,
    Open { opened_at: u64 },
    Closed { reason: CloseReason, closed_at: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloseReason {
    RunsTerminal,
    Author,
}

/// A Run: one agent's one execution of one Task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: Id,
    pub task_id: Id,
    pub agent_id: Id,
    /// Digest of the frozen dispatch package this Run executes against.
    pub snapshot_digest: String,
    pub workspace: String,
    pub progress: RunProgress,
    pub retry_of: Option<Id>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum RunProgress {
    Queued,
    Authorized { request_digest: String },
    Launching { request_digest: String },
    Dispatched { receipt: String },
    Completed { artifact_digest: String },
    Failed { failure: String },
    Cancelled,
}

/// The immutable authorization: what the author clicked, exactly (INV-14).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchAuthorization {
    pub id: Id,
    pub run_ids: Vec<Id>,
    pub manifest_path: String,
    pub manifest_digest: String,
    pub authorized_at: u64,
}

/// The world as the journal remembers it: every task, run, authorization.
#[derive(Debug, Default)]
pub struct HostState {
    pub tasks: Vec<ReviewTask>,
    pub runs: Vec<Run>,
    pub authorizations: Vec<DispatchAuthorization>,
}

/// The journal seam: load the world, append one fact. The store implements
/// it over refrain.db; the tests implement it over a Vec.
pub trait HostJournal {
    type Error: std::fmt::Display;
    fn load(&self) -> Result<HostState, Self::Error>;
    fn append_task(&mut self, task: &ReviewTask) -> Result<(), Self::Error>;
    /// §8.2-2: the authorization, its Runs, and the Task transition land in
    /// one transaction or not at all.
    fn record_authorization(
        &mut self,
        task: &ReviewTask,
        runs: &[Run],
        authorization: &DispatchAuthorization,
    ) -> Result<(), Self::Error>;
    fn update_task(&mut self, task: &ReviewTask) -> Result<(), Self::Error>;
    fn update_run(&mut self, run: &Run) -> Result<(), Self::Error>;
    /// A retry Run joins the world on its own (§8.4b); its authorization
    /// arrives later through `record_authorization`.
    fn append_run(&mut self, run: &Run) -> Result<(), Self::Error>;
}

/// What staging produced: the manifest snapshot's path and each staged
/// request's digest, hashed from the bytes that actually landed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedDispatch {
    pub manifest_path: String,
    pub request_digests: Vec<(Id, String)>,
}

/// The frozen context seam: the compiler's output for one dispatch, kept in
/// the host-private directory until a Run's launch promotes it.
pub trait FrozenContext {
    type Error: std::fmt::Display;
    /// Stage the immutable manifest snapshot and one request per Run,
    /// fsync'd, producer-invisible (§8.2-1).
    fn stage(
        &mut self,
        package: &DispatchPackage,
        requests: &[(Id, String)],
    ) -> Result<StagedDispatch, Self::Error>;
    /// Promote the staged request and its manifest snapshot into the Run
    /// workspace. Atomic rename (§8.2-3): the producer never sees a partial
    /// request.
    fn promote_request(
        &mut self,
        run_id: Id,
        workspace: &str,
        manifest_digest: &str,
    ) -> Result<(), Self::Error>;
    /// Whether the staged request for a Run still exists and hashes to the
    /// digest the authorization froze (§8.2-5: missing blocks; the host
    /// never rebuilds from current state).
    fn staged_request_matches(&self, run_id: Id, digest: &str) -> Result<bool, Self::Error>;
}

/// Every command the host takes. Timestamps arrive as payload: the host has
/// no clock of its own, so its facts stay deterministic and replayable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostCommand {
    DraftTask {
        baseline: Id,
        document: String,
        prompt: String,
        context_digest: String,
    },
    /// One command, two shapes (§8.2-2): on a Draft Task the first
    /// authorization mints one Run per agent and opens the Task; on an Open
    /// Task only existing Queued retry Runs may be authorized — an Open Task
    /// never takes a fresh agent.
    AuthorizeDispatch {
        task_id: Id,
        new_agents: Vec<Id>,
        retry_runs: Vec<Id>,
        package: DispatchPackage,
        clicked_digest: String,
        authorized_at: u64,
    },
    LaunchRun {
        run_id: Id,
        workspace: String,
    },
    CompleteDispatch {
        run_id: Id,
        receipt: String,
    },
    CollectAttempt {
        run_id: Id,
        artifact_digest: String,
        at: u64,
    },
    FailRun {
        run_id: Id,
        failure: String,
        at: u64,
    },
    CancelRun {
        run_id: Id,
        at: u64,
    },
    RetryRun {
        run_id: Id,
    },
    CloseTask {
        task_id: Id,
        at: u64,
    },
}

/// Every refusal.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HostRefusal {
    #[error("task {0} does not exist")]
    UnknownTask(Id),
    #[error("run {0} does not exist")]
    UnknownRun(Id),
    #[error("task {0} is closed")]
    TaskClosed(Id),
    #[error("task {0} is open: only queued retry runs may be authorized")]
    TaskOpenRejectsNewAgents(Id),
    #[error("task {0} is draft: its first authorization mints runs from agents")]
    TaskDraftHasNoRuns(Id),
    #[error("task {0} names no run to authorize")]
    NothingToAuthorize(Id),
    #[error("run {0} is not authorized")]
    RunNotAuthorized(Id),
    #[error("run {0} is not queued")]
    RunNotQueued(Id),
    #[error("run {0} is not launching")]
    RunNotLaunching(Id),
    #[error("run {0} is not dispatched")]
    RunNotDispatched(Id),
    #[error("run {0} is terminal")]
    RunTerminal(Id),
    #[error("run {0} is not cancellable in its current state")]
    RunNotCancellable(Id),
    #[error("run {0} is not retryable in its current state")]
    RunNotRetryable(Id),
    #[error("run {0}'s staged request is gone or changed: the launch is blocked, not rebuilt")]
    StagingLost(Id),
    #[error(
        "manifest digest drifted: the click authorised {expected}, the recompile holds {actual}"
    )]
    AuthorizationDrift { expected: String, actual: String },
    #[error("journal: {0}")]
    Journal(String),
    #[error("context: {0}")]
    Context(String),
}

/// The whole orchestration state, journal-backed.
pub struct AgentHost<J: HostJournal, C: FrozenContext> {
    journal: J,
    context: C,
    tasks: Vec<ReviewTask>,
    runs: Vec<Run>,
    authorizations: Vec<DispatchAuthorization>,
    /// Runs found `Launching`/`Dispatched` at open (§8.2-5).
    recovery_required: Vec<Id>,
    /// Runs found `Authorized` at open: the author continues or cancels.
    awaiting_launch: Vec<Id>,
}

impl<J: HostJournal, C: FrozenContext> AgentHost<J, C> {
    pub fn open(journal: J, context: C) -> Result<Self, HostRefusal> {
        let HostState {
            tasks,
            runs,
            authorizations,
        } = journal
            .load()
            .map_err(|error| HostRefusal::Journal(error.to_string()))?;
        let recovery_required = runs
            .iter()
            .filter(|run| {
                matches!(
                    run.progress,
                    RunProgress::Launching { .. } | RunProgress::Dispatched { .. }
                )
            })
            .map(|run| run.id)
            .collect();
        let awaiting_launch = runs
            .iter()
            .filter(|run| matches!(run.progress, RunProgress::Authorized { .. }))
            .map(|run| run.id)
            .collect();
        Ok(Self {
            journal,
            context,
            tasks,
            runs,
            authorizations,
            recovery_required,
            awaiting_launch,
        })
    }

    #[must_use]
    pub fn tasks(&self) -> &[ReviewTask] {
        &self.tasks
    }

    #[must_use]
    pub fn runs(&self) -> &[Run] {
        &self.runs
    }

    #[must_use]
    pub fn authorizations(&self) -> &[DispatchAuthorization] {
        &self.authorizations
    }

    /// Runs that were mid-flight when the process last stopped (§8.2-5).
    #[must_use]
    pub fn runs_requiring_recovery(&self) -> &[Id] {
        &self.recovery_required
    }

    /// Runs authorized but never launched: the author continues or cancels.
    #[must_use]
    pub fn runs_awaiting_launch(&self) -> &[Id] {
        &self.awaiting_launch
    }

    fn task_index(&self, id: Id) -> Result<usize, HostRefusal> {
        self.tasks
            .iter()
            .position(|task| task.id == id)
            .ok_or(HostRefusal::UnknownTask(id))
    }

    fn run_index(&self, id: Id) -> Result<usize, HostRefusal> {
        self.runs
            .iter()
            .position(|run| run.id == id)
            .ok_or(HostRefusal::UnknownRun(id))
    }

    /// Which Runs an authorization opens, and whether they are new.
    ///
    /// A Task in `Draft` mints one Run per agent and has nothing to retry. A
    /// Task already `Open` mints nothing and may only re-authorize Runs that
    /// are still `Queued`. A `Closed` Task authorizes nothing at all.
    ///
    /// This lived inline in `execute`, where the three-way decision was hard
    /// to see through the staging and journalling around it. The refusals are
    /// the point: each one names a state the author can reason about.
    fn runs_to_authorize(
        &self,
        task_id: Id,
        task_index: usize,
        new_agents: &[Id],
        retry_runs: &[Id],
    ) -> Result<Authorized, HostRefusal> {
        match self.tasks[task_index].progress {
            TaskProgress::Draft => {
                if !retry_runs.is_empty() || new_agents.is_empty() {
                    return Err(HostRefusal::TaskDraftHasNoRuns(task_id));
                }
                Ok(Authorized::Minted(
                    new_agents.iter().map(|_| Id::new()).collect(),
                ))
            }
            TaskProgress::Open { .. } => {
                if !new_agents.is_empty() {
                    return Err(HostRefusal::TaskOpenRejectsNewAgents(task_id));
                }
                if retry_runs.is_empty() {
                    return Err(HostRefusal::NothingToAuthorize(task_id));
                }
                for run_id in retry_runs {
                    let run = &self.runs[self.run_index(*run_id)?];
                    if run.task_id != task_id || !matches!(run.progress, RunProgress::Queued) {
                        return Err(HostRefusal::RunNotQueued(*run_id));
                    }
                }
                Ok(Authorized::Retried(retry_runs.to_vec()))
            }
            TaskProgress::Closed { .. } => Err(HostRefusal::TaskClosed(task_id)),
        }
    }

    /// A Task closes `RunsTerminal` once every Run is `Completed` or
    /// `Cancelled`. `Failed` is deliberately not terminal here: a failed Run
    /// holds its Task open for the author's retry-or-close judgment.
    fn close_if_runs_terminal(&mut self, task_id: Id, at: u64) -> Result<(), HostRefusal> {
        let all_terminal = self
            .runs
            .iter()
            .filter(|run| run.task_id == task_id)
            .all(|run| {
                matches!(
                    run.progress,
                    RunProgress::Completed { .. } | RunProgress::Cancelled
                )
            });
        if !all_terminal {
            return Ok(());
        }
        let task_index = self.task_index(task_id)?;
        if matches!(self.tasks[task_index].progress, TaskProgress::Open { .. }) {
            self.tasks[task_index].progress = TaskProgress::Closed {
                reason: CloseReason::RunsTerminal,
                closed_at: at,
            };
            let task = &self.tasks[task_index];
            self.journal
                .update_task(task)
                .map_err(|error| HostRefusal::Journal(error.to_string()))?;
        }
        Ok(())
    }

    pub fn execute(&mut self, command: HostCommand) -> Result<(), HostRefusal> {
        match command {
            HostCommand::DraftTask {
                baseline,
                document,
                prompt,
                context_digest,
            } => {
                let task = ReviewTask {
                    id: Id::new(),
                    baseline,
                    document,
                    prompt,
                    context_digest,
                    progress: TaskProgress::Draft,
                };
                self.journal
                    .append_task(&task)
                    .map_err(|error| HostRefusal::Journal(error.to_string()))?;
                self.tasks.push(task);
            }
            HostCommand::AuthorizeDispatch {
                task_id,
                new_agents,
                retry_runs,
                package,
                clicked_digest,
                authorized_at,
            } => {
                // INV-14: the digest the author clicked must equal the package
                // re-compiled at click time, byte for byte. Drift kills the
                // authorization; the author re-reads and clicks again.
                if package.digest != clicked_digest {
                    return Err(HostRefusal::AuthorizationDrift {
                        expected: clicked_digest,
                        actual: package.digest,
                    });
                }
                let task_index = self.task_index(task_id)?;
                let authorized =
                    self.runs_to_authorize(task_id, task_index, &new_agents, &retry_runs)?;

                // §8.2-1: stage first — manifest snapshot and one frozen
                // request per Run, producer-invisible. Each request carries
                // its own Run id where the compiler left the placeholder.
                let requests: Vec<(Id, String)> = authorized
                    .ids()
                    .iter()
                    .map(|run_id| {
                        (
                            *run_id,
                            package
                                .request_md
                                .replace(RUN_ID_PLACEHOLDER, &run_id.to_string()),
                        )
                    })
                    .collect();
                let staged = self
                    .context
                    .stage(&package, &requests)
                    .map_err(|error| HostRefusal::Context(error.to_string()))?;
                let digest_for = |run_id: Id| -> Result<String, HostRefusal> {
                    staged
                        .request_digests
                        .iter()
                        .find(|(staged_id, _)| *staged_id == run_id)
                        .map(|(_, digest)| digest.clone())
                        .ok_or_else(|| {
                            HostRefusal::Context(format!("staging dropped run {run_id}'s request"))
                        })
                };

                // Minting builds Runs and opens the Task; retrying moves
                // existing Runs back to Authorized. Everything after this —
                // the authorization record and the single journal write — is
                // the same for both, and is written once.
                let runs: Vec<Run> = match &authorized {
                    Authorized::Minted(run_ids) => {
                        let mut minted = Vec::with_capacity(new_agents.len());
                        for (run_id, agent_id) in run_ids.iter().zip(new_agents.iter()) {
                            minted.push(Run {
                                id: *run_id,
                                task_id,
                                agent_id: *agent_id,
                                snapshot_digest: package.digest.clone(),
                                workspace: String::new(),
                                progress: RunProgress::Authorized {
                                    request_digest: digest_for(*run_id)?,
                                },
                                retry_of: None,
                            });
                        }
                        self.tasks[task_index].progress = TaskProgress::Open {
                            opened_at: authorized_at,
                        };
                        minted
                    }
                    Authorized::Retried(run_ids) => {
                        let mut revived = Vec::with_capacity(run_ids.len());
                        for run_id in run_ids {
                            let run_index = self.run_index(*run_id)?;
                            self.runs[run_index].progress = RunProgress::Authorized {
                                request_digest: digest_for(*run_id)?,
                            };
                            revived.push(self.runs[run_index].clone());
                        }
                        revived
                    }
                };

                // §8.2-2 / §8.4b: one transaction's worth of facts, whether
                // this is the Task's first authorization or a retry's own.
                let authorization = DispatchAuthorization {
                    id: Id::new(),
                    run_ids: authorized.ids().to_vec(),
                    manifest_path: staged.manifest_path,
                    manifest_digest: package.digest,
                    authorized_at,
                };
                self.journal
                    .record_authorization(&self.tasks[task_index], &runs, &authorization)
                    .map_err(|error| HostRefusal::Journal(error.to_string()))?;
                if matches!(authorized, Authorized::Minted(_)) {
                    self.runs.extend(runs);
                }
                self.authorizations.push(authorization);
            }
            HostCommand::LaunchRun { run_id, workspace } => {
                let run_index = self.run_index(run_id)?;
                let request_digest = match &self.runs[run_index].progress {
                    RunProgress::Authorized { request_digest } => request_digest.clone(),
                    _ => return Err(HostRefusal::RunNotAuthorized(run_id)),
                };
                let snapshot_digest = self.runs[run_index].snapshot_digest.clone();
                // §8.2-5: continuing an authorized Run re-verifies its staged
                // request. Missing blocks; nothing is rebuilt from the now.
                if !self
                    .context
                    .staged_request_matches(run_id, &request_digest)
                    .map_err(|error| HostRefusal::Context(error.to_string()))?
                {
                    return Err(HostRefusal::StagingLost(run_id));
                }
                // §8.2-3: Authorized→Launching lands first, then the request
                // becomes visible to the producer, then the adapter.
                self.runs[run_index].progress = RunProgress::Launching {
                    request_digest: request_digest.clone(),
                };
                self.runs[run_index].workspace.clone_from(&workspace);
                self.journal
                    .update_run(&self.runs[run_index])
                    .map_err(|error| HostRefusal::Journal(error.to_string()))?;
                self.context
                    .promote_request(run_id, &workspace, &snapshot_digest)
                    .map_err(|error| HostRefusal::Context(error.to_string()))?;
                self.awaiting_launch.retain(|id| *id != run_id);
            }
            HostCommand::CompleteDispatch { run_id, receipt } => {
                let run_index = self.run_index(run_id)?;
                if !matches!(self.runs[run_index].progress, RunProgress::Launching { .. }) {
                    return Err(HostRefusal::RunNotLaunching(run_id));
                }
                self.runs[run_index].progress = RunProgress::Dispatched { receipt };
                self.journal
                    .update_run(&self.runs[run_index])
                    .map_err(|error| HostRefusal::Journal(error.to_string()))?;
                self.recovery_required.retain(|id| *id != run_id);
            }
            HostCommand::CollectAttempt {
                run_id,
                artifact_digest,
                at,
            } => {
                let run_index = self.run_index(run_id)?;
                if !matches!(
                    self.runs[run_index].progress,
                    RunProgress::Dispatched { .. }
                ) {
                    return Err(HostRefusal::RunNotDispatched(run_id));
                }
                // §8.3: Completed only after the artifact validated and was
                // atomically promoted — process exit is not completion.
                let task_id = self.runs[run_index].task_id;
                self.runs[run_index].progress = RunProgress::Completed { artifact_digest };
                self.journal
                    .update_run(&self.runs[run_index])
                    .map_err(|error| HostRefusal::Journal(error.to_string()))?;
                self.recovery_required.retain(|id| *id != run_id);
                self.close_if_runs_terminal(task_id, at)?;
            }
            HostCommand::FailRun {
                run_id,
                failure,
                at: _,
            } => {
                let run_index = self.run_index(run_id)?;
                if matches!(
                    self.runs[run_index].progress,
                    RunProgress::Completed { .. } | RunProgress::Cancelled
                ) {
                    return Err(HostRefusal::RunTerminal(run_id));
                }
                // §8.2-4: a failing Run is recorded, never rolled back. It
                // also never closes its Task: retry-or-close is the author's.
                self.runs[run_index].progress = RunProgress::Failed { failure };
                self.journal
                    .update_run(&self.runs[run_index])
                    .map_err(|error| HostRefusal::Journal(error.to_string()))?;
                self.recovery_required.retain(|id| *id != run_id);
            }
            HostCommand::CancelRun { run_id, at } => {
                let run_index = self.run_index(run_id)?;
                if matches!(
                    self.runs[run_index].progress,
                    RunProgress::Completed { .. } | RunProgress::Cancelled
                ) {
                    return Err(HostRefusal::RunNotCancellable(run_id));
                }
                let task_id = self.runs[run_index].task_id;
                self.runs[run_index].progress = RunProgress::Cancelled;
                self.journal
                    .update_run(&self.runs[run_index])
                    .map_err(|error| HostRefusal::Journal(error.to_string()))?;
                self.recovery_required.retain(|id| *id != run_id);
                self.awaiting_launch.retain(|id| *id != run_id);
                self.close_if_runs_terminal(task_id, at)?;
            }
            HostCommand::RetryRun { run_id } => {
                let run_index = self.run_index(run_id)?;
                let run = &self.runs[run_index];
                if !matches!(
                    run.progress,
                    RunProgress::Failed { .. } | RunProgress::Cancelled
                ) {
                    return Err(HostRefusal::RunNotRetryable(run_id));
                }
                let task_index = self.task_index(run.task_id)?;
                if matches!(self.tasks[task_index].progress, TaskProgress::Closed { .. }) {
                    return Err(HostRefusal::TaskClosed(run.task_id));
                }
                // §8.4b: retry is a NEW Run, new workspace, new authorization —
                // pointing at the run it retries.
                let retry = Run {
                    id: Id::new(),
                    task_id: run.task_id,
                    agent_id: run.agent_id,
                    snapshot_digest: run.snapshot_digest.clone(),
                    workspace: format!("{}-retry", run.workspace),
                    progress: RunProgress::Queued,
                    retry_of: Some(run_id),
                };
                self.journal
                    .append_run(&retry)
                    .map_err(|error| HostRefusal::Journal(error.to_string()))?;
                self.runs.push(retry);
            }
            HostCommand::CloseTask { task_id, at } => {
                let task_index = self.task_index(task_id)?;
                if matches!(self.tasks[task_index].progress, TaskProgress::Closed { .. }) {
                    return Err(HostRefusal::TaskClosed(task_id));
                }
                self.tasks[task_index].progress = TaskProgress::Closed {
                    reason: CloseReason::Author,
                    closed_at: at,
                };
                self.journal
                    .update_task(&self.tasks[task_index])
                    .map_err(|error| HostRefusal::Journal(error.to_string()))?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use refrain_core::context_compiler::ManifestEntry;
    use refrain_core::digest::content_hex;

    #[derive(Default)]
    struct VecJournal {
        tasks: Vec<ReviewTask>,
        runs: Vec<Run>,
        authorizations: Vec<DispatchAuthorization>,
        /// Every `record_authorization` call is one transaction; the count
        /// proves the multi-run authorization was not fanned out.
        authorization_calls: usize,
    }

    impl HostJournal for VecJournal {
        type Error = String;
        fn load(&self) -> Result<HostState, String> {
            Ok(HostState {
                tasks: self.tasks.clone(),
                runs: self.runs.clone(),
                authorizations: self.authorizations.clone(),
            })
        }
        fn append_task(&mut self, task: &ReviewTask) -> Result<(), String> {
            self.tasks.push(task.clone());
            Ok(())
        }
        fn record_authorization(
            &mut self,
            task: &ReviewTask,
            runs: &[Run],
            authorization: &DispatchAuthorization,
        ) -> Result<(), String> {
            self.authorization_calls += 1;
            let existing = self
                .tasks
                .iter_mut()
                .find(|candidate| candidate.id == task.id)
                .ok_or("missing task")?;
            *existing = task.clone();
            for run in runs {
                if let Some(existing) = self
                    .runs
                    .iter_mut()
                    .find(|candidate| candidate.id == run.id)
                {
                    *existing = run.clone();
                } else {
                    self.runs.push(run.clone());
                }
            }
            self.authorizations.push(authorization.clone());
            Ok(())
        }
        fn update_task(&mut self, task: &ReviewTask) -> Result<(), String> {
            let existing = self
                .tasks
                .iter_mut()
                .find(|candidate| candidate.id == task.id)
                .ok_or("missing task")?;
            *existing = task.clone();
            Ok(())
        }
        fn update_run(&mut self, run: &Run) -> Result<(), String> {
            let existing = self
                .runs
                .iter_mut()
                .find(|candidate| candidate.id == run.id)
                .ok_or("missing run")?;
            *existing = run.clone();
            Ok(())
        }
        fn append_run(&mut self, run: &Run) -> Result<(), String> {
            self.runs.push(run.clone());
            Ok(())
        }
    }

    #[derive(Default)]
    struct MapContext {
        staged: std::collections::HashMap<Id, String>,
        promoted: Vec<Id>,
        manifest_path: String,
        lost: bool,
    }

    impl FrozenContext for MapContext {
        type Error = String;
        fn stage(
            &mut self,
            package: &DispatchPackage,
            requests: &[(Id, String)],
        ) -> Result<StagedDispatch, String> {
            self.manifest_path = format!("staging/manifest-{}.json", package.digest);
            let mut digests = Vec::new();
            for (run_id, request) in requests {
                self.staged.insert(*run_id, request.clone());
                digests.push((*run_id, content_hex(request.as_bytes())));
            }
            Ok(StagedDispatch {
                manifest_path: self.manifest_path.clone(),
                request_digests: digests,
            })
        }
        fn promote_request(
            &mut self,
            run_id: Id,
            _workspace: &str,
            _manifest_digest: &str,
        ) -> Result<(), String> {
            self.promoted.push(run_id);
            Ok(())
        }
        fn staged_request_matches(&self, run_id: Id, digest: &str) -> Result<bool, String> {
            if self.lost {
                return Ok(false);
            }
            Ok(self
                .staged
                .get(&run_id)
                .is_some_and(|request| content_hex(request.as_bytes()) == digest))
        }
    }

    fn package() -> DispatchPackage {
        let request_md = format!(
            "# Before\n<!-- scope ch01:b3 -->\n原文。\n\n# Request\n改克制。\n\n# Reply format\n把 <agent-result> 写进 runs/{RUN_ID_PLACEHOLDER}/attempts/{RUN_ID_PLACEHOLDER}/result.md。\n"
        );
        DispatchPackage {
            digest: content_hex(request_md.as_bytes()),
            request_md,
            manifest: vec![ManifestEntry {
                section: "Request".to_string(),
                source: "author".to_string(),
                digest: "d".to_string(),
                bytes: 6,
                tokens: refrain_core::context_compiler::Tokens::Estimated(10),
            }],
        }
    }

    /// A host with one drafted task; returns (host, package, task_id).
    fn host_with_draft() -> (AgentHost<VecJournal, MapContext>, DispatchPackage, Id) {
        let host = AgentHost::open(VecJournal::default(), MapContext::default()).unwrap();
        let mut host = host;
        let baseline = Id::new();
        host.execute(HostCommand::DraftTask {
            baseline,
            document: "ch01.md".to_string(),
            prompt: "把这两段的语气改得更克制。".to_string(),
            context_digest: "ctx".to_string(),
        })
        .unwrap();
        let task_id = host.tasks()[0].id;
        (host, package(), task_id)
    }

    fn authorize(host: &mut AgentHost<VecJournal, MapContext>, task_id: Id, agents: &[Id]) {
        let package = package();
        host.execute(HostCommand::AuthorizeDispatch {
            task_id,
            new_agents: agents.to_vec(),
            retry_runs: vec![],
            clicked_digest: package.digest.clone(),
            package,
            authorized_at: 1_000,
        })
        .unwrap();
    }

    #[test]
    fn a_dispatch_flows_draft_to_completed_and_closes_the_task() {
        let (mut host, _package, task_id) = host_with_draft();
        let agent = Id::new();
        authorize(&mut host, task_id, &[agent]);
        assert!(matches!(
            host.tasks()[0].progress,
            TaskProgress::Open { opened_at: 1_000 }
        ));
        assert_eq!(host.runs().len(), 1);
        assert!(matches!(
            host.runs()[0].progress,
            RunProgress::Authorized { .. }
        ));
        assert_eq!(
            host.journal.authorization_calls, 1,
            "the authorization fanned out of its transaction"
        );

        let run_id = host.runs()[0].id;
        host.execute(HostCommand::LaunchRun {
            run_id,
            workspace: format!("runs/{run_id}"),
        })
        .unwrap();
        assert!(matches!(
            host.runs()[0].progress,
            RunProgress::Launching { .. }
        ));
        assert_eq!(host.context.promoted, vec![run_id]);
        // The staged request carries this run's own id, not the placeholder.
        assert!(!host.context.staged[&run_id].contains(RUN_ID_PLACEHOLDER));

        host.execute(HostCommand::CompleteDispatch {
            run_id,
            receipt: "receipt-1".to_string(),
        })
        .unwrap();
        host.execute(HostCommand::CollectAttempt {
            run_id,
            artifact_digest: "artifact-1".to_string(),
            at: 2_000,
        })
        .unwrap();
        assert!(matches!(
            host.runs()[0].progress,
            RunProgress::Completed { .. }
        ));
        assert!(matches!(
            host.tasks()[0].progress,
            TaskProgress::Closed {
                reason: CloseReason::RunsTerminal,
                closed_at: 2_000
            }
        ));
    }

    #[test]
    fn a_drifted_digest_kills_the_authorization_before_any_run_exists() {
        let (mut host, _package, task_id) = host_with_draft();
        let error = host
            .execute(HostCommand::AuthorizeDispatch {
                task_id,
                new_agents: vec![Id::new()],
                retry_runs: vec![],
                package: package(),
                clicked_digest: "tampered".to_string(),
                authorized_at: 1_000,
            })
            .unwrap_err();
        assert!(matches!(error, HostRefusal::AuthorizationDrift { .. }));
        assert!(host.runs().is_empty());
        assert!(host.authorizations().is_empty());
        assert!(matches!(host.tasks()[0].progress, TaskProgress::Draft));
        assert_eq!(host.journal.authorization_calls, 0);
    }

    #[test]
    fn a_failing_run_is_recorded_and_never_rolls_back_or_closes() {
        let (mut host, _package, task_id) = host_with_draft();
        authorize(&mut host, task_id, &[Id::new(), Id::new()]);
        let first = host.runs()[0].id;
        host.execute(HostCommand::LaunchRun {
            run_id: first,
            workspace: "w1".to_string(),
        })
        .unwrap();
        host.execute(HostCommand::CompleteDispatch {
            run_id: first,
            receipt: "r1".to_string(),
        })
        .unwrap();
        host.execute(HostCommand::FailRun {
            run_id: first,
            failure: "duplicate-replacement".to_string(),
            at: 3_000,
        })
        .unwrap();

        // The second Run is untouched by the first's failure (§8.2-4), and a
        // failed Run holds its Task open for the author's judgment.
        assert!(matches!(
            host.runs()[1].progress,
            RunProgress::Authorized { .. }
        ));
        assert!(matches!(
            host.runs()[0].progress,
            RunProgress::Failed { .. }
        ));
        assert!(matches!(
            host.tasks()[0].progress,
            TaskProgress::Open { .. }
        ));
    }

    #[test]
    fn a_retry_gets_a_new_run_and_its_own_authorization() {
        let (mut host, _package, task_id) = host_with_draft();
        authorize(&mut host, task_id, &[Id::new()]);
        let run_id = host.runs()[0].id;
        host.execute(HostCommand::FailRun {
            run_id,
            failure: "malformed".to_string(),
            at: 1_100,
        })
        .unwrap();
        host.execute(HostCommand::RetryRun { run_id }).unwrap();
        let retry = host.runs()[1].clone();
        assert_eq!(retry.retry_of, Some(run_id));
        assert!(matches!(retry.progress, RunProgress::Queued));
        assert_ne!(retry.id, run_id);

        // The retry's authorization is new (§8.4b), on the still-Open task.
        host.execute(HostCommand::AuthorizeDispatch {
            task_id,
            new_agents: vec![],
            retry_runs: vec![retry.id],
            clicked_digest: package().digest,
            package: package(),
            authorized_at: 1_200,
        })
        .unwrap();
        assert!(matches!(
            host.runs()[1].progress,
            RunProgress::Authorized { .. }
        ));
        // The retry re-authorizes a Run that already exists. Counting matters:
        // asserting only that runs()[1] is Authorized passes just as happily
        // when the Run has been appended a second time, and the author would
        // see one retry listed twice.
        assert_eq!(host.runs().len(), 2);
        assert_eq!(host.authorizations().len(), 2);
        assert_eq!(host.authorizations()[1].run_ids, vec![retry.id]);
        assert_eq!(host.journal.authorization_calls, 2);
    }

    #[test]
    fn a_closed_task_authorizes_nothing() {
        let (mut host, _package, task_id) = host_with_draft();
        authorize(&mut host, task_id, &[Id::new()]);
        let run_id = host.runs()[0].id;
        host.execute(HostCommand::CloseTask { task_id, at: 1_100 })
            .unwrap();
        assert!(matches!(
            host.tasks()[0].progress,
            TaskProgress::Closed { .. }
        ));

        // Closing is the author's decision that this Task is done. Authorizing
        // into it would reopen work they had finished with.
        let error = host
            .execute(HostCommand::AuthorizeDispatch {
                task_id,
                new_agents: vec![],
                retry_runs: vec![run_id],
                clicked_digest: package().digest,
                package: package(),
                authorized_at: 1_200,
            })
            .unwrap_err();
        assert!(matches!(error, HostRefusal::TaskClosed(_)));
    }

    #[test]
    fn an_open_task_rejects_fresh_agents() {
        let (mut host, _package, task_id) = host_with_draft();
        authorize(&mut host, task_id, &[Id::new()]);
        let error = host
            .execute(HostCommand::AuthorizeDispatch {
                task_id,
                new_agents: vec![Id::new()],
                retry_runs: vec![],
                clicked_digest: package().digest,
                package: package(),
                authorized_at: 2_000,
            })
            .unwrap_err();
        assert!(matches!(error, HostRefusal::TaskOpenRejectsNewAgents(_)));
    }

    #[test]
    fn a_lost_staging_blocks_the_launch() {
        let (mut host, _package, task_id) = host_with_draft();
        authorize(&mut host, task_id, &[Id::new()]);
        host.context.lost = true;
        let run_id = host.runs()[0].id;
        let error = host
            .execute(HostCommand::LaunchRun {
                run_id,
                workspace: "w".to_string(),
            })
            .unwrap_err();
        assert!(matches!(error, HostRefusal::StagingLost(_)));
        assert!(matches!(
            host.runs()[0].progress,
            RunProgress::Authorized { .. }
        ));
    }

    #[test]
    fn terminal_runs_do_not_move_again() {
        let (mut host, _package, task_id) = host_with_draft();
        authorize(&mut host, task_id, &[Id::new()]);
        let run_id = host.runs()[0].id;
        host.execute(HostCommand::CancelRun { run_id, at: 1_500 })
            .unwrap();
        // The only run cancelled: the task closes RunsTerminal.
        assert!(matches!(
            host.tasks()[0].progress,
            TaskProgress::Closed {
                reason: CloseReason::RunsTerminal,
                closed_at: 1_500
            }
        ));
        assert!(matches!(
            host.execute(HostCommand::FailRun {
                run_id,
                failure: "late".to_string(),
                at: 1_600
            }),
            Err(HostRefusal::RunTerminal(_))
        ));
        assert!(matches!(host.runs()[0].progress, RunProgress::Cancelled));
        // Retry refuses on a closed task: ask again with a new Task instead.
        assert!(matches!(
            host.execute(HostCommand::RetryRun { run_id }),
            Err(HostRefusal::TaskClosed(_))
        ));
    }

    #[test]
    fn the_author_may_close_a_task_at_any_time() {
        let (mut host, _package, task_id) = host_with_draft();
        host.execute(HostCommand::CloseTask { task_id, at: 900 })
            .unwrap();
        assert!(matches!(
            host.tasks()[0].progress,
            TaskProgress::Closed {
                reason: CloseReason::Author,
                closed_at: 900
            }
        ));
        assert!(matches!(
            host.execute(HostCommand::CloseTask { task_id, at: 901 }),
            Err(HostRefusal::TaskClosed(_))
        ));
    }

    #[test]
    fn a_restart_reports_recovery_and_awaiting_without_moving_anything() {
        let (mut host, _package, task_id) = host_with_draft();
        authorize(&mut host, task_id, &[Id::new(), Id::new()]);
        let launched = host.runs()[0].id;
        let waiting = host.runs()[1].id;
        host.execute(HostCommand::LaunchRun {
            run_id: launched,
            workspace: "w1".to_string(),
        })
        .unwrap();
        let journal = host.journal;
        let context = host.context;

        let reopened = AgentHost::open(journal, context).unwrap();
        assert_eq!(reopened.runs_requiring_recovery(), &[launched]);
        assert_eq!(reopened.runs_awaiting_launch(), &[waiting]);
        // Nothing moved: states persist exactly as the journal held them.
        assert!(matches!(
            reopened.runs()[0].progress,
            RunProgress::Launching { .. }
        ));
        assert!(matches!(
            reopened.runs()[1].progress,
            RunProgress::Authorized { .. }
        ));
    }
}
