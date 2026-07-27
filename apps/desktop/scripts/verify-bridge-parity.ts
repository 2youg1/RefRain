/**
 * Every stubbed bridge answers what the real preload answers.
 *
 * Ten render gates each hand-write `window.refrain`, and nothing compared them
 * to the bridge they stand in for. The drift is silent by construction: a
 * method the stub forgets is `undefined` at call time, the component takes the
 * empty branch, and the gate reports PASS on a screen the user will never see.
 * verify-anchor failed exactly this way — it drove a panel whose accept button
 * was never reachable, and the failure read as a product defect.
 *
 * This gate is static. It parses the stub object literals out of the gate
 * scripts and the `contextBridge.exposeInMainWorld` call out of preload, then
 * asserts no stub is missing a key the real bridge exposes.
 *
 * A stub is allowed to be *narrower* only where the gate cannot reach that
 * surface. That exemption is declared here, per stub, with a reason — an
 * undeclared gap is a failure.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = fileURLToPath(new URL("..", import.meta.url));
const SCRIPTS = join(DESKTOP, "scripts");

/**
 * Surfaces a given gate provably never drives. Anything not listed here must
 * be present in every stub. Keep reasons specific: "unused" is not a reason.
 */
const EXEMPT: Record<string, { keys: string[]; because: string }> = {};

/**
 * Top-level keys of an object literal starting at `start`.
 *
 * Depth must count parentheses and brackets too, not just braces. A first pass
 * counted braces alone, so every arrow-function parameter and every TypeScript
 * annotation inside a method signature read as a key: `chapterId`, `payload`,
 * `throwing` and `it` all showed up as bridge methods that no stub provided.
 * The gate was loud and wrong, which is worse than silent.
 */
const keysOf = (source: string, start: number): Set<string> => {
  const keys = new Set<string>();
  let depth = 0;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    const prev = source[i - 1];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      else continue;
    }
    if (inBlockComment) {
      if (prev === "*" && ch === "/") inBlockComment = false;
      continue;
    }
    if (!inString && ch === "/" && next === "/") {
      inLineComment = true;
      continue;
    }
    if (!inString && ch === "/" && next === "*") {
      inBlockComment = true;
      continue;
    }
    if (inString) {
      if (ch === inString && prev !== "\\") inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    } else if (depth === 1 && (prev === "\n" || prev === "," || prev === "{")) {
      // A key at the top level of the literal. Requiring the previous
      // significant character to open a member position is what separates a
      // key from a parameter name: `fullscreen: (on: boolean) => ...` has both
      // `fullscreen` and `on` at brace-depth 1 once parentheses are counted,
      // and only the first is a bridge method.
      const match = /^\s*([a-zA-Z_$][\w$]*)\s*[:(]/.exec(source.slice(i));
      if (match?.[1]) keys.add(match[1]);
    }
  }
  return keys;
};

const memberObjectKeys = (
  source: string,
  start: number,
  member: string,
): Set<string> | undefined => {
  let depth = 0;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    const previous = source[index - 1];
    const next = source[index + 1];
    if (inLineComment) {
      if (character === "\n") inLineComment = false;
      else continue;
    }
    if (inBlockComment) {
      if (previous === "*" && character === "/") inBlockComment = false;
      continue;
    }
    if (!inString && character === "/" && next === "/") {
      inLineComment = true;
      continue;
    }
    if (!inString && character === "/" && next === "*") {
      inBlockComment = true;
      continue;
    }
    if (inString) {
      if (character === inString && previous !== "\\") inString = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      inString = character;
      continue;
    }
    if (character === "{" || character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth -= 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return undefined;
    } else if (depth === 1 && (previous === "\n" || previous === "," || previous === "{")) {
      const match = new RegExp(`^\\s*${member}\\s*:\\s*\\{`).exec(source.slice(index));
      if (match) return keysOf(source, index + match[0].lastIndexOf("{"));
    }
  }
  return undefined;
};

interface BridgeShape {
  readonly keys: Set<string>;
  readonly files: Set<string>;
}

const shapeOf = (source: string, start: number): BridgeShape => {
  const files = memberObjectKeys(source, start, "files");
  if (files === undefined)
    throw new Error("bridge literal has no files object — nested parity is blind");
  return { keys: keysOf(source, start), files };
};

const realBridge = (): BridgeShape => {
  const source = readFileSync(join(DESKTOP, "src/main/preload.ts"), "utf8");
  const call = source.search(/exposeInMainWorld\(\s*"refrain"\s*,\s*(\w+)\s*\)/);
  if (call < 0) throw new Error("preload.ts no longer exposes 'refrain' — this gate is blind");
  const exposed = /exposeInMainWorld\(\s*"refrain"\s*,\s*(\w+)\s*\)/.exec(source)?.[1];
  // The bridge is exposed by name, so follow the identifier to its definition.
  const declaration = exposed ? source.search(new RegExp(`const\\s+${exposed}\\s*[:=]`)) : -1;
  if (declaration < 0) throw new Error(`cannot find the definition of '${exposed}' in preload.ts`);
  const literal = source.indexOf("{", source.indexOf("=", declaration));
  const shape = shapeOf(source, literal);
  if (shape.keys.size === 0)
    throw new Error("parsed zero keys from preload — the gate would pass vacuously");
  return shape;
};

/** The shared base every gate is expected to spread before overriding. */
const baseShape = (): BridgeShape => {
  const source = readFileSync(join(SCRIPTS, "browser.ts"), "utf8");
  const assign = source.search(/BRIDGE_STUB\s*=/);
  if (assign < 0) throw new Error("browser.ts no longer exports BRIDGE_STUB — this gate is blind");
  return shapeOf(source, source.indexOf("{", assign));
};

const BASE = baseShape();

const stubs = readdirSync(SCRIPTS)
  .filter((name) => name.startsWith("verify-") && name.endsWith(".ts"))
  .flatMap((name) => {
    const source = readFileSync(join(SCRIPTS, name), "utf8");
    // Two shapes: a bare assignment, or an override spread over BRIDGE_STUB.
    // Matching only the first is how this gate went blind the moment every
    // stub was rebased — it found nothing and would have passed vacuously.
    const assign = source.search(/window\.refrain\s*=|Object\.assign\(window\.refrain\s*,/);
    if (assign < 0) return [];
    const literal = source.indexOf("{", assign);
    const inheritsBase = source.includes("BRIDGE_STUB");
    const inheritedKeys = inheritsBase ? BASE.keys : new Set<string>();
    const ownFiles = memberObjectKeys(source, literal, "files");
    const inheritsFiles = inheritsBase && source.includes("...window.refrain.files");
    return [
      {
        name,
        source,
        keys: new Set([...inheritedKeys, ...keysOf(source, literal)]),
        files:
          ownFiles === undefined
            ? inheritsBase
              ? BASE.files
              : new Set<string>()
            : new Set([...(inheritsFiles ? BASE.files : []), ...ownFiles]),
      },
    ];
  });

if (stubs.length === 0) {
  console.error("FAIL  found no stubbed bridges — this gate scans by pattern and has gone blind");
  process.exit(1);
}

const real = realBridge();
let failed = false;

const reportDrift = (
  label: string,
  expected: Set<string>,
  actual: Set<string>,
  missingExempt: Set<string> = new Set(),
): void => {
  const missing = [...expected].filter((key) => !actual.has(key) && !missingExempt.has(key)).sort();
  const extra = [...actual].filter((key) => !expected.has(key)).sort();
  if (missing.length === 0 && extra.length === 0) return;
  failed = true;
  console.error(
    `FAIL  ${label} drifted from preload` +
      `${missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""}` +
      `${extra.length > 0 ? `; extra: ${extra.join(", ")}` : ""}`,
  );
};

reportDrift("BRIDGE_STUB", real.keys, BASE.keys);
reportDrift("BRIDGE_STUB.files", real.files, BASE.files);

for (const stub of stubs) {
  reportDrift(stub.name, real.keys, stub.keys, new Set(EXEMPT[stub.name]?.keys ?? []));
  reportDrift(`${stub.name}.files`, real.files, stub.files);
}

if (failed) {
  console.error(
    "\nA missing key is undefined at call time; an extra key gives the gate a\n" +
      "capability production does not have. Keep top-level and files methods in exact\n" +
      "parity, or declare a missing top-level key in EXEMPT with a concrete reason.",
  );
  process.exit(1);
}

/*
 * A gate nobody calls is a gate that does not exist. One script in this
 * directory sat unreferenced long enough to fail unnoticed, and its absence
 * was written into the design baseline as a product defect. Two lists —
 * what is on disk, what the workflows invoke — compared here so the drift
 * cannot repeat silently.
 */
const WORKFLOWS = join(DESKTOP, "../../.github/workflows");
const invoked = new Set(
  readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith(".yml"))
    .flatMap(
      (name) => readFileSync(join(WORKFLOWS, name), "utf8").match(/verify-[a-z-]+\.ts/g) ?? [],
    ),
);
const onDisk = readdirSync(SCRIPTS).filter((n) => n.startsWith("verify-") && n.endsWith(".ts"));
const uncalled = onDisk.filter((name) => !invoked.has(name)).sort();

if (uncalled.length > 0) {
  console.error(
    `FAIL  ${uncalled.length} gate(s) exist but no workflow runs them: ${uncalled.join(", ")}`,
  );
  console.error("      Wire it into .github/workflows, or delete it.");
  process.exit(1);
}

/*
 * Parity of keys is not parity of answers.
 *
 * `loadWorkspace` returned a bare chapter array before multi-Root, and two
 * stubs kept answering that way long after the real bridge began returning
 * `{ roots, chapters }`. One gate crashed the page it was driving — reported
 * as a product defect — and the other passed, because it never reached the
 * manuscript and so was covering the rot rather than finding it.
 *
 * Keys cannot catch this: the key was present in both. The shape is what
 * drifted, so the shape is what is asserted, for the bridge methods whose
 * answers the interface destructures.
 */
const SHAPES: Record<string, RegExp> = {
  loadWorkspace: /\{\s*roots\s*:|\(\{\s*roots/,
};

const wrongShape = stubs.flatMap(({ name, source }) =>
  Object.entries(SHAPES).flatMap(([method, shape]) => {
    const at = source.indexOf(`${method}:`);
    if (at === -1) return [];
    // The answer is whatever the stub's arrow function returns, up to the next
    // top-level key. Long enough to hold an object literal, short enough not to
    // run into an unrelated method that happens to match.
    const answer = source.slice(at, at + 400);
    return shape.test(answer) ? [] : [`${name}: ${method} does not answer { roots, … }`];
  }),
);

if (wrongShape.length > 0) {
  console.error(`FAIL  ${wrongShape.length} stub answer(s) have drifted from the real bridge:`);
  for (const line of wrongShape) console.error(`  ${line}`);
  console.error("      A stub that answers the wrong shape drives a screen no user will see.");
  process.exit(1);
}

console.log(
  `PASS  ${stubs.length} stubbed bridges match ${real.keys.size} top-level and ` +
    `${real.files.size} files methods; all ${onDisk.length} gates are wired into CI`,
);
