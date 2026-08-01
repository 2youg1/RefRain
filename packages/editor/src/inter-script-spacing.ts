/**
 * 混排间距：把 `@refrain/typeset` 算出的间距量画进 DOM。
 *
 * ## 为什么必须自研（本机实测，Chromium）
 *
 * CSS 有一个专门做这件事的属性 `text-autospace`，理论上浏览器代劳即可。
 * 实测结果是不能：
 *
 * | 探针 | 结果 |
 * |---|---|
 * | `CSS.supports("text-autospace", "normal")` | true |
 * | `CSS.supports("text-autospace", "ideograph-alpha")` | **false** |
 * | 「中文abc混排」在 no-autospace / ideograph-alpha / 默认三档下的宽度 | **全是 569px** |
 *
 * 也就是说属性名解析得了，值不支持，开关三档量出来一模一样——**声明支持
 * 不等于真生效**。同一轮探针里 `text-spacing-trim: trim-start`、
 * `line-break: strict`、`word-break: auto-phrase` 是真支持的，所以这不是探
 * 针写坏了，是这一个属性确实没实现。
 *
 * 顺带查出 `surfaces.css` 里的 `hanging-punctuation: allow-end last` 也一直
 * 是死的：`CSS.supports("hanging-punctuation", "allow-end")` 返回 false。
 *
 * ## 为什么是空元素而不是空格字符
 *
 * 插入 U+2009 之类的空白字符会**改变磁盘字节**，而 Plan 第 2 项的判据是
 * 「开关此功能磁盘字节完全不变」。字节一旦变了，Source Backup、digest、
 * agent 引用的块区间全都跟着变，而作者从没敲过那个字符。
 *
 * 空元素没有这个问题。实测（真 contenteditable，17 个光标位置逐一往返）：
 *
 * | | textContent | 长度 | 光标错位 |
 * |---|---|---:|---|
 * | 纯文本 | 中文abc混排english测试 | 16 | 无 |
 * | 插入 4 个间距元素 | 中文abc混排english测试 | 16 | **无** |
 *
 * 两条性质使它成立：`textContent` 不收集空元素（它没有文本节点），而
 * `placeCaret` 用 TreeWalker 只遍历文本节点累加偏移——间距元素在那个遍历
 * 里根本不存在。所以它对光标、选区、复制、保存全都是透明的。
 *
 * `contenteditable="false"` 是必需的：否则光标可以停在这个 span 内部，
 * 作者会遇到一个「按右键光标不动」的位置。
 *
 * ## 给将来用 Rust 重写渲染器的人
 *
 * 这里的分段规则（哪里该插间距）全部来自 `@refrain/typeset` 的
 * `measure()`，它是零 DOM 的纯函数。重写渲染器时**不需要重新研究间距规则**
 * ——那部分连同 CLREQ/JLREQ 的依据都在 `packages/typeset/src/spacing.ts`
 * 与 `preset.ts` 里。要重写的只是本文件：把「在第 n 个字符后插入 x em」这
 * 组指令画到目标 UI 上。
 *
 * 中日不共用一张表：GB/T 15834 §5.1.10 要求行尾全角标点压半字身，JLREQ
 * §3.1.9 把句点看作「半角字身 + 后置半角空白」且行尾那段空白原则上保留，
 * 两者方向相反。混排间距默认取 CSS Text 4 §8.4.1 的 1/8 ic（CLREQ §6.3.3
 * 的 1/4 是**上界**不是规范值），日文按 JIS 用 1/4 em。
 */

import {
  type AdjustedChar,
  measure,
  optimizedLineStarts,
  presetOf,
  type TypesetPreset,
} from "@refrain/typeset";

/** 间距元素带的类名。渲染与门禁都引用这一个常量。 */
export const GAP_CLASS = "cjk-gap";

/**
 * 断行元素带的类名。
 *
 * 与间距元素同族：空元素、`contenteditable="false"`、对 `textContent` 透明。
 * 实测（`e2e/probe-forced-break.ts`）`display: block` 的空元素能强制换行而
 * `textContent` 与光标坐标系逐字不变。
 *
 * **不用 `<br>`**，虽然它同样通过了那三项实测。理由是所有权：`<br>` 是真实
 * 节点，浏览器在 contenteditable 里会自行增删它（空段落的占位、Enter 的默认
 * 行为），于是「哪些是我们画的、哪些是浏览器加的」需要额外区分，而区分错了
 * 的表现是段落里多一个看不见的换行。一个我们独有的类名没有这个问题。
 */
export const BREAK_CLASS = "cjk-break";

/**
 * 一段文本按混排边界与**断行**切开的结果。
 *
 * `gapAfter` 是这一段之后要插入的间距（em）；最后一段是 0。**可以是负数**
 * ——那是标点挤压：连续两个全角标点各自的内白挨在一起，中间形成一个可见的
 * 空洞，CLREQ §6.3.2 要求把这一对压到 1.5 字宽。切分本身不改变任何字符——
 * 把所有 `text` 顺序拼起来必须逐字等于原文，这条由
 * `packages/editor/test/inter-script-spacing.test.ts` 守着。
 *
 * `breakAfter` 为真表示这一段之后要换行。间距与断行由**同一份 `measure`
 * 结果**驱动：断行位置取决于挤压后的宽度（挤压会改变换行位置，这是 CLREQ
 * 明文的处理顺序，第 3 步早于第 5 步），各测一次必然漂开。
 *
 * 引擎那边记的是 `spaceBefore`（这个字符**之前**的空白），这里转成
 * 「这一段之后」。方向不同不是随意选的：引擎记在之前，才问得出「行首要不
 * 要保留这段空白」——JLREQ §3.1.9 的行尾空白正是它的镜像。而渲染要的是
 * 「在哪两段之间塞一个元素」，所以在这一层翻过来。
 */
export interface SpacedRun {
  readonly text: string;
  readonly gapAfter: number;
  readonly breakAfter: boolean;
}

/**
 * 按预设把一段文本切成若干段，标出每段之后的混排间距、标点挤压量与换行。
 *
 * 没有任何调整且不需要换行时返回单元素数组，调用方据此走「一个文本节点」的
 * 快路径——纯中文或纯英文的短段落是多数，不该为它们建一串 DOM 节点。
 *
 * **正负都要收**。第一版只收 `spaceBefore > 0`，于是引擎算出来的挤压量被
 * 整个丢在这一层，而且不报错——探针实测 `「引用」，然后……` 引擎给出净调整
 * −0.5em、画进 DOM 的是 0em，`、。！？；：` 差额高达 −2.5em。表现是标点之间
 * 挂着可见的空洞，也就是 Plan 3.2-3 那条判据说的「无可见空洞」的反面。
 *
 * 这是「引擎有、接线无」的典型形态：`packages/typeset` 的单元测试断言的是
 * `measure()` 的返回值，它一直是对的；没有任何测试问过那些数字有没有被画出来。
 * 断行是同一个形态的第二次——`optimizedLineStarts` 写完之后同样零调用。
 *
 * `measureEm` 为 0 或负数时不断行，只切间距：那表示调用方还不知道版心多宽
 * （元素尚未进 DOM、宽度尚未测出），此时按 0 宽断行会把每个字断成一行。
 */
export function spacedRuns(
  text: string,
  preset: TypesetPreset,
  measureEm = 0,
): readonly SpacedRun[] {
  if (text === "") return [{ text: "", gapAfter: 0, breakAfter: false }];

  // `measure` 按**码位**返回，每项自带 text。不要用下标去 slice 原串：
  // emoji 与增补平面汉字在 UTF-16 里占两格，按码位下标切会切进代理对中间，
  // 得到两个坏字符。累加 `character.text.length` 才是对的。
  const adjusted = measure(text, preset);
  // 断行下标是**码位**下标，与 adjusted 的下标同一个坐标系。
  const starts = measureEm > 0 ? new Set(optimizedLineStarts(adjusted, preset, measureEm)) : null;
  const runs: SpacedRun[] = [];
  let pending = "";

  adjusted.forEach((character, index) => {
    // 行首意味着**上一段到此为止**，且那一段之后要换行。
    //
    // 不写 `index > 0` 的守卫：`optimizedLineStarts` 恒把 0 作为第一个行首，
    // 但 index 0 处 `pending` 还是空串，已经被下面那道 `pending !== ""` 挡住
    // ——注入实测（去掉守卫后逐 run 对拍）输出**逐字相同**。一条删掉后行为
    // 不变的守卫什么也没防，却会让下一个人以为「段首那一下」是靠它挡住的。
    const startsLine = starts?.has(index) === true;
    // spaceBefore 记在「这个字符之前」，所以看到它也意味着上一段到此为止。
    if ((startsLine || character.spaceBefore !== 0) && pending !== "") {
      runs.push({
        text: pending,
        // 换行处的间距不画：那段空白会挂在行尾，把行推出版心。JLREQ §3.1.9
        // 的行尾空白是另一回事（它是标点自带的后置空白，不是混排间距）。
        gapAfter: startsLine ? 0 : character.spaceBefore,
        breakAfter: startsLine,
      });
      pending = "";
    }
    pending += character.text;
  });

  runs.push({ text: pending, gapAfter: 0, breakAfter: false });
  return runs;
}

/**
 * 把切分结果画进一个已有的元素，替换它现有的内容。
 *
 * 调用方保证 `element` 此刻显示的就是 `text`——这个函数不读它，只写。
 *
 * `measureEm` 是版心宽度（em）。给了正值就接管折行：段落的 `white-space`
 * 必须同时是 `pre`，否则浏览器会在我们的断行之外**再**自己折一次，两套断点
 * 叠加，而屏幕上看起来只是「行短了一点」。这个配对关系由
 * `verify:linebreak-takeover` 守着。
 */
export function paintSpacedText(
  element: HTMLElement,
  text: string,
  language: string,
  measureEm = 0,
): void {
  const preset = presetOf(language);
  const runs = spacedRuns(text, preset, measureEm);

  // 快路径：没有混排边界也不需要换行，就是一个文本节点，与不开这个功能时
  // 完全一样。
  if (runs.length === 1) {
    element.textContent = text;
    return;
  }

  const document_ = element.ownerDocument;
  const fragment = document_.createDocumentFragment();
  for (const run of runs) {
    if (run.text !== "") fragment.appendChild(document_.createTextNode(run.text));
    if (run.gapAfter !== 0) {
      const gap = document_.createElement("span");
      gap.className = GAP_CLASS;
      // 行内块而不是 letter-spacing：后者会作用到整段，而这里要的是
      // 精确落在两个 script 之间的一处。
      gap.style.display = "inline-block";
      if (run.gapAfter > 0) {
        gap.style.width = `${run.gapAfter}em`;
      } else {
        // 挤压用负 margin，不能用负 width——`width: -0.5em` 是非法值，浏览器
        // 整条声明丢弃且不报错，表现与「挤压没实现」完全相同。宽度置 0 之后
        // 由 margin 把后一段往回拉，这是唯一能在行内产生负位移的机制。
        gap.style.width = "0";
        gap.style.marginLeft = `${run.gapAfter}em`;
      }
      // 没有这一行，光标可以停进这个 span，作者会遇到一个按方向键不动的
      // 位置——而它在屏幕上是空白，看不出为什么。
      gap.contentEditable = "false";
      fragment.appendChild(gap);
    }
    if (run.breakAfter) {
      const lineBreak = document_.createElement("span");
      lineBreak.className = BREAK_CLASS;
      // `display: block` 且高度为零：块级元素强制它前后的内容分行，而零高度
      // 让它自己不占任何垂直空间。实测三个候选里只有这一个与 `<br>` 同时
      // 满足「断行生效 + textContent 逐字不变 + 光标坐标系一致」。
      lineBreak.style.display = "block";
      lineBreak.style.height = "0";
      lineBreak.contentEditable = "false";
      fragment.appendChild(lineBreak);
    }
  }
  element.textContent = "";
  element.appendChild(fragment);
}
