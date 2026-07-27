import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/bindings.rs", import.meta.url), "utf8");
const workspace = source.match(
  /#\[napi\]\nimpl Workspace \{([\s\S]*?)\n\}\n\n#\[napi\(object\)\]/,
)?.[1];

if (!workspace) throw new Error("the Workspace N-API impl could not be found");

test("every synchronous Workspace export catches an unwinding panic", () => {
  const exports: { declaration: string; attribute: string }[] = [];
  let attribute = "";

  for (const line of workspace.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#[napi")) attribute = trimmed;
    if (!trimmed.startsWith("pub fn ")) continue;
    exports.push({ declaration: trimmed, attribute });
    attribute = "";
  }

  expect(exports).toHaveLength(16);
  expect(exports.filter(({ attribute }) => !attribute.includes("catch_unwind"))).toEqual([]);
});
