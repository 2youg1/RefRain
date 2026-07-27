/**
 * A file URL's `.pathname` is not a path, and Windows is where that bites.
 *
 * `new URL("..", import.meta.url).pathname` yields `/D:/a/repo` on Windows.
 * Joining that produced `\D:\a\repo\packages\fs\src` — a path with a leading
 * backslash before a drive letter, which does not exist — so `verify:trash-only`
 * crashed with ENOENT. That gate guards the one loss this application promises
 * never to cause, and it had only ever run on Linux, where `.pathname` happens
 * to be correct. It failed on the platform the installer ships to, in the
 * release job, on the day of the release.
 *
 * Every other script in the repository already used `fileURLToPath`. This is
 * therefore not a design question but a lint: one arm of a convention had
 * drifted, and no platform-independent check could see it.
 *
 * Catching it by grep rather than by running on Windows is the point. A gate
 * that only fails on one platform is a gate most contributors never see fail.
 *
 * Injection proof that this bites: change `verify-trash-only.ts` back to
 * `new URL("..", import.meta.url).pathname` and this exits 1 naming the file
 * and line.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Where scripts live. A script is the only place `import.meta.url` becomes a path. */
const DIRS = ["scripts", "apps/desktop/scripts", "packages/fs/scripts", "docs"];

/** `.pathname` or `.href` read off a URL built from `import.meta.url`, used as a path. */
const PATHNAME_OF_FILE_URL = /new URL\([^)]*import\.meta\.url[^)]*\)\s*\.\s*(pathname|href)/;

const walk = (dir: string): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : walk(path);
    return path.endsWith(".ts") || path.endsWith(".mjs") ? [path] : [];
  });
};

const files = DIRS.flatMap((dir) => walk(join(root, dir)));
const failures: string[] = [];

for (const path of files) {
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) return;
    if (!PATHNAME_OF_FILE_URL.test(line)) return;
    failures.push(
      `${path.slice(root.length)}:${index + 1}  ${line.trim()}\n` +
        "      use fileURLToPath(new URL(...)) — .pathname yields /D:/… on Windows",
    );
  });
}

// A check that scans a directory tree can silently degrade to scanning nothing
// once files move. This project has already shipped one of those.
if (files.length === 0) {
  console.error("found no scripts to scan — the directories moved and this check went blind");
  process.exit(1);
}

if (failures.length > 0) {
  console.error("a file URL is being used as a filesystem path\n");
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}

console.log(`PASS  ${files.length} scripts turn file URLs into paths the way Windows needs`);
