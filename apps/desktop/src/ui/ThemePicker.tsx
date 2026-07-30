// The theme picker (SPEC 9.8 + D12): the list is generated, the write goes to
// the single Config, and the choice projects immediately. The paper row is the
// manuscript sheet's three edges: none / hairline / paper.
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { describe, unwrap } from "../bridge";
import { commands, type PaperMode, type ThemeInfoDto } from "../generated/bindings.gen";

type ThemePickerProps = {
  onPicked?: (slug: string) => void;
};

const PAPERS: { value: PaperMode; label: string; title: string }[] = [
  { value: "none", label: "无", title: "纸面：无边缘" },
  { value: "hairline", label: "细", title: "纸面：细边" },
  { value: "paper", label: "纸", title: "纸面：纸张" },
];

export function ThemePicker(props: ThemePickerProps) {
  const [themes, setThemes] = createSignal<ThemeInfoDto[]>([]);
  const [activeTheme, setActiveTheme] = createSignal<string | null>(null);
  const [paper, setPaper] = createSignal<PaperMode>("hairline");
  const [error, setError] = createSignal<string | null>(null);

  const dayThemes = createMemo(() => themes().filter((theme) => theme.mode === "day"));
  const nightThemes = createMemo(() => themes().filter((theme) => theme.mode === "night"));

  onMount(async () => {
    try {
      setThemes(await commands.listThemes());
      const snapshot = await unwrap(commands.readConfig());
      const appearance = snapshot.config.appearance;
      if (appearance !== undefined) {
        setActiveTheme(appearance.theme);
        setPaper(appearance.paper ?? "hairline");
      }
    } catch (cause) {
      setError(describe(cause));
    }
  });

  const pick = async (slug: string): Promise<void> => {
    try {
      await unwrap(commands.updatePreferences({ kind: "setTheme", value: slug }));
      setActiveTheme(slug);
      props.onPicked?.(slug);
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const pickPaper = async (mode: PaperMode): Promise<void> => {
    try {
      await unwrap(commands.updatePreferences({ kind: "setPaper", value: mode }));
      setPaper(mode);
    } catch (cause) {
      setError(describe(cause));
    }
  };

  return (
    <fieldset class="theme-picker" aria-label="主题">
      <div class="picker-block">
        <span class="picker-name">主题</span>
        <div class="picker-rows">
          <fieldset class="seg" aria-label="日间">
            <For each={dayThemes()}>
              {(theme) => (
                <button
                  type="button"
                  classList={{ current: theme.slug === activeTheme() }}
                  data-theme-slug={theme.slug}
                  title={theme.slug}
                  onClick={() => void pick(theme.slug)}
                >
                  {theme.cn}
                </button>
              )}
            </For>
          </fieldset>
          <fieldset class="seg night" aria-label="夜间">
            <For each={nightThemes()}>
              {(theme) => (
                <button
                  type="button"
                  classList={{ current: theme.slug === activeTheme() }}
                  data-theme-slug={theme.slug}
                  title={theme.slug}
                  onClick={() => void pick(theme.slug)}
                >
                  {theme.cn}
                </button>
              )}
            </For>
          </fieldset>
        </div>
      </div>
      <div class="picker-block">
        <span class="picker-name">纸面</span>
        <div class="picker-rows">
          <fieldset class="seg" aria-label="纸面">
            <For each={PAPERS}>
              {(mode) => (
                <button
                  type="button"
                  classList={{ current: mode.value === paper() }}
                  data-paper-mode={mode.value}
                  title={mode.title}
                  onClick={() => void pickPaper(mode.value)}
                >
                  {mode.label}
                </button>
              )}
            </For>
          </fieldset>
        </div>
      </div>
      <Show when={error() !== null}>
        <p class="error">{error()}</p>
      </Show>
    </fieldset>
  );
}
