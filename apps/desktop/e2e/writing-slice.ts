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

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exe = process.argv[2];
if (!exe) {
  console.error("usage: bun apps/desktop/e2e/writing-slice.ts <refrain.exe>");
  process.exit(2);
}

const DRIVER_PORT = Number(process.env.REFRAIN_E2E_PORT ?? 4444);
const fixture = mkdtempSync(join(tmpdir(), "refrain-e2e-"));
const dataDir = mkdtempSync(join(tmpdir(), "refrain-e2e-data-"));
const evidenceDir = join(process.cwd(), "target", "e2e-evidence", "writing");
mkdirSync(evidenceDir, { recursive: true });
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
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${base}${path}`, init);
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

const screenshot = async (name: string): Promise<void> => {
  const encoded = (await call("GET", `/session/${session}/screenshot`)) as string;
  writeFileSync(join(evidenceDir, `${name}.png`), Buffer.from(encoded, "base64"));
};

const pressKey = (key: string): Promise<unknown> =>
  call("POST", `/session/${session}/actions`, {
    actions: [
      {
        type: "key",
        id: "single-key",
        actions: [
          { type: "keyDown", value: key },
          { type: "keyUp", value: key },
        ],
      },
    ],
  });

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
      stdio: ["ignore", "pipe", "pipe"],
      // tauri:options has no env field: the app inherits the driver's
      // environment, and the driver inherits this one.
      env: { ...process.env, REFRAIN_DATA_DIR: dataDir },
    },
  );
  driver.stdout?.on("data", (chunk: Buffer) => process.stderr.write(`[tauri-driver] ${chunk}`));
  driver.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[tauri-driver] ${chunk}`));

  const caps = {
    capabilities: {
      alwaysMatch: {
        browserName: "webview2",
        "ms:edgeOptions": {
          // CI runners have no GPU-backed desktop; without these the WebView2
          // browser process dies before it opens its devtools port.
          args: [
            `--user-data-dir=${join(dataDir, "webview-args")}`,
            "--enable-logging=stderr",
            "--v=0",
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
  await screenshot("01-welcome");

  // WindowChrome is verified against the native Windows window, not only by
  // source tokens. Three distinct rects prove repeated resize; the custom
  // controls must change native state and keep their accessible names in sync.
  type WindowRect = { x: number; y: number; width: number; height: number };
  const rect = (): Promise<WindowRect> =>
    call("GET", `/session/${session}/window/rect`) as Promise<WindowRect>;
  for (const [width, height] of [
    [1000, 700],
    [1180, 760],
    [900, 600],
  ] as const) {
    await call("POST", `/session/${session}/window/rect`, { width, height });
    const measured = await rect();
    check(
      `the real window resizes to ${width}×${height}`,
      Math.abs(measured.width - width) <= 2 && Math.abs(measured.height - height) <= 2,
      JSON.stringify(measured),
    );
  }
  const restoredRect = await rect();
  await execute(
    `document.body.tabIndex = -1; document.body.focus(); return document.activeElement === document.body`,
  );
  await pressKey("");
  const firstFocus = String(
    await execute(`return document.activeElement?.getAttribute("aria-label") ?? ""`),
  );
  check(
    "keyboard Tab reaches the first custom window control",
    firstFocus === "最小化",
    firstFocus,
  );
  await click(await element('button[aria-label="最大化窗口"]'));
  await waitFor(
    "the maximize control to become restore",
    async () => (await elementOrNull('button[aria-label="还原窗口"]')) !== null,
  );
  const maximizedRect = await rect();
  check(
    "the custom maximize control changes native window bounds",
    maximizedRect.width >= restoredRect.width && maximizedRect.height >= restoredRect.height,
    `${JSON.stringify(restoredRect)} → ${JSON.stringify(maximizedRect)}`,
  );
  await click(await element('button[aria-label="还原窗口"]'));
  await waitFor(
    "the restore control to become maximize",
    async () => (await elementOrNull('button[aria-label="最大化窗口"]')) !== null,
  );
  await pressKey("");
  await waitFor(
    "F11 to enter fullscreen",
    async () => (await elementOrNull('button[aria-label="退出全屏"]')) !== null,
  );
  await pressKey("");
  await waitFor(
    "F11 to exit fullscreen",
    async () => (await elementOrNull('button[aria-label="进入全屏"]')) !== null,
  );
  check("F11 enters and exits the real fullscreen window", true);

  await click(await element('button[aria-label="最小化"]'));
  await waitFor(
    "the minimized window to become hidden",
    async () => String(await execute("return document.visibilityState")) === "hidden",
  );
  await call("POST", `/session/${session}/window/rect`, restoredRect);
  await waitFor(
    "the minimized window to restore",
    async () => String(await execute("return document.visibilityState")) === "visible",
  );
  check("the custom minimize control minimizes the real window", true);

  const display = (await execute(`return __TAURI_INTERNALS__.invoke("display_profile")`, [])) as {
    refreshHz: number;
    frameBudgetMs: number;
    scaleFactor: number;
    hairlineCssPx: number;
  };
  check(
    "the real Windows display reports a coherent frame budget",
    display.refreshHz > 1 && Math.abs(display.frameBudgetMs - 1000 / display.refreshHz) < 0.02,
    JSON.stringify(display),
  );
  check(
    "the real display hairline is one physical pixel",
    Math.abs(display.hairlineCssPx * display.scaleFactor - 1) < 0.02,
    JSON.stringify(display),
  );
  await waitFor("the display profile to reach CSS", async () =>
    Boolean(
      await execute(
        `const root = document.documentElement;
         return parseFloat(root.style.getPropertyValue("--display-refresh-hz")) > 1 &&
           parseFloat(root.style.getPropertyValue("--hairline")) > 0`,
      ),
    ),
  );
  check("the measured DisplayProfile reaches the renderer once per frame", true);

  await execute(
    `window["refrain.e2e.pick"] = ${JSON.stringify(fixture)}; window["refrain.e2e.pin"] = true; "planted"`,
  );
  await clickButton("打开文件夹");

  // The theme picker reads the generated list, writes the single Config, and
  // the choice projects immediately (D12). Appearance lives in the Settings
  // surface, off the rail (C12.6).
  await clickButton("设置");
  await screenshot("02-settings");
  const systemFontCount = Number(
    await execute(
      `return __TAURI_INTERNALS__.invoke("list_fonts").then((fonts) =>
        fonts.filter((font) => font.bundledSlot === null).length
      )`,
    ),
  );
  check(
    "the real Windows font scan reaches Settings through IPC",
    systemFontCount > 0,
    systemFontCount,
  );
  const paperOf = async (): Promise<string> =>
    String(
      await execute(
        `return getComputedStyle(document.documentElement).getPropertyValue("--paper").trim()`,
        [],
      ),
    );
  await waitFor(
    "theme buttons",
    async () => (await elements(".theme-picker [data-theme-slug]")).length === 7,
  );
  const themeButtons = await elements(".theme-picker [data-theme-slug]");
  check(
    "the generated theme list reaches the picker",
    themeButtons.length === 7,
    themeButtons.length,
  );
  const paperBefore = await paperOf();
  await clickButton("墨");
  await waitFor("the shell to repaint", async () => (await paperOf()) !== paperBefore);
  const paperAfter = await paperOf();
  check("picking 墨 repaints the shell", true, `${paperBefore} → ${paperAfter}`);
  await waitFor("the choice on disk", async () =>
    readFileSync(join(dataDir, "config.toml"), "utf8").includes('theme = "sumi"'),
  );
  check("the choice lands in the single Config (INV-10)", true);

  // The manuscript sheet's three edges (SPEC 9.8): the pick writes the one
  // Config and the projection attribute answers immediately.
  await clickButton("无");
  await waitFor("the edgeless sheet", async () =>
    Boolean(await execute(`return document.documentElement.dataset.paper === "none"`, [])),
  );
  await waitFor("the paper mode on disk", async () =>
    readFileSync(join(dataDir, "config.toml"), "utf8").includes('paper = "none"'),
  );
  check("the paper mode lands in the single Config", true);
  await clickButton("细");
  await waitFor("the hairline sheet", async () =>
    Boolean(await execute(`return document.documentElement.dataset.paper === "hairline"`, [])),
  );
  check("the sheet returns to hairline", true);

  await clickButton("撤销本次调整");
  await waitFor("the Settings-entry snapshot to return", async () =>
    Boolean(
      await execute(
        `return document.documentElement.dataset.theme === "tou" && document.documentElement.dataset.paper === "hairline"`,
      ),
    ),
  );
  check("Settings can undo every adjustment made since entry", true);

  await clickButton("墨");
  await clickButton("无");
  await clickButton("恢复本页默认");
  await waitFor("the appearance defaults to return", async () =>
    Boolean(
      await execute(
        `return document.documentElement.dataset.theme === "tou" && document.documentElement.dataset.paper === "hairline"`,
      ),
    ),
  );
  check("Settings resets only the current appearance page", true);

  // Font priority (SPEC 9.8): the same sentinel 直骨令 rendered under both
  // orders must differ, and the real editor stack must render it like the
  // family the author put first.
  await execute(
    `await Promise.all([
      document.fonts.load('32px "Chiron Sung HK"', "直骨令"),
      document.fonts.load('32px "Shippori Mincho"', "直骨令"),
      document.fonts.load('32px "Antic Didone"', "Ag"),
    ]);
    return document.fonts.ready;`,
    [],
  );
  const measurePixels = async (stack: string): Promise<string> =>
    String(
      await execute(
        `const c = document.createElement("canvas");
         c.width = 160; c.height = 60;
         const x = c.getContext("2d");
         x.fillStyle = "#fff"; x.fillRect(0, 0, 160, 60);
         x.fillStyle = "#000";
         x.font = "32px " + ${JSON.stringify(stack)};
         x.textBaseline = "top";
         x.fillText("直骨令", 4, 4);
         const d = x.getImageData(0, 0, 160, 60).data;
         let h = 0;
         for (let i = 0; i < d.length; i += 1) h = (h * 31 + d[i]) >>> 0;
         return h.toString(16);`,
        [],
      ),
    );
  const chineseFirst = await measurePixels('"Chiron Sung HK", "Shippori Mincho", serif');
  const japaneseFirst = await measurePixels('"Shippori Mincho", "Chiron Sung HK", serif');
  check(
    "the sentinel 直骨令 is drawn differently by the two orders",
    chineseFirst !== japaneseFirst,
    `${chineseFirst} vs ${japaneseFirst}`,
  );

  // The default priority puts Chinese ahead of Japanese.
  const editorStack = String(
    await execute(
      `return getComputedStyle(document.querySelector(".theme-picker")?.closest("body") ?? document.body).getPropertyValue("--manuscript-family").trim()`,
      [],
    ),
  );
  check(
    "the editor stack opens with the configured first slot",
    editorStack.includes("Antic Didone") &&
      editorStack.indexOf("Chiron Sung HK") < editorStack.indexOf("Shippori Mincho"),
    editorStack,
  );

  // Switch priority to Japanese-first through the real command. The backend
  // broadcasts the change and the app re-projects — no harness recompute.
  await execute(
    `return __TAURI_INTERNALS__.invoke("update_preferences", {
      change: { kind: "setFontPriority", value: ["japanese", "chinese", "latin"] },
    }).then(() => "ok", (e) => { throw new Error(JSON.stringify(e)); })`,
    [],
  );
  await waitFor("the app to re-project the stack", async () =>
    String(
      await execute(
        `return getComputedStyle(document.documentElement).getPropertyValue("--manuscript-family").trim()`,
        [],
      ),
    ).startsWith('"Shippori Mincho"'),
  );
  check("the app re-projects the stack from the broadcast config", true);
  const configStack = String(
    await execute(
      `return __TAURI_INTERNALS__.invoke("read_config").then((snapshot) => {
        const fonts = snapshot.config.appearance.fonts;
        const names = { latin: fonts.latin, chinese: fonts.chinese, japanese: fonts.japanese };
        return fonts.priority.map((slot) => '"' + names[slot] + '"').join(", ") + ", serif";
      })`,
      [],
    ),
  );
  check(
    "the Config records the new order",
    configStack.startsWith('"Shippori Mincho"'),
    configStack,
  );
  const japanesePriorityPixels = await measurePixels(configStack);
  check(
    "Japanese-first order draws the sentinel unlike the Chinese-first order",
    japanesePriorityPixels !== chineseFirst,
  );
  const editorVarPixels = await measurePixels(
    String(
      await execute(
        `return getComputedStyle(document.documentElement).getPropertyValue("--manuscript-family").trim()`,
        [],
      ),
    ),
  );
  check(
    "the Config-ordered stack draws like the editor's computed stack",
    editorVarPixels === japanesePriorityPixels,
    `${editorVarPixels} vs ${japanesePriorityPixels}`,
  );

  // Emitted assets are the source fonts: bytes hash out, not family names.
  // The page's CSP (connect-src) forbids an in-page fetch, so the hash is
  // read off the built bundle directly — that IS the emitted asset.
  const { createHash } = await import("node:crypto");
  const { readdirSync } = await import("node:fs");
  const emitted = readdirSync("apps/desktop/dist/assets").find((name) =>
    name.startsWith("ChironSungHK-"),
  );
  check("the bundle emits the Chiron asset", emitted !== undefined);
  const assetHash = createHash("sha256")
    .update(readFileSync(`apps/desktop/dist/assets/${emitted}`))
    .digest("hex");
  const sourceHash = createHash("sha256")
    .update(readFileSync("apps/desktop/src/fonts/ChironSungHK.woff2"))
    .digest("hex");
  check(
    "the emitted font asset is byte-identical to the source",
    assetHash === sourceHash,
    assetHash,
  );

  // The icon pipeline (SPEC 9.8): a plain SVG normalises to the button's
  // pixels; an outward-reaching SVG is refused with a typed error.
  const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#ca4d23"/></svg>`;
  const digest = String(
    await execute(
      `return __TAURI_INTERNALS__.invoke("set_universal_icon", {
        bytes: [...new TextEncoder().encode(${JSON.stringify(iconSvg)})],
      }).then(
        (d) => d,
        (e) => { throw new Error("set_universal_icon refused a plain SVG: " + JSON.stringify(e)); },
      )`,
      [],
    ),
  );
  check("a plain SVG imports and is named by digest", digest.length === 64, digest);
  await waitFor("the button to show the icon", async () =>
    Boolean(
      await execute(
        `const img = document.querySelector(".icon-button img");
         return img && img.complete && img.naturalWidth > 0;`,
        [],
      ),
    ),
  );
  check("the Universal Button draws the imported pixels", true);
  const malicious = String(
    await execute(
      `return __TAURI_INTERNALS__.invoke("set_universal_icon", {
        bytes: [...new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="https://evil.example/x.png"/></svg>')],
      }).then(
        () => "imported (DEFECT)",
        (e) => "refused:" + (e.code ?? JSON.stringify(e)),
      )`,
      [],
    ),
  );
  check("an outward-reaching SVG is refused", malicious.startsWith("refused:"), malicious);

  await pressKey("");
  await waitFor(
    "Settings to close on Escape",
    async () => (await elementOrNull(".settings")) === null,
  );
  check("Escape closes Settings and returns to the workbench", true);

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

  const selectAndOpenContext = async (block: El, start: number, end: number): Promise<void> => {
    await execute(
      `const block = arguments[0];
       const text = block.firstChild;
       const range = document.createRange();
       range.setStart(text, ${start});
       range.setEnd(text, ${end});
       const selection = window.getSelection();
       selection.removeAllRanges();
       selection.addRange(range);
       block.dispatchEvent(new MouseEvent("contextmenu", {
         bubbles: true, clientX: 360, clientY: 240, button: 2,
       }));`,
      [asElement(block)],
    );
    await waitFor("the editor context menu", async () =>
      Boolean(await execute(`return document.querySelector(".context-menu") !== null`)),
    );
  };

  const firstBlock = blocks[0];
  const secondBlock = blocks[1];
  if (firstBlock === undefined || secondBlock === undefined)
    throw new Error("annotation blocks gone");
  await selectAndOpenContext(firstBlock, 0, 3);
  await clickButton("建立高亮");
  await execute(`window.prompt = () => "核对第二句的时间关系"`, []);
  await selectAndOpenContext(secondBlock, 0, 5);
  await clickButton("添加批注");
  await clickButton("批注");
  await waitFor("the persisted annotation panel", async () =>
    Boolean(await execute(`return document.querySelectorAll(".annotations li").length === 2`)),
  );
  check("a highlight and a comment reach the annotation panel", true);
  await screenshot("03-annotations");
  const annotationCheckbox = await element(".annotations input[type=checkbox]");
  await click(annotationCheckbox);

  // 关掉面板去看正文，再打开——勾选必须还在。
  //
  // 这曾经是 AnnotationSurface 的组件本地信号，面板一关就随 DOM 消失：
  // 作者勾了十条、回正文核对一句、再打开，全没了且没有任何提示，他会以为
  // 自己没点。选择现在归外壳的 AnnotationSelection，面板的生死碰不到它。
  //
  // 这条只能在真窗口里验：单元测试测得了那个模块，测不了「面板卸载之后
  // 复选框还勾着」——那是组件与外壳之间的事。
  await clickButton("返回正文");
  await waitFor("the annotation panel to close", async () =>
    Boolean(await execute(`return document.querySelector(".annotations") === null`)),
  );
  await clickButton("批注");
  await waitFor("the annotation panel to reopen", async () =>
    Boolean(await execute(`return document.querySelectorAll(".annotations li").length === 2`)),
  );
  check(
    "a selected annotation survives closing and reopening the panel",
    Boolean(
      await execute(
        `return document.querySelectorAll(".annotations input[type=checkbox]:checked").length === 1`,
      ),
    ),
  );

  await clickButton("将所选批注转为派发工单");
  await waitFor("the annotation dispatch ticket", async () =>
    Boolean(await execute(`return document.querySelector(".dispatch-prompt") !== null`)),
  );
  const annotationPrompt = String(
    await execute(`return document.querySelector(".dispatch-prompt")?.value ?? ""`),
  );
  check(
    "the annotation dispatch ticket freezes the author's instruction",
    annotationPrompt.includes("核对第二句的时间关系") && annotationPrompt.includes("原来的第二"),
    annotationPrompt,
  );
  await clickButton("收起");

  const editable = (await elements("p[data-block-id]"))[1];
  if (editable === undefined) throw new Error("no second block");
  await click(editable);
  await sendKeys(editable, ""); // END: the click lands mid-text, typing belongs at the end
  await sendKeys(editable, "加一句结尾。");
  await waitFor("unsaved state", async () => (await statusText()).includes("未保存"));
  check("typing marks the document unsaved", true);
  await click(await element('button[aria-label="关闭"]'));
  await waitFor("close protection", async () =>
    String(await execute(`return document.querySelector(".notice")?.textContent ?? ""`)).includes(
      "正文尚未保存",
    ),
  );
  check("the custom close control refuses to destroy an unsaved window", session !== "");
  await screenshot("03-writing-unsaved");

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
  await execute(
    `window["refrain.e2e.pick"] = ${JSON.stringify(fixture)}; window["refrain.e2e.pin"] = true; "planted"`,
  );
  await clickButton("打开文件夹");
  // A re-adopt inside the still-running process can take seconds (C12.6
  // observation: contention with the project the first session left open —
  // recorded in the Memo for C14). Wait for the shelf before touching it.
  await waitFor(
    "the shelf after re-adopt",
    async () => (await elements(".rail li button")).length >= 1,
  );
  await clickButton("第一章.md");
  await waitFor(
    "blocks to render again",
    async () => (await elements("p[data-block-id]")).length >= 2,
  );
  const blocks2 = await elements("p[data-block-id]");
  await waitFor("annotations to project after restart", async () =>
    Boolean(await execute(`return document.querySelectorAll('p[data-annotation]').length === 2`)),
  );
  check("highlights and comments recover after restart", true);
  await clickButton("批注");
  await waitFor("annotation bodies after restart", async () =>
    String(
      await execute(`return document.querySelector('.annotations')?.textContent ?? ''`),
    ).includes("核对第二句的时间关系"),
  );
  check("the author's annotation body recovers after restart", true);
  await clickButton("返回正文");
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
  await screenshot("04-conflict");
  check(
    "the refusal kept the other edit",
    readFileSync(chapterPath, "utf8") === "别处改写的一句。\n",
  );
  // The conflict choice uses the same Solid event path as a trusted click.
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
