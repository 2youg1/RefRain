import type { SourceExecutableIdentity } from "./native-document-evidence-identity.ts";

export interface NativeInteractionReport extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: 2;
  readonly runsPerOperation: 20;
  readonly fixture: Readonly<Record<string, unknown>>;
  readonly checks: Readonly<Record<string, boolean>>;
  readonly identity: SourceExecutableIdentity & Readonly<Record<string, unknown>>;
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
    fixture.viewportBlocks !== 24
  ) {
    throw new Error("Native interaction report does not prove the shared 100,000-block fixture");
  }
  const identity = value.identity;
  if (
    !isRecord(identity) ||
    typeof identity.sourceRevision !== "string" ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(identity.sourceRevision) ||
    typeof identity.sourceDirty !== "boolean" ||
    !isSha256(identity.dirtyManifestSha256) ||
    !isSha256(identity.executableSha256)
  ) {
    throw new Error("Native interaction report has no complete source and executable identity");
  }
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

function isSha256(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const machineIdWarning =
  /^\(refrain:\d+\): Gtk-WARNING \*\*: \d{2}:\d{2}:\d{2}\.\d{3}: Unable to acquire session bus: Cannot spawn a message bus without a machine-id: Unable to load \/var\/lib\/dbus\/machine-id or \/etc\/machine-id: Failed to open file [“”‘’'"?]?\/(?:var\/lib\/dbus|etc)\/machine-id[“”‘’'"?]?: No such file or directory$/u;

const runtimeEvent = /^ts=\d+ level=info kind=event name="runtime\.event" event="[a-z0-9_]+"$/;

/**
 * Reject every Native runtime stderr payload except event telemetry and the one
 * complete warning produced when the rootless Linux evidence environment has
 * no machine-id.
 */
export function assertNativeRuntimeStderr(stderr: string): void {
  const message = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !runtimeEvent.test(line))
    .join("\n");
  if (message.length === 0 || machineIdWarning.test(message)) return;
  throw new Error(`unexpected native runtime stderr:\n${message}`);
}

/** Accept only the Native SDK's documented silent, delivery, and assertion records. */
export function assertNativeAutomationStderr(
  stderr: string,
  command: string,
  automationDir: string,
): void {
  const expectedDelivery = `delivered ${command} -> ${automationDir}\n`;
  const expectedAssertion =
    command === "assert" &&
    /^assert ok: \d+ pattern\(s\) (?:absent|matched) after \d+ms\n$/.test(stderr);
  if (stderr.length === 0 || stderr === expectedDelivery || expectedAssertion) return;
  throw new Error(`native automate ${command} wrote unexpected stderr\n${stderr}`);
}
