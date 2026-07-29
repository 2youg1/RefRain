/**
 * Visual probe (C12.6): real-window screenshots across themes and paper
 * modes, saved to probe-results/ for pixel review. Not a gate — the gates
 * assert behaviour; this produces the pictures a designer signs.
 *
 * Run: `bun apps/desktop/e2e/probe-visual.ts <path-to-refrain.exe>`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exe = process.argv[2];
if (!exe) {
  console.error("usage: bun apps/desktop/e2e/probe-visual.ts <refrain.exe>");
  process.exit(2);
}

const DRIVER_PORT = Number(process.env.REFRAIN_E2E_PORT ?? 4444);
const fixture = mkdtempSync(join(tmpdir(), "refrain-e2e-"));
const dataDir = mkdtempSync(join(tmpdir(), "refrain-e2e-data-"));
writeFileSync(
  join(fixture, "第一章.md"),
  "霧が下流から這い上がって、川の湾を一枚ずつ畳んでいく。彼は振り返らず、手の帳面をもう一方の手へ移した。\n\n遠くで誰かが何かを打っている。とても遅く、間を置いて一度ずつ。\n\n雾从下游漫上来，把河湾一层层收走。他没有回头，只是把手里的册子换到另一只手。\n",
);

const base = `http://127.0.0.1:${DRIVER_PORT}`;

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = JSON.parse(text) as { value?: unknown };
  if (!response.ok)
    throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  return parsed.value;
}

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
let session = "";

const element = async (selector: string, xpath = false): Promise<string> => {
  const value = (await call("POST", `/session/${session}/element`, {
    using: xpath ? "xpath" : "css selector",
    value: selector,
  })) as Record<string, string>;
  return value[ELEMENT_KEY] ?? Object.values(value)[0] ?? "";
};

const clickButton = async (label: string): Promise<void> => {
  let id = "";
  await waitFor(async () => {
    try {
      id = await element(`//button[contains(.,'${label}')]`, true);
      return true;
    } catch {
      return false;
    }
  });
  await call("POST", `/session/${session}/element/${id}/click`, {});
};

const execute = (script: string): Promise<unknown> =>
  call("POST", `/session/${session}/execute/sync`, { script, args: [] });

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 500));

const shoot = async (name: string): Promise<void> => {
  const png = (await call("GET", `/session/${session}/screenshot`)) as string;
  writeFileSync(join("probe-results", `c126-${name}.png`), Buffer.from(png, "base64"));
  console.log(`shot  ${name}`);
};

const waitFor = async (probe: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("timeout");
};

let driver: ChildProcess | null = null;

const run = async (): Promise<void> => {
  const nativeDriver = process.env.REFRAIN_MSEDGEDRIVER ?? "msedgedriver";
  driver = spawn(
    "tauri-driver",
    [
      "--native-driver",
      nativeDriver,
      "--port",
      String(DRIVER_PORT),
      "--native-port",
      String(DRIVER_PORT + 100),
    ],
    {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, REFRAIN_DATA_DIR: dataDir },
    },
  );
  const caps = {
    capabilities: {
      alwaysMatch: {
        browserName: "webview2",
        "ms:edgeOptions": {
          args: ["--disable-gpu", "--no-first-run", "--disable-extensions"],
        },
        "tauri:options": {
          application: exe.replaceAll("/", "\\"),
          webviewOptions: { userDataFolder: join(dataDir, "webview") },
        },
      },
    },
  };
  await waitFor(async () => {
    try {
      await fetch(`${base}/status`);
      return true;
    } catch {
      return false;
    }
  });
  session = ((await call("POST", "/session", caps)) as { sessionId?: string }).sessionId ?? "";

  // The WebView2 cold start can outlive a screenshot; wait for the app to
  // actually mount before touching anything.
  await waitFor(async () =>
    Boolean(
      await execute(
        `return document.readyState === "complete" && !!document.querySelector(".workbench")`,
      ),
    ),
  );
  await shoot("welcome");
  await execute(
    `window["refrain.e2e.pick"] = ${JSON.stringify(fixture)}; window["refrain.e2e.pin"] = true; "planted"`,
  );
  await clickButton("打开文件夹");
  await waitFor(
    async () =>
      ((await execute(`return document.querySelectorAll(".rail li button").length`)) as number) > 0,
  );
  await clickButton("第一章.md");
  await waitFor(
    async () =>
      ((await execute(`return document.querySelectorAll("p[data-block-id]").length`)) as number) >
      0,
  );
  // The first manuscript auto-enters KARA (D18); the probe shoots the normal
  // chrome, so step back out. A real chord does not reach .workbench while
  // KARA owns the window (C10 lesson), so the keydown is dispatched in-page.
  await execute(
    `document.querySelector(".workbench").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); "toggled"`,
  );
  await clickButton("设置");
  await waitFor(
    async () =>
      ((await execute(
        `return document.querySelectorAll(".theme-picker [data-theme-slug]").length`,
      )) as number) > 0,
  );
  await shoot("tou-hairline");

  await clickButton("纸");
  await settle();
  await shoot("tou-paper");
  await clickButton("韶");
  await settle();
  await shoot("shao-paper");
  await clickButton("无");
  await settle();
  await shoot("shao-none");
  await clickButton("霞");
  await settle();
  await shoot("kasumi-none");
  await clickButton("砂");
  await clickButton("细");
  await settle();
  await shoot("suna-hairline");
};

try {
  await run();
} catch (error) {
  console.error("PROBE FAILED:", error);
  process.exitCode = 1;
} finally {
  if (session) await call("DELETE", `/session/${session}`).catch(() => {});
  driver?.kill();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  rmSync(fixture, { recursive: true, force: true, maxRetries: 3 });
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // The OS releases the profile a beat after the process dies; a leftover
    // temp dir is not probe evidence either way.
  }
}
