// 门禁：标点悬挂在屏幕上真的把字符推出了版心，且只在日文预设推。
//
// 为什么必须在真浏览器里：`hanging-takeover.test.ts` 测的是 `hangEm` 这个数
// 算得对不对。它全绿只证明数据对，不证明那个字符在屏幕上动了。这个项目在
// 同一个形状上踩过三次——标点挤压算出来没画、`optimizedLineStarts` 写完零
// 调用、`hanging-punctuation` 那行 CSS 从没生效。`hangingAt` 是第四个：它在
// 产品里零调用了整整一版，调用者只有单元测试与 `verify-preset-divergence`。
//
// 判据：
//
// 1. 日文段落里存在 `.cjk-hang` 元素（接线在役）。
// 2. 挂出去的字符**相对它自己不挂时的位置**右移了 hangEm。这是「悬挂」这个
//    词的全部含义。基准是对照组而不是版心右沿——探针 `probe-hang-css.ts`
//    实测过：文本没填满行时行尾字符本来就在版心左侧，拿版心当基准会把
//    「这一行短」读成「悬挂失效」。对照组用同一段文本、同一版心、同一字体，
//    唯一的差别是有没有那个位移，所以差值只可能来自悬挂。
// 3. 其余字符的位置**不**因悬挂而变。没有这一条，「整段右移」也能过判据 2。
// 4. 中文段落一个 `.cjk-hang` 都没有（CLREQ §6.1.3，预设默认关）。
//    与判据 1 成对：只断日文有，测不出「跨语言全局开关」这个错法。
// 5. `textContent` 逐字不变——悬挂包了一个 span，文本不能因此多一个字符。
// 6. 右方向键能把光标走进被挂出去的那个字符。这一条针对一个具体的错法：
//    间距与断行元素都设了 `contenteditable="false"`，照抄到悬挂上会让光标
//    整块跳过它。**不是「写不了字」**——探针实测两种情况都能插入文本，差别
//    只在键盘导航；我最初的注释在这里说错了，是探针纠正的。
//
// 注入验红（本轮实测，逐条改一处跑一次，报错各不相同）：
// - `hangEmOf` 恒返回 0 → 判据 1 红（没有悬挂元素）。
// - `left` 改回 `marginRight` 负值 → 判据 2 红（这正是第一版的写法，实测
//   位移为 0，门禁抓到了它）。
// - `left` 的正负号反过来 → 判据 2 红（推的方向反了，缩进版心内）。
// - 忽略预设一律挂 0.5em → 判据 4 红（中文段落也出现了悬挂元素）。
// - 悬挂 span 加上 `contentEditable = "false"` → 判据 6 红（右方向键跳过它）。
//   这条第一版用手工 `setStart` 定位光标，注入时**全绿**——手工设置绕过
//   浏览器的编辑规则。改用 `Selection.modify` 走真实按键路径后才能红。

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

const FONT_PX = 17;
const MEASURE_EM = 16;
const WIDTH_PX = FONT_PX * MEASURE_EM;

/**
 * 夏目漱石《吾輩は猫である》开篇。em=16 这一档实测切出 6 行，其中 2 行的行尾
 * 是句读点——探针 `probe-hang` 量过四档，这一档可挂行最多，区分力最好。
 */
const JA_TEXT =
  "吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。吾輩はここで始めて人間というものを見た。";

/** 同样密度的中文。用来验「不该挂的一个都不挂」。 */
const ZH_TEXT =
  "我是一只猫。还没有名字。完全不知道生在何处。只记得在一个昏暗潮湿的地方喵喵地哭着。我在那里第一次见到了人这种东西。";

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; }
  .editor-host { font: ${FONT_PX}px/1.9 "Noto Sans SC", "Noto Sans JP", sans-serif; width: ${WIDTH_PX}px; }
  /* 版心之外必须能看见挂出去的字：默认 overflow 会把它裁掉，那样量到的
     右边缘会停在版心上，判据 2 就永远红——红得毫无信息。 */
  .editor-host { overflow: visible; }
</style>
<div class="editor-host" lang="ja"><div id="ja"></div></div>
<div class="editor-host" lang="zh-Hans"><div id="zh"></div></div>
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

let browser: Browser | null = null;
const failures: string[] = [];
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "networkidle" });

  await page.evaluate(
    ([jaText, zhText]) => {
      const api = window as unknown as {
        editorApi: {
          mountEditor(
            element: HTMLElement,
            document: { revision: string; blocks: Array<{ id: string; text: string }> },
            port: { submit: (action: unknown) => void },
          ): unknown;
        };
      };
      api.editorApi.mountEditor(
        document.getElementById("ja") as HTMLElement,
        { revision: "r1", blocks: [{ id: "ja1", text: jaText ?? "" }] },
        { submit: () => undefined },
      );
      api.editorApi.mountEditor(
        document.getElementById("zh") as HTMLElement,
        { revision: "r1", blocks: [{ id: "zh1", text: zhText ?? "" }] },
        { submit: () => undefined },
      );
    },
    [JA_TEXT, ZH_TEXT],
  );

  // 字体到位之后才量：fallback 与真实字体的度量不同，量早了得到的是另一套
  // 字体的行，而行不同则行尾不同。
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(
    () => (document.querySelector('[data-block-id="ja1"]')?.textContent ?? "").length > 0,
    undefined,
    { timeout: 15_000 },
  );

  const report = await page.evaluate(() => {
    const paragraphOf = (id: string) =>
      document.querySelector(`[data-block-id="${id}"]`) as HTMLElement;

    const ja = paragraphOf("ja1");
    const zh = paragraphOf("zh1");
    const hangs = [...ja.querySelectorAll(".cjk-hang")] as HTMLElement[];

    /** 逐字符量出这一段每个字符的左沿，跳过零宽的（断行元素之类）。 */
    const characterLefts = (root: HTMLElement): number[] => {
      const lefts: number[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node !== null) {
        const text = node as Text;
        for (let index = 0; index < text.length; index += 1) {
          const range = document.createRange();
          range.setStart(text, index);
          range.setEnd(text, index + 1);
          const box = range.getBoundingClientRect();
          if (box.width > 0) lefts.push(box.left - root.getBoundingClientRect().left);
        }
        node = walker.nextNode();
      }
      return lefts;
    };

    const withHang = characterLefts(ja);

    // 对照组：把每个悬挂 span 的位移关掉，重新量一次同一棵 DOM。
    //
    // 关掉再量而不是另建一个段落：另建的段落要复制字体、版心、行高、语言，
    // 任何一项抄漏都会让两组数字因为无关的原因不同，而门禁会把那读成
    // 「悬挂生效了」。同一棵 DOM 上开关同一个属性，差值只可能来自它。
    const saved = hangs.map((element) => element.style.left);
    for (const element of hangs) element.style.left = "0px";
    const withoutHang = characterLefts(ja);
    hangs.forEach((element, index) => {
      element.style.left = saved[index] ?? "";
    });

    const fontPx = Number.parseFloat(getComputedStyle(ja).fontSize);

    // 光标用**右方向键**能不能走进被挂出去的那个字符。
    //
    // 用 `Selection.modify` 而不是手工 `setStart`：手工设置绕过浏览器的编辑
    // 规则，`contenteditable="false"` 的 span 照样能被设进去，于是这条判据
    // 在注入时全绿。`modify("move","forward","character")` 走的是真实按键
    // 那条路径——实测（`probe-hang-css.ts`）关掉编辑后光标停在 `DIV:2`，
    // 开着时停在 span 的 `#text:1`。
    let caretEntersHang = false;
    const last = hangs.at(-1);
    if (last !== undefined) {
      const selection = document.getSelection();
      selection?.removeAllRanges();
      const start = document.createRange();
      const first = ja.firstChild;
      if (first !== null) {
        start.setStart(first, 0);
        start.collapse(true);
        selection?.addRange(start);
        // 一路右移到不再变化为止，看有没有一步落进悬挂 span。
        let previous = "";
        for (let step = 0; step < 400; step += 1) {
          selection?.modify("move", "forward", "character");
          const anchor = selection?.anchorNode ?? null;
          if (anchor !== null && last.contains(anchor)) {
            caretEntersHang = true;
            break;
          }
          const position = `${anchor?.nodeName}:${selection?.anchorOffset}`;
          if (position === previous) break;
          previous = position;
        }
      }
      selection?.removeAllRanges();
    }

    return {
      hangCount: hangs.length,
      hangTexts: hangs.map((element) => element.textContent ?? ""),
      withHang,
      withoutHang,
      fontPx,
      zhHangCount: zh.querySelectorAll(".cjk-hang").length,
      jaText: ja.textContent ?? "",
      zhText: zh.textContent ?? "",
      caretEntersHang,
    };
  });

  // 判据 1
  if (report.hangCount === 0) {
    failures.push("日文段落里没有任何 .cjk-hang 元素：悬挂没有接到渲染上");
  }

  // 判据 2 与判据 3 共用一组差值：开悬挂与关悬挂逐字符对拍。
  const HANG_EM = 0.5;
  if (report.withHang.length !== report.withoutHang.length) {
    failures.push(
      `开关悬挂后可见字符数不同（${report.withHang.length} vs ${report.withoutHang.length}）：位移不该增删字符`,
    );
  } else if (report.hangCount > 0) {
    const shifts = report.withHang.map((left, index) => left - (report.withoutHang[index] ?? 0));
    const expected = HANG_EM * report.fontPx;
    // 判据 2：恰好有 hangCount 个字符右移了 hangEm。
    const moved = shifts.filter((pixels) => Math.abs(pixels - expected) < 1);
    if (moved.length !== report.hangCount) {
      failures.push(
        `右移 ${expected.toFixed(1)}px 的字符有 ${moved.length} 个，应为 ${report.hangCount} 个：位移没生效或方向错了（实测位移 ${
          shifts
            .filter((n) => n !== 0)
            .map((n) => n.toFixed(1))
            .join(", ") || "全为 0"
        }）`,
      );
    }
    // 判据 3：其余字符一动不动。
    const strays = shifts.filter((pixels) => pixels !== 0 && Math.abs(pixels - expected) >= 1);
    if (strays.length > 0) {
      failures.push(
        `${strays.length} 个非悬挂字符也移动了（${strays.map((n) => n.toFixed(1)).join(", ")}px）：动的是整段而不是行尾那一个`,
      );
    }
    const stops = report.hangTexts.filter((text) => text === "。" || text === "、");
    if (stops.length !== report.hangCount) {
      failures.push(`挂出去的字符里有不是句读点的：${JSON.stringify(report.hangTexts)}`);
    }
  }

  // 判据 4
  if (report.zhHangCount !== 0) {
    failures.push(
      `中文段落里出现了 ${report.zhHangCount} 个悬挂元素：CLREQ §6.1.3 说中文横排默认不悬挂，这说明悬挂被做成了跨语言的开关`,
    );
  }

  // 判据 5
  if (report.jaText !== JA_TEXT) {
    failures.push("日文段落的 textContent 与块文本不再逐字相同：悬挂动到了文本");
  }
  if (report.zhText !== ZH_TEXT) {
    failures.push("中文段落的 textContent 与块文本不再逐字相同");
  }

  // 判据 6
  if (report.hangCount > 0 && !report.caretEntersHang) {
    failures.push(
      "右方向键走不进被挂出去的字符：悬挂 span 关掉了编辑，光标会整块跳过它——作者按键移动时会发现段末那个句号点不进去",
    );
  }

  if (failures.length === 0) {
    console.log(
      `PASS  标点悬挂画到了屏幕上（${report.hangCount} 处，各右移 ${(0.5 * report.fontPx).toFixed(1)}px，其余 ${report.withHang.length - report.hangCount} 个字符一动不动），中文一处不挂，文本与光标不受影响`,
    );
  }
} finally {
  await browser?.close();
  await server.stop(true);
}

if (failures.length > 0) {
  throw new Error(failures.join("; "));
}
