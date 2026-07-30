// 外观选择（SPEC 9.8 + D12）：清单是生成的，写入落到单一 Config，选完立即投影。
//
// 这里的每一行都是同一件事——一排互斥格子，选中即写一个 Config 字段。所以行由
// `ChoiceRow` 画，写入走同一条 `apply`：加一项外观选项是加一行数据，不是再抄一份
// 读值/写值/记错误的代码。
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { describe, unwrap } from "../bridge";
import {
  commands,
  type PanelMaterial,
  type PanelSide,
  type PaperMode,
  type PreferencesChangeDto,
  type ThemeInfoDto,
} from "../generated/bindings.gen";
import { ChoiceRow } from "./ChoiceRow";

type ThemePickerProps = {
  onPicked?: (slug: string) => void;
};

const PAPERS = [
  { value: "none", label: "无", title: "纸面：无边缘" },
  { value: "hairline", label: "细", title: "纸面：细边" },
  { value: "paper", label: "纸", title: "纸面：纸张" },
] as const satisfies readonly { value: PaperMode; label: string; title: string }[];

const SIDES = [
  { value: "left", label: "向右展开", title: "面板从左侧一层层向右打开" },
  { value: "right", label: "向左展开", title: "面板从右侧一层层向左打开" },
] as const satisfies readonly { value: PanelSide; label: string; title: string }[];

const MATERIALS = [
  { value: "solid", label: "实心", title: "不透光，可读性最高" },
  { value: "acrylic", label: "亚克力", title: "一层磨砂，知道底下有东西" },
  { value: "liquid", label: "液态玻璃", title: "有厚度的玻璃，背后的形状带得过来" },
] as const satisfies readonly { value: PanelMaterial; label: string; title: string }[];

const SWITCHES = [
  { value: "on", label: "开" },
  { value: "off", label: "关" },
] as const;
type Switch = (typeof SWITCHES)[number]["value"];
const onOff = (value: boolean): Switch => (value ? "on" : "off");

/** 代码配色。「跟随主题」不是一个具体配色，而是「继续跟着界面走」这件事本身。 */
const CODE_THEMES = [
  { value: "", label: "跟随主题", title: "代码配色随界面主题变化" },
  { value: "vitesse-light", label: "Vitesse 日", title: "低饱和印刷感" },
  { value: "vitesse-dark", label: "Vitesse 夜", title: "同族的夜间版" },
  { value: "github-light", label: "GitHub 日", title: "最眼熟的一套" },
  { value: "github-dark", label: "GitHub 夜", title: "最眼熟的一套" },
  { value: "min-light", label: "极简 日", title: "几乎只区分注释与字符串" },
  { value: "min-dark", label: "极简 夜", title: "几乎只区分注释与字符串" },
] as const;
type CodeThemeChoice = (typeof CODE_THEMES)[number]["value"];

export function ThemePicker(props: ThemePickerProps) {
  const [themes, setThemes] = createSignal<ThemeInfoDto[]>([]);
  const [activeTheme, setActiveTheme] = createSignal<string | null>(null);
  const [paper, setPaper] = createSignal<PaperMode>("hairline");
  const [side, setSide] = createSignal<PanelSide>("left");
  const [material, setMaterial] = createSignal<PanelMaterial>("solid");
  const [animation, setAnimation] = createSignal<Switch>("on");
  const [lamp, setLamp] = createSignal<Switch>("off");
  const [codeTheme, setCodeTheme] = createSignal<CodeThemeChoice>("");
  const [error, setError] = createSignal<string | null>(null);

  const dayThemes = createMemo(() => themes().filter((theme) => theme.mode === "day"));
  const nightThemes = createMemo(() => themes().filter((theme) => theme.mode === "night"));

  onMount(async () => {
    try {
      setThemes(await commands.listThemes());
      const snapshot = await unwrap(commands.readConfig());
      const appearance = snapshot.config.appearance;
      if (appearance === undefined) return;
      setActiveTheme(appearance.theme);
      setPaper(appearance.paper ?? "hairline");
      setSide(appearance.panel_side ?? "left");
      setMaterial(appearance.panel_material ?? "solid");
      setAnimation(onOff(appearance.panel_animation ?? true));
      setLamp(onOff(appearance.night_lamp === true));
      setCodeTheme((appearance.code_theme ?? "") as CodeThemeChoice);
    } catch (cause) {
      setError(describe(cause));
    }
  });

  /**
   * 每一次选择走同一条路：写进 Config，成功了才更新本地显示。
   *
   * 先更新本地再写会让失败的那次留下一个亮着的格子——作者以为选中了，
   * 而磁盘上没有。
   */
  const apply = async <Value,>(
    change: PreferencesChangeDto,
    remember: (value: Value) => void,
    value: Value,
  ): Promise<void> => {
    try {
      await unwrap(commands.updatePreferences(change));
      remember(value);
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const pick = async (slug: string): Promise<void> => {
    await apply({ kind: "setTheme", value: slug }, setActiveTheme, slug);
    if (error() === null) props.onPicked?.(slug);
  };

  return (
    <fieldset class="theme-picker" aria-label="外观">
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

      <ChoiceRow
        label="纸面"
        data="paper"
        options={PAPERS}
        current={paper()}
        onPick={(value) => void apply({ kind: "setPaper", value }, setPaper, value)}
      />
      <ChoiceRow
        label="夜间灯"
        data="lamp"
        options={SWITCHES}
        current={lamp()}
        onPick={(value) =>
          void apply({ kind: "setNightLamp", value: value === "on" }, setLamp, value)
        }
      />
      <ChoiceRow
        label="面板方向"
        data="panel-side"
        options={SIDES}
        current={side()}
        onPick={(value) => void apply({ kind: "setPanelSide", value }, setSide, value)}
      />
      <ChoiceRow
        label="面板材质"
        data="panel-material"
        options={MATERIALS}
        current={material()}
        onPick={(value) => void apply({ kind: "setPanelMaterial", value }, setMaterial, value)}
      />
      <ChoiceRow
        label="面板动画"
        data="panel-animation"
        options={SWITCHES}
        current={animation()}
        onPick={(value) =>
          void apply({ kind: "setPanelAnimation", value: value === "on" }, setAnimation, value)
        }
      />
      <ChoiceRow
        label="代码配色"
        data="code-theme"
        options={CODE_THEMES}
        current={codeTheme()}
        onPick={(value) =>
          // 空串是「跟随主题」：存 null 而不是存一个当下解析出来的具体配色，
          // 否则作者换界面主题时代码块不会跟着变。
          void apply(
            { kind: "setCodeTheme", value: value === "" ? null : value },
            setCodeTheme,
            value,
          )
        }
      />

      <Show when={error() !== null}>
        <p class="error">{error()}</p>
      </Show>
    </fieldset>
  );
}
