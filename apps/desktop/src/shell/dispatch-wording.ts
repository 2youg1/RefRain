/**
 * 派发的措辞：把领域值变成屏幕上的一句话。
 *
 * 这些函数从 `dispatch-session.ts` 搬出来。那个文件管的是一次派发怎么走完，
 * 而「一个 Run 的状态用中文怎么说」与走完流程无关——它只在渲染时被问到，
 * 且只有 `DispatchSurface` 会问。混在一起让 625 行的会话模块同时管两件事。
 *
 * 搬出来之后立刻看见两个缺陷，它们在原处被 625 行的上下文盖住了：
 *
 * 其一，`runStatusLabel` 每次调用都重建一个七项的对象字面量，而它在 `<For>` 里
 * 逐个 Run 调用——一次渲染建几十个立刻丢掉的对象。
 *
 * 其二，`terminal()` 与那张表各自枚举同一组状态，是两处权威。加一个终态而忘了
 * 改另一处，取消按钮就会出现在一个已经结束的 Run 上。现在终态从一处推出。
 */

import type { RunDto, Tokens } from "../generated/bindings.gen";

/**
 * 一个 Run 走到哪一步了。
 *
 * 表在模块顶层，不在函数体里——它每次渲染都要被读几十次，而它一次也不会变。
 */
const PROGRESS: Readonly<Record<string, string>> = {
  queued: "排队",
  authorized: "已授权",
  launching: "启动",
  dispatched: "在途",
  completed: "完成",
  failed: "失败",
  cancelled: "取消",
};

/**
 * 已经结束的几步。取消按钮不该出现在它们上面。
 *
 * 这是终态的唯一权威：`terminal()` 读它，措辞表与它同源。此前两处各写一遍，
 * 加一个终态而漏改另一处的后果是作者能去取消一个已经完成的 Run。
 */
const FINISHED: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

/** 一个 Run 还能不能取消。 */
export function terminal(run: RunDto): boolean {
  return FINISHED.has(run.progress);
}

export function runStatusLabel(run: RunDto): string {
  const label = PROGRESS[run.progress];
  if (label === undefined) return run.progress;
  // 失败要带上原因；别的状态说完就完了。
  return run.progress === "failed" && run.failure ? `失败：${run.failure}` : label;
}

/**
 * token 的数字。
 *
 * 实报与预估必须在措辞上分得开——作者据此判断这次派发花了多少，把预估读成实报
 * 会让他对成本产生错误的信心。RefRain 不做计费换算，只如实转述 harness 的数字。
 */
export function tokenLabel(tokens: Tokens): string {
  if (tokens.kind === "actual") return `token 实报 ${tokens.value}`;
  if (tokens.kind === "estimated") return `token 预估约 ${tokens.value}`;
  return "token 未知";
}
