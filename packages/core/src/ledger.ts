import { Database } from "bun:sqlite";
import type { Verdict } from "./verdict.ts";

/**
 * The Verdict Ledger (SPEC 1.2). Editors go stale and harnesses turn over; the
 * record of what this author accepted, refused, and why does not.
 *
 * `reason` is stored nullable rather than defaulted to "": a stated reason and
 * an unstated one are different facts, and only the former is worth replaying
 * to an agent.
 */

interface Row {
  id: string;
  proposal_id: string;
  slice_id: string | null;
  kind: string;
  final_text: string | null;
  reason: string | null;
  baseline: string;
  decided_at: string;
}

const toVerdict = (row: Row): Verdict => ({
  id: row.id,
  proposalId: row.proposal_id,
  kind: row.kind as Verdict["kind"],
  baseline: row.baseline,
  decidedAt: row.decided_at,
  ...(row.slice_id === null ? {} : { sliceId: row.slice_id }),
  ...(row.final_text === null ? {} : { finalText: row.final_text }),
  ...(row.reason === null ? {} : { reason: row.reason }),
});

export class VerdictLedger {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS verdicts (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL,
      slice_id TEXT,
      kind TEXT NOT NULL,
      final_text TEXT,
      reason TEXT,
      baseline TEXT NOT NULL,
      decided_at TEXT NOT NULL
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS verdicts_decided ON verdicts(decided_at)");
  }

  record(verdict: Verdict): this {
    this.db
      .query(
        `INSERT INTO verdicts VALUES ($id, $proposal, $slice, $kind, $final, $reason, $baseline, $at)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, final_text = excluded.final_text, reason = excluded.reason`,
      )
      .run({
        $id: verdict.id,
        $proposal: verdict.proposalId,
        $slice: verdict.sliceId ?? null,
        $kind: verdict.kind,
        $final: verdict.finalText ?? null,
        $reason: verdict.reason ?? null,
        $baseline: verdict.baseline,
        $at: verdict.decidedAt,
      });
    return this;
  }

  all(): Verdict[] {
    return this.db
      .query<Row, []>("SELECT * FROM verdicts ORDER BY decided_at, id")
      .all()
      .map(toVerdict);
  }

  forProposal(proposalId: string): Verdict[] {
    return this.db
      .query<Row, [string]>("SELECT * FROM verdicts WHERE proposal_id = ? ORDER BY decided_at, id")
      .all(proposalId)
      .map(toVerdict);
  }

  /** Retrieval over stated reasoning is what turns the ledger into taste. */
  search(fragment: string): Verdict[] {
    return this.db
      .query<Row, [string]>("SELECT * FROM verdicts WHERE reason LIKE ? ORDER BY decided_at, id")
      .all(`%${fragment}%`)
      .map(toVerdict);
  }

  close(): void {
    this.db.close();
  }
}
