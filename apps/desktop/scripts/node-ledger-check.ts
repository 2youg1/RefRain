/**
 * Exercise the Verdict Ledger under Electron's embedded Node — the runtime its
 * main process actually uses. Bundled by `make.sh` and run through the Electron
 * executable with ELECTRON_RUN_AS_NODE, because `bun test` proves only the Bun
 * branch and a system Node can carry a different `node:sqlite` implementation.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VerdictLedger } from "@refrain/core";

const root = mkdtempSync(join(tmpdir(), "refrain-node-"));

try {
  const ledger = new VerdictLedger(join(root, "verdicts.db"));
  const verdict = {
    id: "v1",
    proposalId: "p1",
    sliceId: "s1",
    kind: "accept-modified" as const,
    finalText: "剑没有松。",
    reason: "更冷",
    baseline: "rev0",
    decidedAt: "2026-07-26T00:00:00.000Z",
  };

  ledger.record(verdict);
  const [stored] = ledger.all();
  if (stored?.finalText !== verdict.finalText) throw new Error("round trip lost finalText");
  if (ledger.search("更冷").length !== 1) throw new Error("search failed");

  const { reason: _stated, ...withoutReason } = verdict;
  ledger.record({ ...withoutReason, id: "v2" });
  const unstated = ledger.all().find((v) => v.id === "v2");
  if (unstated?.reason !== undefined) throw new Error("absent reason became a value");

  ledger.close();
  console.log("PASS  the ledger round-trips under Electron's embedded Node");
} catch (error) {
  console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  rmSync(root, { recursive: true, force: true });
}
