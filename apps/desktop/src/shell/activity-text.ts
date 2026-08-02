/**
 * The one-line wording for "something is in progress".
 *
 * Every session's working state names its operation; this module translates
 * the operation name into a sentence the author can read. That translation
 * did not exist before, so three surfaces each dropped the working state
 * and rendered only reported/failed — nothing in progress was ever visible.
 * The progress gap was a missing projection, not a missing component.
 */

import type { Activity } from "./session";

/**
 * Operation name to Chinese. Adding an operation without a wording falls
 * back to "正在处理" — never wrong, but this table exists so each sentence
 * stays specific.
 */
const OP_TEXT: Readonly<Record<string, string>> = {
  "open-folder": "正在打开项目",
  "open-file": "正在打开文档",
  "create-project": "正在新建项目",
  "create-document": "正在新建",
  "import-material": "正在导入资料",
  "delete-document": "正在移入回收站",
  "set-disclosure": "正在更新范围",
  load: "正在载入",
  send: "正在整理清单",
  authorize: "正在授权并启动",
  collect: "正在收取",
  retry: "正在重发",
  cancel: "正在取消",
  "save-draft": "正在保存草稿",
  "dismiss-draft": "正在退回草稿",
  connect: "正在连接",
  disconnect: "正在断开",
  probe: "正在探测连接",
  "create-agent": "正在登记写作伙伴",
  "update-agent": "正在保存写作伙伴",
  "remove-agent": "正在移除写作伙伴",
  "save-preset": "正在保存预设",
  "remove-preset": "正在移除预设",
  write: "正在写入设置",
};

/** The operation in progress as one sentence, or null when nothing runs. */
export function workingText(activity: Activity<string>): string | null {
  return activity.kind === "working" ? (OP_TEXT[activity.op] ?? "正在处理") : null;
}

/** What a finished operation reported (success or failure); null otherwise. */
export function noticeText(activity: Activity<string>): string | null {
  return activity.kind === "reported" || activity.kind === "failed" ? activity.text : null;
}
