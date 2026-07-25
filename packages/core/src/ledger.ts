import { openDatabase, type SqliteDatabase } from "./sqlite.ts";
import type { Verdict } from "./verdict.ts";

/**
 * The Verdict Ledger (SPEC 1.2). Editors go stale and harnesses turn over; the
 * record of what this author accepted, refused, and why does not.
 *
 * SQLite arrives through `./sqlite.ts`, which picks the builtin the current
 * runtime actually has: this module runs under both `bun test` and Electron's
 * Node, and those two ship different SQLite modules.
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
  private readonly db: SqliteDatabase;

  constructor(path: string) {
    this.db = openDatabase(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS verdicts (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL,
      slice_id TEXT,
      kind TEXT NOT NULL,
      final_text TEXT,
      reason TEXT,
      baseline TEXT NOT NULL,
      decided_at TEXT NOT NULL
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS verdicts_decided ON verdicts(decided_at)");
  }

  record(verdict: Verdict): this {
    this.db
      .prepare(
        `INSERT INTO verdicts VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, final_text = excluded.final_text, reason = excluded.reason`,
      )
      .run(
        verdict.id,
        verdict.proposalId,
        verdict.sliceId ?? null,
        verdict.kind,
        verdict.finalText ?? null,
        verdict.reason ?? null,
        verdict.baseline,
        verdict.decidedAt,
      );
    return this;
  }

  all(): Verdict[] {
    return (
      this.db.prepare("SELECT * FROM verdicts ORDER BY decided_at, id").all() as unknown as Row[]
    ).map(toVerdict);
  }

  forProposal(proposalId: string): Verdict[] {
    return (
      this.db
        .prepare("SELECT * FROM verdicts WHERE proposal_id = ? ORDER BY decided_at, id")
        .all(proposalId) as unknown as Row[]
    ).map(toVerdict);
  }

  /** Retrieval over stated reasoning is what turns the ledger into taste. */
  search(fragment: string): Verdict[] {
    return (
      this.db
        .prepare("SELECT * FROM verdicts WHERE reason LIKE ? ORDER BY decided_at, id")
        .all(`%${fragment}%`) as unknown as Row[]
    ).map(toVerdict);
  }

  close(): void {
    this.db.close();
  }
}
