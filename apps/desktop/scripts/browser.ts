import type { Browser } from "playwright";
import { chromium } from "playwright";

/**
 * One place that starts a browser for the rendering gates.
 *
 * Playwright's default launch timeout is 180 seconds, which is generous on a
 * developer's machine and not always enough on a cold Windows runner: a release
 * failed because the browser had not finished starting, reported as a timeout
 * that said nothing about the application. Sixteen scripts each called
 * `chromium.launch()` with no options, so fixing it in one of them fixed it in
 * one of them.
 *
 * The wait is long because a slow machine is not a defect. A browser that never
 * starts still fails the gate, and the message still says which gate.
 */
export const launchBrowser = (): Promise<Browser> => chromium.launch({ timeout: 600_000 });
