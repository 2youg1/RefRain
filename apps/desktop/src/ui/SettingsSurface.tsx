// 设置页外壳（SPEC 9.8 投影）：三个分类共用一个 Config，每项更改立即落盘。
//
// 「撤销本次调整」的语义修正
// ---------------------------------------------------------------------------
// 旧实现有一个真实缺陷：`undoSession` 用 `restoreAppearance` 回灌进入设置页时
// 拍下的**整个 appearance 快照**，而点亮按钮的 `changed` 标志由任意一次
// `config-changed` 事件设置（包含排版改动）。后果是：作者只调了排版、然后点
// 「撤销本次调整」，主题与纸面会被一起拖回进入时的样子——但按钮承诺的是
// 「本次调整」，不是「本次会话开始时的全部外观」。
//
// 正确语义：「本次调整」= 进入设置页时打的 mark 之后、本会话**真正被改过的
// 那些字段**。所以这里按字段粒度记账：
//   1. `mark`   —— 进入时的 appearance 快照，撤销的目标值只从它身上取。
//   2. `latest` —— 最近一次观察到的 appearance（磁盘上的现值）。
//   3. `touched`—— 被本会话动过的**字段路径**集合（如 `typography.measure_tenths_em`、
//                  `theme`、`typography.fonts.latin`），由 mark 与 latest 的
//                  逐叶子比较累积得出，只增不减。
// 撤销时，从 `latest` 克隆一份，只把 `touched` 里**当前仍与 mark 不同**的路径
// 写回 mark 的值，其余字段（作者本次没碰过的主题、纸面、图标……）原样保留，
// 再作为一个完整的 AppearanceConfig 发出去。于是「只改排版 → 撤销」只回退排版。
// 同一套记账也让按钮的点亮变得诚实：不再是「来过事件」，而是「确有字段偏离 mark」。
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { describe, unwrap } from "../bridge";
import {
  type AppearanceConfig,
  commands,
  type PreferencesChangeDto,
} from "../generated/bindings.gen";
import { divergedPaths, type Leaves, leavesOf, readLeaf, writeLeaf } from "../shell/config-leaves";
import { IconPicker } from "./IconPicker";
import { ShortcutsPanel } from "./ShortcutsPanel";
import { ThemePicker } from "./ThemePicker";
import { TypographyPanel } from "./TypographyPanel";

type Section = "appearance" | "typography" | "shortcuts";

/**
 * 打开设置先落在排版。
 *
 * 外观是选主题与图标——装一次就不再动；排版是字体、字号、行距、版心，
 * 作者写一段就想调一次。默认值应当对着最常来的那件事。
 */
const DEFAULT_SECTION: Section = "typography";

type SettingsSurfaceProps = {
  returnLabel?: string;
  initialSection?: Section;
  onClosed?: () => void;
  onThemePicked?: (slug: string) => void;
};

// 排版排在第一位：作者最常回到设置页的理由是调排版（外观选一次就定了），
// 而默认落点已经是排版。分类顺序若仍把外观排在前面，作者进来就看到高亮落在
// 第二个 Tab 上——顺序与默认值必须说同一件事。
const SECTIONS = [
  { id: "typography", label: "排版", detail: "字体、版心、段落与预设" },
  { id: "appearance", label: "外观", detail: "主题、纸面与入口图标" },
  { id: "shortcuts", label: "快捷键", detail: "当前可用的键盘操作" },
] as const satisfies readonly { id: Section; label: string; detail: string }[];

// ——— 字段粒度记账用的最小遍历工具 ———
// appearance 是一棵纯数据树（生成的 DTO，无类实例、无函数）。这里把它摊平成
// 「叶子路径 -> JSON 值」，数组（如 typography_presets、fonts.priority）整体当
// 一个叶子：它们对作者而言就是一次整体选择，没有再细分的意义。

/** appearance 是纯数据；这两个转换只是换一个读写视角，没有放宽类型检查。 */
const asTree = (appearance: AppearanceConfig): Record<string, unknown> =>
  appearance as unknown as Record<string, unknown>;
const asAppearance = (tree: Record<string, unknown>): AppearanceConfig =>
  tree as unknown as AppearanceConfig;

export function SettingsSurface(props: SettingsSurfaceProps) {
  const [section, setSection] = createSignal<Section>(props.initialSection ?? DEFAULT_SECTION);
  const [mark, setMark] = createSignal<AppearanceConfig | null>(null);
  const [latest, setLatest] = createSignal<AppearanceConfig | null>(null);
  // 只增不减的「本会话动过的字段」账本。撤销成功后整本清空。
  const [touched, setTouched] = createSignal<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal("更改会立即保存");
  const [contentRevision, setContentRevision] = createSignal(0);
  let stopConfig: UnlistenFn | null = null;

  createEffect(() => {
    setSection(props.initialSection ?? DEFAULT_SECTION);
  });

  const current = createMemo(() => SECTIONS.find((entry) => entry.id === section()) ?? SECTIONS[0]);
  const canReset = createMemo(() => section() !== "shortcuts" && !busy());

  /** 当前仍偏离 mark、且确实被本会话动过的字段。撤销的作用域就是它。 */
  const pendingPaths = createMemo<string[]>(() => {
    const entered = mark();
    const now = latest();
    if (entered === null || now === null) return [];
    const diverged = new Set(divergedPaths(leavesOf(entered), leavesOf(now)));
    return [...touched()].filter((path) => diverged.has(path));
  });
  const changed = createMemo(() => pendingPaths().length > 0);

  /** 记账：把 latest 与 mark 的差异并入账本。这是唯一让字段变「脏」的入口。 */
  const observe = (appearance: AppearanceConfig): void => {
    const entered = mark();
    setLatest(structuredClone(appearance));
    if (entered === null) return;
    const diverged = divergedPaths(leavesOf(entered), leavesOf(appearance));
    if (diverged.length === 0) return;
    setTouched((previous) => {
      const next = new Set(previous);
      for (const path of diverged) next.add(path);
      return next;
    });
  };

  const apply = async (change: PreferencesChangeDto, message: string): Promise<void> => {
    setBusy(true);
    try {
      const snapshot = await unwrap(commands.updatePreferences(change));
      const appearance = snapshot.config.appearance;
      if (appearance !== undefined) {
        observe(appearance);
        props.onThemePicked?.(appearance.theme);
      }
      setError(null);
      setStatus(message);
      setContentRevision((revision) => revision + 1);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const resetCurrent = async (): Promise<void> => {
    switch (section()) {
      case "appearance":
        await apply({ kind: "resetVisual" }, "外观已恢复默认");
        return;
      case "typography":
        await apply({ kind: "resetTypography" }, "排版已恢复默认");
        return;
      case "shortcuts":
        return;
    }
  };

  // 「撤销本次调整」：逐字段回退，不是整体回灌。
  const undoSession = async (): Promise<void> => {
    const entered = mark();
    const now = latest();
    if (entered === null || now === null) return;
    const paths = pendingPaths();
    if (paths.length === 0) return;
    const enteredTree = asTree(entered);
    const restored = asTree(structuredClone(now));
    for (const path of paths) writeLeaf(restored, path, readLeaf(enteredTree, path));
    await apply({ kind: "restoreAppearance", value: asAppearance(restored) }, "已撤销本次调整");
    // 回退过的字段此刻与 mark 一致，账本可以整本合上：此后再点亮按钮必须是新的改动。
    setTouched(new Set<string>());
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    props.onClosed?.();
  };

  onMount(async () => {
    try {
      const snapshot = await unwrap(commands.readConfig());
      const appearance = snapshot.config.appearance;
      if (appearance !== undefined) {
        setMark(structuredClone(appearance));
        setLatest(structuredClone(appearance));
      }
      // 子面板（主题、图标、排版）自己写 Config；这里靠事件重新读取现值再记账，
      // 而不是「来过事件就算改过」。
      stopConfig = await listen("config-changed", () => {
        void (async () => {
          try {
            const fresh = await unwrap(commands.readConfig());
            const next = fresh.config.appearance;
            if (next !== undefined) observe(next);
            setStatus("已保存");
          } catch (cause) {
            setError(describe(cause));
          }
        })();
      });
      window.addEventListener("keydown", onKeydown);
    } catch (cause) {
      setError(describe(cause));
    }
  });

  onCleanup(() => {
    window.removeEventListener("keydown", onKeydown);
    stopConfig?.();
  });

  return (
    <section class="settings" aria-labelledby="settings-title">
      <div class="settings-frame">
        <header class="settings-hero">
          <button class="settings-back" type="button" onClick={() => props.onClosed?.()}>
            <span aria-hidden="true">←</span>
            返回 {props.returnLabel ?? "工作台"}
          </button>
          <div class="settings-heading">
            <span class="settings-eyebrow">工作环境</span>
            <h2 id="settings-title">设置</h2>
            <p>调整阅读与写作环境。每项更改会自动保存在这台电脑中。</p>
          </div>
          <div class="settings-actions">
            <span class="settings-status" aria-live="polite">
              {status()}
            </span>
            <Show when={section() !== "shortcuts"}>
              <button type="button" disabled={!canReset()} onClick={() => void resetCurrent()}>
                恢复本页默认
              </button>
            </Show>
            <button
              type="button"
              disabled={!changed() || busy()}
              onClick={() => void undoSession()}
            >
              撤销本次调整
            </button>
            <button class="primary" type="button" onClick={() => props.onClosed?.()}>
              完成
            </button>
          </div>
        </header>

        <div class="settings-tabs" aria-label="设置分类" role="tablist">
          <For each={SECTIONS}>
            {(entry) => (
              <button
                type="button"
                role="tab"
                aria-selected={section() === entry.id}
                classList={{ current: section() === entry.id }}
                onClick={() => setSection(entry.id)}
              >
                <span>{entry.label}</span>
                <small>{entry.detail}</small>
              </button>
            )}
          </For>
        </div>

        <div class="settings-panel" role="tabpanel" aria-label={current().label}>
          <Show when={section() === "appearance"}>
            {/* keyed：恢复默认后整块重挂，子面板重新读一次 Config。 */}
            <Show keyed when={`visual-${contentRevision()}`}>
              <div class="settings-grid">
                <article class="settings-card settings-card-wide">
                  <div class="card-heading">
                    <span>阅读环境</span>
                    <p>选择整套色彩与纸面边界。选择本身就是预览。</p>
                  </div>
                  <ThemePicker onPicked={(slug: string) => props.onThemePicked?.(slug)} />
                </article>
                <article class="settings-card">
                  <div class="card-heading">
                    <span>写作入口图标</span>
                    <p>替换编辑区写作入口的图形。RefRain Logo 不受影响。</p>
                  </div>
                  <div class="icon-setting">
                    <IconPicker />
                    <span>PNG 或 SVG</span>
                  </div>
                </article>
              </div>
            </Show>
          </Show>

          <Show when={section() === "typography"}>
            <Show keyed when={`type-${contentRevision()}`}>
              <article class="settings-card typography-card">
                <div class="card-heading">
                  <span>手稿排版</span>
                  <p>从本机字体与语言预设开始，再调整字形、段落、版心和页面留白。</p>
                </div>
                <TypographyPanel />
              </article>
            </Show>
          </Show>

          <Show when={section() === "shortcuts"}>
            <article class="settings-card shortcuts-card">
              <div class="card-heading">
                <span>键盘操作</span>
                <p>这里只列出已经生效的操作。当前版本不提供无效的改键开关。</p>
              </div>
              <ShortcutsPanel />
            </article>
          </Show>
        </div>

        <Show when={error()}>
          {(message) => (
            <p class="settings-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
      </div>
    </section>
  );
}
