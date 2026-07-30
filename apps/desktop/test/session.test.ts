/**
 * The shared session base: subscription and the exclusive-operation lock.
 *
 * These tests exist because three sessions now inherit this behaviour. A defect
 * here is a defect in every surface at once, so the lock and the notice
 * transitions are pinned directly rather than only through their subclasses.
 */

import { describe, expect, test } from "bun:test";

import { type Activity, Session } from "../src/shell/session";

/** A session with no state of its own, so each test observes only the base. */
type ProbeOp = "first" | "second";

class Probe extends Session<ProbeOp> {
  readonly log: string[] = [];

  protected describeError(error: unknown): string {
    return `描述:${String(error)}`;
  }

  read(): Activity<ProbeOp> {
    return this.activity;
  }

  run(operation: () => Promise<string | null>, op: ProbeOp = "first"): Promise<void> {
    return this.exclusive(op, operation);
  }
}

const never = (): Promise<string | null> => new Promise<string | null>(() => {});

describe("Session", () => {
  test("a listener hears every change and stops after it unsubscribes", async () => {
    const session = new Probe();
    let heard = 0;
    const stop = session.onChanged(() => {
      heard += 1;
    });

    await session.run(async () => "完成");
    // Two changes: entering `working`, then settling on `reported`.
    expect(heard).toBe(2);

    stop();
    await session.run(async () => "再一次");
    expect(heard).toBe(2);
  });

  test("two listeners both hear the same change", async () => {
    const session = new Probe();
    let a = 0;
    let b = 0;
    session.onChanged(() => {
      a += 1;
    });
    session.onChanged(() => {
      b += 1;
    });

    await session.run(async () => null);
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
  });

  test("a second operation is refused while the first is still running", async () => {
    const session = new Probe();
    let entered = 0;

    void session.run(async () => {
      entered += 1;
      return never();
    });
    await session.run(async () => {
      entered += 1;
      return "第二次";
    });

    // The refusal is the whole point: interleaved writes would publish a state
    // that never existed. The second body must not have run at all.
    expect(entered).toBe(1);
    expect(session.read()).toEqual({ kind: "working", op: "first" });
  });

  test("the working state names which operation holds the lock", async () => {
    const session = new Probe();
    void session.run(never, "second");
    expect(session.read()).toEqual({ kind: "working", op: "second" });
  });

  test("the lock is released after a failure, not left stuck on working", async () => {
    const session = new Probe();
    await session.run(async () => {
      throw new Error("坏了");
    });
    expect(session.read()).toEqual({ kind: "failed", text: "描述:Error: 坏了" });

    await session.run(async () => "恢复");
    expect(session.read()).toEqual({ kind: "reported", text: "恢复" });
  });

  test("a silent operation settles on idle rather than an empty notice", async () => {
    const session = new Probe();
    await session.run(async () => null);
    expect(session.read()).toEqual({ kind: "idle" });
  });

  test("dismissing clears a notice but never interrupts a running operation", async () => {
    const session = new Probe();
    await session.run(async () => "读过了");
    session.dismissNotice();
    expect(session.read()).toEqual({ kind: "idle" });

    void session.run(never);
    session.dismissNotice();
    expect(session.read()).toEqual({ kind: "working", op: "first" });
  });

  test("dismissing an already-idle session tells nobody anything changed", () => {
    const session = new Probe();
    let heard = 0;
    session.onChanged(() => {
      heard += 1;
    });
    session.dismissNotice();
    expect(heard).toBe(0);
  });
});
