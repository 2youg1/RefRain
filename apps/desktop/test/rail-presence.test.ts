/**
 * 侧栏退开的规则，不必真的等两秒就能问清楚。
 */

import { describe, expect, test } from "bun:test";

import {
  RAIL_FIRST_IDLE_MS,
  RAIL_IDLE_MS,
  RailPresence,
  type Timer,
} from "../src/shell/rail-presence";

/** 手动推进的计时器：测试自己决定「两秒后」什么时候到。 */
class Clock {
  #pending: { delay: number; task: () => void; live: boolean }[] = [];

  readonly timer: Timer = (delay, task) => {
    const entry = { delay, task, live: true };
    this.#pending.push(entry);
    return () => {
      entry.live = false;
    };
  };

  get armed(): number {
    return this.#pending.filter((entry) => entry.live).length;
  }

  lastDelay(): number | null {
    return this.#pending.at(-1)?.delay ?? null;
  }

  /** 让所有还活着的计时器到点。 */
  fire(): void {
    const due = this.#pending.filter((entry) => entry.live);
    this.#pending = [];
    for (const entry of due) entry.task();
  }
}

const rig = () => {
  const clock = new Clock();
  const seen: boolean[] = [];
  const rail = new RailPresence(clock.timer, (receded) => seen.push(receded));
  return { clock, rail, seen };
};

describe("RailPresence", () => {
  test("开场先让作者看见侧栏，过一会儿才让开", () => {
    const { clock, rail } = rig();
    rail.begin();
    expect(rail.receded).toBe(false);
    expect(clock.lastDelay()).toBe(RAIL_FIRST_IDLE_MS);
    clock.fire();
    expect(rail.receded).toBe(true);
  });

  test("指针贴到左缘，侧栏立刻回来", () => {
    const { clock, rail } = rig();
    rail.begin();
    clock.fire();
    rail.pointerMoved(4);
    expect(rail.receded).toBe(false);
  });

  test("召回之后不再排计时——作者正伸手过来", () => {
    const { clock, rail } = rig();
    rail.begin();
    clock.fire();
    rail.pointerMoved(4);
    expect(clock.armed).toBe(0);
    clock.fire();
    expect(rail.receded).toBe(false);
  });

  test("指针停在版心里不动，侧栏让开", () => {
    const { clock, rail } = rig();
    rail.pointerMoved(600);
    expect(clock.lastDelay()).toBe(RAIL_IDLE_MS);
    clock.fire();
    expect(rail.receded).toBe(true);
  });

  test("停在版心与左缘之间，不算在写字，侧栏留着", () => {
    const { clock, rail } = rig();
    rail.pointerMoved(600);
    rail.pointerMoved(120);
    clock.fire();
    expect(rail.receded).toBe(false);
  });

  test("一直在动就一直不收——每次移动都把上一次的计时作废", () => {
    const { clock, rail } = rig();
    rail.pointerMoved(600);
    rail.pointerMoved(610);
    rail.pointerMoved(620);
    expect(clock.armed).toBe(1);
    clock.fire();
    expect(rail.receded).toBe(true);
  });

  test("已经让开之后，在版心里移动不会重复排计时", () => {
    const { clock, rail } = rig();
    rail.pointerMoved(600);
    clock.fire();
    expect(rail.receded).toBe(true);
    rail.pointerMoved(650);
    expect(clock.armed).toBe(0);
  });

  test("状态没变就不惊动外面", () => {
    const { clock, rail, seen } = rig();
    rail.pointerMoved(600);
    clock.fire();
    rail.pointerMoved(650);
    rail.pointerMoved(660);
    expect(seen).toEqual([true]);
  });

  test("拆掉之后，已经排下的计时不会再改状态", () => {
    const { clock, rail } = rig();
    rail.begin();
    rail.dispose();
    clock.fire();
    expect(rail.receded).toBe(false);
  });

  test("开场那次与移动那次不会互相顶掉", () => {
    const { clock, rail } = rig();
    rail.begin();
    // 开场计时还没到，作者就把指针挪进了版心。
    rail.pointerMoved(600);
    // 只应剩一个计时器：先前那次已经作废。
    expect(clock.armed).toBe(1);
    expect(clock.lastDelay()).toBe(RAIL_IDLE_MS);
    clock.fire();
    expect(rail.receded).toBe(true);
  });
});
