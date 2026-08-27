// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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

use crate::run_edge::{self, EdgeRefusal, ResolvedEdge, RunEdge};

/// Pad a short edge list to one entry per minted Run, and refuse a long one.
///
/// A caller that does not orchestrate passes an empty vector, and every
/// caller that predates edges does exactly that. Reading short as "no edges"
/// rather than refusing keeps those callers correct without a migration.
///
/// Too many entries is a different fact: the caller described relations for
/// Runs that will not exist, so one of the two lists is wrong. Silently
/// dropping the tail used to hide that — the author authorised a shape the
/// host never built, and nothing said so. Defaults and structural errors are
/// separate answers.
fn normalise_edges(
    edges: Vec<Option<RunEdge>>,
    runs: usize,
) -> Result<Vec<Option<RunEdge>>, HostRefusal> {
    if edges.len() > runs {
        return Err(HostRefusal::EdgeCountExceedsRuns {
            edges: edges.len(),
            runs,
        });
    }
    let mut edges = edges;
    edges.resize(runs, None);
    Ok(edges)
}

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

/// The token the compiler leaves where the Run's agent belongs, in the same
/// result path. It substitutes at staging for the same reason as
/// [`RUN_ID_PLACEHOLDER`]: the workspace layout is `agents/<agent-id>/runs/<run-id>/`,
/// and the frozen request must name the real path, not the layout's shape.
pub const AGENT_ID_PLACEHOLDER: &str = "<agent-id>";

/// What a Task is: the author's one dispatched collaboration, baseline-pinned
/// at enqueue (Q27). No agentId — a Task is shared by every Run of its round.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case", tag = "kind", content = "value")]
pub enum TaskProgress {
    Draft,
    Open { opened_at: u64 },
    Closed { reason: CloseReason, closed_at: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum CloseReason {
    RunsTerminal,
    Author,
}

/// A Run: one agent's one execution of one Task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
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
    /// How this Run relates to another Run of the same Task.
    ///
    /// Resolved to ids at authorization, because that is when the ids exist.
    /// `None` is the ordinary case: a Run that answers the author's question
    /// on its own.
    #[serde(default)]
    pub edge: Option<ResolvedEdge>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
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
    /// The artifact a terminal Run left behind, if any.
    ///
    /// The launch condition needs it: an edge that requires an upstream result
    /// must refuse before the downstream changes state, not discover the empty
    /// upstream after it is already `Launching`. `None` means the producer left
    /// nothing — which a Failed or Cancelled Run usually did.
    fn read_result(&self, workspace: &str, run_id: Id) -> Result<Option<Vec<u8>>, Self::Error>;
}

/// Every command the host takes. Timestamps arrive as payload: the host has
/// no clock of its own, so its facts stay deterministic and replayable.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
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
        /// How the minted Runs relate to each other, one entry per agent in
        /// `new_agents`. `None` means that Run stands alone, which is what
        /// every caller produced before edges existed and remains the
        /// ordinary case.
        ///
        /// Positions rather than ids: the Runs do not exist yet. An empty
        /// vector is read as "no edges at all", so a caller that does not
        /// care about orchestration passes nothing.
        edges: Vec<Option<RunEdge>>,
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
    /// The proposed edges cannot be authorized.
    ///
    /// Decided before the authorization record exists, because
    /// `DispatchAuthorization` is immutable (INV-14): a record holding a
    /// cycle could never be withdrawn, only refused again at every launch —
    /// a statically decidable error left to run time.
    #[error("edges: {0}")]
    Edges(#[from] EdgeRefusal),
    /// A Run whose edge waits on another was authorized before that other
    /// reached a terminal state.
    ///
    /// `Follows` needs the upstream's artifact; `Verifies` needs something to
    /// verify. Both are meaningless against a Run still in flight.
    #[error("run {run} waits on run {upstream}, which is not terminal")]
    UpstreamNotTerminal { run: Id, upstream: Id },
    /// The upstream reached a terminal state without leaving an artifact.
    ///
    /// Order is not content: a `Failed` or `Cancelled` upstream is terminal, so
    /// the order condition passes, yet a `Follows` Run has nothing to read and
    /// a `Verifies` Run has nothing to verify. Launching anyway used to put the
    /// downstream into `Launching` first and discover the empty upstream only
    /// afterwards, leaving it stuck there and then reported as needing recovery
    /// when no producer had ever started. Refusing before the state changes
    /// keeps the Run authorized and retryable.
    #[error("run {run} waits on run {upstream}, which left no result to read")]
    UpstreamWithoutArtifact { run: Id, upstream: Id },
    /// The authorization described more edges than it mints Runs.
    ///
    /// A short list is a default (callers that do not orchestrate pass none),
    /// but a long one means the two lists disagree about how many Runs this
    /// round has. Truncating used to drop the tail without a word, so the
    /// author could authorise a shape the host never built.
    #[error("the authorization carries {edges} edges for {runs} runs")]
    EdgeCountExceedsRuns { edges: usize, runs: usize },
    /// A verifier proposed a rewrite.
    ///
    /// The whole meaning of `Verifies` is that this Run reads another's work
    /// and reports on it. A replacement from a verifier is a different Run
    /// than the one the author authorized, so the artifact is refused whole
    /// rather than partly kept.
    #[error("run {0} verifies another run and may only comment, but proposed a rewrite")]
    VerifierProposedEdit(Id),
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

    /// The four ways this module reaches a Task or a Run it was named.
    ///
    /// **Why an accessor and not a position.** These replaced a pair of
    /// `*_index` finders whose `usize` then travelled through thirty-six bare
    /// subscripts. Each subscript was correct only while no `push` ran between
    /// the lookup and the use, and proving that took a reading of the whole
    /// 1,810-line file — again after every edit. A name cannot go stale that
    /// way, and a Run that is not on record now leaves through
    /// `HostRefusal::UnknownRun` from one place instead of panicking from
    /// thirty-six.
    ///
    /// **What did not change.** `runs` stays a `Vec` and stays in order.
    /// `run_edge` expresses an edge as a position into the authorized round
    /// (`edges point at positions, not Run ids`), so the order is semantics;
    /// a map keyed by id would break authorization, not just move it.
    fn task(&self, id: Id) -> Result<&ReviewTask, HostRefusal> {
        self.tasks
            .iter()
            .find(|task| task.id == id)
            .ok_or(HostRefusal::UnknownTask(id))
    }

    fn run(&self, id: Id) -> Result<&Run, HostRefusal> {
        self.runs
            .iter()
            .find(|run| run.id == id)
            .ok_or(HostRefusal::UnknownRun(id))
    }

    /// A Task and the journal that records it, borrowed apart.
    ///
    /// Every state change here is "change it, then write it down", and the two
    /// halves need disjoint borrows of `self`. Handing both out of one call is
    /// what lets the arms below name a Task instead of subscripting it — a
    /// `&self` accessor plus `&mut self.journal` would be one borrow too many.
    fn task_and_journal(&mut self, id: Id) -> Result<(&mut ReviewTask, &mut J), HostRefusal> {
        let Self { tasks, journal, .. } = self;
        let task = tasks
            .iter_mut()
            .find(|task| task.id == id)
            .ok_or(HostRefusal::UnknownTask(id))?;
        Ok((task, journal))
    }

    /// A Run and the journal that records it, borrowed apart. See
    /// [`Self::task_and_journal`].
    fn run_and_journal(&mut self, id: Id) -> Result<(&mut Run, &mut J), HostRefusal> {
        let Self { runs, journal, .. } = self;
        let run = runs
            .iter_mut()
            .find(|run| run.id == id)
            .ok_or(HostRefusal::UnknownRun(id))?;
        Ok((run, journal))
    }

    /// The Task named by `id`, for a change this call does not journal.
    fn task_mut(&mut self, id: Id) -> Result<&mut ReviewTask, HostRefusal> {
        self.tasks
            .iter_mut()
            .find(|task| task.id == id)
            .ok_or(HostRefusal::UnknownTask(id))
    }

    /// The Run named by `id`, for a change this call does not journal.
    fn run_mut(&mut self, id: Id) -> Result<&mut Run, HostRefusal> {
        self.runs
            .iter_mut()
            .find(|run| run.id == id)
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
        new_agents: &[Id],
        retry_runs: &[Id],
    ) -> Result<Authorized, HostRefusal> {
        match self.task(task_id)?.progress {
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
                    let run = self.run(*run_id)?;
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
        let (task, journal) = self.task_and_journal(task_id)?;
        if matches!(task.progress, TaskProgress::Open { .. }) {
            task.progress = TaskProgress::Closed {
                reason: CloseReason::RunsTerminal,
                closed_at: at,
            };
            journal
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
                edges,
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
                let authorized = self.runs_to_authorize(task_id, &new_agents, &retry_runs)?;

                // Edges are checked before anything is written down. An
                // authorization is immutable, so a cycle inside one could
                // never be withdrawn — only refused at every subsequent
                // launch, which turns a statically decidable error into a
                // permanent runtime one.
                let edges = normalise_edges(edges, new_agents.len())?;
                run_edge::resolve_order(&edges)?;

                // §8.2-1: stage first — manifest snapshot and one frozen
                // request per Run, producer-invisible. Each request carries
                // its own Run id and its agent's id where the compiler left
                // the placeholders: the result path names the real workspace,
                // and the workspace layout nests runs under their agent.
                let agent_of = |run_id: Id| -> Result<Id, HostRefusal> {
                    let found = match &authorized {
                        Authorized::Minted(run_ids) => run_ids
                            .iter()
                            .zip(new_agents.iter())
                            .find(|(id, _)| **id == run_id)
                            .map(|(_, agent)| *agent),
                        Authorized::Retried(_) => self
                            .runs
                            .iter()
                            .find(|run| run.id == run_id)
                            .map(|run| run.agent_id),
                    };
                    found.ok_or_else(|| {
                        HostRefusal::Context(format!("no agent on record for run {run_id}"))
                    })
                };
                let requests: Vec<(Id, String)> = authorized
                    .ids()
                    .iter()
                    .map(|run_id| {
                        Ok((
                            *run_id,
                            package
                                .request_md
                                .replace(RUN_ID_PLACEHOLDER, &run_id.to_string())
                                .replace(AGENT_ID_PLACEHOLDER, &agent_of(*run_id)?.to_string()),
                        ))
                    })
                    .collect::<Result<_, HostRefusal>>()?;
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
                        // Positions become ids only now, which is why edges
                        // were expressed positionally in the first place.
                        let bound = run_edge::resolve_edges(&edges, run_ids);
                        let mut minted = Vec::with_capacity(new_agents.len());
                        for (index, (run_id, agent_id)) in
                            run_ids.iter().zip(new_agents.iter()).enumerate()
                        {
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
                                edge: bound.get(index).copied().flatten(),
                            });
                        }
                        self.task_mut(task_id)?.progress = TaskProgress::Open {
                            opened_at: authorized_at,
                        };
                        minted
                    }
                    Authorized::Retried(run_ids) => {
                        let mut revived = Vec::with_capacity(run_ids.len());
                        for run_id in run_ids {
                            let request_digest = digest_for(*run_id)?;
                            let run = self.run_mut(*run_id)?;
                            run.progress = RunProgress::Authorized { request_digest };
                            revived.push(run.clone());
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
                let (task, journal) = self.task_and_journal(task_id)?;
                journal
                    .record_authorization(task, &runs, &authorization)
                    .map_err(|error| HostRefusal::Journal(error.to_string()))?;
                if matches!(authorized, Authorized::Minted(_)) {
                    self.runs.extend(runs);
                }
                self.authorizations.push(authorization);
            }
            HostCommand::LaunchRun { run_id, workspace } => {
                // A Run that waits on another may not start before that other
                // is terminal. `Follows` needs the upstream's artifact and
                // `Verifies` needs something to verify; both are meaningless
                // against a Run still in flight. Checked at launch rather than
                // at authorization because the author authorizes the whole
                // round in one click — the waiting is about execution order,
                // not about what was permitted.
                if let Some(edge) = self.run(run_id)?.edge {
                    let upstream = match edge {
                        ResolvedEdge::Follows { upstream } => Some(upstream),
                        ResolvedEdge::Verifies { subject } => Some(subject),
                        // Alternates deliberately imposes no order: that is
                        // the whole of what makes it the star-shaped default.
                        ResolvedEdge::Alternates { .. } => None,
                    };
                    if let Some(upstream) = upstream {
                        let waited = self.run(upstream)?;
                        if !matches!(
                            waited.progress,
                            RunProgress::Completed { .. }
                                | RunProgress::Failed { .. }
                                | RunProgress::Cancelled
                        ) {
                            return Err(HostRefusal::UpstreamNotTerminal {
                                run: run_id,
                                upstream,
                            });
                        }
                        // Order is not content. A Failed or Cancelled upstream
                        // is terminal but usually left no result, and both edge
                        // kinds need one — Follows reads it, Verifies checks it.
                        // The check belongs here, before the state changes: the
                        // downstream used to reach Launching and only then
                        // discover the empty upstream, which left it stranded
                        // there and later reported as needing recovery though no
                        // producer had ever run.
                        let artifact = self
                            .context
                            .read_result(&waited.workspace, upstream)
                            .map_err(|error| HostRefusal::Context(error.to_string()))?;
                        if artifact.is_none_or(|bytes| bytes.is_empty()) {
                            return Err(HostRefusal::UpstreamWithoutArtifact {
                                run: run_id,
                                upstream,
                            });
                        }
                    }
                }
                let launching = self.run(run_id)?;
                let request_digest = match &launching.progress {
                    RunProgress::Authorized { request_digest } => request_digest.clone(),
                    _ => return Err(HostRefusal::RunNotAuthorized(run_id)),
                };
                let snapshot_digest = launching.snapshot_digest.clone();
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
                let (run, journal) = self.run_and_journal(run_id)?;
                run.progress = RunProgress::Launching { request_digest };
                run.workspace.clone_from(&workspace);
                journal
                    .update_run(run)
                    .map_err(|error| HostRefusal::Journal(error.to_string()))?;
                self.context
                    .promote_request(run_id, &workspace, &snapshot_digest)
                    .map_err(|error| HostRefusal::Context(error.to_string()))?;
                self.awaiting_launch.retain(|id| *id != run_id);
            }
            HostCommand::CompleteDispatch { run_id, receipt } => {
                let (run, journal) = self.run_and_journal(run_id)?;
                if !matches!(run.progress, RunProgress::Launching { .. }) {
                    return Err(HostRefusal::RunNotLaunching(run_id));
                }
                run.progress = RunProgress::Dispatched { receipt };
                journal
                    .update_run(run)
                    .map_err(|error| HostRefusal::Journal(error.to_string()))?;
                self.recovery_required.retain(|id| *id != run_id);
            }
            HostCommand::CollectAttempt {
                run_id,
                artifact_digest,
                at,
            } => {
                let (run, journal) = self.run_and_journal(run_id)?;
                if !matches!(run.progress, RunProgress::Dispatched { .. }) {
                    return Err(HostRefusal::RunNotDispatched(run_id));
                }
                // §8.3: Completed only after the artifact validated and was
                // atomically promoted — process exit is not completion.
                let task_id = run.task_id;
                run.progress = RunProgress::Completed { artifact_digest };
                journal
                    .update_run(run)
                    .map_err(|error| HostRefusal::Journal(error.to_string()))?;
                self.recovery_required.retain(|id| *id != run_id);
                self.close_if_runs_terminal(task_id, at)?;
            }
            HostCommand::FailRun {
                run_id,
                failure,
                at: _,
            } => {
                let (run, journal) = self.run_and_journal(run_id)?;
                if matches!(
                    run.progress,
                    RunProgress::Completed { .. } | RunProgress::Cancelled
                ) {
                    return Err(HostRefusal::RunTerminal(run_id));
                }
                // §8.2-4: a failing Run is recorded, never rolled back. It
                // also never closes its Task: retry-or-close is the author's.
                run.progress = RunProgress::Failed { failure };
                journal
                    .update_run(run)
                    .map_err(|error| HostRefusal::Journal(error.to_string()))?;
                self.recovery_required.retain(|id| *id != run_id);
            }
            HostCommand::CancelRun { run_id, at } => {
                let (run, journal) = self.run_and_journal(run_id)?;
                if matches!(
                    run.progress,
                    RunProgress::Completed { .. } | RunProgress::Cancelled
                ) {
                    return Err(HostRefusal::RunNotCancellable(run_id));
                }
                let task_id = run.task_id;
                run.progress = RunProgress::Cancelled;
                journal
                    .update_run(run)
                    .map_err(|error| HostRefusal::Journal(error.to_string()))?;
                self.recovery_required.retain(|id| *id != run_id);
                self.awaiting_launch.retain(|id| *id != run_id);
                self.close_if_runs_terminal(task_id, at)?;
            }
            HostCommand::RetryRun { run_id } => {
                let run = self.run(run_id)?;
                if !matches!(
                    run.progress,
                    RunProgress::Failed { .. } | RunProgress::Cancelled
                ) {
                    return Err(HostRefusal::RunNotRetryable(run_id));
                }
                if matches!(
                    self.task(run.task_id)?.progress,
                    TaskProgress::Closed { .. }
                ) {
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
                    // A retry stands in the same place in the orchestration
                    // as the Run it replaces: an agent retried after its
                    // upstream still follows that upstream, and a verifier
                    // retried still verifies the same subject.
                    edge: run.edge,
                };
                self.journal
                    .append_run(&retry)
                    .map_err(|error| HostRefusal::Journal(error.to_string()))?;
                self.runs.push(retry);
            }
            HostCommand::CloseTask { task_id, at } => {
                let (task, journal) = self.task_and_journal(task_id)?;
                if matches!(task.progress, TaskProgress::Closed { .. }) {
                    return Err(HostRefusal::TaskClosed(task_id));
                }
                task.progress = TaskProgress::Closed {
                    reason: CloseReason::Author,
                    closed_at: at,
                };
                journal
                    .update_task(task)
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

    /// The wire shape of a Run's progress is an ABI fact: the Zig surface's
    /// `progressLabel` and core.ts's in-flight count parse exactly this JSON.
    /// Pin it here — whoever changes the serde attributes must change the
    /// surface in the same commit.
    #[test]
    fn run_progress_crosses_the_abi_adjacently_tagged() {
        let dispatched = RunProgress::Dispatched {
            receipt: "r".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&dispatched).unwrap(),
            serde_json::json!({"kind": "dispatched", "value": {"receipt": "r"}})
        );
        assert_eq!(
            serde_json::to_value(&RunProgress::Cancelled).unwrap(),
            serde_json::json!({"kind": "cancelled"})
        );
        assert_eq!(
            serde_json::to_value(&RunProgress::Failed {
                failure: "f".to_string()
            })
            .unwrap(),
            serde_json::json!({"kind": "failed", "value": {"failure": "f"}})
        );
    }

    #[derive(Default)]
    struct MapContext {
        staged: std::collections::HashMap<Id, String>,
        promoted: Vec<Id>,
        manifest_path: String,
        lost: bool,
        /// Which Runs left a result. A Run absent from this map produced
        /// nothing, which is what a Failed or Cancelled producer usually did.
        results: std::collections::HashMap<Id, Vec<u8>>,
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
        fn read_result(&self, _workspace: &str, run_id: Id) -> Result<Option<Vec<u8>>, String> {
            Ok(self.results.get(&run_id).cloned())
        }
    }

    fn package() -> DispatchPackage {
        let request_md = format!(
            "# Before\n<!-- scope ch01:b3 -->\n原文。\n\n# Request\n改克制。\n\n# Reply format\n把 <agent-result> 写进 runs/{RUN_ID_PLACEHOLDER}/attempts/{RUN_ID_PLACEHOLDER}/result.md。\n"
        );
        DispatchPackage {
            scopes: Vec::new(),
            prefix_bytes: 0,
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
        authorize_with_edges(host, task_id, agents, Vec::new());
    }

    /// Every command that names a Run refuses an unknown one by name.
    ///
    /// The reachable question behind this: the surface holds a Run id it read
    /// from a reply, the author clicks it, and by then the Run may be gone
    /// (another window, a journal rebuilt, a stale roster). Before the
    /// accessors, each arm resolved the id to a position and then subscripted
    /// with it; the resolution refused, but nothing said the subscript could
    /// not be reached another way, and proving it took reading the file.
    ///
    /// The loop is written over the whole command set on purpose: adding a
    /// command that names a Run and forgetting to look it up leaves this test
    /// listing one case fewer than the enum, which is the review this asks for.
    #[test]
    fn every_command_naming_an_unknown_run_refuses_it_by_name() {
        let (mut host, _package, task_id) = host_with_draft();
        authorize(&mut host, task_id, &[Id::new()]);
        let missing = Id::new();

        let commands = [
            HostCommand::LaunchRun {
                run_id: missing,
                workspace: "workspaces/gone".to_string(),
            },
            HostCommand::CompleteDispatch {
                run_id: missing,
                receipt: "r".to_string(),
            },
            HostCommand::CollectAttempt {
                run_id: missing,
                artifact_digest: "d".to_string(),
                at: 1,
            },
            HostCommand::FailRun {
                run_id: missing,
                failure: "f".to_string(),
                at: 1,
            },
            HostCommand::CancelRun {
                run_id: missing,
                at: 1,
            },
            HostCommand::RetryRun { run_id: missing },
        ];
        for command in commands {
            assert_eq!(
                host.execute(command),
                Err(HostRefusal::UnknownRun(missing)),
                "a command naming a Run that is not on record must refuse it"
            );
        }

        // The Task half of the same rule, including the retry path that reads a
        // Run's Task rather than one the caller named.
        assert_eq!(
            host.execute(HostCommand::CloseTask {
                task_id: missing,
                at: 1
            }),
            Err(HostRefusal::UnknownTask(missing))
        );
        assert_eq!(
            host.execute(HostCommand::AuthorizeDispatch {
                task_id: missing,
                new_agents: vec![Id::new()],
                retry_runs: Vec::new(),
                edges: Vec::new(),
                package: package(),
                clicked_digest: package().digest,
                authorized_at: 1,
            }),
            Err(HostRefusal::UnknownTask(missing))
        );

        // And the state the refusals protect is untouched: one Task, one Run.
        assert_eq!(host.tasks().len(), 1);
        assert_eq!(host.runs().len(), 1);
    }

    fn authorize_with_edges(
        host: &mut AgentHost<VecJournal, MapContext>,
        task_id: Id,
        agents: &[Id],
        edges: Vec<Option<RunEdge>>,
    ) {
        try_authorize_with_edges(host, task_id, agents, edges).unwrap();
    }

    fn try_authorize_with_edges(
        host: &mut AgentHost<VecJournal, MapContext>,
        task_id: Id,
        agents: &[Id],
        edges: Vec<Option<RunEdge>>,
    ) -> Result<(), HostRefusal> {
        let package = package();
        host.execute(HostCommand::AuthorizeDispatch {
            task_id,
            new_agents: agents.to_vec(),
            retry_runs: vec![],
            edges,
            clicked_digest: package.digest.clone(),
            package,
            authorized_at: 1_000,
        })
    }

    /// 判据 2-2：环在**授权**时被拒，而且是在写下任何东西**之前**。
    ///
    /// 授权是不可变记录（INV-14）。一份含环的授权一旦落账就撤不掉，只能靠
    /// 每次启动反复拒绝兜底——那等于把一个静态可判定的错误留到运行时。
    ///
    /// 「之前」这个词是断言的一半，起初我漏了：只断言 Run 与授权为空时，
    /// 把环检测挪到 stage 之后仍然全绿，因为内存夹具在抛错后不留痕迹。
    /// 真实的 staging 会写盘并 fsync，那些字节不会因为后一步失败而消失。
    /// 所以这里连 `staged` 一起断言——它是「有没有东西已经落地」的证据。
    #[test]
    fn a_cycle_is_refused_before_anything_is_staged_or_written() {
        let (mut host, _package, task_id) = host_with_draft();
        let agents = vec![Id::new(), Id::new()];
        let refusal = try_authorize_with_edges(
            &mut host,
            task_id,
            &agents,
            vec![
                Some(RunEdge::Follows { upstream: 1 }),
                Some(RunEdge::Follows { upstream: 0 }),
            ],
        )
        .unwrap_err();

        assert!(matches!(
            refusal,
            HostRefusal::Edges(EdgeRefusal::Cycle { .. })
        ));
        // 冻结的请求一个都没落地：这是「检测在 staging 之前」的证据。
        assert!(
            host.context.staged.is_empty(),
            "含环的授权已经冻结了请求：环检测排在 staging 之后"
        );
        // 也没有 Run、没有授权，Task 仍是 Draft。
        assert!(host.runs().is_empty(), "含环的授权铸出了 Run");
        assert!(host.authorizations().is_empty(), "含环的授权落了账");
        assert!(matches!(host.tasks()[0].progress, TaskProgress::Draft));
    }

    /// 指向不存在的位置同样在授权时被拒。
    #[test]
    fn an_edge_past_the_end_is_refused_at_authorization() {
        let (mut host, _package, task_id) = host_with_draft();
        let refusal = try_authorize_with_edges(
            &mut host,
            task_id,
            &[Id::new()],
            vec![Some(RunEdge::Follows { upstream: 5 })],
        )
        .unwrap_err();
        assert!(matches!(
            refusal,
            HostRefusal::Edges(EdgeRefusal::OutOfRange { .. })
        ));
        assert!(host.runs().is_empty());
    }

    /// 边绑到铸出的 Run 上：位置在此刻才变成 id。
    #[test]
    fn edges_are_bound_to_the_runs_that_were_minted() {
        let (mut host, _package, task_id) = host_with_draft();
        let agents = vec![Id::new(), Id::new()];
        authorize_with_edges(
            &mut host,
            task_id,
            &agents,
            vec![None, Some(RunEdge::Follows { upstream: 0 })],
        );
        let runs = host.runs();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].edge, None);
        assert_eq!(
            runs[1].edge,
            Some(ResolvedEdge::Follows {
                upstream: runs[0].id
            })
        );
    }

    /// 冻结请求里的产出路径带的是这个 Run 自己的 agent 与 run id——
    /// 工作区布局（agents/<agent>/runs/<run>）能不能被写对，全看这两个
    /// 占位符在 staging 时被换成真值。
    #[test]
    fn a_staged_request_names_its_own_agent_and_run_and_not_its_peers() {
        let (mut host, _package, task_id) = host_with_draft();
        let agents = vec![Id::new(), Id::new()];
        let request_md = format!(
            "# Before\n原文。\n\n# Request\n改克制。\n\n# Reply format\n写进 agents/{AGENT_ID_PLACEHOLDER}/runs/{RUN_ID_PLACEHOLDER}/attempts/{RUN_ID_PLACEHOLDER}/result.md。\n"
        );
        let package = DispatchPackage {
            scopes: Vec::new(),
            prefix_bytes: 0,
            digest: content_hex(request_md.as_bytes()),
            request_md,
            manifest: vec![],
        };
        host.execute(HostCommand::AuthorizeDispatch {
            task_id,
            new_agents: agents.clone(),
            retry_runs: vec![],
            edges: Vec::new(),
            clicked_digest: package.digest.clone(),
            package,
            authorized_at: 1_000,
        })
        .unwrap();

        let runs = host.runs();
        for (run, agent) in runs.iter().zip(agents.iter()) {
            let staged = &host.context.staged[&run.id];
            assert!(
                staged.contains(&format!("agents/{agent}/runs/{}/", run.id)),
                "请求要指回自己的工作区: {staged}"
            );
            assert!(!staged.contains(RUN_ID_PLACEHOLDER));
            assert!(!staged.contains(AGENT_ID_PLACEHOLDER));
        }
        // 并列隔离：一个 Run 的请求里不出现同侪的 run id。
        let first = &host.context.staged[&runs[0].id];
        assert!(
            !first.contains(&runs[1].id.to_string()),
            "并列 Run 的请求不该提到同侪的工作区"
        );
    }

    /// 重试授权的是一条已存在的 Run，它的 agent 从原 Run 上取——不走
    /// new_agents 那条路，也一样要换对占位符。
    #[test]
    fn a_retry_authorization_substitutes_its_own_agent() {
        let (mut host, _package, task_id) = host_with_draft();
        let agent = Id::new();
        authorize(&mut host, task_id, std::slice::from_ref(&agent));
        let run_id = host.runs()[0].id;
        host.execute(HostCommand::FailRun {
            run_id,
            failure: "malformed".to_string(),
            at: 1_100,
        })
        .unwrap();
        host.execute(HostCommand::RetryRun { run_id }).unwrap();
        let retry = host.runs()[1].id;

        let request_md =
            format!("产出写进 agents/{AGENT_ID_PLACEHOLDER}/runs/{RUN_ID_PLACEHOLDER}/。");
        let package = DispatchPackage {
            scopes: Vec::new(),
            prefix_bytes: 0,
            digest: content_hex(request_md.as_bytes()),
            request_md,
            manifest: vec![],
        };
        host.execute(HostCommand::AuthorizeDispatch {
            task_id,
            new_agents: vec![],
            retry_runs: vec![retry],
            edges: Vec::new(),
            clicked_digest: package.digest.clone(),
            package,
            authorized_at: 1_200,
        })
        .unwrap();

        let staged = &host.context.staged[&retry];
        assert!(staged.contains(&format!("agents/{agent}/runs/{retry}/")));
    }

    /// 判据 2-5 的执行力：上游未终态时下游启动不了。
    #[test]
    fn a_follower_cannot_launch_before_its_upstream_is_terminal() {
        let (mut host, _package, task_id) = host_with_draft();
        let agents = vec![Id::new(), Id::new()];
        authorize_with_edges(
            &mut host,
            task_id,
            &agents,
            vec![None, Some(RunEdge::Follows { upstream: 0 })],
        );
        let upstream = host.runs()[0].id;
        let follower = host.runs()[1].id;

        let refusal = host
            .execute(HostCommand::LaunchRun {
                run_id: follower,
                workspace: "runs/two".to_string(),
            })
            .unwrap_err();
        assert_eq!(
            refusal,
            HostRefusal::UpstreamNotTerminal {
                run: follower,
                upstream
            }
        );

        // 上游自己可以立刻启动。
        host.execute(HostCommand::LaunchRun {
            run_id: upstream,
            workspace: "runs/one".to_string(),
        })
        .unwrap();
        host.execute(HostCommand::CompleteDispatch {
            run_id: upstream,
            receipt: "receipt".to_string(),
        })
        .unwrap();
        host.execute(HostCommand::CollectAttempt {
            run_id: upstream,
            artifact_digest: "artifact".to_string(),
            at: 2_000,
        })
        .unwrap();
        // 收取意味着产出真的落在工作区里；下游的内容条件读的正是它。
        host.context.results.insert(
            upstream,
            b"<agent-result version=\"2\"></agent-result>".to_vec(),
        );

        // 上游终态后下游解锁。
        host.execute(HostCommand::LaunchRun {
            run_id: follower,
            workspace: "runs/two".to_string(),
        })
        .unwrap();
    }

    /// 判据：顺序不是内容。上游终态但没留下产出时，下游必须在进入
    /// `Launching` 之前具名拒绝。
    ///
    /// 旧行为是先把下游写成 `Launching`、提升请求，随后才去读上游产出并失败；
    /// 下游从此停在 `Launching`，重启后被列进「待恢复」，而其实根本没有进程
    /// 需要恢复。把条件挪到状态改变之前，Run 留在 `Authorized`，仍可重试。
    ///
    /// 注入旧顺序（去掉这段检查）会让下面两条断言同时变红：拒绝消失，
    /// 且 Run 落进 `Launching`。
    #[test]
    fn a_follower_refuses_when_its_terminal_upstream_left_no_result() {
        let (mut host, _package, task_id) = host_with_draft();
        let agents = vec![Id::new(), Id::new()];
        authorize_with_edges(
            &mut host,
            task_id,
            &agents,
            vec![None, Some(RunEdge::Follows { upstream: 0 })],
        );
        let upstream = host.runs()[0].id;
        let follower = host.runs()[1].id;

        // 上游跑完但失败了——终态成立，产出不存在。
        host.execute(HostCommand::LaunchRun {
            run_id: upstream,
            workspace: "runs/one".to_string(),
        })
        .unwrap();
        host.execute(HostCommand::CompleteDispatch {
            run_id: upstream,
            receipt: "receipt".to_string(),
        })
        .unwrap();
        host.execute(HostCommand::FailRun {
            run_id: upstream,
            failure: "producer exited 1".to_string(),
            at: 2_000,
        })
        .unwrap();

        let refusal = host
            .execute(HostCommand::LaunchRun {
                run_id: follower,
                workspace: "runs/two".to_string(),
            })
            .unwrap_err();
        assert_eq!(
            refusal,
            HostRefusal::UpstreamWithoutArtifact {
                run: follower,
                upstream
            }
        );
        // 拒绝必须发生在状态改变之前：留在 Authorized 才能重试。
        assert!(matches!(
            host.runs()[1].progress,
            RunProgress::Authorized { .. }
        ));
    }

    /// 判据：授权携带的边比它铸造的 Run 还多时，必须具名拒绝。
    ///
    /// 短列表是默认值（不做编排的调用者一条都不传），长列表却说明两份清单
    /// 对「这一轮有几个 Run」的看法不一致。旧行为是 `resize` 顺手把尾巴丢掉，
    /// 作者于是授权了一个宿主根本没建的形状，而且没有任何一处说出来。
    ///
    /// 注入旧行为（把拒绝换回 `resize`）会让这条变红：授权会成功，
    /// 而第二条边连同它描述的关系一起消失。
    #[test]
    fn an_authorization_with_more_edges_than_runs_is_refused_not_truncated() {
        let (mut host, _package, task_id) = host_with_draft();
        let refusal = try_authorize_with_edges(
            &mut host,
            task_id,
            &[Id::new()],
            // 一个 agent，两条边：多出来的那条描述的 Run 不会存在。
            vec![None, Some(RunEdge::Follows { upstream: 0 })],
        )
        .unwrap_err();
        assert_eq!(
            refusal,
            HostRefusal::EdgeCountExceedsRuns { edges: 2, runs: 1 }
        );
        // 拒绝先于写入：一个 Run 都没铸。
        assert!(host.runs().is_empty());
    }

    /// 判据 2-7：星形不回归。并列的 Run 谁都不等谁。
    #[test]
    fn alternates_launch_without_waiting_for_each_other() {
        let (mut host, _package, task_id) = host_with_draft();
        let agents = vec![Id::new(), Id::new()];
        authorize_with_edges(
            &mut host,
            task_id,
            &agents,
            vec![
                Some(RunEdge::Alternates { peer: 1 }),
                Some(RunEdge::Alternates { peer: 0 }),
            ],
        );
        // 两条都能立刻启动，顺序任意。
        for (index, workspace) in ["runs/one", "runs/two"].iter().enumerate() {
            let run_id = host.runs()[index].id;
            host.execute(HostCommand::LaunchRun {
                run_id,
                workspace: (*workspace).to_string(),
            })
            .unwrap();
        }
    }

    /// 重试继承原 Run 的边：它站在编排里的同一个位置。
    #[test]
    fn a_retry_keeps_the_edge_of_the_run_it_replaces() {
        let (mut host, _package, task_id) = host_with_draft();
        let agents = vec![Id::new(), Id::new()];
        authorize_with_edges(
            &mut host,
            task_id,
            &agents,
            vec![None, Some(RunEdge::Verifies { subject: 0 })],
        );
        let verifier = host.runs()[1].id;
        let edge = host.runs()[1].edge;

        host.execute(HostCommand::LaunchRun {
            run_id: host.runs()[0].id,
            workspace: "runs/one".to_string(),
        })
        .unwrap();
        host.execute(HostCommand::FailRun {
            run_id: verifier,
            failure: "boom".to_string(),
            at: 2_000,
        })
        .unwrap();
        host.execute(HostCommand::RetryRun { run_id: verifier })
            .unwrap();

        let retry = host
            .runs()
            .iter()
            .find(|run| run.retry_of == Some(verifier))
            .expect("retry run");
        assert_eq!(retry.edge, edge, "重试应站在编排里的同一位置");
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
                edges: Vec::new(),
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
            edges: Vec::new(),
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
                edges: Vec::new(),
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
                edges: Vec::new(),
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
