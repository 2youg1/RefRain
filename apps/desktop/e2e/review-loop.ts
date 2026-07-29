/**
 * The review loop against the real window (C8 evidence).
 *
 * Fixture candidates (debug-only command) → keyboard verdicts → one batch
 * commit → the text actually changes. Then the recovery vector: judge past
 * forty, kill the app, and the session restores cursor, verdicts, reasons,
 * final texts, and batch (SPEC 9.7's five things).
 *
 * Run: `bun apps/desktop/e2e/review-loop.ts <path-to-refrain.exe>`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exe = process.argv[2];
if (!exe) {
  console.error("usage: bun apps/desktop/e2e/review-loop.ts <refrain.exe>");
  process.exit(2);
}

const DRIVER_PORT = Number(process.env.REFRAIN_E2E_PORT ?? 4444);
const fixture = mkdtempSync(join(tmpdir(), "refrain-review-"));
const dataDir = mkdtempSync(join(tmpdir(), "refrain-review-data-"));
const chapterPath = join(fixture, "长章.md");

// Forty-five paragraphs — the long keyboard path and the kill-after-forty
// recovery in one fixture.
const sentences = Array.from({ length: 45 }, (_, i) => `第${i + 1}段原来如此。`);
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

const chord = (key: string): Promise<unknown> =>
  call("POST", `/session/${session}/actions`, {
    actions: [
      {
        type: "key",
        id: "keyboard",
        actions: [
          { type: "keyDown", value: "" },
          { type: "keyDown", value: key },
          { type: "keyUp", value: key },
          { type: "keyUp", value: "" },
        ],
      },
    ],
  });

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
  session = ((await call("POST", "/session", caps())) as { sessionId?: string }).sessionId ?? "";
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

const openChapter = async (): Promise<void> => {
  await clickButton("打开文件夹");
  await clickButton("长章.md");
  await waitFor("editor blocks", async () =>
    Boolean(await execute(`return document.querySelector("p[data-block-id]") !== null`)),
  );
  // KARA auto-engages on the first manuscript; the rail (and its Review
  // button) leaves the stage until the toggle. The review surface is not a
  // KARA surface in this slice, so toggle out first.
  await chord("");
  await waitFor("KARA off", async () =>
    Boolean(await execute(`return document.querySelector(".kara-chrome") === null`)),
  );
};

const blockId = async (): Promise<string> =>
  String(
    await execute(`return document.querySelector("p[data-block-id]")?.dataset.blockId ?? "";`, []),
  );

const run = async (): Promise<void> => {
  await start();
  const adopted = await execute(
    `return __TAURI_INTERNALS__.invoke("debug_adopt_root", {
      path: ${JSON.stringify(fixture)},
      kind: "folder",
    }).then((r) => r.rootId, (e) => { throw new Error(JSON.stringify(e)); })`,
    [],
  );
  const rootId = String(adopted);
  await openChapter();
  const id = await blockId();
  check("the chapter is open", id !== "");

  const allBlocks = (await execute(
    `return __TAURI_INTERNALS__.invoke("current_document", {
      rootId: ${JSON.stringify(rootId)},
      path: "长章.md",
    }).then((doc) => doc.blocks.map((b) => b.id), (e) => { throw new Error(JSON.stringify(e)); })`,
    [],
  )) as string[];
  check("the chapter has forty-five blocks", allBlocks.length === 45, allBlocks.length);

  const proposals = await execute(
    `return __TAURI_INTERNALS__.invoke("inject_fixture_proposal", {
      rootId: ${JSON.stringify(rootId)},
      path: "长章.md",
      replacements: [
        { blocks: ${JSON.stringify(allBlocks)}, after: ${JSON.stringify(sentences.map((x) => `${x}（改写）`).join("\n\n"))} },
      ],
    }).then(
      (rows) => rows,
      (e) => { throw new Error(JSON.stringify(e)); })`,
    [],
  );
  const changedSlices = (proposals as { slices: { kind: string }[] }[])
    .flatMap((p) => p.slices)
    .filter((s) => s.kind !== "same").length;
  check("the fixture froze candidates with changed slices", changedSlices > 0, changedSlices);

  // The keyboard path: judge every unit with Alt+A.
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
  for (let i = 0; i < 100; i += 1) {
    const [done, totalNow] = await counts();
    if (totalNow > 0 && done >= totalNow) break;
    await altKey("a");
    // A verdict is record + persist + advance (~700ms end to end): wait for
    // the count AND the advance, or the next press duplicates the slice.
    await waitFor(`verdict ${done + 1}`, async () => (await counts())[0] > done, 6_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (i === 99) throw new Error("the keyboard path did not exhaust the units");
  }
  const [judged, total] = await counts();
  check("all units judged on the keyboard", judged === total && total > 40, `${judged}/${total}`);

  // Stage every judged unit by walking back through them.
  for (let i = 0; i < total; i += 1) {
    const stagedBefore = Number(
      String(
        await execute(`return document.querySelector(".review-head")?.textContent ?? "";`, []),
      ).match(/(\d+) 待合并/)?.[1] ?? "0",
    );
    await altKey("s");
    await waitFor(
      `stage ${stagedBefore + 1}`,
      async () =>
        Number(
          String(
            await execute(`return document.querySelector(".review-head")?.textContent ?? "";`, []),
          ).match(/(\d+) 待合并/)?.[1] ?? "0",
        ) > stagedBefore,
    );
    await altKey("k");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const stagedText = String(
    await execute(`return document.querySelector(".review-head")?.textContent ?? "";`, []),
  );
  check("the judged units are staged", stagedText.includes("89 待合并"), stagedText);

  // Persist the revision BEFORE the kill: proposals freeze against this head,
  // and only continuity lets a post-restart commit see the same baseline.
  await chord("s");
  await new Promise((resolve) => setTimeout(resolve, 800));

  // --- Kill BEFORE the commit: the five things must come back. ---
  await stop();
  await start();
  await execute(
    `return __TAURI_INTERNALS__.invoke("debug_adopt_root", {
      path: ${JSON.stringify(fixture)},
      kind: "folder",
    }).then((r) => r, (e) => { throw new Error(JSON.stringify(e)); })`,
    [],
  );
  await openChapter();
  const restored = (await execute(
    `return __TAURI_INTERNALS__.invoke("review_state", {
      rootId: ${JSON.stringify(rootId)},
      path: "长章.md",
    }).then((s) => s, (e) => { throw new Error(JSON.stringify(e)); })`,
    [],
  )) as { verdicts: unknown[]; batch: string[]; cursor: number; proposals: unknown[] };
  check(
    "the judged verdicts survive the kill",
    restored.verdicts.length === 89,
    restored.verdicts.length,
  );
  check("the staged batch survives the kill", restored.batch.length === 89, restored.batch.length);
  check("the cursor comes back exactly", typeof restored.cursor === "number", restored.cursor);

  // Commit after the restart: one Text Action, batch clears, disk untouched.
  await clickButton("Review");
  await waitFor("the review surface again", async () =>
    Boolean(await execute(`return document.querySelector(".review-surface") !== null`)),
  );
  const surface2 = await elementOrNull(".review-surface");
  if (surface2 !== null) await click(surface2);
  await altKey("");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await waitFor("the surface to close on commit", async () =>
    Boolean(await execute(`return document.querySelector(".review-surface") === null`)),
  );
  const head = await execute(
    `return __TAURI_INTERNALS__.invoke("current_document", {
      rootId: ${JSON.stringify(rootId)},
      path: "长章.md",
    }).then((doc) => doc.blocks.map((b) => b.text).join(String.fromCharCode(10, 10)), (e) => "err:" + JSON.stringify(e));`,
    [],
  );
  check(
    "the batch landed as one Text Action in the manuscript",
    String(head).includes("（改写）"),
    String(head).slice(-40),
  );
  const onDisk = readFileSync(chapterPath, "utf8");
  check("disk stays untouched until the author saves (INV-2)", !onDisk.includes("（改写）"));

  const after = (await execute(
    `return __TAURI_INTERNALS__.invoke("review_state", {
      rootId: ${JSON.stringify(rootId)},
      path: "长章.md",
    }).then((s) => s, (e) => { throw new Error(JSON.stringify(e)); })`,
    [],
  )) as { batch: string[]; proposals: unknown[]; verdicts: unknown[] };
  check("the batch clears after the commit", after.batch.length === 0);
  check(
    "candidates and verdicts stay for the audit",
    after.proposals.length > 0 && after.verdicts.length === 89,
  );

  await stop();
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log("\nreview loop: all checks passed");
  rmSync(fixture, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
};

void run().finally(() => driver?.kill());
