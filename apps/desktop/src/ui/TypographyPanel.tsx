// 手稿排版面板（SPEC 9.8 投影）：一个领域、一张表单。这里刻意不按行数拆分——
// 字体、字形节奏、版心段落、页面留白读的是同一个 TypographyConfig，写的是同一个
// `setTypography`，拆开只会把「一次修改要克隆整个配置再提交」这条不变量分散到
// 四个文件里。预设是命名快照：应用之前它不改变任何生效值。
//
// 这个文件只做两件事：把 TypographySession 的 view 投影成控件，把控件事件译成
// 意图。任何「先怎样再怎样」的次序、任何跨桥调用、任何「保存中不许再点」的判断，
// 都不在这里——它们属于 session，并且在没有浏览器的情况下被测试。
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { describe } from "../bridge";
import type {
  BuiltinTypographyPreset,
  FontSlot,
  TextAlignment,
  TypographyConfig,
  TypographyPreset,
} from "../generated/bindings.gen";
import {
  browserTypographyGateway,
  SLOT_NAME,
  TypographySession,
} from "../shell/typography-session";
import { TypographySpecimen } from "./TypographySpecimen";

const SLOTS = ["latin", "chinese", "japanese"] as const satisfies readonly FontSlot[];
const BUILTIN_COPY: Record<string, { name: string; detail: string }> = {
  "chinese-prose": { name: "中文长文", detail: "两字缩进，适中的段间呼吸" },
  "japanese-prose": { name: "日文长文", detail: "日文字形优先，收紧字间与行宽" },
  "english-prose": { name: "英文长文", detail: "较短行距，增加英文词间距" },
};
const GRID_LINE_CHOICES = [1, 2, 3, 4, 5, 6] as const;

type NumericTypographyKey = {
  [Key in keyof TypographyConfig]: TypographyConfig[Key] extends number ? Key : never;
}[keyof TypographyConfig];

export function TypographyPanel() {
  const session = new TypographySession(browserTypographyGateway, describe);

  // 一个信号承载整份 view：session 每次广播就换一个引用，Solid 据此重算读到它的
  // 部分。给九个字段各开一个信号只会让它们有机会彼此不同步。
  const [view, setView] = createSignal(session.view());
  onCleanup(session.onChanged(() => setView(session.view())));
  onMount(() => void session.load());

  // 只属于这个面板的状态：作者正在某个槽位的搜索框里打什么字。它不是「手稿如何
  // 排版」的一部分，放进 session 会让 session 谎报自己的主题。
  const [familySearch, setFamilySearch] = createSignal<Record<FontSlot, string>>({
    latin: "",
    chinese: "",
    japanese: "",
  });
  const [presetName, setPresetName] = createSignal("");

  const typography = () => view().typography;
  const busy = () => view().activity.kind === "working";
  const failure = (): string | null => {
    const activity = view().activity;
    return activity.kind === "failed" ? activity.text : null;
  };
  const status = createMemo(() => {
    const activity = view().activity;
    if (activity.kind === "reported") return activity.text;
    if (typography() === null) return "正在读取本机字体…";
    return "更改会立即保存";
  });

  const builtins = () => view().builtins;
  const presets = () => view().presets;
  const availableWeights = () => session.availableWeights();
  const visibleFamilies = (slot: FontSlot) => session.visibleFamilies(slot, familySearch()[slot]);

  const setField = <Key extends keyof TypographyConfig>(
    key: Key,
    value: TypographyConfig[Key],
  ): void => void session.setField(key, value);
  const setNumber = (key: NumericTypographyKey, value: number): void => setField(key, value);
  const setFamily = (slot: FontSlot, family: string): void => void session.setFamily(slot, family);
  const promote = (slot: FontSlot): void => void session.promote(slot);
  const applyBuiltin = (preset: BuiltinTypographyPreset): void =>
    void session.applyBuiltin(preset, BUILTIN_COPY[preset.id]?.name ?? preset.id);
  const applyPreset = (preset: TypographyPreset): void => void session.applyPreset(preset);
  const savePreset = async (): Promise<void> => {
    const name = presetName();
    await session.savePreset(name);
    if (view().activity.kind === "reported") setPresetName("");
  };
  const removePreset = (preset: TypographyPreset): void => void session.removePreset(preset);

  const numberFrom = (event: Event): number =>
    Number((event.currentTarget as HTMLInputElement | HTMLSelectElement).value);
  const textFrom = (event: Event): string =>
    (event.currentTarget as HTMLInputElement | HTMLSelectElement).value;
  const faceStyle = (family: string): Record<string, string> => ({
    "font-family": `"${family}", sans-serif`,
  });
  const signed = (value: number): string => (value > 0 ? `+${value}` : String(value));

  const alignmentFrom = (value: string): TextAlignment =>
    value === "justify" ? "justify" : "left";

  return (
    <div class="typography-panel" aria-busy={busy()}>
      <TypographySpecimen />
      <p class="panel-status" aria-live="polite">
        {status()}
      </p>

      <section class="type-section preset-section" aria-labelledby="preset-title">
        <div class="section-heading">
          <div>
            <h3 id="preset-title">从一套稳妥的排版开始</h3>
            <p>预设会替换下面的全部排版值；应用后仍可逐项调整。</p>
          </div>
        </div>
        <div class="preset-grid">
          <For each={builtins()}>
            {(preset) => (
              <button
                type="button"
                class="preset-button"
                disabled={busy()}
                onClick={() => applyBuiltin(preset)}
              >
                <strong>{BUILTIN_COPY[preset.id]?.name ?? preset.id}</strong>
                <span>{BUILTIN_COPY[preset.id]?.detail}</span>
              </button>
            )}
          </For>
        </div>
        <Show when={presets().length}>
          <fieldset class="saved-presets" aria-label="我的排版方案">
            <For each={presets()}>
              {(preset) => (
                <div class="saved-preset">
                  <button type="button" disabled={busy()} onClick={() => applyPreset(preset)}>
                    {preset.name}
                  </button>
                  <button
                    type="button"
                    class="remove-preset"
                    aria-label={`删除排版方案 ${preset.name}`}
                    disabled={busy()}
                    onClick={() => void removePreset(preset)}
                  >
                    删除
                  </button>
                </div>
              )}
            </For>
          </fieldset>
        </Show>
        <form
          class="save-preset"
          onSubmit={(event) => {
            event.preventDefault();
            void savePreset();
          }}
        >
          <label for="preset-name">保存当前排版</label>
          <input
            id="preset-name"
            type="text"
            maxlength="40"
            placeholder="例如：访谈长稿"
            value={presetName()}
            disabled={busy() || typography() === null}
            onInput={(event) => setPresetName(event.currentTarget.value)}
          />
          <button type="submit" disabled={busy() || typography() === null}>
            保存方案
          </button>
        </form>
      </section>

      <Show when={typography()}>
        {(config) => (
          <>
            <section class="type-section" aria-labelledby="faces-title">
              <div class="section-heading">
                <div>
                  <h3 id="faces-title">字体与共享汉字</h3>
                  <p>输入名称即可搜索本机字体。排在第一位的字形负责绘制共享汉字。</p>
                </div>
                <fieldset class="priority" aria-label="共享汉字优先级">
                  <For each={config().fonts.priority}>
                    {(slot, index) => (
                      <button
                        type="button"
                        classList={{ first: index() === 0 }}
                        disabled={busy()}
                        title={`让${SLOT_NAME[slot]}字形优先`}
                        onClick={() => promote(slot)}
                      >
                        <span>{index() + 1}</span>
                        {SLOT_NAME[slot]}
                      </button>
                    )}
                  </For>
                </fieldset>
              </div>

              <div class="font-grid">
                <For each={SLOTS}>
                  {(slot) => (
                    <label class="font-choice">
                      <span>{SLOT_NAME[slot]}字体</span>
                      <input
                        type="search"
                        placeholder={`搜索本机${SLOT_NAME[slot]}字体`}
                        value={familySearch()[slot]}
                        disabled={busy()}
                        onInput={(event) =>
                          setFamilySearch((previous) => ({
                            ...previous,
                            [slot]: event.currentTarget.value,
                          }))
                        }
                      />
                      <select
                        value={config().fonts[slot]}
                        disabled={busy()}
                        aria-label={`${SLOT_NAME[slot]}字体`}
                        style={faceStyle(config().fonts[slot])}
                        onChange={(event) => setFamily(slot, textFrom(event))}
                      >
                        <For each={visibleFamilies(slot)}>
                          {(face) => (
                            <option
                              value={face.family}
                              selected={face.family === config().fonts[slot]}
                            >
                              {face.family}
                              {face.bundledSlot ? " · 内置" : ""}
                            </option>
                          )}
                        </For>
                      </select>
                    </label>
                  )}
                </For>
              </div>
            </section>

            <section class="type-section" aria-labelledby="rhythm-title">
              <div class="section-heading">
                <div>
                  <h3 id="rhythm-title">字形与行文节奏</h3>
                  <p>先调整字号和行距；字距只在稿件确实需要时微调。</p>
                </div>
              </div>
              <div class="control-grid">
                <label class="control">
                  <span>
                    <b>字号</b>
                    <output>{(config().text_size_tenths_px / 10).toFixed(1)} px</output>
                  </span>
                  <input
                    type="range"
                    min="120"
                    max="360"
                    step="5"
                    value={config().text_size_tenths_px}
                    disabled={busy()}
                    onChange={(event) => setNumber("text_size_tenths_px", numberFrom(event))}
                  />
                </label>
                <label class="control">
                  <span>
                    <b>字重</b>
                    <output>{config().font_weight}</output>
                  </span>
                  <select
                    value={config().font_weight}
                    disabled={busy()}
                    onChange={(event) => setNumber("font_weight", numberFrom(event))}
                  >
                    <For each={availableWeights()}>
                      {(weight) => (
                        <option value={weight} selected={weight === config().font_weight}>
                          {weight}
                        </option>
                      )}
                    </For>
                  </select>
                </label>
                <label class="control">
                  <span>
                    <b>行距</b>
                    <output>{(config().line_height_percent / 100).toFixed(2)}</output>
                  </span>
                  <input
                    type="range"
                    min="120"
                    max="300"
                    step="5"
                    value={config().line_height_percent}
                    disabled={busy()}
                    onChange={(event) => setNumber("line_height_percent", numberFrom(event))}
                  />
                </label>
                <label class="control">
                  <span>
                    <b>字距</b>
                    <output>{signed(config().letter_spacing_thousandths_em)} / 1000 em</output>
                  </span>
                  <input
                    type="range"
                    min="-100"
                    max="200"
                    step="5"
                    value={config().letter_spacing_thousandths_em}
                    disabled={busy()}
                    onChange={(event) =>
                      setNumber("letter_spacing_thousandths_em", numberFrom(event))
                    }
                  />
                </label>
                <label class="control">
                  <span>
                    <b>词距</b>
                    <output>{signed(config().word_spacing_thousandths_em)} / 1000 em</output>
                  </span>
                  <input
                    type="range"
                    min="-100"
                    max="500"
                    step="10"
                    value={config().word_spacing_thousandths_em}
                    disabled={busy()}
                    onChange={(event) =>
                      setNumber("word_spacing_thousandths_em", numberFrom(event))
                    }
                  />
                </label>
                <label class="control">
                  <span>
                    <b>显示缩放</b>
                    <output>{config().zoom_percent}%</output>
                  </span>
                  <input
                    type="range"
                    min="50"
                    max="200"
                    step="5"
                    value={config().zoom_percent}
                    disabled={busy()}
                    onChange={(event) => setNumber("zoom_percent", numberFrom(event))}
                  />
                </label>
              </div>
            </section>

            <section class="type-section" aria-labelledby="paragraph-title">
              <div class="section-heading">
                <div>
                  <h3 id="paragraph-title">版心与段落</h3>
                  <p>控制每行长度、首行缩进和段落之间的距离。</p>
                </div>
              </div>
              <div class="control-grid">
                <label class="control">
                  <span>
                    <b>每行宽度</b>
                    <output>{(config().measure_tenths_em / 10).toFixed(1)} em</output>
                  </span>
                  <input
                    type="range"
                    min="200"
                    max="720"
                    step="10"
                    value={config().measure_tenths_em}
                    disabled={busy()}
                    onChange={(event) => setNumber("measure_tenths_em", numberFrom(event))}
                  />
                </label>
                <label class="control">
                  <span>
                    <b>首行缩进</b>
                    <output>{(config().first_line_indent_tenths_em / 10).toFixed(1)} em</output>
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="40"
                    step="5"
                    value={config().first_line_indent_tenths_em}
                    disabled={busy()}
                    onChange={(event) =>
                      setNumber("first_line_indent_tenths_em", numberFrom(event))
                    }
                  />
                </label>
                <label class="control">
                  <span>
                    <b>段落间距</b>
                    <output>{config().paragraph_spacing_percent}%</output>
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="200"
                    step="5"
                    value={config().paragraph_spacing_percent}
                    disabled={busy()}
                    onChange={(event) => setNumber("paragraph_spacing_percent", numberFrom(event))}
                  />
                </label>
                <label class="control segmented">
                  <span>
                    <b>段落对齐</b>
                  </span>
                  <span class="segment-buttons">
                    <button
                      type="button"
                      classList={{ current: config().alignment === "left" }}
                      disabled={busy()}
                      onClick={() => setField("alignment", alignmentFrom("left"))}
                    >
                      左对齐
                    </button>
                    <button
                      type="button"
                      classList={{ current: config().alignment === "justify" }}
                      disabled={busy()}
                      onClick={() => setField("alignment", alignmentFrom("justify"))}
                    >
                      两端对齐
                    </button>
                  </span>
                </label>
              </div>
            </section>

            <section class="type-section" aria-labelledby="page-title">
              <div class="section-heading">
                <div>
                  <h3 id="page-title">页面留白与基线</h3>
                  <p>底部留白让光标停在视野中部；基线规则只辅助观察，不写入正文。</p>
                </div>
              </div>
              <div class="control-grid">
                <label class="control">
                  <span>
                    <b>顶部留白</b>
                    <output>{(config().page_top_padding_tenths_rem / 10).toFixed(1)} rem</output>
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="120"
                    step="5"
                    value={config().page_top_padding_tenths_rem}
                    disabled={busy()}
                    onChange={(event) =>
                      setNumber("page_top_padding_tenths_rem", numberFrom(event))
                    }
                  />
                </label>
                <label class="control">
                  <span>
                    <b>底部留白</b>
                    <output>{(config().page_bottom_padding_tenths_vh / 10).toFixed(0)} vh</output>
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="1000"
                    step="50"
                    value={config().page_bottom_padding_tenths_vh}
                    disabled={busy()}
                    onChange={(event) =>
                      setNumber("page_bottom_padding_tenths_vh", numberFrom(event))
                    }
                  />
                </label>
                <label class="control">
                  <span>
                    <b>基线参考线</b>
                    <output>
                      {config().baseline_grid_lines === 0
                        ? "关闭"
                        : `每 ${config().baseline_grid_lines} 行`}
                    </output>
                  </span>
                  <select
                    value={config().baseline_grid_lines}
                    disabled={busy()}
                    onChange={(event) => setNumber("baseline_grid_lines", numberFrom(event))}
                  >
                    <option value={0} selected={config().baseline_grid_lines === 0}>
                      关闭
                    </option>
                    <For each={GRID_LINE_CHOICES}>
                      {(line) => (
                        <option value={line} selected={config().baseline_grid_lines === line}>
                          每 {line} 行
                        </option>
                      )}
                    </For>
                  </select>
                </label>
              </div>
            </section>
          </>
        )}
      </Show>

      <Show when={failure()}>
        {(message) => (
          <p class="panel-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
    </div>
  );
}
