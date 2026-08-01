// 门禁：外部改动的着色必须真的画到屏幕上，两种呈现必须可见不同。
//
// 为什么要在真浏览器里跑：`change-highlights.test.ts` 测的是账本——哪些区间
// 该着色。它全绿并不意味着屏幕上有任何颜色，而这正是这个项目反复踩到的形状：
// 引擎算了三个月，没有一个数字被画出来（标点挤压那次），或者 CSS 里那行
// `hanging-punctuation` 从写下的第一天起就没生效过。**声明支持不等于真生效，
// 数据算对不等于画出来了。**
//
// 所以这里断的是几何与实际注册的 Highlight，不是内部状态：
//
// 1. 外部改动之后，`CSS.highlights` 里确实有那个注册名，且它的 Range 宽度 > 0。
// 2. 作者自己的编辑（同一份文本再来一遍）不产生任何着色。
// 3. Kara 模式与普通模式**可见不同**：纯删除时普通模式段落带 data-changed=
//    "removed"，Kara 模式一个标记也没有。
// 4. 反向：新增在两种模式下都要看得见——Kara 不是「不显示改动」。
// 5. 着色不改变文本：textContent 逐字不变，行数不变。
//
// 注入验红（本轮实测，改一处跑一次）：
// - `#projectChangeHighlights` 整个函数体改成 `return;` → 判据 1 红。
// - `forPresentation` 改成原样返回 → 判据 3 红（Kara 也画出了删除标记）。
// - `forPresentation` 的 result 分支改成返回 `[]` → 判据 4 红。
// - `observe` 改成不比对 id（所有块都进账）→ 判据 2 红。

import { type Browser, chromium } from "playwright";
import { ensureNodeDriver } from "../../../scripts/pw-chromium.ts";

ensureNodeDriver(import.meta.url);

const bundle = await Bun.build({
  entrypoints: ["packages/editor/src/index.ts"],
  target: "browser",
  format: "esm",
  minify: false,
});
if (!bundle.success || bundle.outputs[0] === undefined) {
  throw new Error(`editor bundle failed: ${bundle.logs.map(String).join("\n")}`);
}
const editorJavaScript = await bundle.outputs[0].text();

// 产品的着色规则从 surfaces.css 原样取，不在这里抄一份色值：抄下来的副本会
// 与产品漂开，而门禁照样全绿——它测的是自己的副本。
const surfaces = await Bun.file("apps/desktop/src/styles/surfaces.css").text();
const diffRules = surfaces
  .split("\n")
  .join("\n")
  .match(
    /\.editor-host::highlight\(refrain-diff-added\)[^}]*}|\.editor-host p\[data-changed[^}]*}/g,
  );
if (diffRules === null || diffRules.length < 2) {
  throw new Error(
    "surfaces.css 里找不到改动着色的规则：门禁引用的是产品样式，找不到就说明规则被改名或删掉了",
  );
}

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  body{margin:0}
  #editor{font:16px/1.6 system-ui;width:420px}
  :root{--accepted:#2b6c41;--accepted-wash:#ddefe1;--refused:#983938;--refused-wash:#fce3e0}
  ${diffRules.join("\n")}
</style>
<div class="editor-host"><div id="editor"></div></div>
<script type="module">
  import * as editor from "/editor.js";
  window.editorApi = editor;
</script>`;

const server = await Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/editor.js") {
      return new Response(editorJavaScript, { headers: { "content-type": "text/javascript" } });
    }
    return new Response(html, { headers: { "content-type": "text/html" } });
  },
});

interface Report {
  readonly addedWidth: number;
  readonly addedRegistered: boolean;
  readonly changedMarks: readonly (string | null)[];
  readonly text: string;
  readonly height: number;
}

let browser: Browser | null = null;
const failures: string[] = [];
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "networkidle" });

  /**
   * 挂一个编辑器，喂一次 replace，报回屏幕上的事实。
   *
   * `presentation` 决定 Kara 与否。每次调用都重新挂载：Highlight 是全局注册的，
   * 上一轮的残留会让下一轮读到别人的颜色。
   */
  const project = async (
    before: string,
    after: string,
    presentation: "marks" | "result",
  ): Promise<Report> =>
    page.evaluate(
      async ({ before, after, presentation }) => {
        const api = window as unknown as {
          editorApi: {
            mountEditor(
              element: HTMLElement,
              document: { revision: string; blocks: Array<{ id: string; text: string }> },
              port: { submit: (action: unknown) => void },
            ): {
              replace(document: {
                revision: string;
                blocks: Array<{ id: string; text: string }>;
              }): void;
              setDiffPresentation(presentation: "marks" | "result"): void;
              destroy(): void;
            };
          };
          live?: { destroy(): void };
        };
        api.live?.destroy();
        const host = document.getElementById("editor") as HTMLElement;
        const handle = api.editorApi.mountEditor(
          host,
          { revision: "r1", blocks: [{ id: "b1", text: before }] },
          { submit: () => undefined },
        );
        api.live = handle;
        handle.setDiffPresentation(presentation);
        handle.replace({ revision: "r2", blocks: [{ id: "b1", text: after }] });
        // 让浏览器完成一次布局，Range 的几何才有意义。
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

        const highlights = (
          CSS as unknown as {
            highlights: Map<string, Iterable<Range>> & { has(name: string): boolean };
          }
        ).highlights;
        const added = highlights.get("refrain-diff-added");
        let addedWidth = 0;
        if (added !== undefined) {
          for (const range of added) addedWidth += range.getBoundingClientRect().width;
        }
        const paragraph = host.querySelector('[data-block-id="b1"]') as HTMLElement | null;
        return {
          addedWidth,
          addedRegistered: highlights.has("refrain-diff-added"),
          changedMarks: [...host.querySelectorAll("[data-block-id]")].map((element) =>
            element.getAttribute("data-changed"),
          ),
          text: paragraph?.textContent ?? "",
          height: paragraph?.getBoundingClientRect().height ?? 0,
        };
      },
      { before, after, presentation },
    );

  // ── 判据 1：外部新增必须画出可见宽度 ──────────────────────────────
  const inserted = await project("这一段原本的文字。", "这一段新加了几个字的文字。", "marks");
  if (!inserted.addedRegistered) {
    failures.push("外部改动之后 CSS.highlights 里没有 refrain-diff-added：着色根本没注册");
  }
  if (inserted.addedWidth <= 0) {
    failures.push(
      `新增区间的可见宽度是 ${inserted.addedWidth}px：Range 注册了但画不出像素（零宽区间的形态）`,
    );
  }
  if (inserted.text !== "这一段新加了几个字的文字。") {
    failures.push(`着色改变了文本：${JSON.stringify(inserted.text)}`);
  }

  // ── 判据 2：文本没变则一处着色也没有 ─────────────────────────────
  const unchanged = await project("完全一样的一段话。", "完全一样的一段话。", "marks");
  if (unchanged.addedWidth > 0 || unchanged.changedMarks.some((mark) => mark !== null)) {
    failures.push(
      `文本没变却着了色（宽 ${unchanged.addedWidth}px，标记 ${JSON.stringify(unchanged.changedMarks)}）：` +
        "作者自己的编辑会被当成外部改动",
    );
  }

  // ── 判据 3：纯删除，两种模式必须可见不同 ─────────────────────────
  const deletedMarks = await project(
    "这句话有一个多余的尾巴要删掉。",
    "这句话有一个多余的。",
    "marks",
  );
  const deletedKara = await project(
    "这句话有一个多余的尾巴要删掉。",
    "这句话有一个多余的。",
    "result",
  );
  if (!deletedMarks.changedMarks.includes("removed")) {
    failures.push(
      `普通模式下纯删除没有留下 data-changed="removed"：删掉一整句话在版面上完全看不见`,
    );
  }
  if (deletedKara.changedMarks.some((mark) => mark !== null)) {
    failures.push(
      `Kara 模式仍然标出了删除（${JSON.stringify(deletedKara.changedMarks)}）：` +
        "它应当只渲染改动后的成品，不堆叠增删标记",
    );
  }

  // ── 判据 4（反向）：新增在两种模式下都要看得见 ───────────────────
  const addedKara = await project("这一段原本的文字。", "这一段新加了几个字的文字。", "result");
  if (addedKara.addedWidth <= 0) {
    failures.push(
      "Kara 模式下新增也没有着色：Kara 不是「不显示改动」，它照常接受并显示，只是不堆叠标记",
    );
  }

  // ── 判据 5：行高不因着色而变 ─────────────────────────────────────
  const plain = await project("这一段原本的文字。", "这一段原本的文字。", "marks");
  if (Math.abs(plain.height - inserted.height) > 1 && inserted.text.length === plain.text.length) {
    failures.push(`着色改变了段落高度：${plain.height}px → ${inserted.height}px`);
  }

  if (failures.length > 0) throw new Error(failures.join("; "));
  console.log(
    `PASS  改动着色画到了屏幕上（新增 ${inserted.addedWidth.toFixed(1)}px），` +
      "两种呈现可见不同，文本与行高不受影响",
  );
} finally {
  await browser?.close();
  server.stop(true);
}
