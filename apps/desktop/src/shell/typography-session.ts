/**
 * The one owner of "how this author's manuscript is set".
 *
 * Four operations previously lived in the panel, and all four ended the same
 * way: cross the bridge, receive a whole `Config` snapshot, and pick the
 * typography and the preset list out of it. Writing that projection four times
 * is how a missing concept announces itself — the concept is "a snapshot has
 * landed", and it is `#absorb` below.
 *
 * The panel keeps one thing this session refuses to hold: the per-slot search
 * text. That is a property of the widget an author is looking at, not of how
 * the manuscript is set, and putting it here would make the session lie about
 * its subject.
 *
 * Framework-free: no solid-js import, no DOM. Testable by calling it.
 */

import { unwrap } from "../bridge";
import {
  type BuiltinTypographyPreset,
  type ConfigSnapshot,
  commands,
  type FontFamilyDto,
  type FontSlot,
  type TypographyConfig,
  type TypographyPreset,
} from "../generated/bindings.gen";
import { type Activity, type DescribeError, Session } from "./session";

/**
 * Read-only all the way down.
 *
 * `readonly` on a field stops reassignment but not mutation of what it points
 * at, which is exactly the hole a shared config falls through.
 */
export type Immutable<T> = T extends (infer Element)[]
  ? readonly Immutable<Element>[]
  : T extends readonly (infer Element)[]
    ? readonly Immutable<Element>[]
    : T extends object
      ? { readonly [Key in keyof T]: Immutable<T[Key]> }
      : T;

/** The author-facing name of each font slot, used in the notices below. */
export const SLOT_NAME: Record<FontSlot, string> = {
  latin: "西文",
  chinese: "中文",
  japanese: "日文",
};

/** 数值键：TypographyConfig 里值为 number 的键，滑杆与数值输入只认它们。 */
export type NumericTypographyKey = {
  [Key in keyof TypographyConfig]: TypographyConfig[Key] extends number ? Key : never;
}[keyof TypographyConfig];

/**
 * What the panel renders.
 *
 * `typography` is null until the first snapshot lands. That is a real state —
 * the panel has nothing to show yet — so it is represented rather than faked
 * with defaults that would flash wrong values at the author.
 */
/** What this session can be busy doing. */
export type TypographyOperation = "load" | "write" | "save-preset" | "remove-preset";

export interface TypographyView {
  /**
   * Deeply read-only rather than a defensive clone: the panel reads this on
   * every render, so copying an entire config per read would put allocation on
   * a hot path to defend against a mistake the compiler can refuse outright.
   */
  readonly typography: Immutable<TypographyConfig> | null;
  readonly catalog: readonly FontFamilyDto[];
  readonly builtins: readonly BuiltinTypographyPreset[];
  readonly presets: readonly TypographyPreset[];
  readonly activity: Activity<TypographyOperation>;
}

/** Exactly the four calls this session makes. A test double is four functions. */
export interface TypographyGateway {
  readConfig(): Promise<ConfigSnapshot>;
  listFonts(): Promise<FontFamilyDto[]>;
  listBuiltinPresets(): Promise<BuiltinTypographyPreset[]>;
  updatePreferences(
    intent:
      | { kind: "setTypography"; value: TypographyConfig }
      | { kind: "saveTypographyPreset"; value: string }
      | { kind: "removeTypographyPreset"; value: string },
  ): Promise<ConfigSnapshot>;
}

export const browserTypographyGateway: TypographyGateway = {
  readConfig: () => unwrap(commands.readConfig()),
  listFonts: () => unwrap(commands.listFonts()),
  listBuiltinPresets: () => commands.listBuiltinTypographyPresets(),
  updatePreferences: (intent) => unwrap(commands.updatePreferences(intent)),
};

export class TypographySession extends Session<TypographyOperation> {
  #typography: Immutable<TypographyConfig> | null = null;
  #catalog: readonly FontFamilyDto[] = [];
  #builtins: readonly BuiltinTypographyPreset[] = [];
  #presets: readonly TypographyPreset[] = [];
  #pendingScrub: { key: NumericTypographyKey; value: number } | null = null;

  constructor(
    private readonly gateway: TypographyGateway,
    private readonly describe: DescribeError,
  ) {
    super();
  }

  protected describeError(error: unknown): string {
    return this.describe(error);
  }

  view(): TypographyView {
    return {
      typography: this.#typography,
      catalog: this.#catalog,
      builtins: this.#builtins,
      presets: this.#presets,
      activity: this.activity,
    };
  }

  load(): Promise<void> {
    return this.exclusive("load", async () => {
      const [snapshot, installed, builtins] = await Promise.all([
        this.gateway.readConfig(),
        this.gateway.listFonts(),
        this.gateway.listBuiltinPresets(),
      ]);
      this.#absorb(snapshot);
      this.#catalog = installed;
      this.#builtins = builtins;
      return `已找到 ${installed.length} 个字体家族`;
    });
  }

  /** Write one field of the manuscript setting. */
  setField<Key extends keyof TypographyConfig>(
    key: Key,
    value: TypographyConfig[Key],
  ): Promise<void> {
    const next = this.#draft();
    if (next === null) return Promise.resolve();
    next[key] = value;
    return this.#commit(next, "排版已保存");
  }

  /**
   * 拖动中的连续写入：一次拖动是「一次修改」，不是六十次。
   *
   * 桥上一次只在飞一笔写（exclusive 的重入拒绝）。拖动给出的中间值只记下
   * 最新的一个；在飞的那笔落地后，把最新值补写出去。没有这个，拖动收尾的
   * 那一下正好撞在飞行中的写上会被拒绝——作者拖到的值没生效，而滑杆已经
   * 停在那里。
   */
  scrubField(key: NumericTypographyKey, value: number): void {
    if (this.activity.kind === "working") {
      this.#pendingScrub = { key, value };
      return;
    }
    void this.setField(key, value).then(() => {
      const pending = this.#pendingScrub;
      if (pending === null) return;
      this.#pendingScrub = null;
      this.scrubField(pending.key, pending.value);
    });
  }

  setFamily(slot: FontSlot, family: string): Promise<void> {
    const next = this.#draft();
    if (next === null) return Promise.resolve();
    next.fonts[slot] = family;
    return this.#commit(next, `${SLOT_NAME[slot]}字体已保存`);
  }

  /**
   * Put one slot's glyphs first.
   *
   * Han characters shared across the three scripts are drawn by whichever slot
   * leads the priority list, so "promote" means move to the head while the rest
   * keep their order. Reordering, not replacing, is what preserves the author's
   * earlier choice between the two slots they did not just touch.
   */
  promote(slot: FontSlot): Promise<void> {
    const next = this.#draft();
    if (next === null) return Promise.resolve();
    next.fonts.priority = [slot, ...next.fonts.priority.filter((entry) => entry !== slot)] as [
      FontSlot,
      FontSlot,
      FontSlot,
    ];
    return this.#commit(next, `${SLOT_NAME[slot]}字形已优先`);
  }

  applyBuiltin(preset: BuiltinTypographyPreset, label: string): Promise<void> {
    return this.#commit(structuredClone(preset.typography), `已应用“${label}”`);
  }

  applyPreset(preset: TypographyPreset): Promise<void> {
    return this.#commit(structuredClone(preset.typography), `已应用“${preset.name}”`);
  }

  savePreset(rawName: string): Promise<void> {
    const name = rawName.trim();
    if (name === "") {
      this.report("请先为这套排版命名。");
      return Promise.resolve();
    }
    return this.exclusive("save-preset", async () => {
      this.#absorb(
        await this.gateway.updatePreferences({ kind: "saveTypographyPreset", value: name }),
      );
      return `已保存“${name}”`;
    });
  }

  removePreset(preset: TypographyPreset): Promise<void> {
    return this.exclusive("remove-preset", async () => {
      this.#absorb(
        await this.gateway.updatePreferences({
          kind: "removeTypographyPreset",
          value: preset.id,
        }),
      );
      return `已删除“${preset.name}”`;
    });
  }

  /**
   * Every weight offered by any font the author has currently selected, plus
   * the one in force. The one in force is included unconditionally so a config
   * naming a weight the catalogue no longer reports still renders its own value
   * rather than silently showing a different one.
   */
  availableWeights(): readonly number[] {
    const config = this.#typography;
    if (config === null) return [];
    const selected = new Set(
      Object.values(config.fonts).filter((entry): entry is string => typeof entry === "string"),
    );
    const weights = new Set<number>([config.font_weight]);
    for (const row of this.#catalog) {
      if (!selected.has(row.family)) continue;
      for (const weight of row.weights) weights.add(weight);
    }
    return [...weights].sort((left, right) => left - right);
  }

  /**
   * The families worth offering for one slot: whatever matches the author's
   * search, or the whole catalogue when they have not searched. The selected
   * family always survives the filter, because a list that can hide the
   * current choice makes the panel unable to show what is in force.
   *
   * 空查询不再只给内置推荐：list_fonts 已经把整台机器的字族摸过一遍，
   * 藏着不给等于替作者决定他机器上没有那些字。分组（内置/本机）是面板
   * 对 `bundledSlot` 的投影，不是这里的第二份清单。上限只用来兜住 DOM
   * 的大小——原生 <select> 画一千个 option 不费劲，所以放宽到一千。
   */
  visibleFamilies(slot: FontSlot, search: string, limit = 1000): readonly FontFamilyDto[] {
    const query = search.trim().toLocaleLowerCase();
    const selected = this.#typography?.fonts[slot];
    return this.#catalog
      .filter((entry) => {
        if (entry.family === selected) return true;
        if (query !== "") return entry.family.toLocaleLowerCase().includes(query);
        return true;
      })
      .slice(0, limit);
  }

  /** A mutable copy to edit, or null when nothing has loaded yet. */
  #draft(): TypographyConfig | null {
    return this.#typography === null
      ? null
      : (structuredClone(this.#typography) as TypographyConfig);
  }

  #commit(next: TypographyConfig, message: string): Promise<void> {
    return this.exclusive("write", async () => {
      this.#absorb(
        await this.gateway.updatePreferences({
          kind: "setTypography",
          value: structuredClone(next),
        }),
      );
      return message;
    });
  }

  /**
   * Take the typography and presets out of a Config snapshot.
   *
   * Cloning matters: the snapshot is shared structure from the bridge, and
   * handing it out directly would let an edit in the panel mutate the value the
   * session believes is on disk.
   */
  #absorb(snapshot: ConfigSnapshot): void {
    const appearance = snapshot.config.appearance;
    if (appearance === undefined) return;
    this.#typography = structuredClone(appearance.typography);
    this.#presets = structuredClone(appearance.typography_presets ?? []);
  }
}
