#!/usr/bin/env node
/**
 * Launch the built app and require one successful process exit after the window
 * reports a finished load.
 *
 * The binary path comes from the `electron` package itself rather than a
 * node_modules/.bin shim: Bun hoists differently per platform, and on Windows
 * the shim waits on a console handle that never arrives under CI.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const smokeCheckPassed = ({ code, signal, output }) =>
  code === 0 && signal === null && output.split(/\r?\n/u).includes("SMOKE_OK");

const runLaunchCheck = () => {
  const require = createRequire(import.meta.url);
  const electron = require("electron");
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const child = spawn(electron, [join(root, "dist", "main", "main.cjs"), "--smoke"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
  });

  let output = "";
  let launchFailure;
  let timedOut = false;
  const capture = (chunk) => {
    const text = String(chunk);
    output += text;
    process.stdout.write(text);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.on("error", (error) => {
    launchFailure = error;
  });

  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 90_000);

  // `close`, not `exit`: the streams are drained before the marker is judged.
  child.on("close", (code, signal) => {
    clearTimeout(deadline);
    if (timedOut) console.error("\nFAIL  no window loaded within 90s");
    else if (launchFailure)
      console.error(`\nFAIL  electron did not launch: ${launchFailure.message}`);
    else if (smokeCheckPassed({ code, signal, output })) {
      console.log("\nPASS  the window finished loading and Electron exited cleanly");
      return;
    } else {
      const ended = signal === null ? `exit ${code}` : `signal ${signal}`;
      console.error(`\nFAIL  electron ended with ${ended} without one clean SMOKE_OK line`);
    }
    process.exitCode = 1;
  });
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runLaunchCheck();
