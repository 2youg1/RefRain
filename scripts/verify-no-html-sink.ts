#!/usr/bin/env bun
/**
 * 正文与代码永远不经过 HTML 字符串。
 *
 * 作者的稿子里可以有任何字符，Agent 回传的提案也可以。若其中任何一段被当作
 * HTML 拼进 DOM，一段写着 `<script>` 的正文就会执行——而这个产品的正文**就是
 * 用户输入**，没有「可信来源」这一说。
 *
 * 现在它在结构上不可能：全仓零 `innerHTML`，代码高亮交出的是 token 数组而不是
 * HTML 字符串（`code-highlight.ts` 明确写了这条），Solid 的 JSX 插值默认转义。
 * **但「结构上不可能」需要有人守**——下一个人为了省事写一行 `innerHTML` 就破了，
 * 而那一行不会有任何测试变红：它在通常的语料上工作得很好，只在作者写下一段
 * 尖括号时才出事。
 *
 * 与 `verify:no-network` 同一个形状：守的不是「今天没有」，是「明天也不许有」。
 *
 * 三条注入各对一条分支：
 *   - 任何源码里出现 `innerHTML` → 红
 *   - `outerHTML` / `insertAdjacentHTML` / `document.write` 同样 → 红
 *   - 扫描面指向不存在的目录 → 红（scanned === 0）
 */

import { report, scan } from "./gate-lib.ts";

/**
 * 把字符串变成 DOM 的每一种写法。
 *
 * `innerHTML` 是最常见的，但补齐同族才守得住：一个被拦下的人会顺手换成
 * `insertAdjacentHTML`，而那是同一个洞。
 */
const HTML_SINK =
  /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment)\b/;

const result = await scan(
  ["apps/desktop/src/**/*.{ts,tsx}", "packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"],
  HTML_SINK,
  {
    // 注释里提到这些名字是说明理由，不是使用它们——本文件顶部的说明就是例子。
    ignoreLine: (line) => /^\s*(\/\/|\/\*|\*)/.test(line),
  },
);

report(
  "verify:no-html-sink",
  result,
  "text reaches the DOM as an HTML string — the manuscript is user input, so this is an execution path",
);
