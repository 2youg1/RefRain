/**
 * The REAL Kimi Code link, end to end (C11 evidence).
 *
 * No fakes: the app detects the actual `kimi` CLI on PATH, dispatches a
 * frozen request through the ticket, the real turn's reply lands as the
 * attempt's result, and the artifact freezes into a proposal the review
 * loop can see. Costs one small real turn.
 *
 * Run: `bun apps/desktop/e2e/kimi-live.ts <path-to-refrain.exe>`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exe = process.argv[2];
if (!exe) {
  console.error("usage: bun apps/desktop/e2e/kimi-live.ts <refrain.exe>");
  process.exit(2);
}

const DRIVER_PORT = Number(process.env.REFRAIN_E2E_PORT ?? 4444);
const fixture = mkdtempSync(join(tmpdir(), "refrain-kimi-live-"));
const dataDir = mkdtempSync(join(tmpdir(), "refrain-kimi-live-data-"));
writeFileSync(
  join(fixture, "长章.md"),
  "第一段：事情的起因总是复杂。\n\n第二段：过程也未必简单。\n\n第三段：结尾常常仓促。\n",
);

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

const invoke = (command: string, args: Record<string, unknown>): Promise<unknown> =>
  execute(
    `return __TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})
      .then((r) => r, (e) => { throw new Error(JSON.stringify(e)); })`,
    [],
  );

let driver: ChildProcess | null = null;

const run = async (): Promise<void> => {
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
      env: { ...process.env, REFRAIN_DATA_DIR: dataDir },
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
  session =
    (
      (await call("POST", "/session", {
        capabilities: {
          alwaysMatch: {
            browserName: "webview2",
            "ms:edgeOptions": {
              args: [
                `--user-data-dir=${join(dataDir, "webview-args")}`,
                "--no-sandbox",
                "--disable-gpu",
                "--no-first-run",
                "--disable-extensions",
              ],
            },
            "tauri:options": {
              application: exe.replaceAll("/", "\\"),
              webviewOptions: { userDataFolder: join(dataDir, "webview") },
            },
          },
        },
      })) as { sessionId?: string }
    ).sessionId ?? "";
  await waitFor("tauri internals", async () =>
    Boolean(await execute(`return typeof __TAURI_INTERNALS__ !== "undefined"`)),
  );
  await execute(
    `window["refrain.e2e.pick"] = ${JSON.stringify(fixture)}; window["refrain.e2e.pin"] = true; "planted"`,
  );

  const adopted = (await invoke("debug_adopt_root", { path: fixture, kind: "folder" })) as {
    rootId: string;
  };
  const rootId = adopted.rootId;

  // The real CLI must be detected by its fixed candidate id. Other installed
  // tools may also appear, so this test never assumes a one-item catalog.
  const harnesses = (await invoke("list_harnesses", {})) as {
    candidateId: string;
    connectionId: string | null;
    status: "connected" | "available" | "missing" | "needs-attention";
    version: string | null;
  }[];
  const detectedKimi = harnesses.find((harness) => harness.candidateId === "kimi-code");
  check(
    "the real kimi is detected",
    detectedKimi?.status === "available" || detectedKimi?.status === "connected",
    detectedKimi?.status ?? "absent",
  );
  console.log(`kimi version: ${detectedKimi?.version ?? "?"}`);

  await clickButton("打开文件夹");
  await clickButton("长章.md");
  await waitFor("editor blocks", async () =>
    Boolean(await execute(`return document.querySelector("p[data-block-id]") !== null`)),
  );
  await waitFor("KARA on", async () =>
    Boolean(await execute(`return document.querySelector(".kara-chrome") !== null`)),
  );
  await execute(
    `document.querySelector(".workbench").dispatchEvent(
       new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); "toggled"`,
    [],
  );
  await invoke("persist_revision", { rootId, path: "长章.md", expected: null });

  // Exercise the visible, nontechnical path. Detection alone is not a
  // connection, and a machine connection is not an Agent: the author first
  // connects Kimi, then gives one writing partner a name.
  await clickButton("连接");
  await waitFor("the Connections surface", async () =>
    Boolean(await execute(`return document.querySelector(".connections") !== null`)),
  );
  const clickedConnect = await execute(`
    const card = [...document.querySelectorAll(".tool-card")]
      .find((node) => node.textContent?.includes("Kimi Code"));
    const button = card?.querySelector("button.primary");
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  `);
  check("the Kimi connect action is visible", clickedConnect === true, clickedConnect);
  await waitFor("Kimi to become connected", async () => {
    const catalog = (await invoke("list_harnesses", {})) as {
      candidateId: string;
      connectionId: string | null;
      status: string;
    }[];
    return catalog.some(
      (harness) =>
        harness.candidateId === "kimi-code" &&
        harness.status === "connected" &&
        harness.connectionId !== null,
    );
  });
  await execute(`
    const name = document.querySelector("input.conn-input");
    const channel = document.querySelector("select.conn-input");
    const brief = document.querySelector("textarea.partner-brief");
    if (!(name instanceof HTMLInputElement) ||
        !(channel instanceof HTMLSelectElement) ||
        !(brief instanceof HTMLTextAreaElement)) return false;
    name.value = "真实 Kimi";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    const option = [...channel.options].find((entry) => entry.text.includes("Kimi Code"));
    if (option === undefined) return false;
    channel.value = option.value;
    channel.dispatchEvent(new Event("change", { bubbles: true }));
    brief.value = "只改写所选段落；返回协议要求的提案，不直接修改原稿。";
    brief.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `);
  await waitFor("the writing-partner action", async () =>
    Boolean(
      await execute(`
        const button = [...document.querySelectorAll("button")]
          .find((node) => node.textContent?.includes("添加写作伙伴"));
        return button instanceof HTMLButtonElement && !button.disabled;
      `),
    ),
  );
  await clickButton("添加写作伙伴");
  await waitFor("the named Kimi partner", async () => {
    const current = (await invoke("list_agents", {})) as { id: string; name: string }[];
    return current.some((agent) => agent.name === "真实 Kimi");
  });
  const agents = (await invoke("list_agents", {})) as { id: string; name: string }[];
  const kimiAgent = agents.find((agent) => agent.name === "真实 Kimi")?.id ?? "";
  check("the named Kimi partner was created", kimiAgent.length > 0, agents.length);
  await clickButton("返回手稿");

  await clickButton("派发");
  await waitFor("the agent dropdown", async () =>
    Boolean(await execute(`return document.querySelector(".dispatch-agent") !== null`)),
  );
  await execute(
    `const s = document.querySelector(".dispatch-agent");
     s.value = ${JSON.stringify(kimiAgent)};
     s.dispatchEvent(new Event("change", { bubbles: true }));`,
    [],
  );
  const row = await elementOrNull("(//label[contains(@class,'block-row')])[2]/input", true);
  if (row === null) throw new Error("no block row 2");
  await click(row);
  await execute(
    `const el = document.querySelector(".dispatch-prompt");
     el.value = "把这一段改写得更克制。";
     el.dispatchEvent(new Event("input", { bubbles: true }));`,
    [],
  );
  await clickButton("送出");
  await waitFor("the manifest", async () =>
    Boolean(await execute(`return document.querySelector(".manifest") !== null`)),
  );
  await clickButton("授权");
  await waitFor("the real run to dispatch", async () => {
    const s = (await invoke("host_state", { rootId })) as {
      runs: { progress: string; agentId: string }[];
    };
    return s.runs.some((r) => r.progress === "dispatched" && r.agentId === kimiAgent);
  });
  let state = (await invoke("host_state", { rootId })) as {
    runs: { id: string; progress: string; agentId: string; workspace: string }[];
  };
  const live = state.runs.find((r) => r.agentId === kimiAgent && r.progress === "dispatched");
  if (live === undefined) throw new Error("no dispatched live run");
  console.log(`real turn running: ${live.id}`);

  // A real turn takes seconds, not milliseconds; give it room.
  await waitFor(
    "the real result to land",
    async () =>
      existsSync(join(fixture, ".refrain", live.workspace, "attempts", live.id, "result.md")),
    180_000,
  );
  await clickButton("收取");
  await waitFor(
    "the real run to settle",
    async () => {
      const s = (await invoke("host_state", { rootId })) as {
        runs: { id: string; progress: string; failure: string | null }[];
      };
      const run = s.runs.find((r) => r.id === live.id);
      if (run?.progress === "failed") {
        console.error(`the real run failed typed: ${run.failure ?? ""}`);
        return true;
      }
      return run?.progress === "completed";
    },
    30_000,
  );
  state = (await invoke("host_state", { rootId })) as {
    runs: { id: string; progress: string; failure: string | null }[];
  };
  let done = state.runs.find((r) => r.id === live.id);
  if (done?.progress === "failed") {
    // The designed recovery for a typed failure: a new Run (§8.4b). Model
    // variance is real; one honest retry, not a hidden loop.
    console.log(`first attempt failed typed (${done.failure ?? "?"}); retrying as a new run`);
    await clickButton("重试");
    await waitFor("the retry to dispatch", async () => {
      const s = (await invoke("host_state", { rootId })) as {
        runs: { id: string; progress: string; agentId: string }[];
      };
      return s.runs.some((r) => r.progress === "dispatched" && r.agentId === kimiAgent);
    });
    const retryState = (await invoke("host_state", { rootId })) as {
      runs: { id: string; progress: string; agentId: string; workspace: string }[];
    };
    const retryRun = retryState.runs.find(
      (r) => r.agentId === kimiAgent && r.progress === "dispatched",
    );
    if (retryRun === undefined) throw new Error("no dispatched retry");
    await waitFor(
      "the retry result to land",
      async () =>
        existsSync(
          join(fixture, ".refrain", retryRun.workspace, "attempts", retryRun.id, "result.md"),
        ),
      180_000,
    );
    await clickButton("收取");
    await waitFor(
      "the retry to settle",
      async () => {
        const s = (await invoke("host_state", { rootId })) as {
          runs: { id: string; progress: string; failure: string | null }[];
        };
        const run = s.runs.find((r) => r.id === retryRun.id);
        if (run?.progress === "failed") {
          console.error(`the retry failed typed: ${run.failure ?? ""}`);
          return true;
        }
        return run?.progress === "completed";
      },
      30_000,
    );
    state = (await invoke("host_state", { rootId })) as {
      runs: { id: string; progress: string; failure: string | null }[];
    };
    done = state.runs.find((r) => r.id === retryRun.id);
  }
  check("the real run completed", done?.progress === "completed", done?.failure ?? done?.progress);
  const proposals = (await invoke("list_proposals", { rootId, path: "长章.md" })) as {
    after: string | null;
  }[];
  check(
    "the real artifact froze into a proposal",
    proposals.length === 1 && (proposals[0]?.after ?? "").length > 0,
    proposals.length,
  );
  console.log(`proposal after: ${(proposals[0]?.after ?? "").slice(0, 60)}`);

  driver?.kill("SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log("\nkimi live: the real link works end to end");
  try {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows holds locks briefly after a kill; the temp dirs are disposable.
  }
  process.exit(0);
};

void run().finally(() => driver?.kill());
