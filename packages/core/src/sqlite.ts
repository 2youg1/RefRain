/**
 * SQLite access that works in both runtimes this package targets.
 *
 * `packages/core` runs under `bun test` and under Electron's Node, and the two
 * disagree on their SQLite builtin: Bun 1.3 ships `bun:sqlite` and has no
 * `node:sqlite`, while Node 22+ and Electron ship `node:sqlite` and no
 * `bun:sqlite`. A direct import of either passes in one runtime and throws at
 * load in the other — which is how `bun:sqlite` reached a release build.
 *
 * The two APIs differ only in the corner this module uses, so the adapter is
 * small enough to state in one file rather than pulling in a driver.
 */

export interface Statement {
  run(...params: (string | number | null)[]): unknown;
  all(...params: (string | number | null)[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

interface BunDatabaseConstructor {
  new (
    path: string,
    options?: { create?: boolean },
  ): {
    run(sql: string): void;
    query(sql: string): {
      run(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
    close(): void;
  };
}

interface NodeDatabaseConstructor {
  new (path: string): SqliteDatabase;
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

export const openDatabase = (path: string): SqliteDatabase => {
  if (isBun) {
    const { Database } = require("bun:sqlite") as { Database: BunDatabaseConstructor };
    const db = new Database(path, { create: true });
    return {
      exec: (sql) => db.run(sql),
      prepare: (sql) => db.query(sql) as Statement,
      close: () => db.close(),
    };
  }

  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: NodeDatabaseConstructor };
  return new DatabaseSync(path);
};
