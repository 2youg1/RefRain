#!/usr/bin/env node
/**
 * Run one gate script under Node with the Bun API surface it uses.
 *
 * Why this exists: Playwright's two CDP transports both hang when the driver
 * runs under Bun on Windows (the pipe file descriptors never connect; the
 * bundled WebSocket client never finishes its handshake). The same scripts
 * pass under Node on the same machine, and under Bun everywhere else. So on
 * Windows the browser-driving gates re-exec themselves here, and this file
 * gives them the slice of `Bun.*` they actually call — nothing more.
 */

import { spawnSync } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

class BunFile {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  async text(): Promise<string> {
    return readFileSync(this.path, "utf8");
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    const buffer = readFileSync(this.path);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }
  async exists(): Promise<boolean> {
    return existsSync(this.path);
  }
  get size(): number {
    return statSync(this.path).size;
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "target")
        continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\{([^}]+)\}/g, (_m: string, group: string) => `(${group.split(",").join("|")})`);
  return new RegExp(`^${escaped}$`);
}

class Glob {
  readonly regex: RegExp;
  constructor(pattern: string) {
    this.regex = globToRegex(pattern.replaceAll("\\", "/"));
  }
  async *scan({ cwd }: { cwd: string }): AsyncGenerator<string> {
    const base = resolve(cwd);
    for (const file of walk(base)) {
      const relative = file.slice(base.length + 1).replaceAll(sep, "/");
      if (this.regex.test(relative)) yield relative;
    }
  }
}

class CryptoHasher {
  readonly #hash: Hash;
  constructor(algorithm: string) {
    this.#hash = createHash(algorithm === "blake2b256" ? "blake2b512" : algorithm);
  }
  update(data: string | Uint8Array): this {
    this.#hash.update(data);
    return this;
  }
  digest(encoding: "hex" | "base64" = "hex"): string {
    return this.#hash.digest(encoding);
  }
}

type ServeOptions = {
  port?: number;
  fetch: (request: Request) => Response | Promise<Response> | undefined;
};

async function serve(options: ServeOptions): Promise<{ port: number; stop: () => void }> {
  const server = http.createServer((request, response) => {
    void (async () => {
      const result = await options.fetch(new Request(`http://127.0.0.1${request.url ?? ""}`));
      if (result instanceof Response) {
        response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
        response.end(Buffer.from(await result.arrayBuffer()));
      } else {
        response.writeHead(404);
        response.end();
      }
    })();
  });
  await new Promise<void>((resolveListen) => {
    server.listen(options.port ?? 0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : 0,
    stop: () => server.close(),
  };
}

type BuildOptions = {
  entrypoints: string[];
  outdir?: string;
  target?: string;
  format?: string;
  minify?: boolean;
  write?: boolean;
};

type BuildOutput = { text: () => Promise<string> };
type BuildResult = { success: boolean; outputs: BuildOutput[]; logs: string[] };

async function build(options: BuildOptions): Promise<BuildResult> {
  // Bundle with the Bun CLI: one process, no API bridge. write:false means the
  // caller only wants the text, so write to a temp dir and read it back.
  const outdir = options.outdir ?? join(process.env.TEMP ?? ".", `bun-build-${process.pid}`);
  mkdirSync(outdir, { recursive: true });
  const args = [
    "build",
    ...options.entrypoints,
    "--outdir",
    outdir,
    "--target",
    options.target ?? "browser",
  ];
  if (options.format) args.push("--format", options.format);
  if (options.minify) args.push("--minify");
  const result = spawnSync("bun", args, { encoding: "utf8" });
  if (result.status !== 0) {
    return { success: false, outputs: [], logs: [result.stderr ?? result.stdout] };
  }
  const outputs = readdirSync(outdir)
    .filter((file) => file.endsWith(".js"))
    .map((file) => ({
      text: async () => readFileSync(join(outdir, file), "utf8"),
    }));
  return { success: true, outputs, logs: [] };
}

const BunShim = {
  file: (path: string) => new BunFile(path),
  write: (path: string, data: string | Uint8Array) => writeFileSync(path, data),
  serve,
  build,
  Glob,
  CryptoHasher,
  spawnSync: (command: string[], opts?: object) =>
    spawnSync(command[0] ?? "", command.slice(1), opts ?? {}),
  env: process.env,
};

(globalThis as Record<string, unknown>).Bun = BunShim;

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/node-gate.ts <script>");
  process.exit(1);
}
await import(pathToFileURL(resolve(target)).href);
