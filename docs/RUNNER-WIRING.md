# Runner wiring (M9)

What the producer runner is, where it already runs, and what remains on the
L4/L5 side. Audience: the parent agent that owns `apps/**` and
`docs/ARCHITECTURE.md`. Everything in `crates/` is done and tested; this file
is the hand-off.

## What was built (all in `crates/`, tested)

- `crates/refrain-app/src/runner.rs` — the pump. Public surface:

  ```rust
  pub struct Runner { /* per-Root live table */ }
  pub struct PumpReport {
      pub dispatched: Vec<Id>,
      pub completed: Vec<(Id, u32)>, // (run, proposals) — KARA reads this
      pub failed: Vec<Id>,
  }
  pub struct LaunchChannel {
      pub adapter: Box<dyn HarnessAdapter + Send>,
      pub connection_argv: Vec<String>,
      pub agent_argv: Vec<String>,
  }
  pub type ChannelFactory =
      dyn Fn(&Config, Id) -> Result<Option<LaunchChannel>, (String, String)>;

  pub fn pump(
      root_id: &str,
      entry: &mut ProjectEntry,
      runner: &mut Runner,
      config: &Config,
      now: u64,
  ) -> Result<PumpReport, RefrainError>;

  pub fn pump_with(/* same, plus */ channel_for: &ChannelFactory)
      -> Result<PumpReport, RefrainError>; // the test seam
  ```

  One pump, non-blocking, six steps:
  1. `launch_servable_awaiting` promotes every authorized Run whose turn has
     come **and that the runner can serve** (configured agent + connection +
     channel). L0 and anonymous agents stay `Authorized` for the author's
     manual `LaunchRun` — the manual round trip's starting point is unchanged
     from before the runner existed. A *configured* agent whose connection is
     gone or has no channel fails by name.
  2. Every `Launching` Run is dispatched through `HarnessAdapter::dispatch`;
     `CompleteDispatch` records the receipt; one observer thread per Run runs
     `HarnessAdapter::observe`. The thread is an implementation detail — a
     crash leaves a `Dispatched` row the §8.2-5 recovery path already owns.
  3. Runs a cancel left behind (ledger says not-`Dispatched`, table holds a
     handle) have their process tree killed (≤ one tick).
  4. Finished observers are finalized: the reply lands as `result.md`
     (`DirectoryContext::land_result`, atomic rename), then the *same*
     `collect_attempt` as the manual path validates it. A collect whose
     structural precondition is unmet (the document is not open — block ids
     live only in open manuscripts) is **not** an error: the Run stays
     `Dispatched` in `pending_collect` and is retried every pump until the
     document is open again.
  5. After a completion, downstream auto-launch uses the *unconditional*
     `launch_awaiting_runs` — byte-for-byte parity with what a manual
     `CollectRun` does today (2.2).
  6. Orphan cleanup runs every pump (upstream death can also arrive via
     `HostCommand`, not only via the runner): a `Follows`/`Verifies` Run whose
     upstream is `Failed`/`Cancelled` *and left no artifact* is recorded
     `Failed` with reason `upstream-failed: <upstream failure>` or
     `upstream-cancelled`, transitively.

- `crates/refrain-app/src/collect.rs` — `AgentComment` lands on the annotation
  surface (`annotations` table, same as hand-written comments). A comment whose
  `target` names a frozen scope anchors on that scope's block, `quote` = the
  frozen text; an unknown target anchors on the document's first block with the
  body prefixed `[<target>] ` — no comment is dropped.

- `crates/refrain-host/src/adapters.rs` — `PrintAdapter::for_connection`
  builds the adapter for a configured connection without a `--version` probe
  (the pump runs on the synchronous ABI thread; probing would pay a second
  process per dispatch).

- `crates/refrain-app/src/dispatch.rs` — the `AdapterKind` → channel-id map is
  now `pub(crate) adapter_channel_id`, shared by dispatch (skill install) and
  the runner (launch).

- `crates/refrain-app/src/application.rs` —
  - `Application` gains `runner: Mutex<runner::Runner>`.
  - `Application::pump_runs(&self, root_id)` (private) locks the runner,
    reads the config snapshot, and runs `runner::pump` inside `with_project`.
  - The `ProjectInput::ReadHost` arm pumps first, then fires
    `QuietEvent::AgentCompleted` / `ProposalArrived` per completion (same
    discipline as `CollectRun`), then answers the snapshot.
  - `launch_awaiting_runs` is `pub(crate)` and returns the `Vec<Id>` it
    launched (the runner needs it to tell its own promotions from §8.2-5
    recovery rows — see "The recovery-list trap" below).

## The pump trigger: nothing new to wire in L4

**No new L4 arm is needed.** `apps/native/host/src/project.rs` routes
`{"kind":"readHost","value":{"rootId":…}}` to `ProjectInput::ReadHost`
generically (see the test at project.rs:494), and the pump now lives inside
that arm. The existing poll chain drives everything:

```
core.ts runs_tick (2500ms) → readHostBytes → project_request.readHost
  → project.rs → ProjectInput::ReadHost → pump_runs → snapshot
```

The tick is armed while a host reply counts `authorized` / `launching` /
`dispatched` progress strings (core.ts:1818-1824, `IN_FLIGHT_*`), which covers
every state the pump must advance. After a manual `LaunchRun` the reply is a
snapshot showing `launching`, so the tick stays armed and the next tick
dispatches.

One check worth making on the L5 side: the tick-arming counts string fields in
the raw JSON. Those constants must match the *actual* serde shape below (see
the mismatch warning).

## The host snapshot JSON (what `wire_json` extraction reads)

`HostSnapshot` (serde `rename_all = "camelCase"`):

```json
{
  "kind": "host",
  "value": {
    "tasks": [ReviewTask],
    "runs": [Run],
    "authorizations": [DispatchAuthorization],
    "runsRequiringRecovery": ["<run-id>"],
    "runsAwaitingLaunch": ["<run-id>"],
    "runTotal": 0
  }
}
```

`Run`: `{ "id", "taskId", "agentId", "snapshotDigest", "workspace",
"progress", "retryOf", "edge" }`.

**`progress` is adjacently tagged** (`tag = "kind", content = "value"`,
camelCase variants):

```json
{"kind":"queued"}
{"kind":"authorized","value":{"requestDigest":"…"}}
{"kind":"launching","value":{"requestDigest":"…"}}
{"kind":"dispatched","value":{"receipt":"…"}}
{"kind":"completed","value":{"artifactDigest":"…"}}
{"kind":"failed","value":{"failure":"…"}}
{"kind":"cancelled"}
```

`edge`: `null` or kebab-case adjacently tagged —
`{"kind":"follows","value":{"upstream":"<run-id>"}}`,
`{"kind":"verifies","value":{"subject":"<run-id>"}}`,
`{"kind":"alternates","value":{"peer":"<run-id>"}}`.

`ReviewTask.progress` (kebab-case): `{"kind":"draft"}`,
`{"kind":"open","value":{"openedAt":0}}`,
`{"kind":"closed","value":{"reason":"runs-terminal"|"author","closedAt":0}}`.

### Mismatch the parent must reconcile (pre-existing, now load-bearing)

`apps/native/src/project_view.zig` `progressLabel` tests parse `progress` as a
bare string (`"cancelled"`) or externally tagged
(`{"authorized":{"requestDigest":"d"}}`), and `core.test.ts:1510/1527` fixture
host replies the same way. That is **not** what `Run` serde emits (see above).
Before M9 no real snapshot ever carried a run, so the mismatch was invisible.
Pick one side and align it — the domain's serde attribute is the authority the
Rust tests pin, so the Zig parser and the TS fixtures are the likely edits.
The `IN_FLIGHT_*` string counts in `core.ts` must also match the real shape
(`"kind":"authorized"` etc., or just `"authorized"` appears as a substring in
both shapes — verify).

## Failure codes the runner records on Runs (`progress.failed.value.failure`)

- `connection-unconfigured`, `channel-unsupported`, `channel-unknown` — a
  *configured* agent whose connection can no longer serve the Run; it fails by
  name instead of occupying `Authorized` forever. (An agent id that is not in
  the config at all is the anonymous/manual case and is left alone — it is the
  L0 file channel, not a misconfiguration.)
- `request-missing` — the promoted request is gone.
- `dispatch-failed: <io error>` — the process did not start.
- `observe-failed: <io error>` — the producer's stream said no (e.g. a refusal
  frame) or broke.
- `observer-panicked` — the observe thread itself died.
- `producer-exited: exit code <c> and no reply` — process finished, no artifact
  words.
- `result-lost` — `land_result` succeeded but collect read back nothing
  (structural; should not happen).
- `upstream-failed: <upstream failure>`, `upstream-cancelled` — orphan
  resolution; the Run also keeps its Task open (`Failed` is not terminal for
  close), so retry-or-close stays the author's call.

The L0 file channel is untouched: an agent without a connection (including
anonymous per-round agent ids) stays `Authorized` until the author's explicit
`LaunchRun`, and `collect_attempt` reads the author's hand-placed `result.md`
exactly as before. A run whose result has landed but whose document is not
open stays `Dispatched` and is retried every pump — it is pending, not failed.

## The recovery-list trap (why `launched` exists)

`AgentHost::open` rebuilds `runs_requiring_recovery` from the journal on every
open: *any* `Launching`/`Dispatched` row counts, including rows the pump itself
wrote one step ago. Without a session marker the pump would refuse to dispatch
its own promotions. `Runner.launched` (per Root) holds the ids this process
promoted; the dispatch filter skips recovery-listed ids **unless** they are in
`launched`. Runs genuinely mid-flight at app start are never in `launched`, so
§8.2-5 semantics are unchanged.

## ARCHITECTURE.md edits for the parent (I did not touch the file)

- **Line 133 (F8 row)**: L3 column — add `runner` to
  `dispatch`, `scope`, `upstream`, `cancel`. Status — replace
  "the producer runner is unmade (M9)" with the landed fact: the runner pumps
  from the `ReadHost` poll; dispatch/observe/`result.md`/`CompleteDispatch`
  are production-wired.
- **Line 405 (M9 entry)**: mark landed. All three parts exist and are tested:
  the pump (runner.rs), the verifier-comments consumer (collect.rs lands
  `AgentComment` into `annotations`), orphan-downstream cleanup
  (`upstream-failed` / `upstream-cancelled`).
- **Line ~429 (step 5 of "How a change reaches the manuscript")**: "The
  producer runs" now names a module: `runner.rs` launches authorized Runs via
  `HarnessAdapter::dispatch` and lands `result.md` from `observe`; the manual
  L0 round trip is unchanged.
- **"The missing links" preamble**: if the function matrix marks M9's ◐
  anywhere else (e.g. F8's ◐ mention), flip it.
- **§8.2-5 prose (if any outside host.rs)**: the recovery list is rebuilt on
  every `AgentHost::open`; the runner's session `launched` set is the way a
  same-process promotion is told apart from a crashed one.

## Test evidence

- New: `crates/refrain-app/tests/runner.rs` — 5 integration tests driving the
  real state machine with a scripted adapter over a real child process:
  happy path to a frozen proposal, verifier auto-launch + comments as
  annotations, orphan failure with a recorded reason, unservable run failing
  by name, L0 left to the manual round trip.
- New: `crates/refrain-app/tests/collect.rs` — 2 tests for comment landing
  (scope-targeted and unknown-target).
- New: 1 unit test in `runner.rs` (per-Root scoping).
- No wire-type changes: `protocol/host.json`, specta exports, and all
  generated files are untouched; no `verify:wire-shapes` impact expected.

## Not done / follow-ups

- Cancelling a live producer kills its tree only at the next pump (≤ one tick,
  2.5 s). If instant kill is wanted, the `HostCommand::CancelRun` arm in
  application.rs would need the runner's `ProcessCancel` table — deliberate
  deferral to keep the arm generic.
- `ProducerOutcome.usage` / `session_hint` are collected by the observer but
  not yet recorded anywhere (SPEC 8.5 columns stay `Unknown` first-class).
- A `Dispatched` run at app start still waits for author-driven recovery by
  design; the runner does not auto-reap it.
