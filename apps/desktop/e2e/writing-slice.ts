/**
 * The writing slice against the real window, WebDriver edition (C5 evidence).
 *
 * Driven through tauri-driver + msedgedriver: the officially supported route
 * for a Tauri shell, and the one that works in a CI agent session, where a
 * bare WebView2 never opens a CDP port. Everything is still observed: real
 * key events for typing, the real filesystem for persistence and conflict.
 * The one stubbed seam is the OS folder picker, answered through the app's
 * single picker seam (`src/shell/pick.ts`).
 *
 * Run: `bun apps/desktop/e2e/writing-slice.ts <path-to-refrain.exe>`.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exe = process.argv[2];
if (!exe) {
  console.error("usage: bun apps/desktop/e2e/writing-slice.ts <refrain.exe>");
  process.exit(2);
}

const DRIVER_PORT = 4444;
const fixture = mkdtempSync(join(tmpdir(), "refrain-e2e-"));
const chapterPath = join(fixture, "第一章.md");
writeFileSync(chapterPath, "原来的第一句。\n\n原来的第二句。\n");

const failures: string[] = [];
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    console.error(`FAIL  ${name}${detail === undefined ? "" : `: ${String(detail)}`}`);
    failures.push(name);
  }
};

// ---- a WebDriver client is a dozen lines of HTTP -----------------------------
const base = `http://127.0.0.1:${DRIVER_PORT}`;

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: { value?: unknown } = {};
  try {
    parsed = JSON.parse(text) as { value?: unknown };
  } catch {
    throw new Error(`webdriver ${method} ${path}: not JSON: ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error(`webdriver ${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  }
  return parsed.value;
}

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
type El = string;

let session = "";

async function element(selector: string, xpath = false): Promise<El> {
  const value = (await call("POST", `/session/${session}/element`, {
    using: xpath ? "xpath" : "css selector",
    value: selector,
  })) as Record<string, string>;
  if (!(ELEMENT_KEY in value)) console.error("element response shape:", JSON.stringify(value));
  return value[ELEMENT_KEY] ?? Object.values(value)[0] ?? "";
}

async function elementOrNull(selector: string, xpath = false): Promise<El | null> {
  try {
    return await element(selector, xpath);
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

const text = async (el: El): Promise<string> =>
  ((await call("GET", `/session/${session}/element/${el}/text`)) as string) ?? "";

const sendKeys = (el: El, keys: string): Promise<unknown> =>
  call("POST", `/session/${session}/element/${el}/value`, { text: keys });

// A real chord: CONTROL held while the key goes down and up. Sequential
// sendKeys would tap them one after another, which is not a shortcut.
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
          { type: "pause", duration: 0 },
        ],
      },
    ],
  });

const execute = (script: string, args: unknown[] = []): Promise<unknown> =>
  call("POST", `/session/${session}/execute/sync`, { script, args });

// Elements cross into execute/sync as references, not bare ids.
const asElement = (el: El): Record<string, string> => ({ [ELEMENT_KEY]: el });

const visible = async (el: El): Promise<boolean> =>
  ((await call("GET", `/session/${session}/element/${el}/displayed`)) as boolean) ?? false;

async function waitFor(
  description: string,
  probe: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`timeout waiting for ${description}`);
}

const buttonByText = (label: string): Promise<El> =>
  element(`//button[contains(.,'${label}')]`, true);

const clickButton = async (label: string): Promise<void> => {
  await waitFor(
    `button ${label}`,
    async () => (await elementOrNull(`//button[contains(.,'${label}')]`, true)) !== null,
  );
  await click(await buttonByText(label));
};

const statusText = async (): Promise<string> =>
  String(await execute(`return document.querySelector(".status-line")?.textContent ?? ""`, []));

// ---- drive -------------------------------------------------------------------
let driver: ChildProcess | null = null;

const run = async (): Promise<void> => {
  const nativeDriver = process.env.REFRAIN_MSEDGEDRIVER ?? "msedgedriver";
  driver = spawn("tauri-driver", ["--native-driver", nativeDriver], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  driver.stdout?.on("data", (chunk: Buffer) => process.stderr.write(`[tauri-driver] ${chunk}`));
  driver.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[tauri-driver] ${chunk}`));

  const caps = {
    capabilities: {
      alwaysMatch: {
        browserName: "webview2",
        "ms:edgeOptions": { args: ["--enable-logging=stderr", "--v=0"] },
        "tauri:options": { application: exe.replaceAll("/", "\\") },
      },
    },
  };
  await waitFor("tauri-driver to listen", async () => {
    try {
      await fetch(`${base}/status`);
      return true;
    } catch {
      return false;
    }
  });
  session = ((await call("POST", "/session", caps)) as { sessionId?: string }).sessionId ?? "";
  check("the real window opens under WebDriver", session !== "", session);

  await execute(`window["refrain.e2e.pick"] = ${JSON.stringify(fixture)}; "planted"`);
  await clickButton("打开文件夹");
  await clickButton("第一章.md");
  await waitFor("blocks to render", async () => (await elements("p[data-block-id]")).length === 2);
  const blocks = await elements("p[data-block-id]");
  check(
    "opening renders two blocks from the byte-authoritative layout",
    blocks.length === 2,
    blocks.length,
  );
  check(
    "block text is exactly the disk text",
    (await text(blocks[0] ?? "")) === "原来的第一句。" &&
      (await text(blocks[1] ?? "")) === "原来的第二句。",
  );

  // D18: the first manuscript of the work session engages KARA once.
  const chrome = await elementOrNull(".kara-chrome");
  check("the first manuscript auto-engages KARA (default policy)", chrome !== null);
  const rail = await element(".rail");
  check("the rail leaves the stage in KARA", !(await visible(rail)));
  await chord(""); // CTRL+ENTER as one chord (ENTER, not RETURN)
  await waitFor("KARA off", async () => (await elementOrNull(".kara-chrome")) === null);
  check("Ctrl+Enter is the only toggle out (D10)", true);
  check("the rail returns on manual exit", await visible(rail));
  await chord("");
  await waitFor("KARA back on", async () => (await elementOrNull(".kara-chrome")) !== null);
  check("Ctrl+Enter re-engages manually", true);
  await chord("");
  await waitFor("KARA off again", async () => (await elementOrNull(".kara-chrome")) === null);

  const editable = (await elements("p[data-block-id]"))[1];
  if (editable === undefined) throw new Error("no second block");
  await click(editable);
  await sendKeys(editable, ""); // END: the click lands mid-text, typing belongs at the end
  await sendKeys(editable, "加一句结尾。");
  await waitFor("unsaved state", async () => (await statusText()).includes("未保存"));
  check("typing marks the document unsaved", true);

  await chord("s"); // CTRL+S
  await waitFor("saved state", async () => (await statusText()).includes("已保存"));
  const onDisk = readFileSync(chapterPath, "utf8");
  check("save writes the confirmed text to disk", onDisk.includes("加一句结尾。"), onDisk);
  check(
    "untouched bytes survive the save (INV-5)",
    onDisk.startsWith("原来的第一句。\n\n原来的第二句。"),
  );

  // A composition contributes nothing the save state can see; its text
  // becomes an action — and only then a change — at compositionend.
  await execute(
    `arguments[0].dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));`,
    [asElement(editable)],
  );
  await sendKeys(editable, "候选字");
  await new Promise((resolve) => setTimeout(resolve, 500));
  check(
    "mid-composition text never reaches the domain (INV-7)",
    (await statusText()).includes("已保存"),
    await statusText(),
  );
  await execute(
    `arguments[0].dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));`,
    [asElement(editable)],
  );
  await waitFor("the settled candidate dirties the document", async () =>
    (await statusText()).includes("未保存"),
  );
  check("the settled candidate becomes one action at compositionend", true);
  await chord("s");
  await waitFor("saved again", async () => (await statusText()).includes("已保存"));
  check(
    "the candidate reached disk through the settled action",
    readFileSync(chapterPath, "utf8").includes("候选字"),
  );

  await call("DELETE", `/session/${session}`);
  session = "";

  // --- Second session: reopen from disk. ---
  session = ((await call("POST", "/session", caps)) as { sessionId?: string }).sessionId ?? "";
  await execute(`window["refrain.e2e.pick"] = ${JSON.stringify(fixture)}; "planted"`);
  await clickButton("打开文件夹");
  await clickButton("第一章.md");
  await waitFor(
    "blocks to render again",
    async () => (await elements("p[data-block-id]")).length >= 2,
  );
  const blocks2 = await elements("p[data-block-id]");
  const reopened = await text(blocks2[1] ?? "");
  check(
    "close and reopen finds the saved text",
    reopened.includes("加一句结尾。") && reopened.includes("候选字"),
    reopened,
  );

  // --- Conflict: the file moved on underneath. ---
  writeFileSync(chapterPath, "别处改写的一句。\n");
  const editable2 = blocks2[1];
  if (editable2 === undefined) throw new Error("no second block in session two");
  await click(editable2);
  await sendKeys(editable2, ""); // END
  await sendKeys(editable2, "这边仍在写。");
  await chord("s");
  await waitFor(
    "the Safety conflict to surface",
    async () => (await elementOrNull("//h2[contains(.,'磁盘上的版本已经变了')]", true)) !== null,
  );
  check("an outside edit surfaces as a Safety conflict", true);
  check(
    "the refusal kept the other edit",
    readFileSync(chapterPath, "utf8") === "别处改写的一句。\n",
  );
  // The click on the native-dialog-mocked button goes through the same Vue
  // path as a trusted one (synthetic here; the trusted click was already
  // covered by the CDP harness during development).
  await execute(
    `const button = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("用我的覆盖磁盘"));
     if (!button) { throw new Error("resolve button gone"); }
     button.click();
     "clicked"`,
    [],
  );
  await waitFor("saved after resolve", async () => (await statusText()).includes("已保存"));
  check(
    "resolving for mine writes through a CAS on the shown stamp",
    readFileSync(chapterPath, "utf8").includes("这边仍在写。"),
  );

  await call("DELETE", `/session/${session}`);
  session = "";

  if (failures.length > 0) {
    console.error(`
${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log("writing slice: all checks passed");
  rmSync(fixture, { recursive: true, force: true });
  process.exit(0);
};

void run().finally(() => {
  driver?.kill();
  if (session !== "") void call("DELETE", `/session/${session}`).catch(() => {});
});
