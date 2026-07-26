/**
 * Delete goes to the trash, everywhere.
 *
 * This is the one defect this application cannot apologise for: a writer who
 * loses a chapter has lost the work the whole thing exists to protect. The
 * promise is only worth as much as the thing that fails when it is broken, so
 * this scans every layer for a permanent delete and exits non-zero if one has
 * appeared.
 *
 * It checks four surfaces, because a delete could be added at any of them:
 *
 *   1. the Rust file layer,
 *   2. the N-API binding,
 *   3. the TypeScript wrapper,
 *   4. the IPC channel table.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

const read = (path: string): string => readFileSync(join(root, path), "utf8");

const failures: string[] = [];
const check = (claim: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${claim}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(claim);
};

/*
 * 1 — the Rust layer.
 *
 * `remove_file` and `remove_dir_all` delete without recourse. The crate is
 * allowed to use them nowhere but its own tests, where a scratch directory is
 * being cleaned up rather than a manuscript.
 */
const rustSources = readdirSync(join(root, "packages/fs/src"))
  .filter((name) => name.endsWith(".rs"))
  .map((name) => ({ name, text: read(`packages/fs/src/${name}`) }));

for (const { name, text } of rustSources) {
  // Everything from `#[cfg(test)]` onwards is test scaffolding.
  const production = text.split("#[cfg(test)]")[0] ?? text;
  const permanent = /\bfs::remove_(file|dir_all|dir)\b/.exec(production);
  check(
    `packages/fs/src/${name} deletes nothing permanently`,
    permanent === null,
    permanent ? `found ${permanent[0]}` : "",
  );
}

check(
  "the Rust layer routes deletion through the system trash",
  read("packages/fs/src/ops.rs").includes("trash::delete"),
);

/*
 * 2 and 3 — the binding and the wrapper.
 *
 * A method named for permanent deletion must not exist. The name matters as
 * much as the behaviour: a caller reaching for `remove` should find nothing.
 */
const forbidden = /\b(remove_entry|delete_entry|unlink|purge|destroy)\b/;

check(
  "the N-API surface exposes no permanent delete",
  !forbidden.test(read("packages/fs/src/bindings.rs")),
);

const wrapper = read("packages/fs/src/index.ts");
check("the TypeScript wrapper exposes no permanent delete", !forbidden.test(wrapper));
check("the TypeScript wrapper exposes the trash", wrapper.includes("trash("));

/*
 * 4 — the IPC channel table.
 *
 * The renderer can only invoke what the preload bridge lists, so a permanent
 * delete would have to appear as a channel here first.
 */
// Every main-process module, not just ipc.ts. Extracting the file channels
// into their own file once silently emptied this check — a guard that reads one
// path is a guard a refactor can walk out from under.
const mainDir = join(root, "apps/desktop/src/main");
const ipc = readdirSync(mainDir)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => readFileSync(join(mainDir, name), "utf8"))
  .join("\n");

const channels = [...ipc.matchAll(/ipc\.handle\(\s*"([^"]+)"/g)].map((match) => match[1] ?? "");
check("the channel scan found handlers at all", channels.length > 0, `${channels.length} channels`);
const destructive = channels.filter((channel) =>
  /^files:(delete|remove|unlink|destroy|purge)/.test(channel),
);

check("no IPC channel deletes permanently", destructive.length === 0, destructive.join(", "));
check("the trash channel exists", channels.includes("files:trash"));

/*
 * The Source Backup is never written to, and the guard is the only thing
 * standing between an agent-suggested path and the author's original.
 */
const guard = read("packages/fs/src/guard.rs");
check("the guard refuses the Source Backup", guard.includes("SourceBackup"));
check(
  "every mutating operation passes through the guard",
  ["move_to", "copy", "trash", "link", "create_directory"].every((name) => {
    const body = read("packages/fs/src/ops.rs");
    const signature = new RegExp(`pub fn ${name}\\([^)]*guard: &Guard`);
    return signature.test(body);
  }),
);

/* A file layer that is not exercised by tests proves nothing. */
const fsTests = statSync(join(root, "packages/fs/test/boundary.test.ts"));
check("the boundary has its own tests", fsTests.size > 0);

if (failures.length > 0) {
  console.error(`\n${failures.length} invariant(s) violated`);
  process.exit(1);
}
console.log("\ndelete is recoverable at every layer");
