// 门禁：设置搜索真的到达了用户，且只导航不写值。
//
// 为什么必须在真浏览器里：`settings-tree.test.ts` 测的是 `findSettings` 这个
// 函数——给它一个词，它返回哪些叶子。那些测试全绿了整整一版，而 `SettingsSurface`
// 里「搜索」二字出现 0 次：能力从设计到实现从未到达界面。函数正确与用户拿得到
// 是两件事，只有渲染能分辨。
//
// 判据：
//
// 1. 搜索框真的在屏幕上且有像素（宽高 > 0）。断几何不断元素存在：
//    `display:none` 的输入框在 querySelector 眼里一样在。
// 2. 输入一个词能出命中，且命中数少于全部叶子——搜索要真的在筛。
// 3. 点命中会切到那一项所在的分类页。这是它唯一的用户价值。
// 4. **不写值**：整个搜索过程零次桥调用。`settings-tree.ts` 的纪律是「只
//    导航不写值」，一个能顺手改值的搜索框会在作者只想看看某项在哪的时候
//    把他调好的东西改掉。
// 5. 空查询不出列表——否则一打开就糊一屏。
// 6. 搜不到的词给一句明确的话，不是空白。
//
// 注入验红（本轮实测，逐条改一处跑一次，报错文字各不相同）：
// - `findSettings` 恒返回全部叶子 → 判据 2、3 红（并被「语料无区分力」先拦下）。
// - `onJump` 改成空函数 → 判据 3 红。
// - 空查询也渲染列表 → 判据 5 红。
//
// **这道门禁测不到的那件事，以及为什么**：把 `<SettingsSearch>` 从
// `SettingsSurface` 的渲染里整个删掉，这里照样全绿（实测）。因为夹具直接挂
// `SettingsSearch`，绕过了 `SettingsSurface`——它测的是「这个组件能用」，
// 不是「这个组件接在设置界面上」。
//
// 不把夹具改成挂整个 `SettingsSurface`：那个组件一挂就要 Tauri 桥（`describe`、
// `listen`、读 Config），在 headless 里得整套替身，而替身一多，测的就成了替身。
//
// 「它确实接在界面上」由 `settings-surface-wiring.test.ts` 用源码断言守着
// ——那条便宜且直接：`SettingsSurface` 的渲染里必须出现 `<SettingsSearch`。

import { type Browser, chromium } from "playwright";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { ensureNodeDriver } from "../../../scripts/pw-chromium.ts";
import { findSettings, settingsLeaves } from "../src/shell/settings-tree.ts";

ensureNodeDriver(import.meta.url);

const failures: string[] = [];

// 先在 Node 里核对语料本身有区分力——语料选错时下面的判据会平凡通过。
const NEEDLE = "行距";
const hits = findSettings(NEEDLE);
const total = settingsLeaves().length;
if (hits.length === 0) {
  failures.push(`语料无效：「${NEEDLE}」一条都搜不到，判据 2、3 将无从谈起`);
}
if (hits.length >= total) {
  failures.push(`语料无区分力：「${NEEDLE}」命中 ${hits.length}/${total}，等于没筛`);
}

// 用产品自己的 Solid 编译路径构建装置：换一条编译路径，测的就不是产品。
// `Bun.build` 不读 tsconfig 的 `jsxImportSource`，会把 JSX 编成 React。
const built = (await build({
  root: "apps/desktop",
  configFile: false,
  plugins: [solid()],
  logLevel: "error",
  build: {
    write: false,
    minify: false,
    lib: {
      entry: "e2e/fixtures/settings-search-host.tsx",
      formats: ["es"],
      fileName: "host",
    },
  },
})) as unknown as Array<{ output: Array<{ type: string; code?: string }> }>;
const chunk = built[0]?.output.find((item) => item.type === "chunk");
if (chunk?.code === undefined) throw new Error("settings search fixture produced no chunk");
const hostJavaScript = chunk.code;

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; font: 15px/1.7 "Noto Sans SC", sans-serif; }
  :root {
    --ink: #19345c; --ink-faint: #8a97ad; --ink-ghost: #b9c0cc;
    --paper-sunk: #ebe4d5; --paper-raised: #f9f3e7;
    --rule: #dcd4c2; --rule-strong: #c8bfa8;
  }
  .settings-search { position: relative; margin-top: 34px; }
  .settings-search input {
    width: 100%; padding: 8px 12px; border: 1px solid var(--rule);
    background: var(--paper-sunk); color: var(--ink); font: inherit; font-size: 13px;
  }
  .settings-search-hits {
    position: absolute; z-index: 2; width: 100%; max-height: 260px;
    margin: 4px 0 0; padding: 4px; overflow-y: auto;
    border: 1px solid var(--rule-strong); background: var(--paper-raised); list-style: none;
  }
  .settings-search-hits button {
    display: flex; flex-direction: column; width: 100%; padding: 6px 10px;
    border: 0; background: none; color: var(--ink); font: inherit; text-align: left;
  }
  .settings-search-empty { padding: 6px 10px; color: var(--ink-faint); font-size: 12px; }
</style>
<div id="host" style="width: 420px; padding: 20px;"></div>
<script type="module">
  import "/host.js";
</script>`;

// await 在真 Bun 下是恒等（Bun.serve 同步返回），在 Windows 的 Node 驱动
// （scripts/node-gate.ts）下是必需——那里的 serve 是 async。不 await 的话，
// server 是一个 Promise，port 与 stop 都不存在。
const server = await Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/host.js") {
      return new Response(hostJavaScript, { headers: { "content-type": "text/javascript" } });
    }
    return new Response(html, { headers: { "content-type": "text/html" } });
  },
});

let browser: Browser | null = null;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // 判据 4：整个过程零次桥调用。任何 invoke 都记下来。
  const invocations: string[] = [];
  await page.exposeFunction("__recordInvoke", (command: string) => {
    invocations.push(command);
  });

  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "networkidle" });

  // 判据 1：搜索框有像素。
  const box = await page.evaluate(() => {
    const input = document.querySelector(".settings-search input");
    if (input === null) return null;
    const rect = input.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  });
  if (box === null) {
    failures.push("判据 1：屏幕上没有搜索框——能力没有到达用户");
  } else if (box.width <= 0 || box.height <= 0) {
    failures.push(`判据 1：搜索框没有像素（${box.width}×${box.height}）`);
  }

  // 判据 5：空查询不出列表。
  const emptyList = await page.evaluate(
    () => document.querySelectorAll(".settings-search-hits").length,
  );
  if (emptyList !== 0) {
    failures.push("判据 5：空查询就渲染了命中列表——一打开会糊一屏");
  }

  // 判据 2：输入能出命中，且在筛。
  await page.fill(".settings-search input", NEEDLE);
  await page.waitForSelector(".settings-search-hits", { timeout: 3000 }).catch(() => undefined);
  const shown = await page.evaluate(
    () => document.querySelectorAll(".settings-search-hits button").length,
  );
  if (shown === 0) {
    failures.push(`判据 2：搜「${NEEDLE}」屏幕上零条命中，而函数返回 ${hits.length} 条`);
  } else if (shown >= total) {
    failures.push(`判据 2：搜「${NEEDLE}」显示了 ${shown} 条（全部 ${total} 条）——没有在筛`);
  }

  // 判据 3：点命中会切页。
  const jumped = await page.evaluate(async () => {
    const first = document.querySelector(".settings-search-hits button") as HTMLElement | null;
    if (first === null) return null;
    first.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return document.getElementById("current-section")?.textContent ?? null;
  });
  if (jumped === null) {
    failures.push("判据 3：没有可点的命中");
  } else if (jumped !== "typography") {
    failures.push(`判据 3：点了「${NEEDLE}」之后停在 ${jumped}，应跳到 typography`);
  }

  // 判据 6：搜不到给一句话。
  await page.fill(".settings-search input", "zzzz不存在的项zzzz");
  await page.waitForTimeout(50);
  const emptyMessage = await page.evaluate(
    () => document.querySelector(".settings-search-empty")?.textContent ?? null,
  );
  if (emptyMessage === null || emptyMessage.trim() === "") {
    failures.push("判据 6：搜不到时是一片空白，没有告诉作者发生了什么");
  }

  // 判据 4：零桥调用。
  if (invocations.length > 0) {
    failures.push(
      `判据 4：搜索过程发生了 ${invocations.length} 次桥调用（${invocations.join(", ")}）——它应当只导航不写值`,
    );
  }
} finally {
  await browser?.close();
  server.stop(true);
}

if (failures.length > 0) {
  console.error(failures.map((line) => `  ✗ ${line}`).join("\n"));
  process.exit(1);
}
console.log(
  `verify:settings-search PASS — 搜索框在屏幕上、「${NEEDLE}」筛出 ${hits.length}/${total} 条、点击跳到对应分类、全程零桥调用`,
);
