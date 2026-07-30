/**
 * 提案过期时，作者看到什么。
 *
 * 领域层已经守住了正确性：`decision.rs` 比对冻结的 `before` 与当前范围文本，
 * 不符就拒绝整个批次（`TextRefusal::StaleProposal`）。**但作者此前看到的是
 * 一句英文技术消息**——那条错误被压成 `ErrorCode::Io` 加 `error.to_string()`，
 * 而他其实是唯一知道该怎么办的人：那一段是他自己改的。
 *
 * 设计要求写在 Memo「四区·边缘情况 3」：
 *
 * > 提案自己降级为「已过期」并出示它当时引用的原文。默默套用是丢作者的字，
 * > 直接丢弃是丢 Agent 的活，两者都不能替他决定。
 *
 * 所以这一层做三件事，一件也不多：认出这类失败、把 `detail` 里的冻结原文
 * 交出来、把恢复步骤翻成作者的话。**它不替他选**——两条路都摆在那里。
 */

import type { RecoveryStep, RefrainError } from "../generated/bindings.gen";
import { RECOVERY_TEXT } from "./recovery-text";

/** 一次提案过期，摊开成界面要显示的东西。 */
export interface StaleProposalNotice {
  readonly kind: "stale";
  /** 一句话说清发生了什么，不含实现术语。 */
  readonly headline: string;
  /** Agent 当时读到的原文。作者拿它跟屏幕上的现文对照。 */
  readonly frozenText: string;
  /** 他可以走的路，按领域给的次序。 */
  readonly steps: readonly string[];
}

/** 这个错误是不是「提案过期」。 */
function isStale(error: unknown): error is RefrainError {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as RefrainError).code === "stale-proposal"
  );
}

/**
 * 认出过期失败，认不出就返回 null 交给通用路径。
 *
 * 返回 null 而不是造一个「未知错误」的过期通知：这一层只懂一件事，
 * 别的失败该由懂它的地方去说。
 */
export function staleProposalNotice(error: unknown): StaleProposalNotice | null {
  if (!isStale(error)) return null;
  const failure = error;
  return {
    kind: "stale",
    // 说的是发生了什么与为什么，不说「baseline 不匹配」这种只有实现者懂的话。
    headline: "这一段在派发之后被改过了，提案没有套用。",
    // detail 是领域放冻结原文的地方。取不到时给空串而不是占位文字——
    // 界面据此决定不显示对照块，而不是显示一块写着「无」的空盒子。
    frozenText: failure.detail ?? "",
    steps: failure.recovery.map(readable),
  };
}

/** 一个恢复步骤对作者的说法。 */
function readable(step: RecoveryStep): string {
  return RECOVERY_TEXT[step];
}
