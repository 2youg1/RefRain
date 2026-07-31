#!/usr/bin/env bun
/**
 * Probe: does one `health` command complete inside a real window?
 *
 * R0's acceptance asks for a round trip through the shipped shell, not through
 * a test harness (SPEC section 12, R0). This builds the frontend with a probe
 * flag, launches the actual Tauri binary, and waits for the frontend to write
 * its evidence file — which it does only after the generated binding returned a
 * HealthReport. The file is the channel because it survives the process and can
 * be read without a WebDriver session.
 *
 * **A display server is required and this probe says so when there is none.**
 * A missing display is a specific blocked exit, not a pass: a probe that goes
 * green without a window would claim a round trip that nothing observed.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";

const BINARY = "target/debug/refrain-desktop";
const EVIDENCE = "probe-results/window-health.json";
const DISPLAY = process.env.DISPLAY ?? ":99";

// A window needs a display. Without one the probe is blocked, not passing.
if (!existsSync(`/tmp/.X11-unix/X${DISPLAY.replace(":", "")}`)) {
  console.error(`BLOCKED  probe-window: no X server on ${DISPLAY}`);
  console.error("         Start one (Xvfb :99 -screen 0 1280x900x24) and run again.");
  console.error("         The round trip is unverified until a real window reports it.");
  process.exit(2);
}

if (!existsSync(BINARY)) {
  console.error(`BLOCKED  probe-window: ${BINARY} is not built`);
  console.error("         Run: cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml");
  process.exit(2);
}

rmSync(EVIDENCE, { force: true });
mkdirSync("probe-results", { recursive: true });

const build = spawnSync("bun", ["run", "build:web"], {
  cwd: "apps/desktop",
  encoding: "utf8",
  env: { ...process.env, VITE_REFRAIN_PROBE: "1" },
});
if (build.status !== 0) {
  console.error("PROBE RED: the frontend build failed");
  console.error(build.stdout, build.stderr);
  process.exit(1);
}

const application = spawn(BINARY, [], {
  env: { ...process.env, DISPLAY, REFRAIN_PROBE_EVIDENCE: EVIDENCE },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
application.stderr.on("data", (chunk) => {
  stderr += String(chunk);
});

try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !existsSync(EVIDENCE)) {
    if (application.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (!existsSync(EVIDENCE)) {
    console.error("PROBE RED: the window never reported a completed health round trip");
    console.error(`         process exit: ${application.exitCode}`);
    console.error(stderr.split("\n").slice(-12).join("\n"));
    process.exit(1);
  }

  const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8"));
  console.log(JSON.stringify(evidence, null, 2));
  console.log("\nPROBE GREEN: a real window completed the health round trip");
} finally {
  application.kill("SIGTERM");
}
