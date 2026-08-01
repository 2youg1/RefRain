// Settings share one Config and persist each change immediately.
// Undo restores only touched leaf paths from the entry mark; untouched current values remain.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { describe, unwrap } from "../bridge";
import {
  type AppearanceConfig,
  commands,
  type PreferencesChangeDto,
} from "../generated/bindings.gen";
import { divergedPaths, leavesOf, readLeaf, writeLeaf } from "../shell/config-leaves";
import { IconPicker } from "./IconPicker";
import { ShortcutsPanel } from "./ShortcutsPanel";
import { ThemePicker } from "./ThemePicker";
import { TypographyPanel } from "./TypographyPanel";

type Section = "appearance" | "typography" | "shortcuts";

type SettingsSurfaceProps = {
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

/** 页眉：状态一句话 + 三个动作。唯一的出口是「完成」（onClosed）。 */
function SettingsHeader(props: {
  status: string;
  showReset: boolean;
  canReset: boolean;
  canUndo: boolean;
  onReset: () => void;
  onUndo: () => void;
  onDone: () => void;
}): JSX.Element {
  return (
    <header class="settings-hero">
      <div class="settings-heading">
        <span class="settings-eyebrow">工作环境</span>
        <h2 id="settings-title">设置</h2>
        <p>调整阅读与写作环境。每项更改会自动保存在这台电脑中。</p>
      </div>
      <div class="settings-actions">
        <span class="settings-status" aria-live="polite">
          {props.status}
        </span>
        <Show when={props.showReset}>
          <button type="button" disabled={!props.canReset} onClick={props.onReset}>
            恢复本页默认
          </button>
        </Show>
        <button type="button" disabled={!props.canUndo} onClick={props.onUndo}>
          撤销本次调整
        </button>
        <button class="primary" type="button" onClick={props.onDone}>
          完成
        </button>
      </div>
    </header>
  );
}

export function SettingsSurface(props: SettingsSurfaceProps) {
  const [section, setSection] = createSignal<Section>(props.initialSection ?? "typography");
  const [mark, setMark] = createSignal<AppearanceConfig | null>(null);
  const [latest, setLatest] = createSignal<AppearanceConfig | null>(null);
  // 只增不减的「本会话动过的字段」账本。撤销成功后整本清空。
  const [touched, setTouched] = createSignal<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal("更改会立即保存");
  const [contentRevision, setContentRevision] = createSignal(0);
  let stopConfig: UnlistenFn | null = null;

  // Follow only a genuine section change (the author ran "open typography"
  // while another section was showing). An unconditional effect would also
  // fire on unrelated panel announcements and drag the author's chosen tab
  // back — that was a real bug.
  createEffect(
    on(
      () => props.initialSection,
      (next) => {
        if (next !== undefined) setSection(next);
      },
      { defer: true },
    ),
  );

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
    <section class="settings" data-quarter="settings" aria-labelledby="settings-title">
      <div class="settings-frame">
        <SettingsHeader
          status={status()}
          showReset={section() !== "shortcuts"}
          canReset={canReset()}
          canUndo={changed() && !busy()}
          onReset={() => void resetCurrent()}
          onUndo={() => void undoSession()}
          onDone={() => props.onClosed?.()}
        />

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
