import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchRootChanges } from "../src/main/file-watch.ts";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "refrain-file-watch-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await Bun.sleep(10);
};

test("an external nested change notifies once, while app state stays quiet", async () => {
  const nested = join(root, "material", "notes");
  const state = join(root, ".refrain");
  mkdirSync(nested, { recursive: true });
  mkdirSync(state);
  let changes = 0;
  const watcher = watchRootChanges(
    root,
    () => {
      changes += 1;
    },
    20,
  );

  writeFileSync(join(nested, "one.md"), "one", "utf8");
  writeFileSync(join(nested, "two.md"), "two", "utf8");
  await waitFor(() => changes > 0);
  expect(changes).toBe(1);

  writeFileSync(join(state, "host.json"), "{}", "utf8");
  await Bun.sleep(80);
  expect(changes).toBe(1);

  watcher.close();
});

/**
 * A closed watch is silent, and the assertion has to be able to see it fail.
 *
 * This started as a third clause of the test above: close, write, sleep 80ms,
 * expect no change. It passed with the watchers deliberately left running and
 * with the `closed` flag deliberately never set — a write after a debounce
 * window has elapsed produces its notification through a path that assertion
 * never observed. Two injections, two greens: it was asserting nothing.
 *
 * The failure branch exists when the write lands *while a debounce is already
 * pending*. A watch that ignores `close` fires that pending callback; a closed
 * one does not, because `close` clears the timer and `schedule` refuses to set
 * another.
 */
test("closing a watch cancels the notification already in flight", async () => {
  const nested = join(root, "material");
  mkdirSync(nested, { recursive: true });
  let changes = 0;
  const watcher = watchRootChanges(
    root,
    () => {
      changes += 1;
    },
    120,
  );

  writeFileSync(join(nested, "one.md"), "one", "utf8");
  // Inside the debounce window: the callback is scheduled but has not run.
  await Bun.sleep(30);
  expect(changes).toBe(0);

  watcher.close();
  await Bun.sleep(220);
  expect(changes).toBe(0);

  // And nothing arrives afterwards either.
  writeFileSync(join(nested, "two.md"), "two", "utf8");
  await Bun.sleep(220);
  expect(changes).toBe(0);
});
