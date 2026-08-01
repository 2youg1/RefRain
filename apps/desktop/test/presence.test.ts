/**
 * Presence：关掉不是消失，是一段可以被看见的离场。
 */

import { describe, expect, test } from "bun:test";

import { type Clock, Presence } from "../src/shell/presence";

/** 手动走针的钟：时间不自己流，测试让它走它才走。 */
function fakeClock() {
  const pending = new Map<number, () => void>();
  let next = 1;
  const clock: Clock = {
    setTimeout: (task, _ms) => {
      const handle = next;
      next += 1;
      pending.set(handle, task);
      return handle;
    },
    clearTimeout: (handle) => {
      pending.delete(handle);
    },
  };
  return {
    clock,
    /** 让下一个到点的任务开火。 */
    tick(): void {
      const [task] = pending.values();
      pending.clear();
      task?.();
    },
    get size(): number {
      return pending.size;
    },
  };
}

describe("Presence", () => {
  test("出现是立即的，消失要等离场窗走完", () => {
    const { clock, tick } = fakeClock();
    const presence = new Presence(clock, 260, () => undefined);

    presence.update(true);
    expect(presence.shown).toBe(true);
    expect(presence.leaving).toBe(false);

    presence.update(false);
    expect(presence.shown).toBe(true);
    expect(presence.leaving).toBe(true);

    tick();
    expect(presence.shown).toBe(false);
    expect(presence.leaving).toBe(false);
  });

  test("离场途中重新出现：取消计时，不留尸体", () => {
    const { clock, tick, size } = fakeClock();
    const presence = new Presence(clock, 260, () => undefined);

    presence.update(true);
    presence.update(false);
    presence.update(true);
    expect(presence.shown).toBe(true);
    expect(presence.leaving).toBe(false);
    expect(size).toBe(0);

    // 之后再走针，也不该把它拆掉。
    tick();
    expect(presence.shown).toBe(true);
  });

  test("每次状态变化只广播一次", () => {
    const { clock } = fakeClock();
    let beats = 0;
    const presence = new Presence(clock, 260, () => {
      beats += 1;
    });

    presence.update(true); // 1
    presence.update(true); // 重复，不广播
    presence.update(false); // 2（进入离场）
    expect(beats).toBe(2);
  });

  test("没出现过就 update(false) 是静默的", () => {
    const { clock, size } = fakeClock();
    let beats = 0;
    const presence = new Presence(clock, 260, () => {
      beats += 1;
    });
    presence.update(false);
    expect(presence.shown).toBe(false);
    expect(beats).toBe(0);
    expect(size).toBe(0);
  });
});
