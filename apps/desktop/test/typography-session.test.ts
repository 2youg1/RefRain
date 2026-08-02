/**
 * How the manuscript setting behaves, tested without a browser.
 *
 * The panel used to hold all of this, which meant none of it could be checked
 * without rendering. These are the invariants an author would notice breaking.
 */

import { describe, expect, test } from "bun:test";

import type {
  BuiltinTypographyPreset,
  ConfigSnapshot,
  FontFamilyDto,
  TypographyConfig,
  TypographyPreset,
} from "../src/generated/bindings.gen";
import { type TypographyGateway, TypographySession } from "../src/shell/typography-session";

const typography = (overrides: Partial<TypographyConfig> = {}): TypographyConfig =>
  ({
    font_weight: 400,
    fonts: {
      latin: "Jost",
      chinese: "Noto Sans SC",
      japanese: "Murecho",
      priority: ["latin", "chinese", "japanese"],
    },
    ...overrides,
  }) as unknown as TypographyConfig;

const snapshot = (
  config: TypographyConfig,
  presets: readonly TypographyPreset[] = [],
): ConfigSnapshot =>
  ({
    config: { appearance: { typography: config, typography_presets: presets } },
  }) as unknown as ConfigSnapshot;

const family = (name: string, slot: string | null, weights: number[]): FontFamilyDto =>
  ({ family: name, bundledSlot: slot, weights }) as unknown as FontFamilyDto;

const harness = (catalog: FontFamilyDto[] = []): Harness => {
  // One mutable object shared with the gateway. Spreading it into the returned
  // value would hand the test a copy, and writes to `rig.disk` would silently
  // never reach the gateway — a fixture that lies is worse than no fixture.
  const rig = {
    disk: typography(),
    presets: [] as readonly TypographyPreset[],
    writes: [] as unknown[],
  };
  const gateway: TypographyGateway = {
    readConfig: async () => snapshot(rig.disk, rig.presets),
    listFonts: async () => catalog,
    listBuiltinPresets: async () => [],
    updatePreferences: async (intent) => {
      rig.writes.push(intent);
      if (intent.kind === "setTypography") rig.disk = intent.value;
      if (intent.kind === "removeTypographyPreset") {
        rig.presets = rig.presets.filter((row) => row.id !== intent.value);
      }
      return snapshot(rig.disk, rig.presets);
    },
  };
  return Object.assign(rig, {
    session: new TypographySession(gateway, (error) => `失败:${String(error)}`),
  });
};

describe("TypographySession", () => {
  test("nothing renders until the first snapshot lands", () => {
    const { session } = harness();
    expect(session.view().typography).toBeNull();
    expect(session.availableWeights()).toEqual([]);
  });

  test("loading reports how many families this machine has", async () => {
    const rig = harness([family("Jost", "latin", [400])]);
    await rig.session.load();
    expect(rig.session.view().activity).toEqual({
      kind: "reported",
      text: "已找到 1 个字体家族",
    });
    expect(rig.session.view().typography).not.toBeNull();
  });

  test("editing before load writes nothing rather than throwing", async () => {
    const rig = harness();
    await rig.session.setField("font_weight" as never, 700 as never);
    expect(rig.writes).toHaveLength(0);
  });

  test("promoting a slot moves it first and keeps the others in order", async () => {
    const rig = harness();
    await rig.session.load();
    await rig.session.promote("japanese");
    expect(rig.session.view().typography?.fonts.priority).toEqual(["japanese", "latin", "chinese"]);
    expect(rig.session.view().activity).toEqual({ kind: "reported", text: "日文字形已优先" });
  });

  test("promoting the slot that already leads changes nothing about the order", async () => {
    const rig = harness();
    await rig.session.load();
    await rig.session.promote("latin");
    expect(rig.session.view().typography?.fonts.priority).toEqual(["latin", "chinese", "japanese"]);
  });

  test("what the panel reads cannot be written back through", async () => {
    const rig = harness();
    await rig.session.load();
    const view = rig.session.view().typography;
    if (view === null) throw new Error("expected a loaded config");

    // The guarantee is enforced by the compiler, not by copying on every read:
    // `view.fonts.latin = "Tampered"` does not typecheck, and @ts-expect-error
    // fails the build if that ever stops being true. A runtime clone would have
    // put an allocation of the whole config on the panel's render path.
    // @ts-expect-error nested fields of a view are read-only
    view.fonts.latin = "Tampered";

    // Editing goes through the session, which drafts its own mutable copy.
    await rig.session.setFamily("latin", "Iowan Old Style");
    expect(rig.session.view().typography?.fonts.latin).toBe("Iowan Old Style");
  });

  test("an unnamed preset is refused with a message, not a silent no-op", async () => {
    const rig = harness();
    await rig.session.load();
    await rig.session.savePreset("   ");
    expect(rig.session.view().activity).toEqual({
      kind: "failed",
      text: "请先为这套排版命名。",
    });
    expect(rig.writes).toHaveLength(0);
  });

  test("a preset name is trimmed before it is saved", async () => {
    const rig = harness();
    await rig.session.load();
    await rig.session.savePreset("  夜读  ");
    expect(rig.writes).toContainEqual({ kind: "saveTypographyPreset", value: "夜读" });
  });

  test("the selected family survives a search that does not match it", async () => {
    const rig = harness([family("Jost", "latin", [400]), family("Iowan Old Style", null, [400])]);
    await rig.session.load();
    const visible = rig.session.visibleFamilies("latin", "iowan");
    expect(visible.map((row) => row.family)).toEqual(["Jost", "Iowan Old Style"]);
  });

  test("with no search the whole catalogue is offered, bundled and local alike", async () => {
    const rig = harness([
      family("Jost", "latin", [400]),
      family("Murecho", "japanese", [400]),
      family("Unrelated", null, [400]),
    ]);
    await rig.session.load();
    // 空查询只给内置推荐的那个版本，等于替作者决定他机器上没有别的字。
    expect(rig.session.visibleFamilies("latin", "").map((row) => row.family)).toEqual([
      "Jost",
      "Murecho",
      "Unrelated",
    ]);
  });

  test("拖动途中的连续写入：在飞只有一笔，最新值最后总会落地", async () => {
    const writes: TypographyConfig[] = [];
    let gateOpen = false;
    const waiters: (() => void)[] = [];
    const gateway: TypographyGateway = {
      readConfig: async () => snapshot(typography()),
      listFonts: async () => [],
      listBuiltinPresets: async () => [],
      updatePreferences: async (intent) => {
        if (intent.kind === "setTypography") {
          writes.push(intent.value);
          if (!gateOpen) await new Promise<void>((resolve) => waiters.push(resolve));
        }
        return snapshot(intent.kind === "setTypography" ? intent.value : typography());
      },
    };
    const session = new TypographySession(gateway, (error) => `失败:${String(error)}`);
    await session.load();

    session.scrubField("text_size_tenths_px", 200); // 第一笔起飞
    session.scrubField("text_size_tenths_px", 240); // 被在飞的那笔挡住，记下
    session.scrubField("text_size_tenths_px", 260); // 覆盖——拖动只认最新位置
    expect(writes).toHaveLength(1);

    gateOpen = true;
    for (const release of waiters.splice(0)) release();
    for (let tick = 0; tick < 20 && writes.length < 2; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // 240 永远不写：它不是作者停下的位置。260 必须补上：那是。
    expect(writes.map((config) => config.text_size_tenths_px)).toEqual([200, 260]);
  });

  test("the weight in force is offered even when no catalogue row reports it", async () => {
    const rig = harness([family("Jost", "latin", [300, 500])]);
    rig.disk = typography({ font_weight: 850 } as Partial<TypographyConfig>);
    await rig.session.load();
    expect(rig.session.availableWeights()).toContain(850);
    expect(rig.session.availableWeights()).toEqual([300, 500, 850]);
  });

  test("weights come only from families the author actually selected", async () => {
    const rig = harness([
      family("Jost", "latin", [400, 700]),
      family("Nobody Selected This", null, [100, 900]),
    ]);
    await rig.session.load();
    expect(rig.session.availableWeights()).toEqual([400, 700]);
  });

  test("a bridge failure is reported and the session stays usable", async () => {
    const rig = harness();
    await rig.session.load();
    const broken = new TypographySession(
      {
        readConfig: async () => {
          throw new Error("桥断了");
        },
        listFonts: async () => [],
        listBuiltinPresets: async () => [],
        updatePreferences: async () => snapshot(typography()),
      },
      (error) => `失败:${String(error)}`,
    );
    await broken.load();
    expect(broken.view().activity.kind).toBe("failed");
  });

  test("applying a builtin names it in the notice the author reads", async () => {
    const rig = harness();
    await rig.session.load();
    const preset = { id: "chinese-prose", typography: typography() } as BuiltinTypographyPreset;
    await rig.session.applyBuiltin(preset, "中文长文");
    expect(rig.session.view().activity).toEqual({
      kind: "reported",
      text: "已应用“中文长文”",
    });
  });
});
