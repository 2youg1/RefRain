import type { Browser } from "playwright";
import { chromium } from "playwright";

/**
 * One place that starts a browser for the rendering gates.
 *
 * Sixteen scripts each called `chromium.launch()` with no options, which is why
 * the failure below could only ever be fixed one gate at a time.
 *
 * **Windows needs a port, not a pipe.** Playwright speaks CDP over an extra file
 * descriptor by default (`--remote-debugging-pipe`). Under Bun on Windows that
 * descriptor never connects: the browser starts — the log says `<launched>
 * pid=…` — and the handshake then waits until the timeout. Raising the timeout
 * from 180 seconds to 600 changed nothing except how long the release took to
 * fail, which is how I learned it was not a slow cold start. Bun's Windows
 * handling of child descriptors past stderr differs from Node's, and the pipe
 * transport depends on it; the same script passes under Bun on Linux, which is
 * why these gates looked healthy for as long as CI ran on Linux alone.
 *
 * `PLAYWRIGHT_CHROMIUM_USE_WEBSOCKET` moves the handshake onto a loopback port,
 * needing no extra descriptor. Loopback only, so SPEC 1.3 is untouched: a test
 * tool talking to a browser it started itself is not an outbound request.
 *
 * I could not verify this on Windows from the machine that wrote it — no
 * Windows side, no display. So the failure path says what it is rather than
 * reporting a bare timeout: a gate that cannot tell "the application is broken"
 * from "the browser never connected" costs an afternoon every time it fires.
 */
export const launchBrowser = async (): Promise<Browser> => {
  const windows = process.platform === "win32";
  if (windows) process.env.PLAYWRIGHT_CHROMIUM_USE_WEBSOCKET = "1";

  try {
    return await chromium.launch({ timeout: 180_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Timeout|ECONNREFUSED|closed/i.test(message)) throw error;

    console.error(
      `the browser did not connect${windows ? " (Windows, websocket transport)" : ""}: ${message}\n` +
        "  This is the harness, not the application under test. If it persists,\n" +
        "  run this gate under Node rather than Bun — Playwright's transport\n" +
        "  relies on child-process descriptors Bun handles differently on Windows.",
    );
    throw error;
  }
};

/**
 * A complete stand-in for the preload bridge.
 *
 * Eighteen gates each hand-wrote their own `window.refrain`, and none of them
 * was complete — a method the stub forgot was `undefined` at call time, so the
 * component took its empty branch and the gate reported PASS on a screen no
 * user would ever see. verify-anchor failed exactly this way.
 *
 * Gates spread this first, then override the handful of methods they actually
 * drive. `verify-bridge-parity` asserts the base stays level with preload.ts,
 * so a new bridge method turns that gate red until this object answers it.
 */
export const BRIDGE_STUB = `window.refrain = {
  openProject: async () => "/p", openFile: async () => null, createProject: async () => null,
  loadProject: async () => [], loadWorkspace: async () => ({ roots: [], chapters: [] }),
  revertEdit: async () => ({ ok: true }), revertAll: async () => ({ ok: true }),
  describeEdits: async () => [], resolveConflict: async () => ({ ok: true }),
  saveChapter: async () => ({ ok: true, edits: [] }),
  pathFor: () => "", resolveDrop: async () => null, fullscreen: async () => true,
  openProjectUrl: async () => true, systemFonts: async () => [], fonts: async () => [],
  listAgents: async () => [], probeAgent: async () => ({ ok: true }),
  trustAgent: async () => ({ ok: true }), removeAgent: async () => ({ ok: true }),
  addAgent: async () => ({}), enqueue: async () => true, manifest: async () => [],
  send: async () => [], collect: async () => ({ proposals: [], comments: [] }),
  runs: async () => [], commit: async () => ({ ok: true, text: "" }),
  ledger: async () => ({ ok: true, verdicts: [] }), reply: async () => "",
  searchLedger: async () => [],
  files: {
    scan: async () => [], search: async () => [], page: async () => [], sort: async () => [],
    copy: async () => ({ ok: true }), move: async () => ({ ok: true }),
    trash: async () => ({ ok: true }), trashViaHome: async () => ({ ok: true }),
    link: async () => ({ ok: true }), createDirectory: async () => ({ ok: true }),
    uniqueName: async () => "", admits: async () => true, searchDirectories: async () => [],
  },
  displayProfile: async () => ({ refreshHz: 60, scaleFactor: 1, css: {} }),
  onDisplayChange: () => {}, onOpenPaths: () => () => {}, onCloseRequest: () => () => {},
};`;
