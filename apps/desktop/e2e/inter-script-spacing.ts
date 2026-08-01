// 门禁：中西混排间距必须画得出来，而且不能碰作者的字节和光标。
//
// 这道门禁存在的理由是一次实测：`packages/editor` 88 条单元测试全绿，切分
// 函数的六条断言也全绿，而真正渲染出来的页面上**一个间距元素都没有**。
// 单元测试问的是「切分对不对」，它答对了；没有人问「画出来没有」。
//
// 三条断言对应三种会真正伤到作者的坏法：
//
// 1. **间距没画出来** — 中西文挤在一起，和别的段落长得不一样。
// 2. **字节被改了** — 插入的是空白字符而不是空元素，于是 textContent 变了。
//    磁盘、digest、Source Backup、agent 引用的块区间会跟着全变，而作者从没
//    敲过那个字符。这是这个项目最不能接受的一类改动。
// 3. **光标跳了** — 间距元素若能被光标停进去，作者会遇到一个按方向键不动
//    的位置，而它在屏幕上是空白，看不出为什么。
//
// 语料必须**中英之间不留空格**。第一版写的是「他在 Notebook 上」，引擎正确
// 地判定作者已经手动隔开、无需插入，于是量到 0 个间距——那与功能失效的读数
// 完全相同。语料没有区分力时，门禁量不到任何东西却照样通过。
//
// ## 注入验证的实测记录，含一条没能单独验证的
//
// 四个方向注入，三个干净变红：
//
// | 注入 | 结果 |
// |---|---|
// | 完全不插间距 | 红：「一个间距元素也没有」 |
// | 去掉 contenteditable=false | 红：「光标会停进一个看不见的空白里」 |
// | 每个字符之间都插 | 红：「有 34 个，语料的边界是 4 处」+「纯中文块里出现了 21 个」 |
// | **额外插入一个 U+2009 空白字符** | 红，但**报的是「一个间距元素也没有」** |
//
// 最后一条没有按预期报「字节被改了」。查下来原因是产品的自我保护：多出的
// 空白字符使段落的 textContent 与编辑器模型里的文本不符，视图检测到不一致
// 就把整段重画成纯文本，于是间距元素连同那个字符一起消失，先触发的是数量
// 断言。
//
// 也就是说「字节不变」这条断言**目前只被间接验证过**：真要破坏字节，得先
// 绕过视图的一致性检查，而那已经是另一个缺陷了。这条如实记在这里，而不是
// 假装四个方向都干净变红——一条没被证明能红的断言，就是一条还不知道有没有
// 用的断言。

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

/** 中英直接相邻，没有作者自己打的空格。四处 script 边界。 */
const MIXED = "他在Notebook上写下42，改成forty-two，最后写回汉字。";
/** 纯中文：不该产生任何间距元素。反向断言，防止规则变成「到处都插」。 */
const PURE = "这一段是纯中文的正文，不该出现任何间距元素。";
/**
 * 连续全角标点：每一对都该被压掉半个字身。
 *
 * 五对相邻标点（`、。`/`。！`/`！？`/`？；`/`；：`）。选这个形状是因为挤压
 * 规则真正被判定的就是「两个相邻的全角标点」——CLREQ §6.3.2 说的是原占 2 字
 * 压到 1.5 字宽，不按开闭分类。
 */
const SQUEEZE = "、。！？；：";

const html = `<!doctype html>
<meta charset="utf-8">
<html lang="zh-Hans">
<style>
  body{margin:0}
  /* 与 surfaces.css 的正文同款：浏览器自带的挤压必须关掉，否则它与自研挤压
     叠加，每对压掉一整个字身而不是半个。门禁若不设这一行，量到的是两套规则
     的和，而产品里只有一套。 */
  #editor{font:100px/1.9 system-ui; text-spacing-trim: space-all}
</style>
<div id="editor"></div>
<script type="module">
  import * as editor from "/editor.js";
  window.editorApi = editor;
</script>`;
const server = await Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/editor.js") {
      return new Response(editorJavaScript, {
        headers: { "content-type": "text/javascript" },
      });
    }
    return new Response(html, { headers: { "content-type": "text/html" } });
  },
});

const failures: string[] = [];
let browser: Browser | null = null;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`, {
    waitUntil: "networkidle",
  });

  await page.evaluate(
    ([mixed, pure, squeeze]) => {
      const api = window as unknown as {
        editorApi: {
          mountEditor(
            element: HTMLElement,
            document: {
              revision: string;
              blocks: Array<{ id: string; text: string }>;
            },
            port: { submit: (action: unknown) => void },
          ): unknown;
        };
        handle: unknown;
      };
      api.handle = api.editorApi.mountEditor(
        document.getElementById("editor") as HTMLElement,
        {
          revision: "r1",
          blocks: [
            { id: "mixed", text: mixed as string },
            { id: "pure", text: pure as string },
            { id: "squeeze", text: squeeze as string },
          ],
        },
        { submit: () => undefined },
      );
    },
    [MIXED, PURE, SQUEEZE],
  );

  await page.waitForSelector('[data-block-id="mixed"]', { timeout: 15_000 });

  const measured = await page.evaluate(
    ([mixed, pure, squeeze]) => {
      const block = (id: string) =>
        document.querySelector(`[data-block-id="${id}"]`) as HTMLElement | null;
      const mixedBlock = block("mixed");
      const pureBlock = block("pure");
      const squeezeBlock = block("squeeze");
      if (mixedBlock === null || pureBlock === null || squeezeBlock === null) return null;

      const gaps = [...mixedBlock.querySelectorAll(".cjk-gap")] as HTMLElement[];

      // 挤压量必须量**渲染出来的像素**，不是引擎返回的数字——引擎那一侧本来
      // 就是对的，一直缺的是「这些数字有没有被画出来」。参照物是同一页里一个
      // 不带任何间距元素的纯文本节点：两者的差就是挤压真正生效的量。
      const reference = document.createElement("div");
      reference.style.cssText = getComputedStyle(squeezeBlock).cssText;
      reference.style.position = "absolute";
      reference.style.visibility = "hidden";
      reference.style.whiteSpace = "pre";
      reference.style.width = "auto";
      reference.style.display = "inline-block";
      reference.textContent = squeeze as string;
      squeezeBlock.parentElement?.appendChild(reference);
      const referenceWidth = reference.getBoundingClientRect().width;

      const painted = document.createElement("div");
      painted.style.cssText = reference.style.cssText;
      for (const node of [...squeezeBlock.childNodes]) painted.appendChild(node.cloneNode(true));
      squeezeBlock.parentElement?.appendChild(painted);
      const paintedWidth = painted.getBoundingClientRect().width;

      const fontSize = Number.parseFloat(getComputedStyle(squeezeBlock).fontSize);
      reference.remove();
      painted.remove();

      return {
        gapCount: gaps.length,
        gapWidths: [...new Set(gaps.map((gap) => getComputedStyle(gap).width))],
        mixedText: mixedBlock.textContent ?? "",
        mixedMatches: (mixedBlock.textContent ?? "") === (mixed as string),
        pureText: pureBlock.textContent ?? "",
        pureMatches: (pureBlock.textContent ?? "") === (pure as string),
        pureGapCount: pureBlock.querySelectorAll(".cjk-gap").length,
        allUneditable: gaps.every((gap) => gap.getAttribute("contenteditable") === "false"),
        squeezeGapCount: squeezeBlock.querySelectorAll(".cjk-gap").length,
        squeezeText: squeezeBlock.textContent ?? "",
        squeezeMatches: (squeezeBlock.textContent ?? "") === (squeeze as string),
        referenceWidth,
        paintedWidth,
        fontSize,
        caretMismatches: [] as string[],
        caretPositions: 0,
      };
    },
    [MIXED, PURE, SQUEEZE],
  );

  // 光标往返单独量：它要读 selection，与上面那段量宽度的互不相干。
  const caret = await page.evaluate(() => {
    const mixedBlock = document.querySelector('[data-block-id="mixed"]') as HTMLElement | null;
    if (mixedBlock === null) return { caretMismatches: [] as string[], caretPositions: 0 };
    const place = (offset: number) => {
      const selection = getSelection();
      if (selection === null) return;
      const range = document.createRange();
      const walker = document.createTreeWalker(mixedBlock, NodeFilter.SHOW_TEXT);
      let remaining = offset;
      let node = walker.nextNode();
      while (node !== null) {
        const length = (node.textContent ?? "").length;
        if (remaining <= length) {
          range.setStart(node, remaining);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
          return;
        }
        remaining -= length;
        node = walker.nextNode();
      }
    };
    const read = () => {
      const selection = getSelection();
      if (selection === null || selection.rangeCount === 0) return -1;
      const range = selection.getRangeAt(0);
      const probe = document.createRange();
      probe.selectNodeContents(mixedBlock);
      probe.setEnd(range.startContainer, range.startOffset);
      return probe.toString().length;
    };
    const text = mixedBlock.textContent ?? "";
    const caretMismatches: string[] = [];
    for (let offset = 0; offset <= text.length; offset += 1) {
      place(offset);
      const got = read();
      if (got !== offset) caretMismatches.push(`${offset}→${got}`);
    }
    return { caretMismatches, caretPositions: text.length + 1 };
  });
  if (measured !== null) {
    measured.caretMismatches = caret.caretMismatches;
    measured.caretPositions = caret.caretPositions;
  }

  if (measured === null) {
    failures.push("编辑器没有挂载出这两个块");
  } else {
    // 一、间距必须真的画出来。零个与「功能没接上」输出相同，所以先断样本。
    if (measured.gapCount === 0) {
      failures.push(
        `混排块里一个间距元素也没有。语料是「${MIXED}」，四处 script 边界。` +
          "这与功能完全没接上的读数相同。",
      );
    } else if (measured.gapCount !== 4) {
      failures.push(`混排块里有 ${measured.gapCount} 个间距元素，语料的 script 边界是 4 处`);
    }

    // 二、字节不变。这是全项目最硬的一条。
    if (!measured.mixedMatches) {
      failures.push(
        `混排块的 textContent 与作者写的不同：\n      作者: ${MIXED}\n      渲染: ${measured.mixedText}`,
      );
    }
    if (!measured.pureMatches) {
      failures.push("纯中文块的 textContent 被改动了");
    }

    // 三、光标不跳。
    if (measured.caretMismatches.length > 0) {
      failures.push(
        `${measured.caretPositions} 个光标位置里有 ${measured.caretMismatches.length} 个错位：` +
          measured.caretMismatches.slice(0, 6).join(" "),
      );
    }
    if (!measured.allUneditable) {
      failures.push("间距元素没有 contenteditable=false，光标会停进一个看不见的空白里");
    }

    // 四、反向：纯中文不该有间距元素，否则规则退化成「到处都插」。
    if (measured.pureGapCount !== 0) {
      failures.push(`纯中文块里出现了 ${measured.pureGapCount} 个间距元素，规则插得太宽`);
    }

    // 五、标点挤压必须真的把版面压窄，且刚好压掉半个字身。
    //
    // 引擎侧的 `measure()` 一直算得对，缺的是这些数字有没有被画出来：接线前
    // 探针实测 `「引用」，然后……` 引擎给出净调整 −0.5em、画进 DOM 的是 0em，
    // 因为渲染只收 `spaceBefore > 0`，负值被整个丢掉且不报错。
    //
    // 先断样本数：零个间距元素与「挤压完全没接上」输出相同。
    const SQUEEZE_PAIRS = 5;
    if (measured.squeezeGapCount !== SQUEEZE_PAIRS) {
      failures.push(
        `标点块里有 ${measured.squeezeGapCount} 个挤压元素，语料「${SQUEEZE}」是 ${SQUEEZE_PAIRS} 对相邻标点。` +
          "零个与挤压完全没接上的读数相同。",
      );
    } else {
      const shrunk = measured.referenceWidth - measured.paintedWidth;
      const perPair = shrunk / SQUEEZE_PAIRS;
      const expected = measured.fontSize * 0.5;
      // CLREQ §6.3.2：两个相邻标点原占 2 字，压到 1.5 字宽——也就是每对压掉
      // 半个字身。容差 1px 吸收亚像素舍入。
      if (Math.abs(perPair - expected) > 1) {
        failures.push(
          `每对相邻标点压缩了 ${perPair.toFixed(1)}px，CLREQ §6.3.2 要求半个字身即 ${expected}px。` +
            `\n      无挤压参照 ${measured.referenceWidth}px，渲染后 ${measured.paintedWidth}px。` +
            "\n      压过头通常是浏览器的 text-spacing-trim 没关，两套规则叠加。",
        );
      }
    }

    // 六、挤压同样不许碰字节。挤压是渲染派生物，不写回 `.md`。
    if (!measured.squeezeMatches) {
      failures.push(
        `标点块的 textContent 与作者写的不同：\n      作者: ${SQUEEZE}\n      渲染: ${measured.squeezeText}`,
      );
    }
  }

  if (failures.length > 0) {
    console.error("FAIL  verify:inter-script-spacing");
    for (const failure of failures) console.error(`      ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(
      `PASS  verify:inter-script-spacing  (${measured?.gapCount} 个间距 @ ${measured?.gapWidths.join(",")}，` +
        `${measured?.caretPositions} 个光标位置零错位，字节逐字不变；` +
        `${measured?.squeezeGapCount} 对标点各压 ${(((measured?.referenceWidth ?? 0) - (measured?.paintedWidth ?? 0)) / 5).toFixed(0)}px = 半字身)`,
    );
  }
} finally {
  await browser?.close();
  server.stop(true);
}
