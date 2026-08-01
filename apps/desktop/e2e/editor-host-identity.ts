// EditorHost 的文档身份门禁。
//
// 守的事实：换一份稿子时，编辑器必须重新挂载。
//
// 为什么需要一道门禁。`Workbench.tsx` 用 `<Show when={active()}>` 包住 EditorHost，
// 而切文档时 `active()` 始终非空——Solid 的 <Show> 只在条件真假翻转时重建子树，
// 于是组件实例被复用，`onMount` 不再执行。但 `props.rootId` 与 `props.path` 是
// 响应式的：编辑器还显示着旧稿，提交路径已经指向新文档。作者以为自己在改甲，
// 字落进了乙，而且带着甲的 revision。
//
// 这不是靠读代码能持续保证的事。<Show> 的重建语义是框架行为，下一个人换成
// <Switch> 或加一层 <Show> 都可能悄悄改变它，所以要有一条会变红的检查。
//
// 装置：把真的 EditorHost 组件（不是它的替身）挂进 Chromium，切换文档 props，
// 再问编辑器 DOM 里现在是谁的文本。

import { type Browser, chromium } from "playwright";
import { ensureNodeDriver } from "../../../scripts/pw-chromium.ts";

ensureNodeDriver(import.meta.url);

import { build } from "vite";
import solid from "vite-plugin-solid";

// 用产品自己的 Solid 编译路径构建装置：换一条编译路径，测的就不是产品。
const built = (await build({
  root: "apps/desktop",
  configFile: false,
  plugins: [solid()],
  logLevel: "error",
  build: {
    write: false,
    minify: false,
    lib: {
      entry: "e2e/fixtures/editor-host-entry.tsx",
      formats: ["es"],
      fileName: "entry",
    },
  },
})) as unknown as Array<{ output: Array<{ type: string; code?: string }> }>;
const chunk = built[0]?.output.find((item) => item.type === "chunk");
if (chunk?.code === undefined) throw new Error("editor host fixture produced no chunk");
const script = chunk.code;
const html = `<!doctype html>
<meta charset="utf-8">
<div id="root"></div>
<script type="module" src="/entry.js"></script>`;
const server = await Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/entry.js") {
      return new Response(script, { headers: { "content-type": "text/javascript" } });
    }
    return new Response(html, { headers: { "content-type": "text/html" } });
  },
});

let browser: Browser | null = null;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => (window as unknown as { hostReady?: boolean }).hostReady === true,
  );

  const result = await page.evaluate(async () => {
    const api = window as unknown as {
      openDocument(path: string): void;
      editorText(): string;
      submittedBase(): string | null;
      typeInto(text: string): void;
      mountCount(): number;
    };
    const first = api.editorText();
    const mountsAfterFirst = api.mountCount();

    api.openDocument("second");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const second = api.editorText();
    const mountsAfterSecond = api.mountCount();

    // 在第二份稿子里打字，问它以谁的 revision 为基。
    api.typeInto("追记");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    return {
      first,
      second,
      mountsAfterFirst,
      mountsAfterSecond,
      submittedBase: api.submittedBase(),
    };
  });

  const failures: string[] = [];
  if (!result.first.includes("第一份稿子")) {
    failures.push(`the first document never rendered (got ${JSON.stringify(result.first)})`);
  }
  if (result.second.includes("第一份稿子")) {
    failures.push(
      "switching documents left the previous manuscript on screen: the editor was not remounted",
    );
  }
  if (!result.second.includes("第二份稿子")) {
    failures.push(`the second document never rendered (got ${JSON.stringify(result.second)})`);
  }
  if (result.mountsAfterSecond <= result.mountsAfterFirst) {
    failures.push(
      `mountEditor ran ${result.mountsAfterSecond} time(s) across two documents; each document needs its own mount`,
    );
  }
  if (result.submittedBase !== "revision-second") {
    failures.push(
      `an edit in the second document was submitted against ${JSON.stringify(result.submittedBase)}; it must use that document's own revision`,
    );
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
  console.log("PASS  editor host remounts per document and submits against its own revision");
} finally {
  await browser?.close();
  server.stop(true);
}
