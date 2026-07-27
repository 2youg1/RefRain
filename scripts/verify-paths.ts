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

/**
 * Two ways a script can assume the filesystem uses forward slashes.
 *
 * Both were live in this repository and both failed only on Windows, in the
 * release job, having passed on Linux forever.
 */
const OFFENCES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /new URL\([^)]*import\.meta\.url[^)]*\)\s*\.\s*(pathname|href)/,
    "use fileURLToPath(new URL(...)) — .pathname yields /D:/… on Windows",
  ],
  [
    // Only where the string came from the filesystem. A stub splitting a
    // made-up POSIX path like "/work/01.md" inside a browser fixture is not
    // touching a real path and must not be flagged, or the gate cries wolf
    // and gets ignored — which is how a gate stops being read at all.
    /\b(?:file|entry|found|dirent|relative|resolved|full|abs)\w*\.split\(\s*["'`]\/["'`]\s*\)/i,
    'split(/[/\\\\]/) — Glob and path APIs return backslashes on Windows, so split("/") keeps the whole path',
  ],
];

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
    for (const [pattern, advice] of OFFENCES) {
      if (!pattern.test(line)) continue;
      failures.push(`${path.slice(root.length)}:${index + 1}  ${line.trim()}\n      ${advice}`);
    }
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
