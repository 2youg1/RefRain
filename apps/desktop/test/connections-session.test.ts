import { describe, expect, test } from "bun:test";
import type { AgentDto, AgentReadingDto, HarnessDto } from "../src/generated/bindings.gen";
import {
  type ConnectionsGateway,
  ConnectionsSession,
  harnessStatusLabel,
} from "../src/shell/connections-session";

const harness = (id: string, status: HarnessDto["status"]): HarnessDto =>
  ({ id, name: id, status, connectionId: `c:${id}` }) as unknown as HarnessDto;

const agent = (id: string): AgentDto => ({ id, name: id }) as unknown as AgentDto;

const reading = (agentId: string): AgentReadingDto =>
  ({ agentId, documents: 1 }) as unknown as AgentReadingDto;

interface Harness {
  session: ConnectionsSession;
  calls: string[];
  setAgents(rows: AgentDto[]): void;
  failNext(message: string): void;
  /** Hold the next gateway call open so concurrency can be observed. */
  block(): () => void;
}

function harnessFor(): Harness {
  const calls: string[] = [];
  let agents: AgentDto[] = [];
  let failure: string | null = null;
  let release: (() => void) | null = null;

  const gate = async (): Promise<void> => {
    if (release !== null) {
      await new Promise<void>((resolve) => {
        const previous = release;
        release = () => {
          previous?.();
          resolve();
        };
      });
    }
    if (failure !== null) {
      const message = failure;
      failure = null;
      throw new Error(message);
    }
  };

  const gateway: ConnectionsGateway = {
    async listHarnesses() {
      calls.push("listHarnesses");
      await gate();
      return [harness("kimi", "connected"), harness("codex", "available")];
    },
    async listAgents() {
      calls.push("listAgents");
      return [...agents];
    },
    async agentReadingLedger() {
      calls.push("ledger");
      return agents.map((row) => reading(row.id));
    },
    async upsertHarnessConnection(id) {
      calls.push(`connect:${id}`);
      await gate();
      return null;
    },
    async removeHarnessConnection(id) {
      calls.push(`disconnect:${id}`);
      return null;
    },
    async probeConnection(id) {
      calls.push(`probe:${id}`);
      await gate();
      return "1.4.2";
    },
    async upsertAgent(name) {
      calls.push(`upsertAgent:${name}`);
      agents = [...agents, agent(name)];
      return null;
    },
    async removeAgent(id) {
      calls.push(`removeAgent:${id}`);
      agents = agents.filter((row) => row.id !== id);
      return null;
    },
  };

  return {
    session: new ConnectionsSession(gateway, "root-1", (error) => String(error)),
    calls,
    setAgents: (rows) => {
      agents = rows;
    },
    failNext: (message) => {
      failure = message;
    },
    block: () => {
      release = () => undefined;
      return () => {
        const fire = release;
        release = null;
        fire?.();
      };
    },
  };
}

describe("ConnectionsSession", () => {
  test("loading fills the catalogue and returns to idle", async () => {
    const h = harnessFor();
    await h.session.load();
    const view = h.session.view();
    expect(view.harnesses).toHaveLength(2);
    expect(view.activity.kind).toBe("idle");
  });

  test("the reading ledger is skipped when no agent exists", async () => {
    const h = harnessFor();
    await h.session.load();
    expect(h.calls).not.toContain("ledger");
  });

  test("the reading ledger is fetched once an agent exists", async () => {
    const h = harnessFor();
    h.setAgents([agent("a1")]);
    await h.session.load();
    expect(h.calls).toContain("ledger");
    expect(h.session.readingOf("a1")).not.toBeNull();
    expect(h.session.readingOf("missing")).toBeNull();
  });

  test("a second operation is refused while one is in flight", async () => {
    const h = harnessFor();
    const unblock = h.block();
    const first = h.session.load();
    expect(h.session.view().activity.kind).toBe("working");
    // The refusal is what keeps two refreshes from interleaving their writes.
    await h.session.connect("codex");
    expect(h.calls).not.toContain("connect:codex");
    unblock();
    await first;
    expect(h.session.view().activity.kind).toBe("idle");
  });

  test("a failure is reported as failed, not as a silent idle", async () => {
    const h = harnessFor();
    h.failNext("bridge down");
    await h.session.load();
    const activity = h.session.view().activity;
    expect(activity.kind).toBe("failed");
    if (activity.kind === "failed") expect(activity.text).toContain("bridge down");
  });

  test("the lock is released after a failure", async () => {
    const h = harnessFor();
    h.failNext("bridge down");
    await h.session.load();
    await h.session.load();
    expect(h.session.view().harnesses).toHaveLength(2);
  });

  test("a probe records the confirmed version", async () => {
    const h = harnessFor();
    await h.session.probe("c:kimi");
    expect(h.session.view().checkedVersions["c:kimi"]).toBe("1.4.2");
    expect(h.session.view().activity).toEqual({ kind: "reported", text: "测试通过：1.4.2" });
  });

  test("disconnecting drops the version it can no longer vouch for", async () => {
    const h = harnessFor();
    await h.session.probe("c:kimi");
    expect(h.session.view().checkedVersions["c:kimi"]).toBe("1.4.2");
    await h.session.disconnect("c:kimi");
    expect(h.session.view().checkedVersions["c:kimi"]).toBeUndefined();
  });

  test("an unnamed agent is not created", async () => {
    const h = harnessFor();
    await h.session.createAgent("   ", "", "");
    expect(h.calls.filter((call) => call.startsWith("upsertAgent"))).toHaveLength(0);
  });

  test("creating an agent trims the name and refreshes", async () => {
    const h = harnessFor();
    await h.session.createAgent("  Kimi  ", "", "  ");
    expect(h.calls).toContain("upsertAgent:Kimi");
    expect(h.session.view().agents.map((row) => row.id)).toEqual(["Kimi"]);
  });

  test("every harness status has an author-facing name", () => {
    for (const status of ["connected", "available", "missing", "needs-attention"] as const) {
      expect(harnessStatusLabel(status).length).toBeGreaterThan(0);
    }
  });
});
