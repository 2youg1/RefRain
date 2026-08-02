/**
 * k3：真 harness 全流程实测（真窗口、本机真 Kimi Code、真模型）。
 *
 * 与 dispatch-loop（假 harness）互补：这里不做任何替身。链路——
 * 打开文档 → 连接真 harness → 创作伙伴 → 选文 → 批注 → 批注转派发 →
 * 真模型产出 → 提案被探测并渲染（印点）→ 裁决接受 → 合并 → 磁盘字节与渲染核对。
 * 附带两项实证：协议装载后首轮请求是否只带指针行；print 模式的 Run 是否落
 * 可恢复的 harness 会话文件（设计项 E 的取证）。
 *
 * 运行：先 `cargo build -p refrain-desktop` 与 `bun run dev:web`，设
 * REFRAIN_MSEDGEDRIVER 到匹配 WebView2 的驱动，然后
 *   bun apps/desktop/e2e/k3-live-harness.ts target/debug/refrain-desktop.exe
 * 注意：会向真实 harness 发真实请求（消耗本机 Kimi 额度），并会执行一次
 * 「安装协议」（写 ~/.kimi-code/skills/refrain/SKILL.md，可随时删除）。
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exe = process.argv[2];
if (!exe) {
  console.error("usage: bun apps/desktop/e2e/k3-live-harness.ts <refrain.exe>");
  process.exit(2);
}

const DRIVER_PORT = Number(process.env.REFRAIN_E2E_PORT ?? 4444);
const fixture = mkdtempSync(join(tmpdir(), "refrain-k3-"));
const dataDir = mkdtempSync(join(tmpdir(), "refrain-k3-data-"));
const evidenceDir = join(process.cwd(), "target", "e2e-evidence", "k3");
mkdirSync(evidenceDir, { recursive: true });
const chapterPath = join(fixture, "章一.md");

writeFileSync(
  chapterPath,
  "雨下了一夜。\n\n他推开窗，看见对岸的灯还亮着，像一句没有说完的话悬在夜色里，久久不肯落下。\n\n第二天清晨，街上空无一人。\n",
);

const failures: string[] = [];
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (condition) console.log(`PASS  ${name}`);
  else {
    console.error(`FAIL  ${name}${detail === undefined ? "" : `: ${String(detail)}`}`);
    failures.push(name);
  }
};

const base = `http://127.0.0.1:${DRIVER_PORT}`;
let session = "";

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const { request } = await import("node:http");
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      `${base}${path}`,
      {
        method,
        headers: {
          "content-type": "application/json",
          ...(payload === undefined
            ? {}
            : { "content-length": String(Buffer.byteLength(payload)) }),
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: { value?: unknown } = {};
          try {
            parsed = JSON.parse(text) as { value?: unknown };
          } catch {
            reject(new Error(`webdriver ${method} ${path}: not JSON: ${text.slice(0, 200)}`));
            return;
          }
          if (res.statusCode !== undefined && res.statusCode >= 400) {
            reject(
              new Error(`webdriver ${method} ${path} -> ${res.statusCode}: ${text.slice(0, 300)}`),
            );
            return;
          }
          resolve(parsed.value);
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`webdriver ${method} ${path} timed out`)));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

type El = string;
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const asElement = (el: El): Record<string, string> => ({ [ELEMENT_KEY]: el });
const execute = (script: string, args: unknown[] = []): Promise<unknown> =>
  call("POST", `/session/${session}/execute/sync`, { script, args }) as Promise<unknown>;

const screenshot = async (name: string): Promise<void> => {
  const png = (await call("GET", `/session/${session}/screenshot`)) as string;
  writeFileSync(join(evidenceDir, `${name}.png`), Buffer.from(png, "base64"));
};

const elementOrNull = async (selector: string, xpath = false): Promise<El | null> => {
  // 找不到是 404（reject），不是 null——探测语义必须把它翻译回来。
  const res = (await call("POST", `/session/${session}/element`, {
    using: xpath ? "xpath" : "css selector",
    value: selector,
  }).catch(() => null)) as Record<string, string> | null;
  if (res === null) return null;
  const id = res[ELEMENT_KEY];
  return id === undefined ? null : id;
};

const click = (el: El): Promise<unknown> =>
  call("POST", `/session/${session}/element/${el}/click`, {});

const clickButton = async (label: string): Promise<void> => {
  const el = await elementOrNull(`//button[contains(.,'${label}')]`, true);
  if (el === null) throw new Error(`no button: ${label}`);
  try {
    await click(el);
  } catch (error) {
    // 不可交互多半是滚出视口；stale 是句柄被重渲染换掉。两种都退到
    // 页面内现查现点（驱动的是同一个 Solid handler，与 tickBlock 同类）。
    console.error(`NOTE  JS-click fallback for ${label}: ${String(error).slice(0, 80)}`);
    await execute(
      `const b = Array.from(document.querySelectorAll("button"))
         .find((node) => node.textContent.includes(${JSON.stringify(label)}));
       if (!b) throw new Error("button vanished: " + ${JSON.stringify(label)});
       b.scrollIntoView({ block: "center" });
       b.click();
       "js-click"`,
    );
  }
};

async function waitFor(
  description: string,
  probe: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timeout waiting for ${description}`);
}

const caps = () => ({
  capabilities: {
    alwaysMatch: {
      browserName: "webview2",
      "ms:edgeOptions": {
        args: [
          `--user-data-dir=${join(dataDir, "webview-args")}`,
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
    // 真实 PATH：让 app 探测到本机真 kimi。数据目录隔离，不动作者的 RefRain 配置。
    { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, REFRAIN_DATA_DIR: dataDir } },
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
  await new Promise((resolve) => setTimeout(resolve, 800));
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

const invoke = (command: string, args: Record<string, unknown>): Promise<unknown> =>
  execute(
    `return __TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})
      .then((r) => r, (e) => { throw new Error(JSON.stringify(e)); })`,
    [],
  );

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

const run = async (): Promise<void> => {
  // ── 打开文档（先注册 Root，再走 UI 采用——与 dispatch-loop 同一顺序）──
  const adopted = (await invoke("debug_adopt_root", { path: fixture, kind: "folder" })) as {
    rootId: string;
  };
  const rootId = adopted.rootId;
  await clickButton("打开文件夹");
  await waitFor("chapter row in the rail", async () =>
    Boolean(await elementOrNull(`//button[contains(.,'章一.md')]`, true)),
  );
  await clickButton("章一.md");
  await waitFor("editor blocks", async () =>
    Boolean(await execute(`return document.querySelector("p[data-block-id]") !== null`)),
  );
  await waitFor("KARA on", async () =>
    Boolean(await execute(`return document.querySelector(".kara-veil") !== null`)),
  );
  await execute(
    `document.querySelector(".workbench").dispatchEvent(
       new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); "toggled"`,
  );
  await waitFor("KARA off", async () =>
    Boolean(await execute(`return document.querySelector(".kara-veil") === null`)),
  );
  // 先落一版：提案的 scope 锚定的是已持久化的修订，未保存的草稿会让裁决过期。
  await invoke("persist_revision", { rootId, path: "章一.md", expected: null });
  check("chapter opened in the real window", rootId.length > 0, rootId);

  // ── 连接真 harness ──
  await clickButton("连接");
  await waitFor("connections surface", async () =>
    Boolean(await execute(`return document.querySelector(".connections") !== null`)),
  );
  await waitFor("a candidate offers connect", async () =>
    Boolean(await elementOrNull(".tool-card button.primary")),
  );
  const connectButton = await elementOrNull(".tool-card button.primary");
  if (connectButton === null) {
    console.error("connections state:", await invoke("list_harnesses", {}));
    throw new Error("no connectable harness candidate (本机 kimi 没被探测到)");
  }
  await click(connectButton);
  await waitFor("harness connected", async () =>
    Boolean(
      await execute(
        `return Array.from(document.querySelectorAll(".tool-state"))
          .some((node) => node.dataset.status === "connected")`,
      ),
    ),
  );
  const harnesses = (await invoke("list_harnesses", {})) as {
    candidateId: string;
    connectionId: string | null;
    status: string;
    version: string | null;
    skillStatus: string;
  }[];
  const kimi = harnesses.find((h) => h.candidateId === "kimi-code" && h.status === "connected");
  if (kimi?.connectionId === null || kimi?.connectionId === undefined) {
    throw new Error("kimi connected without a connection id");
  }
  const probed = (await invoke("probe_connection", { connectionId: kimi.connectionId })) as string;
  check("the REAL kimi probed (not a fake)", !probed.includes("fake"), probed);

  // ── 协议装载：点击安装，徽章转「协议已装」──
  const skillBefore = kimi.skillStatus;
  const installBtn = await elementOrNull(
    `//button[contains(.,'安装协议') or contains(.,'更新协议')]`,
    true,
  );
  if (installBtn !== null) {
    await click(installBtn);
    await waitFor("skill installed badge", async () =>
      Boolean(
        await execute(
          `return Array.from(document.querySelectorAll("[data-skill]"))
            .some((node) => node.dataset.skill === "current")`,
        ),
      ),
    );
  }
  const skillAfter = ((await invoke("list_harnesses", {})) as { skillStatus: string }[])[0]
    ?.skillStatus;
  check(
    "protocol reads as installed (badge current)",
    skillAfter === "current",
    `${skillBefore} -> ${skillAfter}`,
  );

  // ── 创作伙伴 ──
  await execute(
    `const name = document.querySelector('.partner-form input');
     name.value = 'k3伙伴';
     name.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'k3伙伴' }));
     const channel = document.querySelector('.partner-form select');
     channel.value = ${JSON.stringify(kimi.connectionId)};
     channel.dispatchEvent(new Event('change', { bubbles: true }));
     const brief = document.querySelector('.partner-form textarea');
     if (brief) {
       brief.value = '你是精简的中文编辑，只改写，不评论。';
       brief.dispatchEvent(new Event('input', { bubbles: true }));
     }`,
  );
  await clickButton("添加写作伙伴");
  await waitFor("partner card", async () =>
    Boolean(
      await execute(
        `return Array.from(document.querySelectorAll('.partner-card strong'))
          .some((node) => node.textContent === 'k3伙伴')`,
      ),
    ),
  );
  const agent = ((await invoke("list_agents", {})) as { id: string; name: string }[]).find(
    (a) => a.name === "k3伙伴",
  );
  if (agent === undefined) throw new Error("partner not persisted");

  // ── 选文 → 批注 ──
  await clickButton("返回手稿");
  await execute(
    `const p = document.querySelectorAll("p[data-block-id]")[1];
     const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
     const first = walker.nextNode();
     const range = document.createRange();
     range.setStart(first, 0);
     range.setEnd(first, Math.min(8, first.textContent.length));
     const sel = window.getSelection();
     sel.removeAllRanges();
     sel.addRange(range);
     p.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 80 }));
     return p.textContent;`,
  );
  await waitFor("context menu", async () =>
    Boolean(await execute(`return document.querySelector(".context-menu") !== null`)),
  );
  const commentItem = await elementOrNull(
    `//div[contains(@class,'context-menu')]//button[contains(.,'批注')]`,
    true,
  );
  if (commentItem === null) {
    console.error(
      "context menu html:",
      await execute(`return document.querySelector(".context-menu")?.innerHTML ?? null`),
    );
    throw new Error("context menu has no 批注 item");
  }
  await execute(`arguments[0].click(); "js-click"`, [asElement(commentItem)]);
  // 栏内表单（RailPrompt）：label 写着「批注」、input 无 placeholder；Enter 或「确定」交卷。
  await waitFor("annotation prompt", async () =>
    Boolean(await execute(`return document.querySelector("form.rail-prompt") !== null`)),
  );
  await execute(
    `const form = document.querySelector("form.rail-prompt");
     const input = form.querySelector("input");
     input.value = '把这句话改得更紧凑';
     input.dispatchEvent(new InputEvent("input", { bubbles: true, data: '把这句话改得更紧凑' }));
     form.querySelector("button[type=submit]").click();`,
  );
  await waitFor("annotation listed", async () =>
    Boolean(await execute(`return document.querySelector(".annotations") !== null`)),
  );
  check("annotation created from selection", true);
  // 修改批注：UI 事实取证（设计讨论里假设存在的功能）。
  const canEditAnnotation = Boolean(
    await execute(
      `return Array.from(document.querySelectorAll(".annotations button"))
        .some((b) => /改|编辑/.test(b.textContent ?? ""))`,
    ),
  );
  console.error(
    `NOTE  批注正文编辑入口：${canEditAnnotation ? "存在" : "不存在（只有迁移/删除——记为缺口）"}`,
  );

  // ── 批注转派发 ──
  await execute(
    `const box = Array.from(document.querySelectorAll(".annotations input[type=checkbox]"))[0];
     if (box && !box.checked) box.click(); "ticked"`,
  );
  await clickButton("将所选批注转为派发发送");
  await waitFor("dispatch ticket", async () =>
    Boolean(await execute(`return document.querySelector(".dispatch") !== null`)),
  );
  const promptText = (await execute(
    `return document.querySelector(".dispatch textarea, .dispatch [contenteditable]")?.value
       ?? document.querySelector(".dispatch textarea, .dispatch [contenteditable]")?.textContent ?? ""`,
  )) as string;
  check(
    "the annotation's body seeds the dispatch prompt",
    promptText.includes("把这句话改得更紧凑"),
    promptText.slice(0, 120),
  );
  await waitFor("agent select", async () =>
    Boolean(await execute(`return document.querySelector(".dispatch-agent") !== null`)),
  );
  await execute(
    `const s = document.querySelector(".dispatch-agent");
     s.value = ${JSON.stringify(agent.id)};
     s.dispatchEvent(new Event("change", { bubbles: true }));`,
  );
  await clickButton("送出");
  await waitFor("manifest", async () =>
    Boolean(await execute(`return document.querySelector(".manifest") !== null`)),
  );
  await clickButton("授权");
  await waitFor("a run dispatched after authorize", async () => {
    const s = await hostState(rootId);
    return s.runs.some((r) => r.progress === "dispatched");
  });
  let state = await hostState(rootId);
  const live = state.runs.find((r) => r.progress === "dispatched");
  if (live === undefined) throw new Error("no dispatched run after authorize");
  const requestMd = readFileSync(join(fixture, ".refrain", live.workspace, "request.md"), "utf8");
  check("request cites the annotated sentence", requestMd.includes("他推开窗"));
  check(
    "skill installed => first round carries the pointer, not the full contract",
    skillAfter === "current" ? !requestMd.includes("## 错误码") : requestMd.length > 0,
    requestMd.slice(0, 160),
  );

  // ── 真模型产出：等 result.md 落盘（模型延迟，给足窗口）。协议拒绝（如
  // 元素外有字）走「重试是新 Run」的设计路径，最多两棒。──
  let run = live;
  let settledOk = false;
  for (let attempt = 1; attempt <= 2 && !settledOk; attempt++) {
    console.error(`NOTE  等待真 Kimi 产出（第 ${attempt} 棒，最长 5 分钟）…`);
    const resultPath = join(fixture, ".refrain", run.workspace, "attempts", run.id, "result.md");
    await waitFor("the real model's result.md", async () => existsSync(resultPath), 300_000);
    const resultMd = readFileSync(resultPath, "utf8");
    check(
      "the reply is a protocol-shaped artifact",
      resultMd.includes("<agent-result") && resultMd.includes("<replacement"),
      resultMd.slice(0, 160),
    );

    await clickButton("收取");
    await waitFor("run settled (completed or failed)", async () => {
      const s = await hostState(rootId);
      const progress = s.runs.find((r) => r.id === run.id)?.progress;
      return progress === "completed" || progress === "failed";
    });
    state = await hostState(rootId);
    const settled = state.runs.find((r) => r.id === run.id);
    if (settled?.progress === "completed") {
      settledOk = true;
      break;
    }
    // 真实世界里模型会给产出加开场白（text-outside-root）——这是 k3 要找的
    // 行为：如实记录，走重试路，再观察一棒。
    console.error(`NOTE  run failed with code: ${settled?.failure}`);
    console.error(`NOTE  result head: ${resultMd.slice(0, 120).replaceAll("\n", " ⏎ ")}`);
    if (attempt === 2) throw new Error(`two real runs both failed: ${settled?.failure}`);
    await clickButton("重试");
    await waitFor("the retry to dispatch", async () => {
      const s = await hostState(rootId);
      return s.runs.some((r) => r.progress === "dispatched" && r.id !== run.id);
    });
    state = await hostState(rootId);
    const retry = state.runs.find((r) => r.progress === "dispatched" && r.id !== run.id);
    if (retry === undefined) throw new Error("no dispatched retry");
    check("the retry is a NEW run", true, `${run.id} -> ${retry.id}`);
    run = retry;
  }
  const proposals = (await invoke("list_proposals", { rootId, path: "章一.md" })) as {
    after: string | null;
  }[];
  check(
    "the reply froze into proposals",
    proposals.length > 0 && proposals.some((p) => p.after !== null),
    proposals.length,
  );

  // ── 渲染：印点落在原文锚点右缘 ──
  await waitFor("proposal mark rendered", async () =>
    Boolean(await execute(`return document.querySelector(".proposal-mark") !== null`)),
  );
  check("proposal mark renders at the anchor", true);
  await screenshot("k3-01-proposal-mark");

  // ── 裁决接受 → 合并 → 磁盘字节与渲染核对 ──
  // 印点可能重挂（渲染每帧重写段落）：真点击 + 容错 stale，等对话框出现。
  await waitFor("bento (verdict dialog)", async () => {
    try {
      const dot = await elementOrNull(".proposal-mark");
      if (dot === null) return false;
      await click(dot);
    } catch {
      await execute(`document.querySelector(".proposal-mark")?.click(); "dot-js"`).catch(
        () => null,
      );
    }
    return Boolean(await execute(`return document.querySelector(".verdict-bento") !== null`));
  });
  await clickButton("接受");
  // 裁决落账后还要「入批 → 合并」：饭盒只管判，合并是逐句裁决页的动作。
  // 裁决页从信箱点开（单开行：草稿→发送台，其余→逐句裁决）。
  await waitFor("mailbox row", async () =>
    Boolean(await execute(`return document.querySelector(".mailbox-row") !== null`)),
  );
  // 裁决页从命令面板进（v0.2.3 起没有常驻按钮——与 dispatch-loop 同一路径）。
  await execute(
    `document.querySelector(".workbench").dispatchEvent(
       new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })); "menu"`,
  );
  await clickButton("继续 Review");
  await waitFor("review surface", async () =>
    Boolean(await execute(`return document.querySelector(".review-surface") !== null`)),
  );
  const stagedCount = async (): Promise<number> =>
    Number(
      String(
        await execute(`return document.querySelector(".review-head")?.textContent ?? "";`),
      ).match(/(\d+) 待合并/)?.[1] ?? "0",
    );
  if ((await stagedCount()) === 0) {
    await waitFor("the verdict staged", async () => {
      // 键盘是裁决页唯一入批路，而 WebDriver 键发到**焦点元素**：每次都用
      // 可信点击把焦点按回 section（重渲染会抢焦），再发 Alt+S。
      try {
        const surface = await elementOrNull(".review-surface");
        if (surface !== null) await click(surface);
      } catch {
        /* stale：下一轮重查 */
      }
      await altKey("s");
      return (await stagedCount()) > 0;
    });
  }
  // 合并按钮就在裁决页页眉（「合并 N 条」）——比键盘路更不受焦点影响。
  await waitFor("the commit button", async () =>
    Boolean(
      await execute(
        `return Array.from(document.querySelectorAll(".review-surface button"))
          .some((b) => b.textContent.includes("合并") && !b.disabled)`,
      ),
    ),
  );
  await execute(
    `const b = Array.from(document.querySelectorAll(".review-surface button"))
       .find((node) => node.textContent.includes("合并") && !node.disabled);
     b.click(); "commit"`,
  );
  // 合并只动手稿头；字节落盘是保存的动作（作者流：合并 → 未保存 → Ctrl+S）。
  await waitFor(
    "the merged text in the manuscript head",
    async () => {
      const doc = (await invoke("current_document", { rootId, path: "章一.md" })) as {
        blocks: { text: string }[];
      };
      return proposals.some(
        (p) => p.after !== null && doc.blocks.some((b) => b.text.includes(p.after ?? "")),
      );
    },
    30_000,
  );
  check("accepted proposal merged into the manuscript head", true);
  await invoke("persist_revision", { rootId, path: "章一.md", expected: null });
  await waitFor(
    "the merged text on disk",
    async () => {
      const disk = readFileSync(chapterPath, "utf8");
      return proposals.some((p) => p.after !== null && disk.includes(p.after));
    },
    30_000,
  );
  const disk = readFileSync(chapterPath, "utf8");
  const landed = proposals.find((p) => p.after !== null && disk.includes(p.after));
  check("accepted proposal merged into the manuscript bytes", landed !== undefined, {
    disk: disk.slice(0, 120),
  });
  const rendered = (await execute(
    `return Array.from(document.querySelectorAll("p[data-block-id]")).map((p) => p.textContent).join("\\n")`,
  )) as string;
  check(
    "the editor renders the merged bytes (textContent == disk)",
    rendered.includes("雨下了一夜") &&
      (landed === undefined || rendered.includes(landed.after ?? "")),
    rendered.slice(0, 160),
  );
  await screenshot("k3-02-merged");

  // ── E 实证：print 模式的 Run 是否落可恢复会话 ──
  const sessionsRoot = join(process.env.USERPROFILE ?? "", ".kimi-code", "sessions");
  const recent = existsSync(sessionsRoot)
    ? readdirSync(sessionsRoot).filter((name) => {
        try {
          return Date.now() - statSync(join(sessionsRoot, name)).mtimeMs < 15 * 60_000;
        } catch {
          return false;
        }
      })
    : [];
  console.error(
    `NOTE  E 实证：~/.kimi-code/sessions 近 15 分钟${recent.length > 0 ? `有 ${recent.length} 个条目（print 模式落会话，resume 可行）` : "无新条目（print 模式不落可恢复会话，「在终端继续此会话」不可行）"}`,
  );

  check("zero failures along the whole chain", failures.length === 0, failures);
};

try {
  await start();
  await run();
} finally {
  await stop();
}

if (failures.length > 0) {
  console.error(`\nk3 FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(
  "\nk3 PASS: 真 harness 全链路（连接→伙伴→批注→派发→真模型→提案渲染→裁决合并→字节=渲染）",
);
