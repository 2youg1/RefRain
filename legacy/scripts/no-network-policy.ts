import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Glob } from "bun";

export interface NetworkViolation {
  readonly path: string;
  readonly line: number;
  readonly what: string;
}

export interface NetworkAudit {
  readonly problems: string[];
  readonly violations: NetworkViolation[];
  readonly scannedSources: number;
  readonly scannedBundles: number;
}

const NETWORK_MODULE = String.raw`(?:(?:node:)?(?:http|https|http2|net|dgram|dns|tls)|undici)(?:[/\\][^"']*)?`;
const patterns = [
  { pattern: /\bfetch\s*(?:\?\.)?\s*\(/g, what: "fetch()" },
  { pattern: /\bXMLHttpRequest\b/g, what: "XMLHttpRequest" },
  { pattern: /\bWebSocket\b/g, what: "WebSocket" },
  { pattern: /\bEventSource\b/g, what: "EventSource" },
  {
    pattern: new RegExp(
      String.raw`\b(?:import|require)\s*\(\s*["']${NETWORK_MODULE}["']\s*\)`,
      "g",
    ),
    what: "network module",
  },
  {
    pattern: new RegExp(String.raw`\b(?:from|import)\s*["']${NETWORK_MODULE}["']`, "g"),
    what: "network module",
  },
  { pattern: /\bnet\s*\.\s*request\s*\(/g, what: "Electron net.request()" },
  { pattern: /\bautoUpdater\b/g, what: "autoUpdater" },
] as const;

const normalized = (path: string): string => path.split(sep).join("/");

/** Remove comments without changing offsets, so diagnostics still name the real line. */
const withoutComments = (source: string): string => {
  const masked = source.split("");
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "/" && next === "/") {
      for (; index < source.length && source[index] !== "\n"; index += 1) masked[index] = " ";
      index -= 1;
      continue;
    }
    if (char === "/" && next === "*") {
      for (; index < source.length; index += 1) {
        if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
        if (source[index] === "*" && source[index + 1] === "/") {
          masked[index + 1] = " ";
          index += 1;
          break;
        }
      }
    }
  }
  return masked.join("").replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n\r]/g, " "));
};

const inspect = (path: string, source: string): NetworkViolation[] => {
  const code = withoutComments(source);
  const violations: NetworkViolation[] = [];
  for (const { pattern, what } of patterns) {
    for (const match of code.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const module = match[0].includes("undici") ? "network package" : what;
      violations.push({
        path,
        line: code.slice(0, match.index).split("\n").length,
        what: module === "network module" ? "node network module" : module,
      });
    }
  }
  return violations;
};

const sourceSurfaces = [
  "packages/core/src/**/*.ts",
  "packages/agent/src/**/*.ts",
  "packages/fs/src/**/*.ts",
  "apps/desktop/src/main/**/*.ts",
  "apps/desktop/src/renderer/**/*.ts",
  "apps/desktop/src/renderer/**/*.svelte",
] as const;

interface DesktopManifest {
  files?: { path?: unknown }[];
}

const reviewedBundles = async (root: string, problems: string[]): Promise<string[]> => {
  const manifestPath = join(root, "apps/desktop/build/desktop-manifest.json");
  let manifest: DesktopManifest;
  try {
    manifest = JSON.parse(await Bun.file(manifestPath).text()) as DesktopManifest;
  } catch {
    problems.push("missing or invalid reviewed manifest: apps/desktop/build/desktop-manifest.json");
    return [];
  }

  const entries = (manifest.files ?? []).flatMap((entry) =>
    typeof entry.path === "string" ? [entry.path] : [],
  );
  const paths = entries.filter(
    (path) =>
      path === "dist/main/main.cjs" ||
      path === "dist/main/preload.cjs" ||
      (path.startsWith("dist/renderer/") && path.endsWith(".js")),
  );
  for (const required of ["dist/main/main.cjs", "dist/main/preload.cjs"])
    if (!paths.includes(required))
      problems.push(`reviewed manifest omits application bundle: ${required}`);
  if (!paths.some((path) => path.startsWith("dist/renderer/") && path.endsWith(".js")))
    problems.push("reviewed manifest omits every renderer JavaScript bundle");
  return paths;
};

export const auditNoNetwork = async (root: string): Promise<NetworkAudit> => {
  const problems: string[] = [];
  const violations: NetworkViolation[] = [];
  let scannedSources = 0;
  for (const surface of sourceSurfaces) {
    for await (const path of new Glob(surface).scan(root)) {
      scannedSources += 1;
      violations.push(...inspect(normalized(path), await Bun.file(join(root, path)).text()));
    }
  }
  if (scannedSources === 0) problems.push("the source scan matched no files — its globs are wrong");

  let scannedBundles = 0;
  for (const entry of await reviewedBundles(root, problems)) {
    const path = join(root, "apps/desktop", entry);
    const display = normalized(relative(root, path));
    if (!existsSync(path)) {
      problems.push(`missing reviewed bundle: ${display}`);
      continue;
    }
    scannedBundles += 1;
    violations.push(...inspect(display, await Bun.file(path).text()));
  }

  const cargoPath = join(root, "packages/fs/Cargo.toml");
  try {
    const cargo = await Bun.file(cargoPath).text();
    for (const crate of ["reqwest", "hyper", "ureq", "curl", "tokio-tungstenite"])
      if (new RegExp(`^\\s*${crate}\\s*=`, "m").test(cargo))
        violations.push({ path: "packages/fs/Cargo.toml", line: 1, what: crate });
  } catch {
    problems.push("missing Rust dependency manifest: packages/fs/Cargo.toml");
  }

  return { problems, violations, scannedSources, scannedBundles };
};
