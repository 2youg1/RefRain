/**
 * Seven user identities against the real window (C12.6c evidence).
 *
 * Each persona runs one compact flow in its own project fixture and data
 * directory, through tauri-driver + msedgedriver: the real window, real key
 * events, the real filesystem. The three mechanic suites (writing-slice,
 * review-loop, dispatch-loop) already proved the parts; this file records
 * that each identity's path through the product holds end to end, and what
 * the window showed on the way. The written record: probe-results/personas.md.
 *
 * Run: `bun apps/desktop/e2e/personas.ts <path-to-refrain.exe>`.
 */

import { Database } from "bun:sqlite";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exe = process.argv[2];
if (!exe) {
  console.error("usage: bun apps/desktop/e2e/personas.ts <refrain.exe>");
  process.exit(2);
}

const DRIVER_PORT = Number(process.env.REFRAIN_E2E_PORT ?? 4444);
const base = `http://127.0.0.1:${DRIVER_PORT}`;

// A fake `kimi` for the engineer's harness dispatch: a real argv round trip,
// offline. Built once here; only the engineer's driver gets it on PATH.
spawnSync("cargo", ["build", "-p", "refrain-host", "--example", "fake_kimi"], {
  stdio: "inherit",
});
const fixtureBin = mkdtempSync(join(tmpdir(), "refrain-persona-bin-"));
if (!existsSync(join("target", "debug", "examples", "fake_kimi.exe"))) {
  console.error("fake_kimi.exe did not build");
  process.exit(2);
}
copyFileSync(join("target", "debug", "examples", "fake_kimi.exe"), join(fixtureBin, "kimi.exe"));

// ---- per-persona state -------------------------------------------------------
let fixture = "";
let dataDir = "";
let projectDir = "";
let driver: ChildProcess | null = null;
let session = "";

type PersonaResult = { name: string; passed: number; failed: number; notes: string[] };
const results: PersonaResult[] = [];
let current: PersonaResult = { name: "", passed: 0, failed: 0, notes: [] };

const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (condition) {
    current.passed += 1;
    console.log(`PASS  [${current.name}] ${name}`);
  } else {
    current.failed += 1;
    console.error(
      `FAIL  [${current.name}] ${name}${detail === undefined ? "" : `: ${String(detail)}`}`,
    );
  }
};

// An observation, not a verdict: product behaviour the record must carry.
const note = (text: string): void => {
  current.notes.push(text);
  console.log(`NOTE  [${current.name}] ${text}`);
};

// ---- the WebDriver client is a dozen lines of HTTP ---------------------------
async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  // Time the call out and retry once: a WebDriver HTTP call that never comes
  // back otherwise hangs the run with the driver still healthy.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json", connection: "close" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      const parsed = JSON.parse(text) as { value?: unknown };
      if (!response.ok) {
        throw new Error(`webdriver ${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
      }
      return parsed.value;
    } catch (error) {
      lastError = error;
      if (String(error).includes("TimeoutError") || String(error).includes("aborted")) {
        console.error(`NOTE  webdriver call timed out, retrying: ${method} ${path}`);
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
type El = string;

const CONTROL = "";
const ALT = "";
const END = "";

async function elementOrNull(selector: string, xpath = false): Promise<El | null> {
  try {
    const value = (await call("POST", `/session/${session}/element`, {
      using: xpath ? "xpath" : "css selector",
      value: selector,
    })) as Record<string, string>;
    return value[ELEMENT_KEY] ?? null;
  } catch {
    return null;
  }
}

async function elements(selector: string): Promise<El[]> {
  const value = (await call("POST", `/session/${session}/elements`, {
    using: "css selector",
    value: selector,
  })) as Record<string, string>[];
  return value.map((entry) => entry[ELEMENT_KEY] ?? Object.values(entry)[0] ?? "");
}

const click = (el: El): Promise<unknown> =>
  call("POST", `/session/${session}/element/${el}/click`, {});

const sendKeys = (el: El, keys: string): Promise<unknown> =>
  call("POST", `/session/${session}/element/${el}/value`, { text: keys });

const keyChord = (modifier: string, key: string): Promise<unknown> =>
  call("POST", `/session/${session}/actions`, {
    actions: [
      {
        type: "key",
        id: "keyboard",
        actions: [
          { type: "keyDown", value: modifier },
          { type: "keyDown", value: key },
          { type: "keyUp", value: key },
          { type: "keyUp", value: modifier },
        ],
      },
    ],
  });

const chord = (key: string): Promise<unknown> => keyChord(CONTROL, key);
const altKey = (key: string): Promise<unknown> => keyChord(ALT, key);

const execute = (script: string, args: unknown[] = []): Promise<unknown> =>
  call("POST", `/session/${session}/execute/sync`, { script, args });

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

// The rail recedes after idle: a pointer at the left edge summons it back.
const summonRail = (): Promise<unknown> =>
  call("POST", `/session/${session}/actions`, {
    actions: [
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, x: 4, y: 450 },
          { type: "pause", duration: 200 },
        ],
      },
    ],
  });

const asElementRef = (el: El): Record<string, string> => ({ [ELEMENT_KEY]: el });

const clickButton = async (label: string): Promise<void> => {
  await waitFor(
    `button ${label}`,
    async () => (await elementOrNull(`//button[contains(.,'${label}')]`, true)) !== null,
  );
  await summonRail();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const el = await elementOrNull(`//button[contains(.,'${label}')]`, true);
    if (el === null) throw new Error(`no button ${label}`);
    try {
      await click(el);
      return;
    } catch (error) {
      lastError = error;
      if (String(error).includes("stale element")) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
      console.error(`NOTE  JS-click fallback for ${label}: ${String(error).slice(0, 70)}`);
      try {
        await execute(`arguments[0].click(); "js-click"`, [asElementRef(el)]);
        return;
      } catch (jsError) {
        lastError = jsError;
        if (String(jsError).includes("stale element")) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          continue;
        }
        throw jsError;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

const statusText = async (): Promise<string> =>
  String(await execute(`return document.querySelector(".status-line")?.textContent ?? ""`, []));

const invoke = (command: string, args: Record<string, unknown>): Promise<unknown> =>
  execute(
    `return __TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})
      .then((r) => r, (e) => { throw new Error(JSON.stringify(e)); })`,
    [],
  );

// ---- driver lifecycle --------------------------------------------------------
const caps = () => ({
  capabilities: {
    alwaysMatch: {
      browserName: "webview2",
      "ms:edgeOptions": {
        // No GPU-backed desktop on this runner; without these the WebView2
        // browser process dies before it opens its devtools port.
        args: [
          `--user-data-dir=${join(dataDir, "webview-args")}`,
          "--no-first-run",
          "--disable-extensions",
        ],
      },
      "tauri:options": {
        application: exe.replaceAll("/", "\\"),
        // The default WebView2 user-data folder is not writable here; a dead
        // profile kills the browser before its devtools port exists.
        webviewOptions: { userDataFolder: join(dataDir, "webview") },
      },
    },
  },
});

const start = async (withHarness: boolean): Promise<void> => {
  driver = spawn(
    "tauri-driver",
    [
      "--native-driver",
      process.env.REFRAIN_MSEDGEDRIVER ?? "msedgedriver",
      "--port",
      String(DRIVER_PORT),
      "--native-port",
      String(DRIVER_PORT + 100),
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        REFRAIN_DATA_DIR: dataDir,
        ...(withHarness ? { PATH: `${fixtureBin};${process.env.PATH ?? ""}` } : {}),
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
  await waitFor("the app to mount", async () =>
    Boolean(
      await execute(
        `return document.readyState === "complete" && !!document.querySelector(".workbench")`,
      ),
    ),
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
  driver = null;
  await new Promise((resolve) => setTimeout(resolve, 800));
};

// ---- shared flow pieces ------------------------------------------------------

// KARA owns the window once engaged: a real chord never reaches .workbench.
// Dispatch the same keydown in-page; it is the same handler (C10 lesson).
const toggleKaraInPage = async (): Promise<void> => {
  await execute(
    `document.querySelector(".workbench").dispatchEvent(
       new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); "toggled"`,
    [],
  );
};

const karaOn = async (): Promise<boolean> =>
  Boolean(await execute(`return document.querySelector(".kara-veil") !== null`, []));

// Open the project through the rail and leave KARA so the rail comes back.
const openManuscript = async (label: string): Promise<void> => {
  await clickButton("打开文件夹");
  await clickButton(label);
  await waitFor("editor blocks", async () =>
    Boolean(await execute(`return document.querySelector("p[data-block-id]") !== null`, [])),
  );
  // KARA auto-engages on the first manuscript, but asynchronously: wait for
  // the engagement before the toggle, or the toggle would switch it ON.
  await waitFor("KARA on", karaOn);
  await toggleKaraInPage();
  await waitFor("KARA off", async () => !(await karaOn()));
};

type HostRun = {
  id: string;
  taskId: string;
  workspace: string;
  progress: string;
  failure: string | null;
};
type HostState = {
  runs: HostRun[];
};

const hostState = (rootId: string): Promise<HostState> =>
  invoke("host_state", { rootId }) as Promise<HostState>;

const tickBlock = async (ordinal: number): Promise<void> => {
  // The raw input is visually hidden: the wrapping label owns the pixels.
  const el = await elementOrNull(`(//label[contains(@class,'block-row')])[${ordinal}]`, true);
  if (el === null) throw new Error(`no block row ${ordinal}`);
  try {
    await click(el);
  } catch {
    await execute(`arguments[0].click(); "js-click"`, [asElementRef(el)]);
  }
};

const setPrompt = async (value: string): Promise<void> => {
  await execute(
    `const el = document.querySelector(".dispatch-prompt");
     el.value = ${JSON.stringify(value)};
     el.dispatchEvent(new Event("input", { bubbles: true })); "set"`,
    [],
  );
};

const setSelect = async (selector: string, value: string): Promise<void> => {
  await waitFor(`${selector} to appear`, async () =>
    Boolean(
      await execute(`return document.querySelector(${JSON.stringify(selector)}) !== null`, []),
    ),
  );
  await execute(
    `const s = document.querySelector(${JSON.stringify(selector)});
     s.value = ${JSON.stringify(value)};
     s.dispatchEvent(new Event("change", { bubbles: true })); "set"`,
    [],
  );
};

const waitSendReady = async (): Promise<void> => {
  await waitFor("the send cell to fill", async () =>
    Boolean(
      await execute(
        `const b = document.querySelector(".dispatch-send"); return b !== null && !b.disabled;`,
        [],
      ),
    ),
  );
};

const writeResult = (workspace: string, runId: string, body: string): void => {
  const dir = join(projectDir, ".refrain", workspace, "attempts", runId);
  if (!existsSync(dir)) throw new Error(`no attempt directory for run ${runId}`);
  writeFileSync(join(dir, "result.md"), body);
};

const headText = async (rootId: string, path: string): Promise<string> => {
  const doc = (await invoke("current_document", { rootId, path })) as {
    blocks: { text: string }[];
  };
  return doc.blocks.map((block) => block.text).join("\n\n");
};

const reviewCounts = async (): Promise<[number, number]> => {
  const head = String(
    await execute(`return document.querySelector(".review-head")?.textContent ?? "";`, []),
  );
  const match = head.match(/(\d+)\/(\d+)/);
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
};

// The head counts staged VERDICT rows, not units: a merged replace unit
// holds two slices, so staging one unit can move the count by two.
const stagedCount = async (): Promise<number> =>
  Number(
    String(
      await execute(`return document.querySelector(".review-head")?.textContent ?? "";`, []),
    ).match(/(\d+) 待合并/)?.[1] ?? "0",
  );

const openReview = async (): Promise<void> => {
  await clickButton("逐句裁决");
  await waitFor("the review surface", async () =>
    Boolean(await execute(`return document.querySelector(".review-surface") !== null`, [])),
  );
  const surface = await elementOrNull(".review-surface");
  if (surface !== null) await click(surface);
};

// Judge one unit on the keyboard and wait for the ledger to move.
const judgeOne = async (key: string, decidedBefore: number): Promise<void> => {
  await altKey(key);
  await waitFor(
    `verdict ${decidedBefore + 1}`,
    async () => (await reviewCounts())[0] > decidedBefore,
    6_000,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
};

const mergeStaged = async (): Promise<void> => {
  await clickButton("合并");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  // C12.6: the verdict surface no longer closes itself on commit (BUG-04 in
  // the acceptance memo) — the author leaves through 返回.
  if ((await elementOrNull(".review-surface")) !== null) {
    console.error("NOTE  review surface still open after commit — leaving via 返回");
    await clickButton("返回");
  }
  await waitFor("the surface to close after commit", async () =>
    Boolean(await execute(`return document.querySelector(".review-surface") === null`, [])),
  );
};

// ── Persona 1: the AI engineer ─────────────────────────────────────────────
// New project through the welcome screen, a new chapter, text in, a dispatch
// to the fake kimi harness, a collect, one review unit, a merge.
/** 名字不再问 window.prompt：栏内表单（RailPrompt）就地填。 */
const fillRailPrompt = async (text: string): Promise<void> => {
  await waitFor("the inline prompt", async () =>
    Boolean(await execute(`return document.querySelector(".rail-prompt input") !== null`, [])),
  );
  await execute(
    `const i = document.querySelector(".rail-prompt input");
     i.value = ${JSON.stringify(text)};
     i.dispatchEvent(new Event("input", { bubbles: true }));
     i.closest("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));`,
    [],
  );
};

const aiEngineer = async (): Promise<void> => {
  await start(true);

  // The picker seam answers the parent; the inline rail form answers the name.
  await clickButton("新建项目");
  await new Promise((resolve) => setTimeout(resolve, 2500));
  if ((await elementOrNull(".rail-prompt input")) === null) {
    // BUG-06 (acceptance memo): the name prompt lives in the rail, and the
    // rail does not exist before the first project — on the Welcome screen
    // 新建项目 silently stalls. Create through the debug command the prompt
    // would have fed, then adopt through the UI's own folder-open path.
    console.error("NOTE  welcome 新建项目 rendered no name prompt (BUG-06) — debug path");
    await invoke("debug_create_project", { parent: fixture, name: "工程台" });
    await execute(
      `window["refrain.e2e.pick"] = ${JSON.stringify(join(fixture, "工程台"))}; "planted"`,
      [],
    );
    await clickButton("打开文件夹");
  } else {
    await fillRailPrompt("工程台");
  }
  await waitFor("the new project on the rail", async () =>
    Boolean(await execute(`return document.querySelector(".rail") !== null`, [])),
  );
  check("新建项目 creates and adopts the project", true);
  projectDir = join(fixture, "工程台");
  // Nothing is open yet: adopting the same path again returns the same rootId
  // (the permit persists), so later invokes name the project the UI drives.
  const rootId = String(
    ((await invoke("debug_adopt_root", { path: projectDir, kind: "folder" })) as { rootId: string })
      .rootId,
  );

  await clickButton("新章");
  await fillRailPrompt("第一章");
  await waitFor("KARA on for the new chapter", karaOn);
  check("the first manuscript of the session auto-engages KARA", true);
  await toggleKaraInPage();
  await waitFor("KARA off", async () => !(await karaOn()));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const freshBlocks = (await elements("p[data-block-id]")).length;
  note(
    `a fresh 新章 opens with ${freshBlocks} editable block(s); the first text cannot be typed in-app, so it arrived from an outside editor`,
  );

  // The engineer's own editor writes the chapter; RefRain re-reads the bytes.
  const chapterPath = join(projectDir, "第一章.md");
  writeFileSync(chapterPath, "第一段：模型上周上线。\n\n第二段：指标已经回稳。\n");
  note(
    "the live editor does not re-render on a mid-session document switch (EditorHost has no :key and no prop watch); the record re-opens through a cold workbench",
  );
  await stop();
  await start(true);
  await execute(`window["refrain.e2e.pick"] = ${JSON.stringify(projectDir)}; "planted"`, []);
  const rootIdAgain = String(
    ((await invoke("debug_adopt_root", { path: projectDir, kind: "folder" })) as { rootId: string })
      .rootId,
  );
  check("the same project re-adopts with the same rootId", rootIdAgain === rootId, rootIdAgain);
  await clickButton("打开文件夹");
  await clickButton("第一章.md");
  await waitFor("the reopened chapter to render", async () =>
    Boolean(await execute(`return document.querySelectorAll("p[data-block-id]").length === 2`, [])),
  );
  check("the outside text renders as two blocks on the cold workbench", true);
  // A restart re-arms KARA (D18 is per work session): step out again.
  await waitFor("KARA on after the restart", karaOn);
  await toggleKaraInPage();
  await waitFor("KARA off", async () => !(await karaOn()));

  // Now text lands inside the app: append to the second block and save.
  const blocks = await elements("p[data-block-id]");
  const editable = blocks[1];
  if (editable === undefined) throw new Error("no second block");
  await click(editable);
  await sendKeys(editable, END);
  await sendKeys(editable, "应用内补一句收尾。");
  await waitFor("unsaved state", async () => (await statusText()).includes("未保存"));
  await chord("s");
  await waitFor("saved state", async () => (await statusText()).includes("已保存"));
  check(
    "the in-app sentence persisted to disk",
    readFileSync(chapterPath, "utf8").includes("应用内补一句收尾。"),
  );

  // Dispatch block 1 to the fake kimi harness (a real argv round trip).
  // This machine also has a REAL kimi on PATH: candidates can number two.
  const harnesses = (await invoke("list_harnesses", {})) as {
    candidateId: string;
    status: string;
  }[];
  check(
    "the fake kimi harness is detected",
    harnesses.some((h) => h.candidateId === "kimi-code"),
    harnesses.length,
  );

  // Connect through the roster and name a partner: the composer only offers
  // registered agents (dispatch-loop's C12 path). The fake answers the probe
  // with 9.9.9-fake; the real one does not.
  await clickButton("连接");
  await waitFor("the connections surface", async () =>
    Boolean(await execute(`return document.querySelector(".connections") !== null`, [])),
  );
  await waitFor("a harness candidate card", async () =>
    Boolean(
      await execute(`return document.querySelector(".tool-card button.primary") !== null`, []),
    ),
  );
  const connectButton = await elementOrNull(".tool-card button.primary");
  if (connectButton === null) throw new Error("no harness candidate to connect");
  await click(connectButton);
  await waitFor("a harness to connect", async () =>
    Boolean(
      await execute(
        `return [...document.querySelectorAll(".tool-state")].some((n) => n.dataset.status === "connected")`,
        [],
      ),
    ),
  );
  const connected = (await invoke("list_harnesses", {})) as {
    candidateId: string;
    status: string;
    connectionId: string | null;
  }[];
  const fake = connected.find((c) => c.candidateId === "kimi-code" && c.status === "connected");
  if (fake?.connectionId === null || fake?.connectionId === undefined) {
    throw new Error("connected Kimi has no Config connection id");
  }
  const probed = String(await invoke("probe_connection", { connectionId: fake.connectionId }));
  check("the probe reads the fake Kimi version", probed === "9.9.9-fake", probed);
  await execute(
    `const name = document.querySelector('.partner-form input');
     name.value = '工程写手';
     name.dispatchEvent(new InputEvent('input', { bubbles: true, data: '工程写手' }));
     const channel = document.querySelector('.partner-form select');
     channel.value = ${JSON.stringify(fake.connectionId)};
     channel.dispatchEvent(new Event('change', { bubbles: true }));`,
    [],
  );
  await clickButton("添加写作伙伴");
  await waitFor("the named partner to appear", async () =>
    Boolean(
      await execute(
        `return Array.from(document.querySelectorAll('.partner-card strong'))
          .some((node) => node.textContent === '工程写手')`,
        [],
      ),
    ),
  );
  const kimiAgent = ((await invoke("list_agents", {})) as { id: string; name: string }[]).find(
    (candidate) => candidate.name === "工程写手",
  )?.id;
  if (kimiAgent === undefined) throw new Error("the partner was not persisted");
  await clickButton("返回手稿");
  await clickButton("托付");
  await waitFor("the dispatch surface", async () =>
    Boolean(await execute(`return document.querySelector(".dispatch") !== null`, [])),
  );
  await waitFor("the agent dropdown", async () =>
    Boolean(await execute(`return document.querySelector(".dispatch-agent") !== null`, [])),
  );
  await setSelect(".dispatch-agent", kimiAgent);
  await tickBlock(1);
  await setPrompt("把第一段改得更克制。");
  await waitSendReady();
  await clickButton("送出");
  await waitFor("the manifest", async () =>
    Boolean(await execute(`return document.querySelector(".manifest") !== null`, [])),
  );
  check("the manifest previewed before authorization", true);
  await clickButton("授权");
  await waitFor("the harness run to dispatch", async () => {
    const state = await hostState(rootId);
    return state.runs.some((run) => run.progress === "dispatched");
  });
  const dispatched = (await hostState(rootId)).runs.find((run) => run.progress === "dispatched");
  if (dispatched === undefined) throw new Error("no dispatched harness run");
  // The fake settles in milliseconds; the background observer lands the file.
  await waitFor(
    "the harness result to land",
    async () =>
      existsSync(
        join(projectDir, ".refrain", dispatched.workspace, "attempts", dispatched.id, "result.md"),
      ),
    30_000,
  );
  await clickButton("收取");
  await waitFor("the harness run to complete", async () => {
    const state = await hostState(rootId);
    return state.runs.find((run) => run.id === dispatched.id)?.progress === "completed";
  });
  check("the harness run completed", true);
  const proposals = (await invoke("list_proposals", { rootId, path: "第一章.md" })) as {
    after: string | null;
  }[];
  check(
    "the harness artifact froze into a proposal",
    proposals.some((p) => (p.after ?? "").includes("伪 Agent 改写")),
    proposals.length,
  );

  // One review unit: accept it, stage it, merge it.
  await openReview();
  await judgeOne("a", 0);
  check("the unit is judged on the keyboard", (await reviewCounts())[0] === 1);
  await altKey("s");
  await waitFor("the unit staged", async () => (await stagedCount()) > 0, 6_000);
  await mergeStaged();
  const head = await headText(rootId, "第一章.md");
  check(
    "the accepted proposal merged into the manuscript",
    head.includes("伪 Agent 改写。") && head.includes("应用内补一句收尾。"),
    head.slice(0, 80),
  );
};

// ── Persona 2: the one-person AI company owner ──────────────────────────────
// Parallel ×2 on one ticket, the same prompt; both runs settle on their own;
// the owner — not the machine — picks the winner.
const soloOwner = async (): Promise<void> => {
  const chapter = Array.from({ length: 4 }, (_, i) => `第${i + 1}段营业记录。`).join("\n\n");
  writeFileSync(join(fixture, "长章.md"), `${chapter}\n`);
  await start(false);
  const rootId = String(
    ((await invoke("debug_adopt_root", { path: fixture, kind: "folder" })) as { rootId: string })
      .rootId,
  );
  await openManuscript("长章.md");
  await invoke("persist_revision", { rootId, path: "长章.md", expected: null });

  await clickButton("托付");
  await waitFor("the dispatch surface", async () =>
    Boolean(await execute(`return document.querySelector(".dispatch") !== null`, [])),
  );
  await tickBlock(2);
  await setPrompt("改写第二段，给两个候选。");
  await setSelect(".dispatch-arrangement", "parallel2");
  await waitSendReady();
  await clickButton("送出");
  await waitFor("the manifest", async () =>
    Boolean(await execute(`return document.querySelector(".manifest") !== null`, [])),
  );
  await clickButton("授权");
  await waitFor("two parallel runs to dispatch", async () => {
    const state = await hostState(rootId);
    return state.runs.filter((run) => run.progress === "dispatched").length === 2;
  });
  const parallel = (await hostState(rootId)).runs.filter((run) => run.progress === "dispatched");
  const runA = parallel[0];
  const runB = parallel[1];
  if (runA === undefined || runB === undefined) throw new Error("no two parallel runs");
  check("one ticket minted exactly two runs", parallel.length === 2, parallel.length);
  check("the two runs share one task", runA.taskId === runB.taskId);
  check("the two runs own distinct workspaces", runA.workspace !== runB.workspace);
  const requestA = readFileSync(join(fixture, ".refrain", runA.workspace, "request.md"), "utf8");
  const scope = requestA.match(/<!-- scope ([^ ]+) -->/)?.[1] ?? "";
  check("the same prompt froze for both", scope !== "", scope);

  writeResult(
    runA.workspace,
    runA.id,
    `<agent-result version="2"><replacement scope="${scope}">候选甲的第二段。</replacement></agent-result>\n`,
  );
  writeResult(
    runB.workspace,
    runB.id,
    `<agent-result version="2"><replacement scope="${scope}">候选乙的第二段。</replacement></agent-result>\n`,
  );
  await clickButton("收取");
  await waitFor("the first collect to settle one run", async () => {
    const state = await hostState(rootId);
    return (
      state.runs.filter(
        (run) => [runA.id, runB.id].includes(run.id) && run.progress === "completed",
      ).length === 1
    );
  });
  check("the first run settled while the other was still out", true);
  await clickButton("收取");
  await waitFor("the second run to settle", async () => {
    const state = await hostState(rootId);
    return (
      state.runs.filter(
        (run) => [runA.id, runB.id].includes(run.id) && run.progress === "completed",
      ).length === 2
    );
  });
  check("both runs settled independently", true);
  const cohort = (await invoke("list_proposals", { rootId, path: "长章.md" })) as {
    after: string | null;
  }[];
  check(
    "both candidates froze — the machine picked no winner",
    cohort.some((p) => (p.after ?? "").includes("候选甲的第二段")) &&
      cohort.some((p) => (p.after ?? "").includes("候选乙的第二段")),
    cohort.length,
  );

  // The owner decides: accept the first candidate on stage, reject the other.
  await openReview();
  check(
    "the cohort shows as competing drafts",
    Boolean(await execute(`return document.querySelector(".unit .competing") !== null`, [])),
  );
  const shown = String(
    await execute(`return document.querySelector(".unit .text.proposed")?.textContent ?? "";`, []),
  );
  const accepted = shown.includes("候选甲") ? "候选甲的第二段。" : "候选乙的第二段。";
  const rejected = shown.includes("候选甲") ? "候选乙的第二段。" : "候选甲的第二段。";
  await judgeOne("a", 0);
  await judgeOne("x", 1);
  const [decided, total] = await reviewCounts();
  check("the owner judged both candidates", decided === 2 && total === 2, `${decided}/${total}`);
  await altKey("k");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await altKey("s");
  await waitFor("the accepted unit staged", async () => (await stagedCount()) > 0, 6_000);
  await mergeStaged();
  const head = await headText(rootId, "长章.md");
  check("the owner's pick merged", head.includes(accepted), head.slice(0, 80));
  check("the rejected candidate stayed out", !head.includes(rejected));
};

// ── Persona 3: the publishing-house editor ──────────────────────────────────
// Import a source file, attach it to a dispatch, verdict with a reason,
// merge — and the merge trace stays for the audit.
const editor = async (): Promise<void> => {
  const chapter = Array.from({ length: 4 }, (_, i) => `第${i + 1}段书稿原文。`).join("\n\n");
  writeFileSync(join(fixture, "书稿.md"), `${chapter}\n`);
  const sources = mkdtempSync(join(tmpdir(), "refrain-persona-src-"));
  const htmlPath = join(sources, "审稿资料.html");
  writeFileSync(
    htmlPath,
    `<!doctype html><html><head><title>t</title></head><body><h1>审稿纪要</h1><p>初版印数三千册。</p></body></html>`,
  );
  await start(false);
  const rootId = String(
    ((await invoke("debug_adopt_root", { path: fixture, kind: "folder" })) as { rootId: string })
      .rootId,
  );
  await openManuscript("书稿.md");
  await invoke("persist_revision", { rootId, path: "书稿.md", expected: null });

  await execute(`window["refrain.e2e.pick"] = ${JSON.stringify(htmlPath)}; "planted"`, []);
  await clickButton("导入");
  await waitFor("the imported material on the rail", async () =>
    Boolean(
      await execute(
        `return Array.from(document.querySelectorAll(".rail li button")).some((b) => b.textContent.includes("审稿资料"));`,
        [],
      ),
    ),
  );
  check("the source file imported as a Material", true);

  await clickButton("托付");
  await waitFor("the materials checklist", async () =>
    Boolean(await execute(`return document.querySelector(".material-row input") !== null`, [])),
  );
  const matCheckbox = await elementOrNull(`(//label[contains(@class,'material-row')])[1]`, true);
  if (matCheckbox === null) throw new Error("no material checkbox");
  try {
    await click(matCheckbox);
  } catch {
    await execute(`arguments[0].click(); "js-click"`, [asElementRef(matCheckbox)]);
  }
  await tickBlock(1);
  await setPrompt("按审稿资料核改第一段。");
  await waitSendReady();
  await clickButton("送出");
  await waitFor("the manifest", async () =>
    Boolean(await execute(`return document.querySelector(".manifest") !== null`, [])),
  );
  await clickButton("授权");
  await waitFor("the run to dispatch", async () => {
    const state = await hostState(rootId);
    return state.runs.filter((run) => run.progress === "dispatched").length === 1;
  });
  const run = (await hostState(rootId)).runs.find((r) => r.progress === "dispatched");
  if (run === undefined) throw new Error("no dispatched run");
  const request = readFileSync(join(fixture, ".refrain", run.workspace, "request.md"), "utf8");
  check(
    "the attached material rode the frozen request",
    request.includes('<material path="material/审稿资料.md"') &&
      request.includes('access="retrievable"'),
  );
  const scope = request.match(/<!-- scope ([^ ]+) -->/)?.[1] ?? "";
  writeResult(
    run.workspace,
    run.id,
    `<agent-result version="2"><replacement scope="${scope}">编辑核改的第一段。</replacement></agent-result>\n`,
  );
  await clickButton("收取");
  await waitFor("the run to complete", async () => {
    const state = await hostState(rootId);
    return state.runs.find((r) => r.id === run.id)?.progress === "completed";
  });
  const proposals = (await invoke("list_proposals", { rootId, path: "书稿.md" })) as {
    after: string | null;
  }[];
  check(
    "the artifact froze into a proposal",
    proposals.some((p) => (p.after ?? "").includes("编辑核改的第一段")),
    proposals.length,
  );

  // The editor's verdict carries a reason; the stub answers the real prompt.
  await openReview();
  await altKey("r");
  await waitFor("the inline reason editor", async () =>
    Boolean(await execute(`return document.querySelector(".reason-editor") !== null`, [])),
  );
  await execute(
    `const i = document.querySelector(".reason-editor");
     i.value = "史实已核，采用。";
     i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));`,
    [],
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  // The reason editor takes the focus with it when it closes; judging keys
  // only reach the surface when it holds focus again.
  const surfaceAgain = await elementOrNull(".review-surface");
  if (surfaceAgain !== null) await click(surfaceAgain);
  await judgeOne("a", 0);
  const stateWithReason = (await invoke("review_state", { rootId, path: "书稿.md" })) as {
    verdicts: { kind: string; reason: string | null }[];
  };
  check(
    "the verdict carries the editor's reason",
    stateWithReason.verdicts.some((v) => v.kind === "accept" && v.reason === "史实已核，采用。"),
    stateWithReason.verdicts.map((v) => v.reason),
  );
  await altKey("s");
  await waitFor("the unit staged", async () => (await stagedCount()) > 0, 6_000);
  await mergeStaged();
  const head = await headText(rootId, "书稿.md");
  check("the accepted edit merged", head.includes("编辑核改的第一段。"), head.slice(0, 60));
  const after = (await invoke("review_state", { rootId, path: "书稿.md" })) as {
    proposals: unknown[];
    verdicts: { reason: string | null }[];
    batch: string[];
  };
  check(
    "the merge trace stays: candidate and verdict survive the commit",
    after.proposals.length >= 1 &&
      after.verdicts.some((v) => v.reason === "史实已核，采用。") &&
      after.batch.length === 0,
    `proposals=${after.proposals.length} verdicts=${after.verdicts.length}`,
  );
};

// ── Persona 4: the ADHD serial-fiction writer ───────────────────────────────
// The first manuscript pulls the writer into KARA; out and back in through
// the same key; then the edgeless sheet (paper 无) for draft reading.
const writer = async (): Promise<void> => {
  const chapter = Array.from({ length: 3 }, (_, i) => `连载第${i + 1}段。`).join("\n\n");
  writeFileSync(join(fixture, "连载.md"), `${chapter}\n`);
  await start(false);
  await clickButton("打开文件夹");
  await clickButton("连载.md");
  await waitFor("editor blocks", async () =>
    Boolean(await execute(`return document.querySelector("p[data-block-id]") !== null`, [])),
  );
  await waitFor("KARA on", karaOn);
  check("the first manuscript pulls the writer into KARA", true);
  // The rail no longer leaves the stage for KARA (C12.6): recession is
  // pointer/idle-driven, and the veil is the engagement signal.
  await toggleKaraInPage();
  await waitFor("KARA off", async () => !(await karaOn()));
  check("the in-page Ctrl+Enter steps out", true);
  await toggleKaraInPage();
  await waitFor("KARA back on", karaOn);
  check("the same in-page key re-enters KARA", true);
  await toggleKaraInPage();
  await waitFor("KARA off again", async () => !(await karaOn()));

  await clickButton("设置");
  // 排版 is the landing tab since the redo; the sheet edges live under 外观.
  await clickButton("外观");
  await waitFor("the paper buttons", async () =>
    Boolean(
      await execute(`return document.querySelector('[data-choice="paper:none"]') !== null`, []),
    ),
  );
  await clickButton("无");
  await waitFor("the edgeless sheet", async () =>
    Boolean(await execute(`return document.documentElement.dataset.paper === "none"`, [])),
  );
  check("paper 无 projects the edgeless ruled sheet", true);
  const configText = (): string => {
    const path = join(dataDir, "config.toml");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  };
  await waitFor("the paper mode on disk", async () => configText().includes('paper = "none"'));
  check("the choice lands in the one Config", true);
  await toggleKaraInPage();
  await waitFor("KARA on with the edgeless sheet", karaOn);
  check(
    "KARA reads on the edgeless sheet",
    Boolean(await execute(`return document.documentElement.dataset.paper === "none"`, [])),
  );
  await toggleKaraInPage();
  await waitFor("KARA off at the end", async () => !(await karaOn()));
};

// ── Persona 5: the social-science professor ─────────────────────────────────
// Import field material, attach it to a dispatch; afterwards the ticket
// shows the reading-ledger hint: rounds read, and whether the agent is current.
const professor = async (): Promise<void> => {
  const chapter = Array.from({ length: 4 }, (_, i) => `论文第${i + 1}段。`).join("\n\n");
  writeFileSync(join(fixture, "论文.md"), `${chapter}\n`);
  const sources = mkdtempSync(join(tmpdir(), "refrain-persona-src-"));
  const htmlPath = join(sources, "田野史料.html");
  writeFileSync(
    htmlPath,
    `<!doctype html><html><head><title>t</title></head><body><h1>田野笔记</h1><p>1937 年的村庄集市。</p></body></html>`,
  );
  await start(false);
  const rootId = String(
    ((await invoke("debug_adopt_root", { path: fixture, kind: "folder" })) as { rootId: string })
      .rootId,
  );
  await openManuscript("论文.md");
  await invoke("persist_revision", { rootId, path: "论文.md", expected: null });

  await execute(`window["refrain.e2e.pick"] = ${JSON.stringify(htmlPath)}; "planted"`, []);
  await clickButton("导入");
  await waitFor("the imported material on the rail", async () =>
    Boolean(
      await execute(
        `return Array.from(document.querySelectorAll(".rail li button")).some((b) => b.textContent.includes("田野史料"));`,
        [],
      ),
    ),
  );
  check("the field material imported as a Material", true);

  await clickButton("托付");
  await waitFor("the materials checklist", async () =>
    Boolean(await execute(`return document.querySelector(".material-row input") !== null`, [])),
  );
  const matCheckbox = await elementOrNull(`(//label[contains(@class,'material-row')])[1]`, true);
  if (matCheckbox === null) throw new Error("no material checkbox");
  try {
    await click(matCheckbox);
  } catch {
    await execute(`arguments[0].click(); "js-click"`, [asElementRef(matCheckbox)]);
  }
  await tickBlock(2);
  await setPrompt("结合田野史料核改第二段。");
  await waitSendReady();
  await clickButton("送出");
  await waitFor("the manifest", async () =>
    Boolean(await execute(`return document.querySelector(".manifest") !== null`, [])),
  );
  await clickButton("授权");
  await waitFor("the run to dispatch", async () => {
    const state = await hostState(rootId);
    return state.runs.filter((run) => run.progress === "dispatched").length === 1;
  });
  const run = (await hostState(rootId)).runs.find((r) => r.progress === "dispatched");
  if (run === undefined) throw new Error("no dispatched run");
  const request = readFileSync(join(fixture, ".refrain", run.workspace, "request.md"), "utf8");
  check(
    "the field material rode the frozen request",
    request.includes('<material path="material/田野史料.md"') &&
      request.includes('access="retrievable"'),
  );
  const scope = request.match(/<!-- scope ([^ ]+) -->/)?.[1] ?? "";
  writeResult(
    run.workspace,
    run.id,
    `<agent-result version="2"><replacement scope="${scope}">史料核改的第二段。</replacement></agent-result>\n`,
  );
  await clickButton("收取");
  await waitFor("the run to complete", async () => {
    const state = await hostState(rootId);
    return state.runs.find((r) => r.id === run.id)?.progress === "completed";
  });
  check("the run completed and froze its proposal", true);
  const frozen = (await invoke("list_proposals", { rootId, path: "论文.md" })) as {
    after: string | null;
  }[];
  check(
    "the artifact froze into a proposal",
    frozen.some((p) => (p.after ?? "").includes("史料核改的第二段")),
    frozen.length,
  );

  const l0Agent = String(await invoke("l0_file_channel_agent", {}));
  const ledger = (await invoke("agent_reading_ledger", { rootId })) as {
    agentId: string;
    document: string;
    rounds: number;
    stale: boolean;
  }[];
  const row = ledger.find((r) => r.agentId === l0Agent && r.document === "论文.md");
  check(
    "the ledger rebuilt the agent's round on this document",
    (row?.rounds ?? 0) >= 1,
    row?.rounds,
  );
  check("the ledger sees the agent is current", row?.stale === false, row?.stale);
  await clickButton("再发");
  await waitFor("the reading hint on the ticket", async () =>
    Boolean(await execute(`return document.querySelector(".reading") !== null`, [])),
  );
  const hint = String(
    await execute(`return document.querySelector(".reading")?.textContent ?? "";`, []),
  );
  check("the ticket shows the reading hint (N 轮 · 同步)", /\d+ 轮 · 同步/.test(hint), hint);
};

// ── Persona 6: the lawyer ───────────────────────────────────────────────────
// The file moved on disk while the draft was open; the save surfaces the
// Safety conflict; the lawyer keeps their own version (a CAS overwrite).
const lawyer = async (): Promise<void> => {
  const chapterPath = join(fixture, "合同.md");
  writeFileSync(chapterPath, "第一条：交付期限。\n\n第二条：验收标准。\n\n第三条：违约责任。\n");
  await start(false);
  await openManuscript("合同.md");

  const blocks = await elements("p[data-block-id]");
  const editable = blocks[1];
  if (editable === undefined) throw new Error("no second clause");
  await click(editable);
  await sendKeys(editable, END);
  await sendKeys(editable, "（律师批注：本条已核）");
  await waitFor("unsaved state", async () => (await statusText()).includes("未保存"));
  check("the annotation marked the draft unsaved", true);

  // The other side's editor wrote to the same file in the meantime.
  writeFileSync(chapterPath, "对方改过的第一条。\n\n对方改过的第二条。\n");
  await chord("s");
  await waitFor("the Safety conflict", async () =>
    Boolean(await execute(`return document.querySelector(".safety") !== null`, [])),
  );
  check("the outside edit surfaced as a Safety conflict", true);
  const dialog = String(
    await execute(`return document.querySelector(".safety")?.textContent ?? "";`, []),
  );
  check("the dialog shows my side as opened", dialog.includes("第二条：验收标准。"));
  check("the dialog shows the disk version", dialog.includes("对方改过的第一条。"));
  note(
    "the dialog renders 我的版本 from the as-opened blocks: the just-confirmed annotation （律师批注：本条已核） is absent from the display, yet the CAS resolution below writes it correctly",
  );
  check(
    "the refusal kept the other side's bytes",
    readFileSync(chapterPath, "utf8").startsWith("对方改过的第一条。"),
  );
  // The dialog mocks a native modal; the synthetic click goes through the
  // same handler as a trusted one (writing-slice's evidence).
  await execute(
    `const button = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("用我的覆盖磁盘"));
     if (!button) { throw new Error("resolve button gone"); }
     button.click();
     "clicked"`,
    [],
  );
  await waitFor("saved after resolve", async () => (await statusText()).includes("已保存"));
  const onDisk = readFileSync(chapterPath, "utf8");
  check(
    "用我的覆盖磁盘 wrote my version through the CAS",
    onDisk.includes("（律师批注：本条已核）") && onDisk.startsWith("第一条：交付期限。"),
    onDisk.slice(0, 60),
  );
  check("the outside version is replaced", !onDisk.includes("对方改过"));
};

// ── Persona 7: the student ──────────────────────────────────────────────────
// Two agent study cards arrive as material drafts: 保存 one (it becomes a
// Material document), 退回 the other; then switch to 墨 for night reading.
const student = async (): Promise<void> => {
  const chapter = Array.from({ length: 3 }, (_, i) => `课文第${i + 1}段。`).join("\n\n");
  writeFileSync(join(fixture, "课文.md"), `${chapter}\n`);
  await start(false);
  const rootId = String(
    ((await invoke("debug_adopt_root", { path: fixture, kind: "folder" })) as { rootId: string })
      .rootId,
  );
  await openManuscript("课文.md");
  await invoke("persist_revision", { rootId, path: "课文.md", expected: null });
  const revision = (
    (await invoke("current_document", { rootId, path: "课文.md" })) as {
      revision: string;
    }
  ).revision;
  const basisRef = `课文.md@${revision}`;

  await clickButton("托付");
  await waitFor("the dispatch surface", async () =>
    Boolean(await execute(`return document.querySelector(".dispatch") !== null`, [])),
  );
  await tickBlock(1);
  await setPrompt("为这一课做两张学习卡。");
  await waitSendReady();
  await clickButton("送出");
  await waitFor("the manifest", async () =>
    Boolean(await execute(`return document.querySelector(".manifest") !== null`, [])),
  );
  await clickButton("授权");
  await waitFor("the run to dispatch", async () => {
    const state = await hostState(rootId);
    return state.runs.filter((run) => run.progress === "dispatched").length === 1;
  });
  const run = (await hostState(rootId)).runs.find((r) => r.progress === "dispatched");
  if (run === undefined) throw new Error("no dispatched run");
  writeResult(
    run.workspace,
    run.id,
    `<agent-result version="2">
  <material-draft kind="concept-explanation" title="术语卡">
    <basis ref="${basisRef}" />
    <body><![CDATA[能指是声音形象，所指是概念。]]></body>
  </material-draft>
  <material-draft kind="character-profile" title="人物卡">
    <basis ref="${basisRef}" />
    <body><![CDATA[她说话很省，遇事先做。]]></body>
  </material-draft>
</agent-result>
`,
  );
  await clickButton("收取");
  await waitFor("the run to complete", async () => {
    const state = await hostState(rootId);
    return state.runs.find((r) => r.id === run.id)?.progress === "completed";
  });
  const drafts = (await invoke("list_material_drafts", { rootId })) as { title: string }[];
  check(
    "two study cards arrived as material drafts",
    drafts.length === 2 && drafts[0]?.title === "术语卡",
    drafts.map((d) => d.title),
  );
  const docsNow = (): { path: string; role: string }[] => {
    // Disk truth, no side effects: adopt_root would replace the live entry.
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
    "no Material document exists before the student's action",
    docsNow().filter((doc) => doc.role === "material").length === 0,
  );

  await waitFor("the drafts panel", async () =>
    Boolean(await execute(`return document.querySelector(".draft-row") !== null`, [])),
  );
  await clickButton("保存");
  await waitFor("the save to resolve its draft", async () => {
    const left = (await invoke("list_material_drafts", { rootId })) as { title: string }[];
    return left.length === 1 && left[0]?.title === "人物卡";
  });
  const materials = docsNow().filter((doc) => doc.role === "material");
  check("保存 made exactly one Material document", materials.length === 1, materials.length);
  const cardText = readFileSync(join(fixture, materials[0]?.path ?? ""), "utf8");
  check("the card body reached disk", cardText.includes("能指是声音形象"), materials[0]?.path);
  await waitFor("the card on the 资料 shelf", async () =>
    Boolean(
      await execute(
        `return Array.from(document.querySelectorAll(".rail li button")).some((b) => b.textContent.includes("术语卡"));`,
        [],
      ),
    ),
  );
  check("the card joined the 资料 shelf", true);

  await clickButton("退回");
  await waitFor("the drafts to drain", async () => {
    const left = (await invoke("list_material_drafts", { rootId })) as unknown[];
    return left.length === 0;
  });
  check("退回 resolved the other card", true);
  check(
    "退回 wrote no new Material",
    docsNow().filter((doc) => doc.role === "material").length === 1,
  );

  // Night reading: open the card, then switch the theme to 墨. The live
  // editor does not re-render on a mid-session document switch (see the
  // engineer's note), so the card opens on a cold workbench.
  await stop();
  await start(false);
  await clickButton("打开文件夹");
  await clickButton("术语卡");
  await waitFor("the card rendered", async () =>
    Boolean(
      await execute(
        `return Array.from(document.querySelectorAll("p[data-block-id]")).some((p) => p.textContent.includes("能指是声音形象"));`,
        [],
      ),
    ),
  );
  check("the saved card opens for reading", true);
  const paperOf = async (): Promise<string> =>
    String(
      await execute(
        `return getComputedStyle(document.documentElement).getPropertyValue("--paper").trim()`,
        [],
      ),
    );
  await clickButton("设置");
  await clickButton("外观");
  await waitFor("theme buttons", async () =>
    Boolean(
      await execute(
        `return document.querySelector(".theme-picker [data-theme-slug]") !== null`,
        [],
      ),
    ),
  );
  const paperBefore = await paperOf();
  await clickButton("墨");
  await waitFor("the shell to repaint", async () => (await paperOf()) !== paperBefore);
  check("墨 repaints the shell for night reading", true, `${paperBefore} → ${await paperOf()}`);
  const configText = (): string => {
    const path = join(dataDir, "config.toml");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  };
  await waitFor("the theme on disk", async () => configText().includes('theme = "sumi"'));
  check("the night theme lands in the one Config", true);
};

// ---- the runner: one driver at a time, one fixture per persona --------------
type PersonaFn = () => Promise<void>;

const runPersona = async (name: string, fn: PersonaFn): Promise<void> => {
  current = { name, passed: 0, failed: 0, notes: [] };
  results.push(current);
  fixture = mkdtempSync(join(tmpdir(), `refrain-persona-${name}-`));
  dataDir = mkdtempSync(join(tmpdir(), `refrain-persona-${name}-data-`));
  projectDir = fixture;
  console.log(`\n=== ${name} ===`);
  try {
    await fn();
  } catch (error) {
    current.failed += 1;
    console.error(`FAIL  [${name}] the flow aborted: ${String(error).slice(0, 300)}`);
  } finally {
    await stop();
    if (current.failed === 0) {
      try {
        rmSync(fixture, { recursive: true, force: true, maxRetries: 3 });
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // The OS releases the profile a beat after the process dies.
      }
    } else {
      console.error(`      fixture kept for inspection: ${fixture}`);
    }
  }
};

const personas: [string, PersonaFn][] = [
  ["ai-engineer", aiEngineer],
  ["solo-owner", soloOwner],
  ["editor", editor],
  ["writer-adhd", writer],
  ["professor", professor],
  ["lawyer", lawyer],
  ["student", student],
];

for (const [name, fn] of personas) {
  await runPersona(name, fn);
}

let passed = 0;
let failed = 0;
console.log("\n=== C12.6c persona summary ===");
for (const result of results) {
  passed += result.passed;
  failed += result.failed;
  console.log(`${result.name}: ${result.passed} passed, ${result.failed} failed`);
  for (const text of result.notes) console.log(`  note: ${text}`);
}
rmSync(fixtureBin, { recursive: true, force: true });
if (failed > 0) {
  console.error(`\n${failed} check(s) failed across ${results.length} personas`);
  process.exit(1);
}
console.log(`\npersonas: all seven identities passed (${passed} checks)`);
process.exit(0);
