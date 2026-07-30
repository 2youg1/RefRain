/**
 * 作者在设置里改了什么。
 *
 * 「撤销本次调整」要回答一个具体问题：从他进入设置那一刻到现在，哪几项变了。
 * 配置是一棵嵌套的树，而这个问题是逐项的，所以先把树拍平成叶子路径
 * （`typography.serif` 这样的字符串），再比对两次快照的叶子。
 *
 * 这几十行此前住在 `SettingsSurface.tsx` 里，零测试。它们决定作者点撤销时哪些值会
 * 被改回去——漏掉一项，他以为撤销了而那一项还留着；多算一项，他没动过的东西被改回。
 * 两种都不该发生，而两种都无人可测。
 *
 * 拍平用 JSON 序列化比值，因为叶子可能是数字、布尔、字符串或 null，而作者关心的
 * 只是「跟刚进来时一不一样」。
 */

/** 叶子路径 → 该处取值的序列化形式。 */
export type Leaves = Map<string, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectLeaves(value: unknown, prefix: string, into: Leaves): void {
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      collectLeaves(child, prefix === "" ? key : `${prefix}.${key}`, into);
    }
    return;
  }
  // undefined 与 null 在这里合流：作者看到的都是「这项没设」。
  into.set(prefix, JSON.stringify(value ?? null));
}

/** 把一份配置拍平成叶子。数组按整体比，不逐项拆——它是一个值。 */
export function leavesOf(config: unknown): Leaves {
  const leaves: Leaves = new Map();
  collectLeaves(config, "", leaves);
  return leaves;
}

/**
 * 取某一条路径上的值。
 *
 * 路径中途撞上非对象就返回 undefined，而不是抛错——配置的形状会随版本变，
 * 一条过时的路径应当读作「没有这一项」，不该让整个设置页崩掉。
 */
export function readLeaf(tree: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = tree;
  for (const key of path.split(".")) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/**
 * 写某一条路径上的值。
 *
 * 中途缺失的层会被建出来；写 `undefined` 是删除这一项，不是把它设成 undefined
 * ——序列化后两者不同，而作者的意思是「回到没设的状态」。
 */
export function writeLeaf(tree: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop();
  if (last === undefined) return;
  let cursor: Record<string, unknown> = tree;
  for (const key of keys) {
    const next = cursor[key];
    if (isRecord(next)) {
      cursor = next;
      continue;
    }
    const created: Record<string, unknown> = {};
    cursor[key] = created;
    cursor = created;
  }
  if (value === undefined) {
    delete cursor[last];
    return;
  }
  cursor[last] = value;
}

/**
 * 两次快照之间取值不同的叶子路径。
 *
 * 键的出现与消失也算不同——一项从「没设」变成「设了默认值」，序列化后确实不一样，
 * 而作者确实动过它。
 */
export function divergedPaths(mark: Leaves, latest: Leaves): string[] {
  const paths: string[] = [];
  for (const path of new Set([...mark.keys(), ...latest.keys()])) {
    if (mark.get(path) !== latest.get(path)) paths.push(path);
  }
  return paths;
}
