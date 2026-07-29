/**
 * The L0 dispatch round trip against the real window (C10 evidence).
 *
 * Ticket → manifest → authorize → the frozen request lands on disk → a kill
 * mid-flight (the run comes back recovery-required, the result written while
 * the app was down still collects) → proposals freeze → the C8 review loop
 * accepts them. Then the failure vectors: a malformed result fails the run
 * with a typed code, and the retry is a new run that completes.
 *
 * Run: `bun apps/desktop/e2e/dispatch-loop.ts <path-to-refrain.exe>`.
 */

import { Database } from "bun:sqlite";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exe = process.argv[2];
if (!exe) {
  console.error("usage: bun apps/desktop/e2e/dispatch-loop.ts <refrain.exe>");
  process.exit(2);
}

const DRIVER_PORT = 4444;
const fixture = mkdtempSync(join(tmpdir(), "refrain-dispatch-"));
const dataDir = mkdtempSync(join(tmpdir(), "refrain-dispatch-data-"));
const fixtureBin = mkdtempSync(join(tmpdir(), "refrain-dispatch-bin-"));
const chapterPath = join(fixture, "长章.md");

// A fake `kimi` first on PATH: the harness channel runs a real argv round
// trip offline. cargo builds examples for tests; build it explicitly here.
spawnSync("cargo", ["build", "-p", "refrain-host", "--example", "fake_kimi"], {
  stdio: "inherit",
});
copyFileSync(join("target", "debug", "examples", "fake_kimi.exe"), join(fixtureBin, "kimi.exe"));

const sentences = Array.from({ length: 6 }, (_, i) => `第${i + 1}段原来如此。`);
writeFileSync(chapterPath, `${sentences.join("\n\n")}\n`);

const failures: string[] = [];
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    console.error(`FAIL  ${name}${detail === undefined ? "" : `: ${String(detail)}`}`);
    failures.push(name);
  }
};

const base = `http://127.0.0.1:${DRIVER_PORT}`;

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = JSON.parse(text) as { value?: unknown };
  if (!response.ok) {
    throw new Error(`webdriver ${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  }
  return parsed.value;
}

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
type El = string;
let session = "";

const execute = (script: string, args: unknown[] = []): Promise<unknown> =>
  call("POST", `/session/${session}/execute/sync`, { script, args });

const elementOrNull = async (selector: string, xpath = false): Promise<El | null> => {
  try {
    const value = (await call("POST", `/session/${session}/element`, {
      using: xpath ? "xpath" : "css selector",
      value: selector,
    })) as Record<string, string>;
    return value[ELEMENT_KEY] ?? null;
  } catch {
    return null;
  }
};

const click = (el: El): Promise<unknown> =>
  call("POST", `/session/${session}/element/${el}/click`, {});

const clickButton = async (label: string): Promise<void> => {
  await waitFor(
    `button ${label}`,
    async () => (await elementOrNull(`//button[contains(.,'${label}')]`, true)) !== null,
  );
  const el = await elementOrNull(`//button[contains(.,'${label}')]`, true);
  if (el === null) throw new Error(`no button ${label}`);
  await click(el);
};

const altKey = (key: string): Promise<unknown> =>
  call("POST", `/session/${session}/actions`, {
    actions: [
      {
        type: "key",
        id: "keyboard",
        actions: [
          { type: "keyDown", value: "" },
          { type: "keyDown", value: key },
          { type: "keyUp", value: key },
          { type: "keyUp", value: "" },
        ],
      },
    ],
  });

async function waitFor(
  description: string,
  probe: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`timeout waiting for ${description}`);
}

const caps = () => ({
  capabilities: {
    alwaysMatch: {
      browserName: "webview2",
      "ms:edgeOptions": {
        // CI runners have no GPU-backed desktop; without these the WebView2
        // browser process dies before it opens its devtools port.
        args: ["--disable-gpu", "--no-first-run", "--disable-extensions"],
      },
      "tauri:options": {
        application: exe.replaceAll("/", "\\"),
        // CI runners cannot write the default WebView2 user-data folder; a
        // dead profile kills the browser before its devtools port exists
        // (tauri-apps/tauri#10670).
        webviewOptions: { userDataFolder: join(dataDir, "webview") },
      },
    },
  },
});

let driver: ChildProcess | null = null;

const start = async (): Promise<void> => {
  driver = spawn(
    "tauri-driver",
    ["--native-driver", process.env.REFRAIN_MSEDGEDRIVER ?? "msedgedriver"],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        REFRAIN_DATA_DIR: dataDir,
        PATH: `${fixtureBin};${process.env.PATH ?? ""}`,
      },
    },
  );
  driver.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[tauri-driver] ${chunk}`));
  await waitFor("tauri-driver to listen", async () => {
    try {
      await fetch(`${base}/status`);
      return true;
    } catch {
      return false;
    }
  });
  session = ((await call("POST", "/session", caps())) as { sessionId?: string }).sessionId ?? "";
  await waitFor("tauri internals", async () =>
    Boolean(await execute(`return typeof __TAURI_INTERNALS__ !== "undefined"`)),
  );
  await execute(
    `window["refrain.e2e.pick"] = ${JSON.stringify(fixture)}; window["refrain.e2e.pin"] = true; "planted"`,
  );
};

const stop = async (): Promise<void> => {
  if (session !== "") {
    try {
      await call("DELETE", `/session/${session}`);
    } catch {}
    session = "";
  }
  driver?.kill("SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 800));
};

const invoke = (command: string, args: Record<string, unknown>): Promise<unknown> =>
  execute(
    `return __TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})
      .then((r) => r, (e) => { throw new Error(JSON.stringify(e)); })`,
    [],
  );

const openChapter = async (): Promise<void> => {
  await clickButton("打开文件夹");
  await clickButton("长章.md");
  await waitFor("editor blocks", async () =>
    Boolean(await execute(`return document.querySelector("p[data-block-id]") !== null`)),
  );
  // KARA auto-engages on the first manuscript — but asynchronously. Toggling
  // before it lands would switch it ON, so wait for the engagement first.
  await waitFor("KARA on", async () =>
    Boolean(await execute(`return document.querySelector(".kara-chrome") !== null`)),
  );
  // Once KARA is up the rail hides and focus falls back to <body> — a real
  // key chord then never passes through .workbench (its descendant). The
  // real-chord path is review-loop's evidence; here the same Vue handler is
  // exercised by dispatching the keydown onto .workbench directly.
  await execute(
    `document.querySelector(".workbench").dispatchEvent(
       new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); "toggled"`,
    [],
  );
  await waitFor("KARA off", async () =>
    Boolean(await execute(`return document.querySelector(".kara-chrome") === null`)),
  );
};

type HostRun = {
  id: string;
  taskId: string;
  workspace: string;
  progress: string;
  failure: string | null;
};
type HostState = {
  tasks: { id: string; document: string }[];
  runs: HostRun[];
  recoveryRequired: string[];
  awaitingLaunch: string[];
};

const hostState = (rootId: string): Promise<HostState> =>
  invoke("host_state", { rootId }) as Promise<HostState>;

const tickBlock = async (ordinal: number): Promise<void> => {
  const el = await elementOrNull(`(//label[contains(@class,'block-row')])[${ordinal}]/input`, true);
  if (el === null) throw new Error(`no block row ${ordinal}`);
  await click(el);
};

const setPrompt = async (text: string): Promise<void> => {
  await execute(
    `const el = document.querySelector(".dispatch-prompt");
     el.value = ${JSON.stringify(text)};
     el.dispatchEvent(new Event("input", { bubbles: true }));`,
    [],
  );
};

const writeResult = (workspace: string, runId: string, body: string): void => {
  const dir = join(fixture, ".refrain", workspace, "attempts", runId);
  if (!existsSync(dir)) throw new Error(`no attempt directory for run ${runId}`);
  writeFileSync(join(dir, "result.md"), body);
};

const run = async (): Promise<void> => {
  await start();
  const adopted = (await invoke("adopt_root", { path: fixture, kind: "folder" })) as {
    rootId: string;
  };
  const rootId = adopted.rootId;
  await openChapter();
  // Persist the revision BEFORE any kill: continuity (current_head +
  // head_block_ids) is what lets a post-restart manuscript restore the same
  // head id and block ids — without it the proposal's scope no longer
  // resolves (StaleProposal at commit). The command path is deterministic;
  // the Ctrl+S path is writing-slice's evidence.
  await invoke("persist_revision", { rootId, path: "长章.md", expected: null });
  const revAtDraft = (await invoke("current_document", { rootId, path: "长章.md" })) as {
    revision: string;
  };
  console.log(`revision at draft: ${revAtDraft.revision}`);

  // ── The ticket: two blocks, one prompt, one L0 agent. ──
  await clickButton("派发");
  await waitFor("the dispatch surface", async () =>
    Boolean(await execute(`return document.querySelector(".dispatch") !== null`)),
  );
  await tickBlock(2);
  await tickBlock(3);
  await setPrompt("把这两段改得更克制。");
  await waitFor("the send cell to fill", async () =>
    Boolean(
      await execute(
        `const b = document.querySelector(".dispatch-send"); return b !== null && !b.disabled;`,
      ),
    ),
  );
  await clickButton("送出");
  await waitFor("the manifest", async () =>
    Boolean(await execute(`return document.querySelector(".manifest") !== null`)),
  );
  const manifestText = String(
    await execute(`return document.querySelector(".manifest")?.textContent ?? "";`, []),
  );
  check(
    "the manifest lists every section with bytes and tokens",
    manifestText.includes("before") && manifestText.includes("reply-format"),
    manifestText.slice(0, 120),
  );

  // ── Authorize: the frozen request lands on disk. ──
  await clickButton("授权");
  await waitFor("the run to dispatch", async () => {
    const state = await hostState(rootId);
    return state.runs.length === 1 && state.runs[0]?.progress === "dispatched";
  });
  let state = await hostState(rootId);
  const runId = state.runs[0]?.id ?? "";
  const workspace = state.runs[0]?.workspace ?? "";
  const requestPath = join(fixture, ".refrain", workspace, "request.md");
  check("the frozen request is producer-visible", existsSync(requestPath));
  const request = readFileSync(requestPath, "utf8");
  const scopeId = request.match(/<!-- scope ([^ ]+) -->/)?.[1] ?? "";
  check("the request names its scope id", scopeId === "长章:b2-b3", scopeId);
  check(
    "the run id replaced the placeholder",
    request.includes(runId) && !request.includes("<run-id>"),
  );

  // ── The kill: a dispatched run is recovery-required after a restart. ──
  await stop();
  await start();
  await invoke("adopt_root", { path: fixture, kind: "folder" });
  state = await hostState(rootId);
  check(
    "the mid-flight run is recovery-required after the kill",
    state.recoveryRequired.includes(runId),
    state.recoveryRequired,
  );
  check(
    "nothing auto-resumed: the run is still dispatched",
    state.runs[0]?.progress === "dispatched",
  );

  // The result landed while the app was down: L0's whole point.
  writeResult(
    workspace,
    runId,
    `<agent-result version="2">
  <replacement scope="${scopeId}">改写的第二段。

改写的第三段。</replacement>
  <memo topic="语气">结尾偏议论。</memo>
</agent-result>
`,
  );

  // ── Collect through the UI: completed, one proposal frozen. ──
  await openChapter();
  const revAfterRestart = (await invoke("current_document", { rootId, path: "长章.md" })) as {
    revision: string;
  };
  check(
    "continuity restores the baseline revision across the kill",
    revAfterRestart.revision === revAtDraft.revision,
    `${revAfterRestart.revision} != ${revAtDraft.revision}`,
  );
  await clickButton("派发");
  await waitFor("the collect button", async () =>
    Boolean(await execute(`return document.querySelector(".dispatch-collect") !== null`)),
  );
  await clickButton("收取");
  await waitFor("the run to complete", async () => {
    const after = await hostState(rootId);
    return after.runs[0]?.progress === "completed";
  });
  state = await hostState(rootId);
  check("the run completed after the restart collect", state.runs[0]?.progress === "completed");
  const proposals = (await invoke("list_proposals", { rootId, path: "长章.md" })) as {
    after: string | null;
  }[];
  check(
    "the artifact froze into a proposal",
    proposals.length === 1 && (proposals[0]?.after ?? "").includes("改写的第二段"),
    proposals.length,
  );

  // ── The C8 loop accepts it: the text actually changes. ──
  await clickButton("Review");
  await waitFor("the review surface", async () =>
    Boolean(await execute(`return document.querySelector(".review-surface") !== null`)),
  );
  const surfaceEl = await elementOrNull(".review-surface");
  if (surfaceEl !== null) await click(surfaceEl);
  const counts = async (): Promise<[number, number]> => {
    const text = String(
      await execute(`return document.querySelector(".review-head")?.textContent ?? "";`, []),
    );
    const match = text.match(/(\d+)\/(\d+)/);
    return match ? [Number(match[1]), Number(match[2])] : [0, 0];
  };
  for (let i = 0; i < 40; i += 1) {
    const [done, totalNow] = await counts();
    if (totalNow > 0 && done >= totalNow) break;
    await altKey("a");
    // A verdict is record + persist + advance: wait for the count AND the
    // advance, or the next press duplicates the slice (review-loop's rhythm).
    await waitFor(`verdict ${done + 1}`, async () => (await counts())[0] > done, 6_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (i === 39) throw new Error("the review path did not exhaust the units");
  }
  const [, total] = await counts();
  const stagedCount = async (): Promise<number> =>
    Number(
      String(
        await execute(`return document.querySelector(".review-head")?.textContent ?? "";`, []),
      ).match(/(\d+) 待合并/)?.[1] ?? "0",
    );
  for (let i = 0; i < total; i += 1) {
    const before = await stagedCount();
    await altKey("s");
    await waitFor(`stage ${before + 1}`, async () => (await stagedCount()) > before, 6_000);
    await altKey("k");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  check("the judged units are staged", (await stagedCount()) > 0, await stagedCount());
  // The commit button is the always-visible mouse path (SPEC 9.7); the
  // Alt+Enter chord is review-loop's evidence. Use the deterministic one here.
  await clickButton("合并");
  try {
    await waitFor("the surface to close on commit", async () =>
      Boolean(await execute(`return document.querySelector(".review-surface") === null`)),
    );
  } catch (error) {
    const headText = await execute(
      `return document.querySelector(".review-head")?.textContent ?? "";`,
      [],
    );
    const revAtCommit = (await invoke("current_document", { rootId, path: "长章.md" })) as {
      revision: string;
    };
    const proposalsNow = (await invoke("list_proposals", { rootId, path: "长章.md" })) as {
      baseline: string;
    }[];
    let commitError = "unknown";
    try {
      await invoke("commit_decision_batch", { rootId, path: "长章.md" });
      commitError = "(the direct invoke succeeded)";
    } catch (direct) {
      commitError = String(direct);
    }
    console.error("commit did not land:", {
      headText,
      revAtDraft: revAtDraft.revision,
      revAtCommit: revAtCommit.revision,
      proposalBaseline: proposalsNow[0]?.baseline,
      commitError: commitError.slice(0, 300),
    });
    throw error;
  }
  const head = await invoke("current_document", { rootId, path: "长章.md" }).then((doc) =>
    (doc as { blocks: { text: string }[] }).blocks.map((b) => b.text).join("\n\n"),
  );
  check(
    "the collected proposal landed in the manuscript",
    String(head).includes("改写的第二段"),
    String(head).slice(0, 60),
  );

  // ── The failure vectors: malformed → typed failure → retry completes. ──
  // The commit returns the stage to the editor and the ticket remounts on
  // its own (the rail toggle was never switched off): do NOT click 派发
  // here, that would close it.
  await waitFor("the dispatch surface again", async () =>
    Boolean(await execute(`return document.querySelector(".dispatch") !== null`)),
  );
  await tickBlock(5);
  await setPrompt("改写这一段。");
  await clickButton("送出");
  await waitFor("the second manifest", async () =>
    Boolean(await execute(`return document.querySelector(".manifest") !== null`)),
  );
  await clickButton("授权");
  await waitFor("the second run to dispatch", async () => {
    const s = await hostState(rootId);
    return s.runs.filter((r) => r.progress === "dispatched").length === 1;
  });
  state = await hostState(rootId);
  const bad = state.runs.find((r) => r.progress === "dispatched");
  if (bad === undefined) throw new Error("no dispatched run for the failure vector");
  writeResult(bad.workspace, bad.id, "这不是一个 agent-result，只是闲聊。\n");
  await clickButton("收取");
  await waitFor("the run to fail typed", async () => {
    const s = await hostState(rootId);
    return s.runs.find((r) => r.id === bad.id)?.progress === "failed";
  });
  state = await hostState(rootId);
  check(
    "a malformed result fails the run with the parser's code",
    state.runs.find((r) => r.id === bad.id)?.failure === "missing-root",
    state.runs.find((r) => r.id === bad.id)?.failure,
  );

  await clickButton("重试");
  await waitFor("the retry to dispatch", async () => {
    const s = await hostState(rootId);
    return s.runs.filter((r) => r.progress === "dispatched").length === 1;
  });
  state = await hostState(rootId);
  const retryRun = state.runs.find((r) => r.progress === "dispatched");
  if (retryRun === undefined) throw new Error("no dispatched retry");
  check("the retry is a NEW run", retryRun.id !== bad.id, retryRun.id);
  const retryRequest = readFileSync(
    join(fixture, ".refrain", retryRun.workspace, "request.md"),
    "utf8",
  );
  const retryScope = retryRequest.match(/<!-- scope ([^ ]+) -->/)?.[1] ?? "";
  writeResult(
    retryRun.workspace,
    retryRun.id,
    `<agent-result version="2">
  <replacement scope="${retryScope}">改写的第五段。</replacement>
</agent-result>
`,
  );
  await clickButton("收取");
  await waitFor("the retry to complete", async () => {
    const s = await hostState(rootId);
    return s.runs.find((r) => r.id === retryRun.id)?.progress === "completed";
  });
  state = await hostState(rootId);
  check(
    "the retry completes",
    state.runs.find((r) => r.id === retryRun.id)?.progress === "completed",
  );
  check(
    "the failed run stays failed (§8.2-4)",
    state.runs.find((r) => r.id === bad.id)?.progress === "failed",
  );
  const proposalsAfter = (await invoke("list_proposals", { rootId, path: "长章.md" })) as unknown[];
  check(
    "both valid artifacts are frozen proposals",
    proposalsAfter.length === 2,
    proposalsAfter.length,
  );

  // ── The harness channel: the fake kimi does a real argv round trip. ──
  const harnesses = (await invoke("list_harnesses", {})) as { agentId: string }[];
  check("the fake harness is detected", harnesses.length === 1, harnesses.length);
  const kimiAgent = harnesses[0]?.agentId ?? "";
  await clickButton("再发");
  await waitFor("the agent dropdown", async () =>
    Boolean(await execute(`return document.querySelector(".dispatch-agent") !== null`)),
  );
  await execute(
    `const s = document.querySelector(".dispatch-agent");
     s.value = ${JSON.stringify(kimiAgent)};
     s.dispatchEvent(new Event("change", { bubbles: true }));`,
    [],
  );
  await tickBlock(6);
  await setPrompt("改写第六段。");
  await clickButton("送出");
  await waitFor("the harness manifest", async () =>
    Boolean(await execute(`return document.querySelector(".manifest") !== null`)),
  );
  await clickButton("授权");
  await waitFor("the harness run to dispatch", async () => {
    const s = await hostState(rootId);
    return s.runs.some((r) => r.progress === "dispatched" && r.agentId === kimiAgent);
  });
  state = await hostState(rootId);
  const harnessRun = state.runs.find((r) => r.agentId === kimiAgent && r.progress === "dispatched");
  if (harnessRun === undefined) throw new Error("no dispatched harness run");
  // The fake settles in milliseconds; the background observer lands the file.
  await waitFor(
    "the harness result to land",
    async () =>
      existsSync(
        join(fixture, ".refrain", harnessRun.workspace, "attempts", harnessRun.id, "result.md"),
      ),
    30_000,
  );
  await clickButton("收取");
  await waitFor("the harness run to complete", async () => {
    const s = await hostState(rootId);
    return s.runs.find((r) => r.id === harnessRun.id)?.progress === "completed";
  });
  const proposalsFinal = (await invoke("list_proposals", { rootId, path: "长章.md" })) as {
    after: string | null;
  }[];
  check(
    "the harness artifact froze into a proposal",
    proposalsFinal.some((p) => (p.after ?? "").includes("伪 Agent 改写")),
    proposalsFinal.length,
  );
  const landed = readFileSync(
    join(fixture, ".refrain", harnessRun.workspace, "attempts", harnessRun.id, "result.md"),
    "utf8",
  );
  check("the landed result carries the agent-result", landed.includes("<agent-result"));

  // ── The material-draft chain (SPEC 8.7): artifact → draft rows → the only
  // Human Material Action → a Material document → ticked into the next
  // frozen request. ──
  await clickButton("再发");
  // The harness section left the fake kimi selected; this chain hand-writes
  // its result, so it goes through the L0 file channel.
  const l0Agent = (await invoke("l0_file_channel_agent", {})) as string;
  await execute(
    `const s = document.querySelector(".dispatch-agent");
     s.value = ${JSON.stringify(l0Agent)};
     s.dispatchEvent(new Event("change", { bubbles: true }));`,
    [],
  );
  await tickBlock(1);
  await setPrompt("为这一章写一张人物卡。");
  await clickButton("送出");
  await waitFor("the material manifest", async () =>
    Boolean(await execute(`return document.querySelector(".manifest") !== null`)),
  );
  await clickButton("授权");
  await waitFor("the material run to dispatch", async () => {
    const s = await hostState(rootId);
    return s.runs.filter((r) => r.progress === "dispatched").length === 1;
  });
  state = await hostState(rootId);
  const matRun = state.runs.find((r) => r.progress === "dispatched");
  if (matRun === undefined) throw new Error("no dispatched material run");
  // The basis ref must name the store's current head: persist first so the
  // manuscript head and the stored current_head are the same revision.
  await invoke("persist_revision", { rootId, path: "长章.md", expected: null });
  const revForBasis = (await invoke("current_document", { rootId, path: "长章.md" })) as {
    revision: string;
  };
  const basisRef = `长章.md@${revForBasis.revision}`;
  writeResult(
    matRun.workspace,
    matRun.id,
    `<agent-result version="2">
  <material-draft kind="character-profile" title="林栖迟">
    <basis ref="${basisRef}" />
    <body><![CDATA[她说话很省。

遇事先做，再说话。]]></body>
  </material-draft>
  <material-draft kind="concept-explanation" title="克制">
    <basis ref="${basisRef}" />
    <body><![CDATA[删掉形容词。]]></body>
  </material-draft>
</agent-result>
`,
  );
  await clickButton("收取");
  await waitFor("the material run to complete", async () => {
    const s = await hostState(rootId);
    return s.runs.find((r) => r.id === matRun.id)?.progress === "completed";
  });
  const drafts = (await invoke("list_material_drafts", { rootId })) as {
    id: string;
    title: string;
  }[];
  check(
    "the artifact landed two material drafts",
    drafts.length === 2 && drafts[0]?.title === "林栖迟",
    drafts.map((draft) => draft.title),
  );
  const docsNow = (): { path: string; role: string }[] => {
    // Disk truth, no side effects: adopt_root would REPLACE the live project
    // entry (open manuscripts dropped, KARA re-armed) — never a read path.
    const db = new Database(join(fixture, ".refrain", "refrain.db"), { readonly: true });
    try {
      return db.query("SELECT path, role FROM documents").all() as {
        path: string;
        role: string;
      }[];
    } finally {
      db.close();
    }
  };
  check(
    "no Material document exists before the human action",
    docsNow().filter((doc) => doc.role === "material").length === 0,
  );

  // Save the first draft through the panel: the only Human Material Action.
  await waitFor("the drafts panel", async () =>
    Boolean(await execute(`return document.querySelector(".draft-row") !== null`)),
  );
  await clickButton("保存");
  await waitFor("the save to resolve its draft", async () => {
    const left = (await invoke("list_material_drafts", { rootId })) as { title: string }[];
    return left.length === 1 && left[0]?.title === "克制";
  });
  const materialDocs = docsNow().filter((doc) => doc.role === "material");
  check(
    "the save created exactly one Material document",
    materialDocs.length === 1,
    materialDocs.map((doc) => doc.path),
  );
  const materialPath = materialDocs[0]?.path ?? "";
  const materialText = readFileSync(join(fixture, materialPath), "utf8");
  check(
    "the material file carries the draft body through the text path",
    materialText.includes("她说话很省。") && materialText.includes("遇事先做，再说话。"),
    materialPath,
  );

  // Dismiss the second: the row goes, nothing is written.
  await clickButton("退回");
  await waitFor("the drafts to drain", async () => {
    const left = (await invoke("list_material_drafts", { rootId })) as unknown[];
    return left.length === 0;
  });
  check("the dismiss resolves the other draft", true);
  check(
    "the dismiss wrote no new Material",
    docsNow().filter((doc) => doc.role === "material").length === 1,
  );

  // Tick the saved material: it rides the next frozen request.
  await clickButton("再发");
  await waitFor("the materials checklist", async () =>
    Boolean(await execute(`return document.querySelector(".material-row input") !== null`)),
  );
  const matCheckbox = await elementOrNull(
    `(//label[contains(@class,'material-row')])[1]/input`,
    true,
  );
  if (matCheckbox === null) throw new Error("no material checkbox");
  await click(matCheckbox);
  await tickBlock(1);
  await setPrompt("对照人物卡改写第一段。");
  await waitFor("the send cell to fill again", async () =>
    Boolean(
      await execute(
        `const b = document.querySelector(".dispatch-send"); return b !== null && !b.disabled;`,
      ),
    ),
  );
  await clickButton("送出");
  try {
    await waitFor("the ticked-material manifest", async () =>
      Boolean(await execute(`return document.querySelector(".manifest") !== null`)),
    );
  } catch (error) {
    console.error("ticked-material preview never appeared:", {
      notice: await execute(
        `return document.querySelector(".dispatch .notice")?.textContent ?? null;`,
      ),
      phase: await execute(
        `return { send: (document.querySelector(".dispatch-send") || {}).disabled, mat: document.querySelectorAll(".material-row").length, blocks: document.querySelectorAll(".block-row").length };`,
      ),
    });
    throw error;
  }
  await clickButton("授权");
  await waitFor("the ticked-material run to dispatch", async () => {
    const s = await hostState(rootId);
    return s.runs.filter((r) => r.progress === "dispatched").length === 1;
  });
  state = await hostState(rootId);
  const tickedRun = state.runs.find((r) => r.progress === "dispatched");
  if (tickedRun === undefined) throw new Error("no dispatched ticked-material run");
  const tickedRequest = readFileSync(
    join(fixture, ".refrain", tickedRun.workspace, "request.md"),
    "utf8",
  );
  check(
    "the ticked material rides the frozen request",
    tickedRequest.includes("她说话很省。"),
    tickedRequest.length,
  );
  // Leave no in-flight run behind: later sections count dispatched runs.
  await clickButton("取消");
  await waitFor("the ticked-material run to cancel", async () => {
    const s = await hostState(rootId);
    return s.runs.find((r) => r.id === tickedRun.id)?.progress === "cancelled";
  });

  // ── Parallel copies (并行 ×N): one ticket mints N runs of one agent — same
  // frozen input, distinct workspaces, no cross-visibility (SPEC 8.6). ──
  await clickButton("再发");
  await tickBlock(2);
  await setPrompt("改写第二段，给两个候选。");
  await execute(
    `const s = document.querySelector(".dispatch-copies");
     s.value = "2";
     s.dispatchEvent(new Event("change", { bubbles: true }));`,
    [],
  );
  await clickButton("送出");
  await waitFor("the parallel manifest", async () =>
    Boolean(await execute(`return document.querySelector(".manifest") !== null`)),
  );
  await clickButton("授权");
  await waitFor("two parallel runs to dispatch", async () => {
    const s = await hostState(rootId);
    return s.runs.filter((r) => r.progress === "dispatched").length === 2;
  });
  state = await hostState(rootId);
  const parallel = state.runs.filter((r) => r.progress === "dispatched");
  const runA = parallel[0];
  const runB = parallel[1];
  if (runA === undefined || runB === undefined) throw new Error("no two dispatched parallel runs");
  check("one ticket minted exactly two runs", parallel.length === 2, parallel.length);
  check("the two runs share one task", runA.taskId === runB.taskId, runA.taskId);
  check("the two runs own distinct workspaces", runA.workspace !== runB.workspace);
  const reqA = readFileSync(join(fixture, ".refrain", runA.workspace, "request.md"), "utf8");
  const reqB = readFileSync(join(fixture, ".refrain", runB.workspace, "request.md"), "utf8");
  const parScope = reqA.match(/<!-- scope ([^ ]+) -->/)?.[1] ?? "";
  check(
    "both runs froze the same scope",
    parScope !== "" && parScope === (reqB.match(/<!-- scope ([^ ]+) -->/)?.[1] ?? ""),
    parScope,
  );
  check(
    "each request names only its own run",
    reqA.includes(runA.id) &&
      !reqA.includes(runB.id) &&
      reqB.includes(runB.id) &&
      !reqB.includes(runA.id),
  );
  const stripRun = (text: string, id: string): string => text.replaceAll(id, "<run>");
  check(
    "the two frozen requests are the same input",
    stripRun(reqA, runA.id) === stripRun(reqB, runB.id),
  );

  writeResult(
    runA.workspace,
    runA.id,
    `<agent-result version="2"><replacement scope="${parScope}">候选甲的第二段。</replacement></agent-result>\n`,
  );
  writeResult(
    runB.workspace,
    runB.id,
    `<agent-result version="2"><replacement scope="${parScope}">候选乙的第二段。</replacement></agent-result>\n`,
  );
  await clickButton("收取");
  await waitFor("the first parallel run to complete", async () => {
    const s = await hostState(rootId);
    return (
      s.runs.filter((r) => [runA.id, runB.id].includes(r.id) && r.progress === "completed")
        .length === 1
    );
  });
  await clickButton("收取");
  await waitFor("both parallel runs to complete", async () => {
    const s = await hostState(rootId);
    return (
      s.runs.filter((r) => [runA.id, runB.id].includes(r.id) && r.progress === "completed")
        .length === 2
    );
  });
  const cohort = (await invoke("list_proposals", { rootId, path: "长章.md" })) as {
    after: string | null;
  }[];
  check(
    "both candidates froze as proposals — no automatic winner",
    cohort.some((p) => (p.after ?? "").includes("候选甲的第二段")) &&
      cohort.some((p) => (p.after ?? "").includes("候选乙的第二段")),
    cohort.length,
  );

  // ── The reading ledger (C12): rebuilt from the authorization journal. ──
  const readings = (await invoke("agent_reading_ledger", { rootId })) as {
    agentId: string;
    document: string;
    rounds: number;
    stale: boolean;
  }[];
  const l0Reading = readings.find((row) => row.agentId === l0Agent && row.document === "长章.md");
  check(
    "the reading ledger rebuilds the agent's rounds",
    (l0Reading?.rounds ?? 0) >= 6,
    l0Reading?.rounds,
  );
  check("the ledger sees the agent is current", l0Reading?.stale === false, l0Reading?.stale);
  await clickButton("再发");
  check(
    "the ticket shows the agent's reading",
    Boolean(await execute(`return document.querySelector(".reading") !== null`)),
  );

  // ── Carry tiers and contract tiers (C12): 增量/全文/不带, and the harness
  // pointer after its first round. ──
  const setCarry = async (tier: string): Promise<void> => {
    await execute(
      `const s = document.querySelector(".dispatch-carry");
       s.value = ${JSON.stringify(tier)};
       s.dispatchEvent(new Event("change", { bubbles: true }));`,
      [],
    );
  };
  const dispatchOnce = async (text: string): Promise<HostRun> => {
    // newTask does not reset the copies control: force one run per ticket.
    await execute(
      `const s = document.querySelector(".dispatch-copies");
       s.value = "1";
       s.dispatchEvent(new Event("change", { bubbles: true }));`,
      [],
    );
    await tickBlock(2);
    await setPrompt(text);
    await clickButton("送出");
    await waitFor("a manifest", async () =>
      Boolean(await execute(`return document.querySelector(".manifest") !== null`)),
    );
    await clickButton("授权");
    try {
      await waitFor("one run to dispatch", async () => {
        const s = await hostState(rootId);
        return s.runs.filter((r) => r.progress === "dispatched").length === 1;
      });
    } catch (error) {
      console.error("dispatchOnce stalled:", {
        notice: await execute(
          `return document.querySelector(".dispatch .notice")?.textContent ?? null;`,
        ),
        phase: await execute(
          `return { manifest: document.querySelector(".manifest") !== null, runs: (await 0, document.querySelectorAll(".run-row").length) };`,
        ),
      });
      throw error;
    }
    const s = await hostState(rootId);
    const run = s.runs.find((r) => r.progress === "dispatched");
    if (run === undefined) throw new Error("no dispatched run");
    return run;
  };
  const cancelRun = async (runId: string): Promise<void> => {
    await clickButton("取消");
    await waitFor("the run to cancel", async () => {
      const s = await hostState(rootId);
      return s.runs.find((r) => r.id === runId)?.progress === "cancelled";
    });
  };
  const requestOf = (run: HostRun): string =>
    readFileSync(join(fixture, ".refrain", run.workspace, "request.md"), "utf8");

  await setCarry("full");
  const fullRun = await dispatchOnce("用全文对照改写第二段。");
  const fullRequest = requestOf(fullRun);
  check(
    "the full tier carries the whole manuscript and the verdict stream",
    fullRequest.includes("第1段原来如此。") && fullRequest.includes("<changes>"),
  );
  await cancelRun(fullRun.id);

  await clickButton("再发");
  await setCarry("none");
  const bareRun = await dispatchOnce("只改第二段。");
  const bareRequest = requestOf(bareRun);
  check(
    "the none tier carries neither changes nor the manuscript",
    !bareRequest.includes("<changes>") && !bareRequest.includes("第1段原来如此。"),
  );
  check(
    "the none tier still carries the short contract",
    bareRequest.includes("One <replacement> per scope"),
  );
  await cancelRun(bareRun.id);

  // The fake kimi already ran once: its next request carries the pointer
  // line, not the whole contract (KL9's contract injection).
  await clickButton("再发");
  await execute(
    `const s = document.querySelector(".dispatch-agent");
     s.value = ${JSON.stringify(kimiAgent)};
     s.dispatchEvent(new Event("change", { bubbles: true }));`,
    [],
  );
  await setCarry("diff");
  const pointerRun = await dispatchOnce("再改一次第二段。");
  const pointerRequest = requestOf(pointerRun);
  check(
    "a harness's later round carries only the contract pointer",
    pointerRequest.includes("按 RefRain 兼容格式输出") &&
      !pointerRequest.includes("One <replacement> per scope"),
  );
  await cancelRun(pointerRun.id);

  // ── Connections (C12 roster): register → probe → dispatch through →
  // remove. The declared connection replaces PATH detection on the ticket. ──
  const fakeKimiExe = join(fixtureBin, "kimi.exe");
  await invoke("upsert_harness_connection", { executable: fakeKimiExe });
  const cfg = (await invoke("read_config", {})) as {
    config: { harness_connections: { id: string; adapter: string; executable: string }[] };
  };
  check(
    "the connection landed in the one Config without any trust bit",
    cfg.config.harness_connections.length === 1 &&
      cfg.config.harness_connections[0]?.executable === fakeKimiExe &&
      !("trusted" in (cfg.config.harness_connections[0] ?? {})),
    cfg.config.harness_connections.length,
  );
  const conn = cfg.config.harness_connections[0];
  if (conn === undefined) throw new Error("no registered connection");
  const probed = (await invoke("probe_connection", { executable: fakeKimiExe })) as string;
  check("the probe reads the fake kimi's version", probed === "9.9.9-fake", probed);
  const registered = (await invoke("list_harnesses", {})) as { agentId: string }[];
  check(
    "the declared connection replaces PATH detection",
    registered.length === 1 && registered[0]?.agentId === conn.id,
    registered.map((harness) => harness.agentId),
  );

  // The ticket loads its agent list on mount: remount it so the connection
  // appears, then dispatch through it. A first-round harness gets the FULL
  // contract (KL9's contract injection).
  await clickButton("收起");
  await clickButton("派发");
  await waitFor("the remounted ticket", async () =>
    Boolean(await execute(`return document.querySelector(".dispatch-agent") !== null`)),
  );
  await execute(
    `const s = document.querySelector(".dispatch-agent");
     s.value = ${JSON.stringify(conn.id)};
     s.dispatchEvent(new Event("change", { bubbles: true }));`,
    [],
  );
  const connRun = await dispatchOnce("经登记连接改写第二段。");
  const connRequest = requestOf(connRun);
  check(
    "a harness's first round carries the full generated protocol",
    connRequest.includes("unsupported-version"),
  );
  await waitFor(
    "the connection result to land",
    async () =>
      existsSync(join(fixture, ".refrain", connRun.workspace, "attempts", connRun.id, "result.md")),
    30_000,
  );
  await clickButton("收取");
  await waitFor("the connection run to complete", async () => {
    const s = await hostState(rootId);
    return s.runs.find((r) => r.id === connRun.id)?.progress === "completed";
  });
  const connProposals = (await invoke("list_proposals", { rootId, path: "长章.md" })) as {
    after: string | null;
  }[];
  check(
    "the connection's artifact froze into a proposal",
    connProposals.filter((p) => (p.after ?? "").includes("伪 Agent 改写")).length >= 2,
    connProposals.length,
  );

  await invoke("remove_harness_connection", { id: conn.id });
  const cfgAfter = (await invoke("read_config", {})) as {
    config: { harness_connections: unknown[] };
  };
  check(
    "the remove leaves the Config empty",
    cfgAfter.config.harness_connections.length === 0,
    cfgAfter.config.harness_connections.length,
  );

  // ── Source import (C12.3): a real HTML through the real button, a DOCX
  // through the command, a real Word document when Word is present. The
  // other formats are pinned by the store's extractor tests. ──
  const sources = mkdtempSync(join(tmpdir(), "refrain-sources-"));
  const htmlPath = join(sources, "参考资料.html");
  writeFileSync(
    htmlPath,
    `<!doctype html><html><head><title>t</title></head><body><h1>调查结论</h1><p>数字不说谎。</p><script>var x=1;</script></body></html>`,
  );
  await execute(`window.prompt = () => ${JSON.stringify(htmlPath)}; "stubbed"`, []);
  await clickButton("导入");
  await waitFor("the imported material on the rail", async () =>
    Boolean(
      await execute(
        `return Array.from(document.querySelectorAll(".rail li button")).some((b) => b.textContent.includes("参考资料"));`,
      ),
    ),
  );

  const docxStage = mkdtempSync(join(tmpdir(), "refrain-docx-"));
  mkdirSync(join(docxStage, "word"), { recursive: true });
  writeFileSync(
    join(docxStage, "word", "document.xml"),
    `<w:document><w:body><w:p><w:r><w:t>导入的第一段。</w:t></w:r></w:p></w:body></w:document>`,
  );
  const zipPath = join(sources, "调研.zip");
  const docxPath = join(sources, "调研.docx");
  const packed = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${docxStage.replaceAll("/", "\\")}\\*' -DestinationPath '${zipPath.replaceAll("/", "\\")}' -Force`,
    ],
    { stdio: "pipe" },
  );
  if (packed.status !== 0 || !existsSync(zipPath)) {
    throw new Error(`docx fixture packing failed: ${packed.stderr?.toString() ?? ""}`);
  }
  copyFileSync(zipPath, docxPath);
  const docxRow = (await invoke("import_material", { rootId, sourcePath: docxPath })) as {
    path: string;
  };
  const openedDocx = (await invoke("open_document", { rootId, path: docxRow.path })) as {
    blocks: { text: string }[];
  };
  check(
    "the docx material carries its paragraph",
    openedDocx.blocks.some((block) => block.text.includes("导入的第一段。")),
    docxRow.path,
  );

  // Real Word evidence (KL9): Word authors the .docx itself. Gated on the
  // COM server being present — CI runners have no Office.
  const wordDocxPath = join(sources, "真机.docx");
  const word = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `$word = New-Object -ComObject Word.Application; $word.Visible = $false;
       $doc = $word.Documents.Add(); $word.Selection.TypeText("Word 真机第一段。");
       $doc.SaveAs2('${wordDocxPath.replaceAll("/", "\\")}', 16); $doc.Close($false); $word.Quit()`,
    ],
    { stdio: "pipe" },
  );
  if (word.status === 0 && existsSync(wordDocxPath)) {
    const wordRow = (await invoke("import_material", { rootId, sourcePath: wordDocxPath })) as {
      path: string;
    };
    const openedWord = (await invoke("open_document", { rootId, path: wordRow.path })) as {
      blocks: { text: string }[];
    };
    check(
      "a real Word document imports",
      openedWord.blocks.some((block) => block.text.includes("Word 真机第一段。")),
      wordRow.path,
    );
  } else {
    console.log("SKIP  Word COM unavailable on this machine");
  }

  let refused = "";
  try {
    await invoke("import_material", { rootId, sourcePath: chapterPath });
    refused = "(accepted)";
  } catch (error) {
    refused = String(error);
  }
  check(
    "a format outside the six is a typed refusal",
    refused.includes("unsupported-format"),
    refused.slice(0, 120),
  );

  // A cold Workbench opens the imported material straight from disk truth:
  // no dirty-flag fight, the render is the editor's real path.
  await stop();
  await start();
  await invoke("adopt_root", { path: fixture, kind: "folder" });
  await clickButton("打开文件夹");
  await waitFor("the rail after restart", async () =>
    Boolean(
      await execute(
        `return Array.from(document.querySelectorAll(".rail li button")).some((b) => b.textContent.includes("参考资料"));`,
      ),
    ),
  );
  await clickButton("参考资料");
  await waitFor("the imported material rendered", async () =>
    Boolean(
      await execute(
        `return Array.from(document.querySelectorAll("p[data-block-id]")).some((p) => p.textContent.includes("调查结论"));`,
      ),
    ),
  );
  const rendered = String(
    await execute(
      `return Array.from(document.querySelectorAll("p[data-block-id]")).map((p) => p.textContent).join("\\n");`,
      [],
    ),
  );
  check(
    "the imported html renders in the editor with provenance",
    rendered.includes("调查结论") &&
      rendered.includes("> 来源：") &&
      rendered.includes("sha256") &&
      rendered.includes("原件克隆"),
    rendered.slice(0, 100),
  );
  check("scripts never render either", !rendered.includes("var x"), rendered.slice(0, 60));
  // The original bytes sit in the project's read-only zone (KL9: the source
  // never moves).
  const clonesDir = join(fixture, ".refrain-source", "materials");
  const clones = existsSync(clonesDir) ? readdirSync(clonesDir) : [];
  check(
    "the source clone landed in .refrain-source/materials",
    clones.some((name) => name.endsWith(".html")) &&
      readFileSync(
        join(clonesDir, clones.find((name) => name.endsWith(".html")) ?? ""),
        "utf8",
      ).includes("调查结论"),
    clones,
  );

  await stop();
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log("\ndispatch loop: all checks passed");
  rmSync(fixture, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
};

void run().finally(() => driver?.kill());
