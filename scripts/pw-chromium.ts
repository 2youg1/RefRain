// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

/**
 * One line at the top of every browser-driving gate script:
 *
 *   ensureNodeDriver(import.meta.url);
 *
 * Why: Playwright's two CDP transports both hang when the driver runs under
 * Bun on Windows (the pipe file descriptors never connect; the bundled
 * WebSocket client never finishes its handshake). The same scripts pass
 * under Node on the same machine, and under Bun everywhere else. So under
 * Bun on Windows the script re-execs itself through scripts/node-gate.ts,
 * which supplies the slice of `Bun.*` the gates actually call. Everywhere
 * else this returns without doing anything.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bunOnWindows = typeof Bun !== "undefined" && process.platform === "win32";

export function ensureNodeDriver(caller: string): void {
  if (!bunOnWindows || process.env.REFRAIN_NODE_DRIVER === "1") return;
  const here = dirname(fileURLToPath(import.meta.url));
  const script = fileURLToPath(caller);
  const result = spawnSync("node", [join(here, "node-gate.ts"), script], {
    stdio: "inherit",
    env: { ...process.env, REFRAIN_NODE_DRIVER: "1" },
  });
  process.exit(result.status ?? 1);
}
