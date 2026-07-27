import { type FSWatcher, lstatSync, readdirSync, watch } from "node:fs";
import { join } from "node:path";

const INTERNAL = new Set([".git", ".refrain", ".refrain-source", "node_modules"]);

const isVisibleChange = (filename: string | Buffer | null): boolean => {
  if (filename === null) return true;
  return !String(filename)
    .split(/[\\/]/)
    .some((part) => INTERNAL.has(part));
};

export interface RootChangeWatch {
  close(): void;
}

/**
 * Observe one Root without following symbolic links or app-owned state trees.
 *
 * Current Node watches whole trees on the release platforms. The directory-tree
 * fallback keeps tests and older runtimes honest rather than silently reducing a
 * recursive promise to the Root's first level.
 */
export const watchRootChanges = (
  root: string,
  changed: () => void,
  debounceMs = 80,
): RootChangeWatch => {
  const watchers = new Map<string, FSWatcher>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let reconcileNeeded = false;

  const schedule = (reconcile = false): void => {
    if (closed) return;
    reconcileNeeded ||= reconcile;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (reconcileNeeded) {
        reconcileNeeded = false;
        reconcileTree();
      }
      changed();
    }, debounceMs);
  };

  const attach = (path: string): void => {
    if (watchers.has(path)) return;
    try {
      const watcher = watch(path, { persistent: false }, (event, filename) => {
        if (!isVisibleChange(filename)) return;
        schedule(event === "rename");
      });
      watcher.on("error", () => {
        watcher.close();
        watchers.delete(path);
        schedule(true);
      });
      watchers.set(path, watcher);
    } catch {
      // A directory may disappear between traversal and attachment. Its parent
      // watcher will trigger another reconciliation if the Root still exists.
    }
  };

  const directories = (): Set<string> => {
    const found = new Set<string>();
    const pending = [root];
    while (pending.length > 0) {
      const directory = pending.pop();
      if (directory === undefined) break;
      try {
        if (!lstatSync(directory).isDirectory()) continue;
        found.add(directory);
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.isSymbolicLink() && !INTERNAL.has(entry.name))
            pending.push(join(directory, entry.name));
        }
      } catch {
        // One unreadable or concurrently removed directory does not blind the
        // rest of the Root.
      }
    }
    return found;
  };

  function reconcileTree(): void {
    const wanted = directories();
    for (const [path, watcher] of watchers) {
      if (wanted.has(path)) continue;
      watcher.close();
      watchers.delete(path);
    }
    for (const path of wanted) attach(path);
  }

  try {
    const watcher = watch(root, { persistent: false, recursive: true }, (_event, filename) => {
      if (isVisibleChange(filename)) schedule();
    });
    watcher.on("error", () => {
      watcher.close();
      watchers.delete(root);
      reconcileTree();
    });
    watchers.set(root, watcher);
  } catch {
    if (lstatSync(root).isDirectory()) reconcileTree();
    else attach(root);
  }

  return {
    close: () => {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
};
