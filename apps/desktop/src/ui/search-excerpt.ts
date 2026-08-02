/**
 * 把命中的块文本切成「查询词」与「它周围的话」。
 *
 * 与渲染分开成一个 `.ts` 模块，是为了让空查询、多次命中、命中落在末尾这几种
 * 情形能直接测——它们全是字符串问题，不需要一个浏览器来回答。
 */

/** 片段里的一段：命中的词，或它两侧的话。 */
export interface HitPiece {
  readonly text: string;
  readonly matched: boolean;
}

/** 片段最多显示这么多字，超出的部分从命中处向两侧留白。 */
const EXCERPT_BUDGET = 60;

/**
 * 把块文本按查询词切成若干段。
 *
 * 用 `indexOf` 在**块文本**里定位，不把索引里的 bigram 偏移映射回原文字节：
 * 索引可能比磁盘旧，而块文本是刚读出来的，在它自己身上找一个子串永远是对的。
 *
 * 查询串为空时返回整段且一处不标——空查询不该把整篇文章染成命中。
 */
export function splitOnQuery(text: string, query: string): readonly HitPiece[] {
  const needle = query.trim();
  // 没有这一行会死循环：`indexOf("")` 在任何位置都命中且返回 `cursor` 本身，
  // 于是游标永不前进，`pieces` 一直长到内存耗尽。作者清空搜索框就会走到这里。
  if (needle.length === 0) return [{ text, matched: false }];

  const pieces: HitPiece[] = [];
  let cursor = 0;
  for (;;) {
    const at = text.indexOf(needle, cursor);
    if (at < 0) break;
    if (at > cursor) pieces.push({ text: text.slice(cursor, at), matched: false });
    pieces.push({ text: needle, matched: true });
    cursor = at + needle.length;
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), matched: false });
  return pieces.length > 0 ? pieces : [{ text, matched: false }];
}

/**
 * 把片段裁到看得下的长度，命中的词留在中间。
 *
 * 一个段落可以有几百字，而命中可能在末尾。从头截断会把作者要找的那个词恰好
 * 切掉——那正是他点开这一条的理由。
 */
export function excerptAround(text: string, query: string, budget = EXCERPT_BUDGET): string {
  const needle = query.trim();
  if (text.length <= budget) return text;
  const at = needle.length > 0 ? text.indexOf(needle) : -1;
  if (at < 0) return `${text.slice(0, budget)}…`;
  const half = Math.floor((budget - needle.length) / 2);
  const from = Math.max(0, at - half);
  const to = Math.min(text.length, from + budget);
  return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
}
