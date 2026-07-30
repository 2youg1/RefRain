/**
 * 右键落点到派发之间的那条链：不必开窗口就能问清楚它的规矩。
 */

import { describe, expect, test } from "bun:test";
import type { EditorContext } from "@refrain/editor";

import { EditIntents } from "../src/shell/edit-intents";

const contextAt = (blockId: string, selection: EditorContext["selection"] = null): EditorContext =>
  ({ blockId, selection }) as EditorContext;

const selection = { start: 3, end: 7, quote: "得失寸心" };

describe("EditIntents", () => {
  test("意图落定后菜单必须收起", () => {
    const intents = new EditIntents(() => undefined);
    intents.aim(contextAt("b1"), 10, 20);
    expect(intents.pointer).not.toBeNull();
    intents.dispatchAimedBlock(false);
    // 菜单若留在屏幕上，它浮的是一段已经进了派发的正文。
    expect(intents.pointer).toBeNull();
  });

  test("「加入派发」攒一批，「派发此段」从这一段重来", () => {
    const intents = new EditIntents(() => undefined);
    intents.aim(contextAt("b1"), 0, 0);
    intents.dispatchAimedBlock(false);
    intents.aim(contextAt("b2"), 0, 0);
    intents.dispatchAimedBlock(true);
    expect(intents.seed.blockIds).toEqual(["b1", "b2"]);

    intents.aim(contextAt("b3"), 0, 0);
    intents.dispatchAimedBlock(false);
    expect(intents.seed.blockIds).toEqual(["b3"]);
  });

  test("同一段点两次只派发一次", () => {
    const intents = new EditIntents(() => undefined);
    intents.aim(contextAt("b1"), 0, 0);
    intents.dispatchAimedBlock(false);
    intents.aim(contextAt("b1"), 0, 0);
    intents.dispatchAimedBlock(true);
    expect(intents.seed.blockIds).toEqual(["b1"]);
  });

  test("没有右键落点时派发不成立", () => {
    const intents = new EditIntents(() => undefined);
    expect(intents.dispatchAimedBlock(false)).toBe(false);
    expect(intents.seed.blockIds).toEqual([]);
  });

  test("从批注派发时去重并带走那句话", () => {
    const intents = new EditIntents(() => undefined);
    intents.dispatchAnnotations(["b1", "b2", "b1"], "请把这几处改得更短");
    expect(intents.seed.blockIds).toEqual(["b1", "b2"]);
    expect(intents.seed.prompt).toBe("请把这几处改得更短");
  });

  test("没有选区就没有可锚之处，批注目标为空", () => {
    const intents = new EditIntents(() => undefined);
    intents.aim(contextAt("b1", null), 0, 0);
    expect(intents.annotationTarget(null)).toBeNull();
  });

  test("有选区时批注目标带上锚点与原文", () => {
    const intents = new EditIntents(() => undefined);
    intents.aim(contextAt("b1", selection), 0, 0);
    expect(intents.annotationTarget(null)).toEqual({
      blockId: "b1",
      start: 3,
      end: 7,
      quote: "得失寸心",
      id: null,
    });
  });

  test("改写既有批注时带上它的 id", () => {
    const intents = new EditIntents(() => undefined);
    intents.aim(contextAt("b1", selection), 0, 0);
    const target = intents.annotationTarget({ id: "a9" } as never);
    expect(target?.id).toBe("a9");
  });

  test("每次状态变化都广播一次，界面不会停在旧样子", () => {
    let beats = 0;
    const intents = new EditIntents(() => {
      beats += 1;
    });
    intents.aim(contextAt("b1"), 0, 0); // 1
    intents.dispatchAimedBlock(false); // 2（release）
    intents.dispatchAnnotations(["b2"], ""); // 3
    expect(beats).toBe(3);
    intents.release(); // 已经空了，不再广播
    expect(beats).toBe(3);
  });
});
