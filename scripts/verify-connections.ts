#!/usr/bin/env bun

export {};

const rust = await Bun.file("apps/desktop/src-tauri/src/lib.rs").text();
const boundary = await Bun.file("apps/desktop/src-tauri/src/harnesses.rs").text();
const adapters = await Bun.file("crates/refrain-host/src/adapters.rs").text();
const processOwner = await Bun.file("crates/refrain-host/src/process.rs").text();
const bindings = await Bun.file("apps/desktop/src/generated/bindings.gen.ts").text();
const connections = await Bun.file("apps/desktop/src/ui/ConnectionsSurface.tsx").text();
// 票据的领域层搬进了 session；组件只做投影。这条事实的权威随之移位。
const dispatch = await Bun.file("apps/desktop/src/shell/dispatch-session.ts").text();
const e2e = await Bun.file("apps/desktop/e2e/dispatch-loop.ts").text();
const failures: string[] = [];

for (const [source, fact, failure] of [
  [rust, "candidate_id: String", "the connect command does not accept a stable candidate id"],
  [rust, "connection_id: String", "the check command does not accept an existing connection id"],
  [rust, "LocalHarness::from_connection", "dispatch does not rebuild the adapter from Config"],
  [boundary, 'CLAUDE_CODE_CANDIDATE: &str = "claude-code"', "Claude Code is not a fixed candidate"],
  [boundary, 'KIMI_CODE_CANDIDATE: &str = "kimi-code"', "Kimi Code is not a fixed candidate"],
  [boundary, "_ => None", "unknown candidate ids are not refused"],
  [adapters, "validate_version", "version probes do not verify process identity"],
  [adapters, "is_version_number", "current Kimi bare-semver versions are not validated"],
  [adapters, "pub fn at_with_env", "Config-declared environment names do not reach the adapter"],
  [boundary, "&connection.env_allow", "the Config environment allowlist is ignored"],
  [adapters, "outcome.code != Some(0)", "version probes accept failed processes"],
  [processOwner, "pub struct ProcessCancel", "a live process has no independent cancel authority"],
  [
    processOwner,
    "command.process_group(0)",
    "Unix launches do not isolate a cancellable process group",
  ],
  [rust, "active_runs: Mutex<HashMap", "AppState does not retain cancellation by Run"],
  [rust, "struct ActiveRun", "a live Run does not coordinate cancellation with its observer"],
  [rust, "active.cancelled = true", "cancellation does not publish its durable journal result"],
  [
    rust,
    ".map(|active| active.cancelled)",
    "the observer can race cancellation with a terminal failure",
  ],
  [rust, "receipt.handle.cancel_token()", "dispatch does not register the live process"],
  [rust, "active.cancel.cancel_tree()", "cancel does not stop the producer tree"],
  [processOwner, "nix::sys::signal::kill", "Unix cancellation depends on an external kill binary"],
  [
    bindings,
    "upsertHarnessConnection: (candidateId: string)",
    "the bridge still accepts a program path",
  ],
  [
    bindings,
    "probeConnection: (connectionId: string)",
    "the bridge does not bind checks to Config",
  ],
  [connections, "不保存账号或密钥", "the page does not explain the local account boundary"],
  [connections, "添加写作伙伴", "the guided flow does not reach an Agent"],
  // Assert behaviour, not comment wording: the ticket owns an Agent identity,
  // loads the Agent catalogue, and never reads machine connections as Agents.
  [dispatch, "type AgentChoice", "the dispatch ticket has no Agent identity type"],
  [dispatch, "commands.listAgents()", "the dispatch ticket does not load Agents"],
] as const) {
  if (!source.includes(fact)) failures.push(failure);
}

for (const forbidden of [
  "fn probe_connection(executable: String)",
  "upsertHarnessConnection: (executable: string)",
  "pub probe: HarnessProbe",
]) {
  if (`${rust}\n${bindings}`.includes(forbidden)) {
    failures.push(`arbitrary executable surface remains: ${forbidden}`);
  }
}

for (const implementationTerm of ["可执行文件路径", "L0 文件通道", "persona（", "登记即接入"]) {
  if (connections.includes(implementationTerm)) {
    failures.push(`Connections still exposes implementation wording: ${implementationTerm}`);
  }
}

if (dispatch.includes("commands.listHarnesses()")) {
  failures.push("the dispatch ticket still treats a machine connection as an Agent");
}

for (const staleE2eContract of [
  /upsert_harness_connection[\s\S]{0,120}executable/,
  /probe_connection[\s\S]{0,120}executable/,
  /list_harnesses[\s\S]{0,120}agentId/,
]) {
  if (staleE2eContract.test(e2e)) {
    failures.push(`the Windows dispatch E2E uses a retired bridge contract: ${staleE2eContract}`);
  }
}
for (const guidedFact of [
  'candidate.candidateId === "kimi-code"',
  "connectionId: connection.connectionId",
  'invoke("list_agents"',
  'clickButton("添加写作伙伴")',
  'clickButton("返回手稿")',
]) {
  if (!e2e.includes(guidedFact)) {
    failures.push(`the Windows E2E skips the guided connection fact: ${guidedFact}`);
  }
}

// Killing the producer must precede the journal write, or a Run reads Cancelled
// while its process is still producing. The journal write now lives in the use
// case (`refrain_app::cancel::cancel_and_read_back`), so name both sides
// explicitly and refuse when either one is missing — an absent marker must not
// pass as "ordered correctly".
const cancelBody = rust.slice(rust.indexOf("fn cancel_run("), rust.indexOf("fn retry_run("));
const killsTree = cancelBody.indexOf("active.cancel.cancel_tree()");
const writesJournal = cancelBody.indexOf("cancel_and_read_back(");
if (killsTree === -1 || writesJournal === -1) {
  failures.push(
    `cancel_run no longer shows both the producer kill (${killsTree}) and the journal write (${writesJournal}); the ordering guard cannot see what it guards`,
  );
} else if (killsTree > writesJournal) {
  failures.push("the journal claims Cancelled before the producer tree exits");
}

if (failures.length > 0) {
  console.error("FAIL  verify:connections");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(
  "PASS  verify:connections  (8 files, fixed candidates, real cancellation, guided Agent flow)",
);
