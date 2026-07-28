/**
 * Delete goes to the trash, everywhere.
 *
 * This is the one defect this application cannot apologise for: a writer who
 * loses a chapter has lost the work the whole thing exists to protect. The
 * promise is only worth as much as the thing that fails when it is broken, so
 * this scans every layer for a permanent-delete surface and exits non-zero if
 * one has appeared. The sole internal cleanup allowed is the source of a
 * cross-volume move, after an identical copy has already reached system trash.
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
import { fileURLToPath } from "node:url";

// `.pathname` on a file URL is not a path on Windows: it yields `/D:/a/repo`,
// and joining that produced `\D:\a\repo\packages\fs\src`, which does not
// exist. So this gate — the one guarding the only loss this application
// promises never to cause — crashed on the platform the installer ships to,
// and nobody knew, because it had only ever run on Linux. `fileURLToPath` is
// what every other script in the repository already used.
const root = fileURLToPath(new URL("..", import.meta.url));

const read = (path: string): string => readFileSync(join(root, path), "utf8");

const failures: string[] = [];
const check = (claim: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${claim}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(claim);
};

/*
 * 1 — the Rust layer.
 *
 * `remove_file` and `remove_dir_all` delete without recourse. Production may
 * use them only to remove the source of a cross-volume move after an identical
 * copy has reached system trash. That helper is private, has one caller, and is
 * removed from the broad source scan below; any second use turns this gate red.
 */
const rustSources = readdirSync(join(root, "packages/fs/src"))
  .filter((name) => name.endsWith(".rs"))
  .map((name) => ({ name, text: read(`packages/fs/src/${name}`) }));
const ops = read("packages/fs/src/ops.rs");
const cleanupStart = ops.indexOf("fn remove_after_recovery(path: &Path)");
const cleanupEnd = ops.indexOf("\n}\n\n/// Copy a file or a directory tree", cleanupStart);
const cleanup = cleanupStart >= 0 && cleanupEnd >= 0 ? ops.slice(cleanupStart, cleanupEnd + 2) : "";
const cleanupCalls = [...ops.matchAll(/\bremove_after_recovery\(/g)].length;
const crossVolumeOrder = [
  "copy_tree(&target, &staged)?;",
  "verify_copy(&target, &staged)?;",
  "send_to_trash(&staged)?;",
  "remove_after_recovery(&target)?;",
].reduce((after, clause) => {
  const at = ops.indexOf(clause, after);
  return at < 0 ? -1 : at + clause.length;
}, 0);
check(
  "the one permanent cleanup is private and single-purpose",
  cleanup.startsWith("fn remove_after_recovery") &&
    cleanup.includes("fs::remove_file") &&
    cleanup.includes("fs::remove_dir_all") &&
    cleanupCalls === 2,
  `${cleanupCalls - 1} call site(s)`,
);
check(
  "cross-volume cleanup follows copy, byte verification, and system trash",
  crossVolumeOrder > 0,
);

for (const { name, text } of rustSources) {
  // Everything from `#[cfg(test)]` onwards is test scaffolding. The narrowly
  // audited cleanup above is excluded; no other production deletion is legal.
  let production = text.split("#[cfg(test)]")[0] ?? text;
  if (name === "ops.rs" && cleanup) production = production.replace(cleanup, "");
  const permanent = /\bfs::remove_(file|dir_all|dir)\b/.exec(production);
  check(
    `packages/fs/src/${name} has no unguarded permanent deletion`,
    permanent === null,
    permanent ? `found ${permanent[0]}` : "",
  );
}

check("the Rust layer routes deletion through the system trash", ops.includes("trash::delete"));

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

const channels = [
  ...ipc.matchAll(
    /(?:\bipc\.handle|\bhandlers\.handle(?:OpenRoots|Root)?|\bhandleRoot)\(\s*"([^"]+)"/g,
  ),
].map((match) => match[1] ?? "");
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
