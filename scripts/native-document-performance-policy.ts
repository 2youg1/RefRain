import { DEFAULT_VIEWPORT_BLOCKS } from "../apps/native/src/generated/protocol.ts";

export interface NativeInteractionReport extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: 2;
  readonly runsPerOperation: 20;
  readonly fixture: Readonly<Record<string, unknown>>;
  readonly checks: Readonly<Record<string, boolean>>;
  readonly passed: true;
}

/** Parse the child verifier output and reject any partial or self-contradictory report. */
export function parseNativeInteractionReport(stdout: string): NativeInteractionReport {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (error: unknown) {
    throw new Error(
      `Native interaction verifier did not return one JSON report: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error("Native interaction verifier did not return one JSON object");
  }
  const fixture = value.fixture;
  if (
    value.schemaVersion !== 2 ||
    value.runsPerOperation !== 20 ||
    !isRecord(fixture) ||
    fixture.blocks !== 100_000 ||
    fixture.bytes !== 11_953_766 ||
    fixture.viewportBlocks !== DEFAULT_VIEWPORT_BLOCKS
  ) {
    throw new Error("Native interaction report does not prove the shared 100,000-block fixture");
  }
  // The identity of the source and of the binary belongs to the parent lane.
  // This verifier is a tier A program and compiles fully static: it cannot hash
  // a file. The parent collects the identity before the run and again after it,
  // and refuses a report whose binary changed under it.
  const checks = value.checks;
  if (!isRecord(checks) || Object.keys(checks).length === 0) {
    throw new Error("Native interaction report has no named checks");
  }
  if (!Object.values(checks).every((check) => check === true)) {
    throw new Error("Native interaction report checks are not all true");
  }
  if (value.passed !== true) {
    throw new Error("Native interaction report is not passing");
  }
  return value as NativeInteractionReport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const machineIdWarning =
  /^\(refrain:\d+\): Gtk-WARNING \*\*: \d{2}:\d{2}:\d{2}\.\d{3}: Unable to acquire session bus: Cannot spawn a message bus without a machine-id: Unable to load \/var\/lib\/dbus\/machine-id or \/etc\/machine-id: Failed to open file [“”‘’'"?]?\/(?:var\/lib\/dbus|etc)\/machine-id[“”‘’'"?]?: No such file or directory$/u;

// Command ids carry dots (`go.2`, `document.undo`) — the same one-space W1
// names `app.zon` declares. The old shape admitted only `[a-z0-9_]+`, so the
// first command this lane sent read as unexpected stderr.
const runtimeEvent = /^ts=\d+ level=info kind=event name="runtime\.event" event="[a-z0-9_.]+"$/;

/**
 * The SDK's own note that Windows has no live status-item presentation. It is a
 * platform capability statement, not a fault: the menu still updates, and the
 * app never claimed the live channel. Accepted verbatim, so a different warning
 * still fails.
 */
const statusItemWarning =
  "warning(zero_ui_app): status item presentation updates unsupported on this platform: the menu keeps updating";

/**
 * Reject every Native runtime stderr payload except event telemetry, the one
 * complete warning produced when the rootless Linux evidence environment has
 * no machine-id, and the one Windows capability note.
 */
export function assertNativeRuntimeStderr(stderr: string): void {
  const message = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !runtimeEvent.test(line))
    .join("\n");
  if (message.length === 0 || machineIdWarning.test(message) || message === statusItemWarning) {
    return;
  }
  throw new Error(`unexpected native runtime stderr:\n${message}`);
}

/** Accept only the Native SDK's documented silent, delivery, and assertion records. */
export function assertNativeAutomationStderr(
  stderr: string,
  command: string,
  automationDir: string,
): void {
  // Compare the delivery path separator-insensitively: the CLI prints the
  // platform's own path, and this file must not decide that one platform's
  // separator is the true one.
  const samePath = (left: string, right: string): boolean =>
    left.replaceAll("\\", "/") === right.replaceAll("\\", "/");
  const delivered = stderr.match(/^delivered (?<command>[a-z-]+) -> (?<dir>.+)\n$/);
  const expectedDelivery =
    delivered?.groups?.command === command && samePath(delivered.groups.dir ?? "", automationDir);
  const expectedAssertion =
    command === "assert" &&
    /^assert ok: \d+ pattern\(s\) (?:absent|matched) after \d+ms\n$/.test(stderr);
  if (stderr.length === 0 || expectedDelivery || expectedAssertion) return;
  throw new Error(`native automate ${command} wrote unexpected stderr\n${stderr}`);
}
