import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const workflows = resolve(root, ".github", "workflows");
const mutable: string[] = [];

for (const file of readdirSync(workflows)
  .filter((name) => name.endsWith(".yml"))
  .sort()) {
  const lines = readFileSync(resolve(workflows, file), "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    const action = line.match(/^\s*-\s+uses:\s+([^\s#]+)(?:\s+#.*)?$/)?.[1];
    if (!action || action.startsWith("./")) continue;
    if (!/@[0-9a-f]{40}$/.test(action)) mutable.push(`${file}:${index + 1}  ${action}`);
  }
}

if (mutable.length > 0) {
  console.error("FAIL  third-party Actions must name the reviewed commit, not a movable tag:");
  for (const use of mutable) console.error(`  ${use}`);
  process.exit(1);
}

console.log("PASS  every third-party Action is pinned to a 40-character commit");
