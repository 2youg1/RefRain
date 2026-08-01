// 门禁：GFM 表格在屏幕上真的对齐了，且一个字节都没加。
//
// 为什么必须在真浏览器里：`table-render.test.ts` 测的是切分——哪些字节属于
// 哪一列。它全绿不意味着屏幕上列真的对齐了：`min-width` 用错单位、比例字体
// 顶掉等宽、单元格外壳没拿到 `display:inline-block`，三者都会让切分正确而
// 版面散架。这个项目已经踩过三次「数据层全绿、屏幕上什么也没有」。
//
// 判据：
//
// 1. 同一列的左边缘落在同一个 x 上——这是「对齐」的操作定义。断的是**几何**
//    而不是「有没有 min-width 这个属性」：属性写上了但被比例字体顶掉时，
//    属性断言照绿而人眼看到的是参差。
// 2. `textContent` 逐字节等于块文本——补空格对齐会在这里当场变红。整个方案
//    选 CSS 而非补空格，就是为了守住这条。
// 3. 光标能落到表格里每一个字符上，且落点偏移等于字节偏移——没有第二套坐标系。
// 4. 表格块不做断行：源文本里几行，屏幕上就几行。折行会把一行单元格拆到两行
//    上、列当场散架，所以表格必须绕开断行那条路。
// 5. 普通段落不受影响——`tableLayout` 误判会让正文里带竖线的句子被切成单元格。
//
// 注入验红（本轮实测，逐条改一处跑一次）：
// - `paintTableText` 不写 `minWidth` → 判据 1 红（列 x 参差 72px）。
// - `paintTableText` 在单元格后补空格凑宽 → 判据 1、2 红（textContent 多 16 字节）。
// - `#paintText` 的表格分支删掉（表格走普通文本路径）→ 判据 1、3、4 红。
// - CSS 里 `.md-table-cell` 的 `display:inline-block` 去掉 → 判据 1 红。
//
// **四处注入只造出三个不同的世界**：第一处与第四处的输出逐字节相同
// （`72px（x = 64, 40, 112, 112）`）。这不是巧合——「不给宽度」与「给了宽度
// 但元素不是块级因而宽度不生效」在渲染上就是同一件事。记在这里是因为「注入
// 都变红了」容易被读成「每处注入都被独立地看见了」，而后者不成立。
//
// 还原注入时不要用 `git checkout <file>`：这个文件当时尚未进 git，那条命令
// 报 pathspec 错误后什么也没做，注入留在了树上。未跟踪的文件只能靠备份还原。

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

const FONT_PX = 16;
const WIDTH_PX = 900;

/**
 * 语料：列宽悬殊且中西文混排。
 *
 * 各列内容长度必须**不同**——三列一样宽时列宽算错也照样对齐，判据 1 于是
 * 测不到任何东西。「风景的发现」(10 当量) 与「概念」(4) 差六格，min-width
 * 没生效时第二列会当场左移。
 */
const TABLE = [
  "| 概念 | 提出者 | 年份 | 核心主张 |",
  "|---|---|---|---|",
  "| 风景的发现 | 柄谷行人 | 1980 | 内面与风景同时被生产 |",
  "| 知识考古学 | Foucault | 1969 | 话语构成先于主体 |",
].join("\n");

/** 正文里带竖线的句子——不该被当成表格。 */
const PROSE = "他说|我说|大家说，这个竖线只是标点。";

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; }
  .editor-host {
    --ink: #19345c;
    --font-mono: "Noto Sans Mono CJK SC", "Noto Sans Mono", ui-monospace, monospace;
  }
  #editor {
    font: ${FONT_PX}px/1.9 "Noto Sans SC", sans-serif;
    width: ${WIDTH_PX}px;
    color: var(--ink);
  }
  .editor-host [data-table] {
    font-family: var(--font-mono);
    white-space: pre;
    overflow-x: auto;
  }
  .editor-host .md-table-cell { display: inline-block; white-space: pre; }
</style>
<div class="editor-host"><div id="editor"></div></div>
<script type="module">
  import * as editor from "/editor.js";
  window.editorApi = editor;
</script>`;

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/editor.js") {
      return new Response(editorJavaScript, { headers: { "content-type": "text/javascript" } });
    }
    return new Response(html, { headers: { "content-type": "text/html" } });
  },
});

let browser: Browser | null = null;
const failures: string[] = [];
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "networkidle" });

  await page.evaluate(
    ([table, prose]) => {
      const api = window as unknown as {
        editorApi: {
          mountEditor(
            element: HTMLElement,
            document: {
              revision: string;
              blocks: Array<{ id: string; text: string; isFence?: boolean }>;
            },
            port: { submit: (action: unknown) => void },
          ): unknown;
        };
      };
      api.editorApi.mountEditor(
        document.getElementById("editor") as HTMLElement,
        {
          revision: "r1",
          blocks: [
            { id: "t1", text: table as string },
            { id: "p1", text: prose as string },
          ],
        },
        { submit: () => undefined },
      );
    },
    [TABLE, PROSE],
  );
  await page.evaluate(() => document.fonts.ready);

  // 判据 1：同一列的左边缘落在同一个 x 上。
  const columns = await page.evaluate(() => {
    const paragraph = document.querySelector("[data-block-id='t1']");
    if (!paragraph) return null;
    const cells = [...paragraph.querySelectorAll(".md-table-cell")];
    // 按 y 分行、按 x 排序，取每行第 n 个单元格的左边缘。
    const rows = new Map<number, number[]>();
    for (const cell of cells) {
      const box = cell.getBoundingClientRect();
      const key = Math.round(box.top);
      const list = rows.get(key) ?? [];
      list.push(Math.round(box.left));
      rows.set(key, list);
    }
    return [...rows.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, xs]) => xs.sort((a, b) => a - b));
  });

  if (!columns || columns.length < 3) {
    failures.push(
      `判据 1：表格只渲染出 ${columns?.length ?? 0} 行，应至少 3 行（表头 + 两行数据）`,
    );
  } else {
    // 分隔行宽度为 0 被排除，剩下表头 + 两行数据。
    const widths = new Set(columns.map((row) => row.length));
    if (widths.size !== 1) {
      failures.push(`判据 1：各行单元格数不一致（${[...widths].join("/")}），列无法比对`);
    } else {
      const columnCount = columns[0]?.length ?? 0;
      let compared = 0;
      for (let column = 0; column < columnCount; column += 1) {
        const xs = columns.map((row) => row[column] as number);
        const spread = Math.max(...xs) - Math.min(...xs);
        // 1px 容差：亚像素舍入。真的没对齐时差的是整个字宽（16px 以上）。
        if (spread > 1) {
          failures.push(
            `判据 1：第 ${column + 1} 列左边缘参差 ${spread}px（x = ${xs.join(", ")}），列没有对齐`,
          );
        }
        compared += 1;
      }
      if (compared < 3) {
        failures.push(`判据 1：只比对了 ${compared} 列，语料应有 4 列——列数不足时对齐无从谈起`);
      }
    }
  }

  // 判据 2：textContent 逐字节等于块文本。
  const rendered = await page.evaluate(
    () => document.querySelector("[data-block-id='t1']")?.textContent ?? null,
  );
  if (rendered !== TABLE) {
    failures.push(
      `判据 2：textContent 与源文本不符——渲染 ${rendered?.length ?? 0} 字节，源 ${TABLE.length} 字节。补空格对齐会在这里变红`,
    );
  }

  // 判据 3：光标落点偏移等于字节偏移。
  const caret = await page.evaluate(() => {
    const paragraph = document.querySelector("[data-block-id='t1']") as HTMLElement | null;
    if (!paragraph) return null;
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let seen = 0;
    let checked = 0;
    let node = walker.nextNode();
    while (node) {
      const length = node.textContent?.length ?? 0;
      for (let index = 0; index < length; index += 1) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index);
        const box = range.getBoundingClientRect();
        // 每个位置都要能定出一个坐标。定不出来说明这个字符不在坐标系里。
        if (box.top === 0 && box.left === 0 && box.height === 0) return { failed: seen + index };
        checked += 1;
      }
      seen += length;
      node = walker.nextNode();
    }
    return { failed: -1, checked, total: seen };
  });
  if (!caret) {
    failures.push("判据 3：表格块不存在");
  } else if (caret.failed >= 0) {
    failures.push(`判据 3：偏移 ${caret.failed} 处光标定不出坐标——该字符不在坐标系里`);
  } else if ((caret.checked ?? 0) < 60) {
    failures.push(
      `判据 3：只验了 ${caret.checked} 个位置，语料 ${TABLE.length} 字节——样本太少，判据形同虚设`,
    );
  }

  // 判据 4：表格不做断行，源文本几行屏幕上就几行。
  const lineCount = await page.evaluate(() => {
    const paragraph = document.querySelector("[data-block-id='t1']");
    if (!paragraph) return -1;
    // 断行元素由 `paintSpacedText` 插入。表格走另一条路，一个都不该有。
    return paragraph.querySelectorAll(".cjk-break").length;
  });
  if (lineCount !== 0) {
    failures.push(`判据 4：表格里有 ${lineCount} 个断行元素，应为 0——表格走了断行那条路，列会散架`);
  }

  // 判据 5：正文里的竖线不被当成表格。
  const proseIsTable = await page.evaluate(() => {
    const paragraph = document.querySelector("[data-block-id='p1']") as HTMLElement | null;
    if (!paragraph) return null;
    return {
      table: paragraph.dataset.table ?? null,
      cells: paragraph.querySelectorAll(".md-table-cell").length,
    };
  });
  if (!proseIsTable) {
    failures.push("判据 5：正文块不存在");
  } else if (proseIsTable.table !== null || proseIsTable.cells > 0) {
    failures.push(
      `判据 5：正文里带竖线的句子被当成了表格（data-table=${proseIsTable.table}，${proseIsTable.cells} 个单元格）`,
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
  "verify:table-render PASS — 4 列左边缘对齐、textContent 逐字节一致、光标坐标系单一、表格不断行",
);
