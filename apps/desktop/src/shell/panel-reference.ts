import type { SettingsSection, WorkbenchReference } from "./workbench-state";

/**
 * 一个参考面板在栈里怎么落位。
 *
 * 两件只与 reference 有关的事：它占哪一层（键），以及此刻能不能打开。
 * 它们此前住在外壳里，读起来像外壳的编排，其实是 reference 自己的性质——
 * 「批注要有一篇稿子才谈得上」不会因为换个调用方而改变。
 */

/**
 * 面板的键。
 *
 * 设置的每一节各有自己的键：从排版切到外观是换一层，不是在同一层里换内容。
 * 而连接、批注各自只有一层。
 */
export function panelKey(reference: WorkbenchReference): string {
  return reference.kind === "settings" ? `settings/${reference.section}` : reference.kind;
}

/** 批注锚在正文上，没有打开的文档就没有可锚之处。 */
export function canOpen(reference: WorkbenchReference, hasDocument: boolean): boolean {
  return reference.kind !== "annotations" || hasDocument;
}

/**
 * 设置面板此刻停在哪一节。
 *
 * 不在设置层时给「排版」——那是作者最常回到设置页的理由（外观选一次就定了），
 * 也是设置页自己的默认落点。起点只在这里说一次，调用方不各猜一次。
 */
export function settingsSection(reference: WorkbenchReference | null): SettingsSection {
  return reference?.kind === "settings" ? reference.section : "typography";
}
