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
