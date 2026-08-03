// 壳层接线的行为探针：真 Workbench、真点击、真浏览器。
//
// 为什么需要它：T1 的坏法是「模式切了而按钮上的字不变」——unit 测试能证
// 会话切了，证不了显示那半；wiring 测试读的是源码，证不了 Solid 真的重渲染。
// 同样，「右键菜单里的 转换全文标点 把整份稿子转了」与「Ctrl+Z 把它撤回来」
// 是三段接线（菜单→宿主→队列、快捷键→会话→宿主）的乘积，每一段单独测过
// 不代表乘积为真。
//
// 做法：vite 把 e2e/shell-wiring 打成一个真页面，挂上真 Workbench；
// __TAURI_INTERNALS__ 用替身喂固定事实（debug_adopt_root、open_document、
// apply_editor_action、undo_editor_action……），替身同时记账，断言读账。
// 替身之外的命令一律落进 unknown——出现非白名单命令即红，替身不会静默漏接。

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, chromium } from "playwright";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { ensureNodeDriver } from "../../../scripts/pw-chromium.ts";

ensureNodeDriver(import.meta.url);

/** 显示宽度当量：CJK 两格，与 packages/editor 的尺子一致（粗算即可，不断布局）。 */
const widthOf = (text: string): number => {
  let width = 0;
  for (const character of text) width += (character.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
  return width;
};

const block = (id: string, text: string, isFence = false) => ({
  id,
  text,
  widthUnits: widthOf(text),
  hardLines: 1,
  maxLineUnits: widthOf(text),
  isFence,
});

/** 开出来的那份稿子：可转的、围栏、URL、小数各居其位。 */
const BLOCKS = [
  block("b1", "他说,天气不错."),
  block("b2", "```\nif (a, b) { f(3.14); }\n```", true),
  block("b3", "参考 https://example.com/a,b 这个链接,别动."),
  block("b4", "圆周率 3.14 保留, 但逗号,要转."),
];

const row = (id: string, path: string, role: string) => ({
  id,
  path,
  role,
  digest: null,
  currentHead: null,
  headBlockIds: null,
  sourceDigest: null,
  sourceFormat: null,
  disclosure: null,
});

/** 页面加载前注入的 Tauri 替身。FIXTURE 由探针脚本替换进 JSON。 */
const initScript = (): string => `
window.__probe = {
  applied: [],
  undoCalls: 0,
  undone: false,
  deleted: [],
  disclosures: [],
  revertCalls: [],
  unknown: [],
  eventIds: 0,
};
(() => {
  const fixture = ${JSON.stringify({ blocks: BLOCKS, chapter: row("c-1", "第一章.md", "chapter"), materialA: row("m-a", "资料甲.md", "material"), materialB: row("m-b", "资料乙.md", "material") })};
  // 每次过桥都交出深拷贝：编辑器可能就地改块对象，共享引用会让
  // 「回读到原文」变成「回读到编辑器刚改过的同一份」。
  const fresh = (value) => JSON.parse(JSON.stringify(value));
  const state = window.__probe;
  window["refrain.e2e.pick"] = "C:\\\\probe";
  window.__TAURI_INTERNALS__ = {
    callbacks: new Map(),
    transformCallback(callback) {
      const id = this.callbacks.size + 1;
      this.callbacks.set(id, callback);
      return id;
    },
    unregisterCallback(id) {
      this.callbacks.delete(id);
    },
    runCallback() {},
    convertFileSrc: (path) => path,
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
      currentWebviewWindow: { label: "main" },
    },
    async invoke(cmd, args) {
      switch (cmd) {
        case "display_profile":
          return {
            monitor: null,
            physicalWidth: 1920,
            physicalHeight: 1080,
            scaleFactor: 1,
            refreshHz: 60,
            refreshMeasured: true,
            frameBudgetMs: 16.6,
            hairlineCssPx: 1,
          };
        case "plugin:window|is_maximized":
        case "plugin:window|is_fullscreen":
          return false;
        case "plugin:event|listen":
          state.eventIds += 1;
          return state.eventIds;
        case "plugin:event|unlisten":
          return null;
        case "debug_adopt_root":
          return {
            rootId: "root-1",
            backup: { kind: "nothingToCopy" },
            documents: [fixture.chapter, fixture.materialA, fixture.materialB],
            documentTotal: 3,
            documentCursor: null,
            openedPath: fixture.chapter.path,
          };
        case "open_document":
          return {
            // 回显请求的路径：探针要开的不止第一章——守卫测试得真的把一篇
            // 资料开进编辑器，才能说「正在编辑的文档」那一条。
            document: { ...fixture.chapter, path: args.path },
            revision: "r1",
            blocks: fresh(fixture.blocks),
            stamp: { modifiedMs: "1", bytes: "1", digest: "d" },
            replayed: 0,
            staleJournal: [],
            kara: null,
          };
        case "list_annotations":
          return [];
        case "list_text_actions":
          // 新在前：a-3 是当前位置，a-2 可回档（其后 1 步），a-1 已撤回。
          return [
            {
              id: "a-3",
              ordinal: 3,
              cause: "author edit",
              createdAt: "1700000900000",
              undone: state.revertCalls.length > 0,
            },
            { id: "a-2", ordinal: 2, cause: "author edit", createdAt: "1700000800000", undone: false },
            { id: "a-1", ordinal: 1, cause: "open", createdAt: "1700000000000", undone: true },
          ];
        case "revert_to_action":
          state.revertCalls.push(args.actionId);
          return {
            revision: "r0",
            transitions: [{ revision: "r0", actionId: "a-3", touchedBlocks: ["b1", "b4"] }],
            undone: ["a-3"],
          };
        case "host_state":
          return { tasks: [], runs: [], recoveryRequired: [], awaitingLaunch: [] };
        case "kara_state":
          return { state: { kind: "off" }, autoEntry: "pending", queued: [] };
        case "review_state":
          return { proposals: [], verdicts: [], cursor: 0, batch: [] };
        case "mailbox_standings":
          return [];
        case "apply_editor_action":
          state.applied.push(args.action);
          return { revision: "r2", actionId: "a-2", touchedBlocks: [] };
        case "undo_editor_action":
          state.undoCalls += 1;
          if (state.undoCalls === 1) {
            state.undone = true;
            return { revision: "r1", actionId: "a-1", touchedBlocks: ["b1", "b4"] };
          }
          throw {
            code: "io",
            action: "undo the last action",
            subject: args.path,
            detail: "there is no Text Action to undo",
            recovery: [],
          };
        case "current_document":
          state.currentCalls = (state.currentCalls ?? 0) + 1;
          return state.undone
            ? { revision: "r1", blocks: fresh(fixture.blocks) }
            : { revision: "r2", blocks: fresh(fixture.blocks) };
        case "project":
          if (args.input.kind === "deleteDocument") {
            state.deleted.push(args.input.value.path);
            return {
              kind: "deleted",
              value:
                args.input.value.path === fixture.materialA.path
                  ? fixture.materialA
                  : fixture.materialB,
            };
          }
          if (args.input.kind === "setDisclosure") {
            state.disclosures.push([args.input.value.path, args.input.value.disclosure]);
            return {
              kind: "disclosureSet",
              value: { ...fixture.materialB, disclosure: args.input.value.disclosure },
            };
          }
          state.unknown.push("project:" + args.input.kind);
          return null;
        default:
          state.unknown.push(cmd);
          return null;
      }
    },
  };
})();
`;

const outDir = mkdtempSync(join(tmpdir(), "refrain-shell-wiring-"));
const failures: string[] = [];
let browser: Browser | null = null;

try {
  // 入口打成 lib 而不是页面：verify:text-surface 把 .html 当散文审批，
  // 探针的 HTML 由下面的服务器现写，不进仓库。
  await build({
    root: resolve("apps/desktop"),
    configFile: false,
    logLevel: "warn",
    plugins: [solid()],
    build: {
      outDir,
      emptyOutDir: true,
      target: "chrome120",
      minify: false,
      lib: {
        entry: resolve("apps/desktop/e2e/shell-wiring/main.tsx"),
        formats: ["es"],
        fileName: () => "main.js",
      },
    },
  });

  const asset = (suffix: string): string | null => {
    for (const dir of [outDir, join(outDir, "assets")]) {
      if (!existsSync(dir)) continue;
      const found = readdirSync(dir).find((file) => file.endsWith(suffix));
      if (found !== undefined) return join(dir, found);
    }
    return null;
  };
  const cssAsset = asset(".css");
  const html = `<!doctype html>
<meta charset="utf-8">
${cssAsset === null ? "" : '<link rel="stylesheet" href="/style.css">'}
<div id="app"></div>
<script type="module" src="/main.js"></script>`;

  const server = await Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
      if (path === "/style.css" && cssAsset !== null) {
        return new Response(readFileSync(cssAsset), { headers: { "content-type": "text/css" } });
      }
      const file = join(outDir, path);
      if (!existsSync(file)) return new Response("not found", { status: 404 });
      const type = path.endsWith(".js")
        ? "text/javascript"
        : path.endsWith(".woff2")
          ? "font/woff2"
          : "text/plain";
      return new Response(readFileSync(file), { headers: { "content-type": type } });
    },
  });

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on("console", (message) => console.log(`[page:${message.type()}] ${message.text()}`));
    page.on("pageerror", (error) => console.log(`[pageerror] ${error.message}`));
    await page.addInitScript(initScript());
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "networkidle" });

    // —— T1：精度按钮真的翻转 ——
    await page.getByRole("button", { name: "打开文件夹" }).click();
    const mode = page.locator(".search-mode");
    await mode.waitFor();
    const before = {
      text: await mode.textContent(),
      pressed: await mode.getAttribute("aria-pressed"),
    };
    if (before.text !== "精确" || before.pressed !== "false") {
      failures.push(`T1：初始精度按钮应是 精确/false，实为 ${before.text}/${before.pressed}`);
    }
    await mode.click();
    const after = {
      text: await mode.textContent(),
      pressed: await mode.getAttribute("aria-pressed"),
    };
    if (after.text !== "模糊" || after.pressed !== "true") {
      failures.push(
        `T1：点击后按钮应翻转为 模糊/true，实为 ${after.text}/${after.pressed}——模式切了而显示没跟上（裸 getter）`,
      );
    }

    // —— 打开一篇资料：T6 要「正在编辑的文档」是它；T3/T4 只认块，认不出是哪篇 ——
    await page.getByRole("button", { name: "资料乙.md", exact: true }).click();
    await page.locator("[data-block-id='b1']").waitFor();

    // —— T6：正在编辑的文档不能移入回收站（禁用，原因写上，点了也不发出删除） ——
    await page.getByRole("button", { name: "资料乙.md", exact: true }).click({ button: "right" });
    const trash = page.getByRole("menuitem", { name: "移入回收站" });
    if (await trash.isEnabled()) {
      failures.push("T6：正在编辑的文档，「移入回收站」必须禁用");
    }
    const guardMenuText = await page.locator(".mailbox-menu").textContent();
    if (!guardMenuText?.includes("先关闭正在编辑的文档")) {
      failures.push(`T6：禁用原因应写在菜单上，实为 ${JSON.stringify(guardMenuText)}`);
    }
    await trash.click({ force: true });
    const deletedAfterGuard = await page.evaluate(
      () => (window as unknown as { __probe: { deleted: string[] } }).__probe.deleted.length,
    );
    if (deletedAfterGuard !== 0) {
      failures.push("T6：禁用项被点后仍发出了 Project/DeleteDocument");
    }
    // 菜单在指针离开书架时收拢：挪走再开下一段。
    await page.mouse.move(8, 8);

    // —— T3：右键菜单的 转换全文标点 ——
    await page.locator("[data-block-id='b1']").click({ button: "right" });
    await page.getByRole("menuitem", { name: "转换全文标点" }).click();
    await page.waitForFunction(() => {
      const state = (window as unknown as { __probe: { applied: unknown[] } }).__probe;
      return state.applied.length === 1;
    });
    const converted = await page.evaluate(() => ({
      b1: document.querySelector("[data-block-id='b1']")?.textContent,
      b2: document.querySelector("[data-block-id='b2']")?.textContent,
      b3: document.querySelector("[data-block-id='b3']")?.textContent,
      b4: document.querySelector("[data-block-id='b4']")?.textContent,
      changes: (
        window as unknown as {
          __probe: { applied: { changes: { kind: string; value: { blocks: string[] } }[] }[] };
        }
      ).__probe.applied[0]?.changes,
    }));
    if (converted.b1 !== "他说，天气不错。")
      failures.push(`T3：b1 应转为全角，实为 ${converted.b1}`);
    if (converted.b2 !== "```\nif (a, b) { f(3.14); }\n```") {
      failures.push(`T3：围栏被动了：${JSON.stringify(converted.b2)}`);
    }
    if (converted.b3 !== "参考 https://example.com/a,b 这个链接,别动.") {
      failures.push(`T3：URL 所在块被动了：${JSON.stringify(converted.b3)}`);
    }
    if (converted.b4 !== "圆周率 3.14 保留， 但逗号，要转。") {
      failures.push(`T3：b4 应只转两个逗号、留住 3.14，实为 ${JSON.stringify(converted.b4)}`);
    }
    const touched = new Set(
      (converted.changes ?? [])
        .filter((change) => change.kind === "replace")
        .flatMap((change) => change.value.blocks),
    );
    if (touched.size !== 2 || !touched.has("b1") || !touched.has("b4")) {
      failures.push(`T3：一次动作应只覆盖 b1 与 b4，实为 ${[...touched].join("/")}`);
    }

    // —— T4：Ctrl+Z 撤回整次转换；再按一次说出「没有可撤销的一步」 ——
    await page.keyboard.press("Control+z");
    await page.waitForFunction(() => {
      const state = (window as unknown as { __probe: { undoCalls: number } }).__probe;
      return state.undoCalls === 1;
    });
    try {
      await page.waitForFunction(
        () => {
          return document.querySelector("[data-block-id='b1']")?.textContent === "他说,天气不错.";
        },
        undefined,
        { timeout: 5000 },
      );
    } catch {
      const dump = await page.evaluate(() => ({
        probe: (window as unknown as { __probe: Record<string, unknown> }).__probe,
        blocks: [...document.querySelectorAll("[data-block-id]")].map((el) => ({
          id: el.getAttribute("data-block-id"),
          text: el.textContent,
          visible: (el as HTMLElement).offsetParent !== null,
        })),
        notice: document.querySelector(".notice")?.textContent ?? null,
      }));
      console.log("UNDO DUMP:", JSON.stringify(dump, null, 1));
      throw new Error("undo did not revert b1");
    }
    const reverted = await page.evaluate(
      () => document.querySelector("[data-block-id='b4']")?.textContent,
    );
    if (reverted !== "圆周率 3.14 保留, 但逗号,要转.") {
      failures.push(`T4：撤销后 b4 应回到原文，实为 ${JSON.stringify(reverted)}`);
    }
    await page.keyboard.press("Control+z");
    await page.waitForFunction(() => {
      return document.querySelector(".notice")?.textContent?.includes("没有可撤销的一步") ?? false;
    });

    // —— T5：资料行右键 ——
    await page.getByRole("button", { name: "资料甲.md", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "移入回收站" }).click();
    await page.getByRole("menuitem", { name: "确认移入回收站？" }).click();
    await page.waitForFunction(() => {
      const state = (window as unknown as { __probe: { deleted: string[] } }).__probe;
      return state.deleted.length === 1;
    });
    const afterDelete = await page.evaluate(() => ({
      deleted: (window as unknown as { __probe: { deleted: string[] } }).__probe.deleted,
      gone: [...document.querySelectorAll(".shelf button")].every(
        (button) => button.textContent !== "资料甲.md",
      ),
    }));
    if (afterDelete.deleted[0] !== "资料甲.md" || !afterDelete.gone) {
      failures.push(
        `T5：Project/DeleteDocument 应收到 资料甲.md 且行消失，实为 ${afterDelete.deleted.join("/")}，行消失=${afterDelete.gone}`,
      );
    }
    await page.getByRole("button", { name: "资料乙.md", exact: true }).click({ button: "right" });
    // 留证：菜单的样子（两步确认句未出现时的初始态、范围三态与默认标记）。
    mkdirSync("probe-results", { recursive: true });
    await page.screenshot({ path: "probe-results/shell-menu.png" });
    await page.getByRole("menuitemradio", { name: "全文" }).click();
    await page.waitForFunction(() => {
      const state = (window as unknown as { __probe: { disclosures: string[][] } }).__probe;
      return state.disclosures.length === 1;
    });
    const disclosure = await page.evaluate(
      () => (window as unknown as { __probe: { disclosures: string[][] } }).__probe.disclosures[0],
    );
    if (disclosure?.[0] !== "资料乙.md" || disclosure[1] !== "full") {
      failures.push(
        `T5：Project/SetDisclosure 应收到 (资料乙.md, full)，实为 ${JSON.stringify(disclosure)}`,
      );
    }

    // —— T7：历史面板的两步回档 ——
    await page.getByRole("button", { name: "历史" }).click();
    await page.locator(".history li").first().waitFor();
    const historyBefore = await page.evaluate(() => ({
      rows: document.querySelectorAll(".history li").length,
      undone: document.querySelectorAll(".history li.undone").length,
      first: document.querySelector(".history li")?.textContent ?? "",
      hint: document.querySelector(".history-hint")?.textContent ?? null,
      currentCalls:
        (window as unknown as { __probe: { currentCalls?: number } }).__probe.currentCalls ?? 0,
    }));
    if (historyBefore.rows !== 3 || historyBefore.undone !== 1) {
      failures.push(
        `T7：历史应列出 3 行、其中 1 行已撤回，实为 ${historyBefore.rows} 行 / ${historyBefore.undone} 行已撤回`,
      );
    }
    if (!historyBefore.first.includes("编辑") || !historyBefore.first.includes("当前位置")) {
      failures.push(
        `T7：第一行应是「编辑 · 当前位置…」，实为 ${JSON.stringify(historyBefore.first)}`,
      );
    }
    if (historyBefore.hint === null) {
      failures.push("T7：文档有未落盘改动，「已撤回标记保存时才更新」的提示应在场");
    }
    // 第一下立确认：确认句说清代价——其后还有几步将被撤回。
    await page.locator(".history li").nth(1).locator("button.history-row").click();
    const confirmText = await page.locator(".history .revert-confirm").textContent();
    if (!confirmText?.includes("将撤销其后 1 步，回到这一步之后。")) {
      failures.push(`T7：确认句应说清代价，实为 ${JSON.stringify(confirmText)}`);
    }
    // 第二下真的回档：桥收到 a-2，落点回读确认头，a-3 在视图里标为已撤回。
    await page.getByRole("button", { name: "确认回档" }).click();
    await page.waitForFunction(() => {
      const state = (window as unknown as { __probe: { revertCalls: string[] } }).__probe;
      return state.revertCalls.length === 1;
    });
    await page.waitForFunction(() => document.querySelectorAll(".history li.undone").length === 2);
    const historyAfter = await page.evaluate(() => ({
      revertCalls: (window as unknown as { __probe: { revertCalls: string[] } }).__probe
        .revertCalls,
      currentCalls:
        (window as unknown as { __probe: { currentCalls?: number } }).__probe.currentCalls ?? 0,
    }));
    if (historyAfter.revertCalls[0] !== "a-2") {
      failures.push(`T7：revert_to_action 应收到 a-2，实为 ${historyAfter.revertCalls.join("/")}`);
    }
    if (historyAfter.currentCalls <= historyBefore.currentCalls) {
      failures.push("T7：回档落点应回读确认头——current_document 未被再调");
    }
    await page.screenshot({ path: "probe-results/shell-history.png" });

    // 替身之外没有第二个世界：出现白名单之外的桥命令即红。
    const unknown = await page.evaluate(
      () => (window as unknown as { __probe: { unknown: string[] } }).__probe.unknown,
    );
    if (unknown.length > 0) failures.push(`替身之外的桥命令：${unknown.join(", ")}`);

    mkdirSync("probe-results", { recursive: true });
    await page.screenshot({ path: "probe-results/shell-wiring.png", fullPage: true });
  } finally {
    await browser?.close();
    server.stop(true);
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(failures.map((line) => `  ✗ ${line}`).join("\n"));
  process.exit(1);
}
console.log(
  "probe:shell-wiring PASS — 精度按钮点击翻转、编辑中的文档禁入回收站、转换全文标点（围栏/URL/3.14 不动）、Ctrl+Z 撤回与拒绝公告、资料行回收站与范围、历史面板两步回档",
);
