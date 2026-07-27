#!/usr/bin/env bun
/**
 * Every rebindable chord must reach a handler.
 *
 * Five bindings — saveAll, annotate, find, undo, redo — sat in
 * `DEFAULT_BINDINGS` with no handler behind any of them. They were worse than
 * absent. Settings listed them as rebindable, so the author configured a chord
 * and pressed it into silence; and `commandFor` matches by iteration order, so
 * a dead entry holding Ctrl+F shadowed whatever the author had rebound onto
 * that chord, and then nothing ran. Eight verdict chords had gone the same way
 * before them.
 *
 * The repair was to delete them until the features exist. This gate is what
 * keeps them deleted: a binding may be added back only together with the
 * handler that answers it. Static rather than rendered, because the question
 * is about two tables agreeing, and a browser cannot see a chord that is
 * missing from both.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const renderer = join(desktop, "src", "renderer");

const keys = await Bun.file(join(renderer, "keys.ts")).text();
const app = await Bun.file(join(renderer, "App.svelte")).text();

/** The ids in `DEFAULT_BINDINGS`, which is the list Settings offers to rebind. */
const declared = (() => {
  const table = /export const DEFAULT_BINDINGS[^{]*\{([\s\S]*?)\n\};/.exec(keys)?.[1];
  if (table === undefined) throw new Error("keys.ts no longer declares DEFAULT_BINDINGS");
  return [...table.matchAll(/^\s*(\w+):\s*"/gm)].map((match) => match[1] as string);
})();

/** The ids in App.svelte's `handlers` table — the commands a chord can reach. */
const handled = (() => {
  const table = /const handlers: Record<string, \(\) => void> = \{([\s\S]*?)\n {2}\};/.exec(
    app,
  )?.[1];
  if (table === undefined) throw new Error("App.svelte no longer declares a handlers table");
  return [...table.matchAll(/^\s*(\w+):/gm)].map((match) => match[1] as string);
})();

/*
 * `palette` is answered above the table, because toggling the command palette
 * has to run whether or not a command is bound to the chord. Naming it here
 * rather than loosening the parse keeps the exemption to one line and visible.
 */
const answeredElsewhere = ["palette"];

const reachable = new Set([...handled, ...answeredElsewhere]);

if (declared.length === 0 || handled.length === 0) {
  console.error("FAIL  parsed no bindings or no handlers — this gate is reading the wrong shape");
  process.exit(1);
}

const dead = declared.filter((id) => !reachable.has(id));
const orphaned = handled.filter((id) => !declared.includes(id));

if (dead.length > 0) {
  console.error("\nFAIL  these chords are rebindable in Settings and reach nothing:");
  for (const id of dead) console.error(`  ${id}`);
  console.error("\nGive each one a handler in App.svelte, or delete it from DEFAULT_BINDINGS.");
  console.error("A chord that does nothing still shadows the command bound to the same keys.");
  process.exit(1);
}

if (orphaned.length > 0) {
  console.error("\nFAIL  these handlers can never run — no binding names them:");
  for (const id of orphaned) console.error(`  ${id}`);
  process.exit(1);
}

console.log(`checked ${declared.length} bindings against ${handled.length} handlers`);
console.log("PASS  every rebindable chord reaches a handler, and every handler has a chord");
