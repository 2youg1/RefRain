#!/usr/bin/env node
/**
 * Launch the built app and require the window to report a finished load.
 *
 * The binary path comes from the `electron` package itself rather than a
 * node_modules/.bin shim: bun hoists differently per platform, and on Windows
 * the shim waits on a console handle that never arrives under CI, so the job
 * hung until the runner killed it.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");
const root = dirname(dirname(fileURLToPath(import.meta.url)));

const child = spawn(electron, [join(root, "dist", "main", "main.cjs"), "--smoke"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
});

let output = "";
const capture = (chunk) => {
  const text = String(chunk);
  output += text;
  process.stdout.write(text);
};
child.stdout.on("data", capture);
child.stderr.on("data", capture);

const deadline = setTimeout(() => {
  console.error("\nFAIL  no window loaded within 90s");
  child.kill();
  process.exit(1);
}, 90_000);

child.on("exit", (code) => {
  clearTimeout(deadline);
  if (output.includes("SMOKE_OK")) {
    console.log("\nPASS  the window finished loading");
    process.exit(0);
  }
  console.error(`\nFAIL  electron exited ${code} without loading a window`);
  process.exit(1);
});
