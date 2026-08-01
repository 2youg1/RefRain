/**
 * `@refrain/typeset` — 一套排版引擎，两个视口。
 *
 * 零依赖、零 DOM、零 `@tauri-apps`。输入是字符串 + 预设，输出是纯数据
 * （字符类、调整量、候选断点、悬挂量），编辑视图与预览视口各自把这份数据
 * 画出来。
 *
 * **为什么必须 framework-free**：服务端跑一切、客户端各做各的——排版发生在
 * 客户端，而客户端可能是桌面壳、自建前端或某个 Agent。任何一处 `document`
 * 都会把这条缝堵上，而堵上之后没人会注意到，直到有人要在服务端跑它。
 * `verify:typeset-purity` 让这条缝明天也成立。
 *
 * **磁盘字节不变**：间距、悬挂量、挤压结果都是渲染派生物，不写回 `.md`、
 * 不进 Source Backup、不进复制文本。本模块只做字符串进、数字出。
 *
 * 固定的处理顺序（CLREQ 明文，不可颠倒）：
 *
 * ```text
 * 1. 判定字符类           → char-class.ts
 * 2. 取预设的自然空白     → preset.ts
 * 3. 连续标点挤压         → spacing.ts
 * 4. 混排间距             → spacing.ts
 * 5. 候选断点 + 禁则      → line-break.ts
 * 6. 超长行按预设挤进
 * 7. 短行补齐
 * 8. 断点稳定后应用悬挂   → hanging.ts
 * ```
 *
 * 第 3 步早于第 5 步是硬约束：挤压会改变换行位置。
 */

export {
  type CharClass,
  classOf,
  isFullWidthPunctuation,
  isWesternSide,
} from "./char-class.ts";
export { type Hang, hangingAt } from "./hanging.ts";
export { type BreakCandidate, candidates, lineStarts } from "./line-break.ts";
export { longestUnbreakableSpan, optimizedLineStarts } from "./optimal-break.ts";
export {
  type BreakStrictness,
  type HangPolicy,
  JA,
  type LineEndPunctuation,
  PRESETS,
  presetOf,
  type TypesetPreset,
  ZH_HANS,
  ZH_HANT,
} from "./preset.ts";
export {
  type AdjustedChar,
  lineEndAdjustment,
  measure,
  widthEm,
} from "./spacing.ts";
