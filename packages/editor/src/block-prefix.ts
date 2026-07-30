/**
 * 块级 Markdown 前缀，按行开头的切换。
 *
 * 与 `inline-mark` 是两件事：行内标记包裹选区两侧，块级前缀改的是每一行的开头。
 * 把它们塞进同一个函数会让两种语法互相解释对方的边界条件——一个包裹范围，
 * 一个作用于整行，连"当前状态是什么"都不是同一个问题。
 *
 * 与行内标记相同的是**三态**：已经是这个前缀就去掉，不是就加上。作者按两次
 * 标题应当回到原文，而不是得到 `## ## 标题`。
 */

/** 作者能通过命令切换的块级前缀。 */
export type BlockPrefix =
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "quote"
  | "bullet-list"
  | "ordered-list";

/** 该前缀写成什么。有序列表按行号递增，故由函数给出。 */
const PREFIX_AT: Readonly<Record<BlockPrefix, (lineIndex: number) => string>> = {
  "heading-1": () => "# ",
  "heading-2": () => "## ",
  "heading-3": () => "### ",
  quote: () => "> ",
  "bullet-list": () => "- ",
  "ordered-list": (index) => `${index + 1}. `,
};

/**
 * 该前缀能识别出的既有写法。
 *
 * 比"它等于我要写的那个字符串"宽：作者可能已经写了 `1.`、`2.`、`*` 或 `+`，
 * 那些都是同一个前缀的合法形态，再加一次会得到两层前缀。
 */
const PATTERN_OF: Readonly<Record<BlockPrefix, RegExp>> = {
  "heading-1": /^#\s+/,
  "heading-2": /^##\s+/,
  "heading-3": /^###\s+/,
  quote: /^>\s*/,
  "bullet-list": /^[-*+]\s+/,
  "ordered-list": /^\d+[.)]\s+/,
};

/** 前缀在这些行上的状态。`mixed` 表示有的行有、有的行没有。 */
export type PrefixState = "on" | "off" | "mixed";

/**
 * 一段文本在某个前缀下的状态。
 *
 * 空行不参与判定：一段里夹着空行时，它既不该让状态变成 `mixed`，也不该被加上
 * 一个孤零零的 `- `。
 */
export function blockPrefixState(text: string, prefix: BlockPrefix): PrefixState {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return "off";
  const pattern = PATTERN_OF[prefix];
  const marked = lines.filter((line) => pattern.test(line)).length;
  if (marked === 0) return "off";
  return marked === lines.length ? "on" : "mixed";
}

/**
 * 切换一段文本的块级前缀。
 *
 * `on` 时移除，其余情况加上——`mixed` 视作"作者想要全部都有"，与行内标记同理。
 * 加前缀之前先移除**其它**块级前缀：一行不能既是标题又是引用，把 `# ` 变成
 * `> ` 时留下 `> # ` 是把两种意图叠在一起，而作者只表达了后一个。
 *
 * 返回 null 表示无可施加的对象（全是空行），调用方据此让命令失效，而不是写入
 * 一个只有前缀的空行。
 */
export function applyBlockPrefix(text: string, prefix: BlockPrefix): string | null {
  const lines = text.split("\n");
  if (lines.every((line) => line.trim().length === 0)) return null;

  const removing = blockPrefixState(text, prefix) === "on";
  let ordinal = 0;
  const next = lines.map((line) => {
    if (line.trim().length === 0) return line;
    const bare = stripEveryPrefix(line);
    if (removing) return bare;
    const written = PREFIX_AT[prefix](ordinal);
    ordinal += 1;
    return `${written}${bare}`;
  });
  return next.join("\n");
}

/** 去掉行首任何一种块级前缀，连同它后面的空白。 */
function stripEveryPrefix(line: string): string {
  for (const pattern of Object.values(PATTERN_OF)) {
    const match = pattern.exec(line);
    if (match !== null) return line.slice(match[0].length);
  }
  return line;
}
