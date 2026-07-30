/**
 * What each recovery step means to the author.
 *
 * A Record over the union rather than a switch with a default: adding a
 * seventh step then fails to compile here, instead of silently rendering as
 * nothing at the moment a save has just failed.
 *
 * The domain names the step; this is the one place it becomes a sentence. It
 * lives outside the component because it is data, not rendering — and because
 * a plain module can be tested without a JSX runtime.
 */
import type { RecoveryStep } from "../generated/bindings.gen";

export const RECOVERY_TEXT: Record<RecoveryStep, string> = {
  retry: "再存一次",
  "choose-another-location": "换一个位置保存",
  "choose-another-name": "换一个文件名",
  "grant-permission": "给这个文件夹写入权限",
  "open-settings": "到设置里检查",
  "report-defect": "这是软件的缺陷，请反馈",
  // 提案过期时给作者的两条路。他是唯一知道该走哪条的人——那一段是他改的。
  "compare-with-frozen-text": "看看 Agent 当时读到的是什么",
  "send-again": "按现在的文字重新发一次",
};
