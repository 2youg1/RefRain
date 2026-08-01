/**
 * 不可分单元：一段文本里绝不能被断行切开的区间。
 *
 * ## 为什么这属于排版引擎而不是编辑器
 *
 * `punctuation.ts` 里已经有一个同名概念（行内代码保护区），但那一份服务的是
 * 全半角切换——它回答「这里的标点该不该转换」。断行要问的是另一个问题：
 * 「这里能不能换行」。两个问题的答案区间高度重合（都覆盖代码、URL、路径），
 * 但它们的**权威归属不同**：断行是排版事实，在没有编辑器的服务端渲染、
 * 预览视口、PDF 导出里同样成立，所以它必须住在零依赖的 typeset 里。
 *
 * 让两处各自持有一份规则是「同一事实两个权威」，但合并它们要跨越
 * `verify:typeset-purity` 守着的那条缝（typeset 不得依赖 editor，editor 可以
 * 依赖 typeset）。正确方向是 editor 那边将来改为复用这里，不是反过来。
 *
 * ## 实测出来的缺陷
 *
 * 灾难语料 4-F：`参见 https://www.w3.org/TR/clreq/#line-breaking-rules 的说明。`
 * 在 14em 版心下断在下标 21 与 37，也就是把 URL 切成
 * `https://www.w3.org/TR` + `/clreq/#line-` + `breaking-rules`。
 *
 * 根因是字符类判不出来：`/`、`:`、`#`、`-`、`.` 单看都是 `other` 类，两侧
 * 是拉丁字母，`candidates` 生成的是一个代价 10 的合法断点。**字符类是逐字
 * 判定的，而 URL 是一个跨越几十个字符的结构**——这个层级差就是缺陷的位置。
 *
 * 成熟排版器都不这样断。CSS 里 `word-break: break-all` 才允许，默认值不允许；
 * TeX 需要 `\url{}` 才能在斜杠后断，且那是显式选择。
 *
 * ## 边界的选择
 *
 * 这里识别的是**保守的**不可分单元，宁可漏判不可误判：一个被误判为不可分的
 * 长段落会把整行推出版心，那比断错一个 URL 更糟。所以：
 *
 * - URL 要求带协议（`https://`、`ftp://`）或以 `www.` 起头，不认裸域名——
 *   `例如 example.com 这样` 里的域名与句子里的普通词无法可靠区分。
 * - 路径要求有分隔符且不含空格，Windows 盘符单独认。
 * - 邮箱要求 `@` 两侧都有非空白且右侧含点。
 * - 行内代码由反引号成对界定，与 `punctuation.ts` 同规则。
 */

/** 一个左闭右开的不可分区间。 */
export interface UnbreakableRange {
  readonly start: number;
  readonly end: number;
}

/**
 * 逐条列出不可分单元的正则。
 *
 * 次序无关（结果会被合并），但每条都必须是**保守**的：宁可漏判。
 */
const PATTERNS: readonly RegExp[] = [
  // 带协议的 URL。尾部的 `[^\s]` 里刻意含标点，因为 `#anchor` 与 `?q=1` 都是
  // URL 的一部分；行尾的中文句号由下面的收尾修剪摘掉。
  /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s，。！？；：、）」』]+/gu,
  // 无协议但以 www. 起头。
  /\bwww\.[^\s，。！？；：、）」』]+/gu,
  // 邮箱：@ 左右都要有内容，右侧要含点。
  /[^\s@，。！？；：、（）「」『』]+@[^\s@，。！？；：、（）「」『』]+\.[a-zA-Z]{2,}/gu,
  // Windows 盘符路径。
  /\b[A-Za-z]:\\[^\s，。！？；：、）」『』]*/gu,
  // Unix 绝对路径：至少两段，避免把句子里的 `/` 当路径。
  /\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]*)+/gu,
  // 行内代码。
  /`[^`]*`/gu,
  // 行内标记符与它紧邻的那个字符不可分。
  //
  // 标记符留在正文里画淡（见 `inline-render.ts`），于是它会参与断行；不挡的话
  // 断点可能落在标记符与内容之间，屏幕上就是行首孤零零一个 `**`，读起来像
  // 误输入的标点。实测 em=16 时「**风景的发现**并非…」被推到行首。
  //
  // 只绑一个字符而不是整个标记区间：把 `**很长的一段加粗**` 整体设为不可断，
  // 一段长加粗就会因为放不下而整体跳到下一行，右缘出现大片空白——那比行首一个
  // 星号更难看。绑一个字符足以让标记符跟着它的内容走。
  //
  // 开标记（`**` 在左）与闭标记（`**` 在右）各一条：正则从左往右扫，一条模式
  // 表达不了「符号可能在任意一侧」。
  /[*`~_]+[^\s*`~_]/gu,
  /[^\s*`~_][*`~_]+/gu,
  // 带单位或符号的数值：`-273.15°C`、`101.325kPa`、`3.14×10⁻⁶`、`16:9`。
  /[+-]?\d[\d,.]*(?:[×xX*]\d[\d.]*)?(?:\s*[°%‰]|[a-zA-Z°µΩ]+|:\d+)?/gu,
];

/**
 * 找出文本里所有不可分区间，已按起点排序且互不重叠。
 *
 * 重叠的区间会被合并——一条 URL 里嵌着一个看起来像数值的片段时，两者应当
 * 一起视为不可分，取并集才是保守的做法。
 */
export function unbreakableRanges(text: string): readonly UnbreakableRange[] {
  const found: UnbreakableRange[] = [];
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      if (start === undefined) continue;
      const end = start + match[0].length;
      if (end - start < 2) continue; // 单字符不成单元
      found.push({ start, end });
    }
  }
  if (found.length === 0) return [];

  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: UnbreakableRange[] = [];
  for (const range of found) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) {
      if (range.end > last.end) merged[merged.length - 1] = { start: last.start, end: range.end };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

/**
 * 这个下标处能不能断行。
 *
 * 区间的**两端**是可以断的（URL 前后当然能换行），只有内部不行。
 */
export function isInsideUnbreakable(ranges: readonly UnbreakableRange[], index: number): boolean {
  for (const range of ranges) {
    if (index > range.start && index < range.end) return true;
    if (range.start > index) break;
  }
  return false;
}
