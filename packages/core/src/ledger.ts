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

/**
 * A thought that arrived while the author was writing something else (SPEC Q12).
 *
 * It carries where they were standing, because the whole value of catching one
 * is being able to walk back to the sentence it interrupted. Deliberately not
 * a task: no priority, no due date, no state beyond existing. The moment it
 * grows those it competes with the manuscript for attention, which is the
 * problem it was built to remove.
 */
export interface KaraNote {
  readonly id: string;
  readonly text: string;
  /** Absent when the thought arrived with no chapter open. */
  readonly chapterId?: string;
  readonly blockId?: string;
  readonly capturedAt: string;
}

interface NoteRow {
  id: string;
  text: string;
  chapter_id: string | null;
  block_id: string | null;
  captured_at: string;
}

const toNote = (row: NoteRow): KaraNote => ({
  id: row.id,
  text: row.text,
  capturedAt: row.captured_at,
  ...(row.chapter_id === null ? {} : { chapterId: row.chapter_id }),
  ...(row.block_id === null ? {} : { blockId: row.block_id }),
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

    // A separate table, not a Verdict with an unusual kind: a note is about
    // the work rather than about a Proposal, so giving it `proposal_id` and
    // `baseline` would mean writing two lies to store one thought — and every
    // query over verdicts would then have to remember to exclude it.
    this.db.exec(`CREATE TABLE IF NOT EXISTS kara_notes (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      chapter_id TEXT,
      block_id TEXT,
      captured_at TEXT NOT NULL
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS kara_notes_captured ON kara_notes(captured_at)");
  }

  record(verdict: Verdict): this {
    return this.recordAll([verdict]);
  }

  /** One Decision Batch is one ledger transaction; a partial audit cannot exist. */
  recordAll(verdicts: readonly Verdict[]): this {
    if (verdicts.length === 0) return this;
    const insert = this.db.prepare(`INSERT INTO verdicts VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                                   ON CONFLICT(id) DO NOTHING`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const verdict of verdicts)
        insert.run(
          verdict.id,
          verdict.proposalId,
          verdict.sliceId ?? null,
          verdict.kind,
          verdict.finalText ?? null,
          verdict.reason ?? null,
          verdict.baseline,
          verdict.decidedAt,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

  /**
   * Retrieval over stated reasoning is what turns the ledger into taste.
   *
   * `_` and `%` are LIKE's wildcards and used to travel unescaped. The
   * parameter was bound, so nothing could be injected — the failure was
   * quieter than that: searching `snake_case`, or a reason that mentions
   * "30%", returned rows that do not match, and the author had no way to see
   * it happening. A search that lies is worse than one that finds nothing.
   */
  search(fragment: string): Verdict[] {
    // `!` rather than a backslash: the escape character has to survive both a
    // TypeScript string literal and SQL's own quoting, and a backslash spends
    // the whole trip being halved. `!` needs neither, and is escaped here like
    // any other special character so a reason containing one still matches.
    const pattern = fragment.replace(/[!%_]/g, (character) => `!${character}`);
    return (
      this.db
        .prepare("SELECT * FROM verdicts WHERE reason LIKE ? ESCAPE '!' ORDER BY decided_at, id")
        .all(`%${pattern}%`) as unknown as Row[]
    ).map(toVerdict);
  }

  /**
   * Catch a thought without letting it take over (SPEC Q12).
   *
   * Newest first on the way out, because the last thing the author caught is
   * the one still live in their head.
   */
  note(note: KaraNote): this {
    this.db
      .prepare(
        `INSERT INTO kara_notes VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(note.id, note.text, note.chapterId ?? null, note.blockId ?? null, note.capturedAt);
    return this;
  }

  notes(): KaraNote[] {
    return (
      this.db
        .prepare("SELECT * FROM kara_notes ORDER BY captured_at DESC, id DESC")
        .all() as unknown as NoteRow[]
    ).map(toNote);
  }

  /** Going back to it and dropping it are the only two things v0.1.6 offers. */
  dropNote(id: string): this {
    this.db.prepare("DELETE FROM kara_notes WHERE id = ?").run(id);
    return this;
  }

  close(): void {
    this.db.close();
  }
}
