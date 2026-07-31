/** Cmd+1..4 opens each quarter; Cmd+4 returns to the last Agent destination. */

import { type Quarter, quarterForKey } from "./quarters";
import type { WorkbenchReference } from "./workbench-state";

/** Agent 层的三个去处。派发是一个 stage，另外两个是 reference。 */
export type AgentDestination = "dispatch" | { readonly reference: WorkbenchReference };

/** 一次层导航要做什么。调用方照着执行，不必再判断。 */
export type Navigation =
  | { readonly kind: "openSettings" }
  /** 文件层就是 Rail，它始终在场——要做的是把焦点交给它。 */
  | { readonly kind: "focusRail" }
  /** 编辑层就是正文本身：收起面板，把光标还给稿子。 */
  | { readonly kind: "returnToManuscript" }
  | { readonly kind: "openStage"; readonly stage: "dispatch" }
  | { readonly kind: "openReference"; readonly reference: WorkbenchReference };

/**
 * 记住 Agent 层上次停在哪一个面板。
 *
 * 只记 Agent 层：另外三层没有可记的分歧。默认是批注——作者按 Cmd+4 之前
 * 从没用过 Agent 层时，锚在正文上的那个入口最贴近他此刻在做的事。
 */
export class QuarterMemory {
  #agent: AgentDestination = { reference: { kind: "annotations" } };

  get agent(): AgentDestination {
    return this.#agent;
  }

  /** 作者打开了 Agent 层的某个面板，记下来。 */
  rememberAgent(destination: AgentDestination): void {
    this.#agent = destination;
  }
}

/**
 * 一次层导航要做什么。调用方照着执行，不必再判断。
 *
 * 这五个动作就是外壳需要提供的全部能力，`runQuarterKey` 按名字调它们。
 * 分成「决定去哪」与「怎么去」两半，是因为前者是四区的规矩（可测、
 * 与渲染无关），后者是外壳手里那几个句柄。
 */
export interface QuarterActions {
  readonly openSettings: () => void;
  readonly focusRail: () => void;
  readonly returnToManuscript: () => void;
  readonly openDispatch: () => void;
  readonly openReference: (reference: WorkbenchReference) => void;
}

/**
 * 一个数字键从按下到落地的整条路径。
 *
 * 解析键、查规矩、记忆、执行——四步收在一处，因为它们只在这一个场景里
 * 组合出现。散在外壳里的话，外壳就得同时认识 `quarterForKey`、`navigateTo`
 * 与五个分支，而它一个也不需要理解。
 *
 * 返回 false 表示这一下不该被接管，调用方据此决定要不要 preventDefault。
 */
export function runQuarterKey(
  key: string,
  memory: QuarterMemory,
  hasDocument: boolean,
  actions: QuarterActions,
): boolean {
  const quarter = quarterForKey(key);
  if (quarter === null) return false;
  const step = navigateTo(quarter, memory, hasDocument);
  if (step === null) return false;
  switch (step.kind) {
    case "openSettings":
      actions.openSettings();
      return true;
    case "focusRail":
      actions.focusRail();
      return true;
    case "returnToManuscript":
      actions.returnToManuscript();
      return true;
    case "openStage":
      actions.openDispatch();
      return true;
    case "openReference":
      actions.openReference(step.reference);
      return true;
  }
}

/**
 * 一个数字键指向哪里。
 *
 * 返回 null 表示这一下不该被接管——例如没有打开的稿子时按 Cmd+4，
 * 批注没有可锚之处。**不该做的事不要假装做了**：静默地什么都不发生
 * 比跳到一个空面板更诚实。
 */
export function navigateTo(
  quarter: Quarter,
  memory: QuarterMemory,
  hasDocument: boolean,
): Navigation | null {
  switch (quarter) {
    case "settings":
      return { kind: "openSettings" };
    case "files":
      return { kind: "focusRail" };
    case "editing":
      // 没有稿子时「回到正文」没有宾语。
      return hasDocument ? { kind: "returnToManuscript" } : null;
    case "agent": {
      if (!hasDocument) return null;
      const destination = memory.agent;
      return destination === "dispatch"
        ? { kind: "openStage", stage: "dispatch" }
        : { kind: "openReference", reference: destination.reference };
    }
  }
}
