import { describe, expect, test } from "bun:test";
import { DEFAULT_VIEWPORT_BLOCKS } from "../apps/native/src/generated/protocol.ts";
import {
  assertNativeAutomationStderr,
  assertNativeRuntimeStderr,
  parseNativeInteractionReport,
} from "./native-document-performance-policy.ts";

const machineIdWarning = `
(refrain:4281): Gtk-WARNING **: 16:42:11.120: Unable to acquire session bus: Cannot spawn a message bus without a machine-id: Unable to load /var/lib/dbus/machine-id or /etc/machine-id: Failed to open file “/var/lib/dbus/machine-id”: No such file or directory
`;

describe("native document performance stderr policy", () => {
  test("accepts a silent runtime", () => {
    expect(() => assertNativeRuntimeStderr("\n")).not.toThrow();
  });

  test("accepts Native SDK event telemetry", () => {
    expect(() =>
      assertNativeRuntimeStderr(
        'ts=1785765018190454773 level=info kind=event name="runtime.event" event="effects_wake"\n',
      ),
    ).not.toThrow();
  });

  test("accepts event telemetry plus one complete machine-id warning", () => {
    expect(() =>
      assertNativeRuntimeStderr(
        `ts=1785765018190454773 level=info kind=event name="runtime.event" event="effects_wake"\n${machineIdWarning}`,
      ),
    ).not.toThrow();
  });

  test("rejects a different GTK warning", () => {
    expect(() =>
      assertNativeRuntimeStderr(
        "(refrain:4281): Gtk-WARNING **: 16:42:11.120: cannot open display\n",
      ),
    ).toThrow("unexpected native runtime stderr");
  });

  test("rejects extra stderr beside the complete machine-id warning", () => {
    expect(() => assertNativeRuntimeStderr(`${machineIdWarning}panic: hidden failure\n`)).toThrow(
      "unexpected native runtime stderr",
    );
  });

  test("rejects a truncated machine-id warning", () => {
    expect(() =>
      assertNativeRuntimeStderr(
        "(refrain:4281): Gtk-WARNING **: 16:42:11.120: Unable to acquire session bus\n",
      ),
    ).toThrow("unexpected native runtime stderr");
  });
});

describe("Native SDK automation stderr policy", () => {
  test("accepts silent snapshot delivery", () => {
    expect(() => assertNativeAutomationStderr("", "snapshot", "/tmp/automation")).not.toThrow();
  });

  test("accepts the explicit delivery record", () => {
    expect(() =>
      assertNativeAutomationStderr(
        "delivered snapshot -> /tmp/automation\n",
        "snapshot",
        "/tmp/automation",
      ),
    ).not.toThrow();
  });

  test("accepts one exact assertion result", () => {
    expect(() =>
      assertNativeAutomationStderr(
        "assert ok: 3 pattern(s) matched after 12ms\n",
        "assert",
        "/tmp/automation",
      ),
    ).not.toThrow();
  });

  test("rejects unrelated automation stderr", () => {
    expect(() =>
      assertNativeAutomationStderr("warning: hidden failure\n", "snapshot", "/tmp/automation"),
    ).toThrow("native automate snapshot wrote unexpected stderr");
  });
});

describe("Native interaction report policy", () => {
  const report = {
    schemaVersion: 2,
    runsPerOperation: 20,
    fixture: { blocks: 100_000, bytes: 11_953_766, viewportBlocks: DEFAULT_VIEWPORT_BLOCKS },
    checks: { mountP95: true, noDispatchErrors: true },
    passed: true,
  } as const;

  test("accepts one complete passing report", () => {
    expect(parseNativeInteractionReport(JSON.stringify(report))).toEqual(report);
  });

  test("rejects a child report that claims passed beside a failed check", () => {
    const falseReport = { ...report, checks: { ...report.checks, noDispatchErrors: false } };

    expect(() => parseNativeInteractionReport(JSON.stringify(falseReport))).toThrow(
      "checks are not all true",
    );
  });

  test("rejects a report with the wrong workload identity", () => {
    const wrongFixture = { ...report, fixture: { ...report.fixture, bytes: 11_953_765 } };

    expect(() => parseNativeInteractionReport(JSON.stringify(wrongFixture))).toThrow(
      "shared 100,000-block fixture",
    );
  });
});
