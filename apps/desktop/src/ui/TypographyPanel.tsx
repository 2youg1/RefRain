// 手稿排版面板（SPEC 9.8 投影）：一个领域、一张表单。这里刻意不按行数拆分——
// 字体、字形节奏、版心段落、页面留白读的是同一个 TypographyConfig，写的是同一个
// `setTypography`，拆开只会把「一次修改要克隆整个配置再提交」这条不变量分散到
// 四个文件里。预设是命名快照：应用之前它不改变任何生效值。
//
// 这个文件只做两件事：把 TypographySession 的 view 投影成控件，把控件事件译成
// 意图。任何「先怎样再怎样」的次序、任何跨桥调用、任何「保存中不许再点」的判断，
// 都不在这里——它们属于 session，并且在没有浏览器的情况下被测试。
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
import { describe } from "../bridge";
import type {
  BuiltinTypographyPreset,
  FontFamilyDto,
  FontSlot,
  TextAlignment,
  TypographyConfig,
  TypographyPreset,
} from "../generated/bindings.gen";
import {
  browserTypographyGateway,
  type NumericTypographyKey,
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

/** config 值与作者读到的数之间的换算：存储多是十分之一、千分之一。 */
interface SliderScale {
  /** config 值 ÷ scale ＝ 作者读到、也输入的数。 */
  readonly scale: number;
  /** 显示的小数位数。 */
  readonly decimals: number;
  /** 单位后缀，空串表示没有。 */
  readonly unit: string;
}

const PX_TENTHS: SliderScale = { scale: 10, decimals: 1, unit: "px" };
const EM_TENTHS: SliderScale = { scale: 10, decimals: 1, unit: "em" };
const REM_TENTHS: SliderScale = { scale: 10, decimals: 1, unit: "rem" };
const VH_TENTHS: SliderScale = { scale: 10, decimals: 0, unit: "vh" };
const PERCENT: SliderScale = { scale: 1, decimals: 0, unit: "%" };
const RATIO_HUNDREDTHS: SliderScale = { scale: 100, decimals: 2, unit: "" };
const RAW: SliderScale = { scale: 1, decimals: 0, unit: "" };

/** 离 value 最近的一档：字重只有字体真实存在的那几档，中间值不存在。 */
function nearestOf(choices: readonly number[], value: number): number {
  let best = value;
  let distance = Number.POSITIVE_INFINITY;
  for (const choice of choices) {
    const gap = Math.abs(choice - value);
    if (gap < distance) {
      distance = gap;
      best = choice;
    }
  }
  return best;
}

/** 内置推荐一组、本机其余一组：分组的判据就是 `bundledSlot`，不另造清单。 */
function bundledFamilies(
  slot: FontSlot,
  families: readonly FontFamilyDto[],
): readonly FontFamilyDto[] {
  return families.filter((face) => face.bundledSlot === slot);
}

function localFamilies(
  slot: FontSlot,
  families: readonly FontFamilyDto[],
): readonly FontFamilyDto[] {
  return families.filter((face) => face.bundledSlot !== slot);
}

/**
 * 一根可以拖、也可以打字的数值滑杆。
 *
 * 原生 range 在这里拖不动：每次 input 都是一次跨桥写，在飞的写让 exclusive
 * 拒绝后续——指针在动，值却停在上一次落地的地方。这根滑杆自己持有拖动生命
 * 周期（指针捕获、Escape 还原、方向键微调），连续值走 session.scrubField：
 * 在飞的那笔落地后，最新的值总会补出去。
 */
function NumberSlider(props: {
  label: string;
  min: number;
  max: number;
  step: number;
  /** 落值前的最后一道对齐：默认对齐到 step；字重对齐到字体真实存在的档。 */
  snap?: (value: number) => number;
  scale: SliderScale;
  value: number;
  disabled: boolean;
  /** 输出的修饰（如正负号）；默认按 scale 格式化。 */
  format?: (display: number) => string;
  onScrub: (value: number) => void;
}): JSX.Element {
  const [held, setHeld] = createSignal<number | null>(null);
  const [typed, setTyped] = createSignal<string | null>(null);
  let track: HTMLDivElement | undefined;
  let dragPointer: number | null = null;
  let dragBefore = 0;

  const snap = (value: number): number => {
    const stepped = Math.round((value - props.min) / props.step) * props.step + props.min;
    const clamped = Math.min(Math.max(stepped, props.min), props.max);
    return props.snap?.(clamped) ?? clamped;
  };
  const shown = () => held() ?? props.value;
  const displayOf = (value: number): number => value / props.scale.scale;
  const displayText = (): string => {
    const display = displayOf(shown());
    if (props.format !== undefined) return props.format(display);
    const fixed = display.toFixed(props.scale.decimals);
    return props.scale.unit === "" ? fixed : `${fixed} ${props.scale.unit}`;
  };
  const fillPercent = () => ((shown() - props.min) / (props.max - props.min)) * 100;

  // 提交追上拖动落点之前显示落点本身，不回弹；一相等就交还给 config 值。
  createEffect(
    on(
      () => props.value,
      (value) => {
        if (held() === value) setHeld(null);
      },
    ),
  );

  const applyAt = (clientX: number): void => {
    if (track === undefined) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
    const next = snap(props.min + ratio * (props.max - props.min));
    setHeld(next);
    props.onScrub(next);
  };

  const beginDrag = (event: PointerEvent): void => {
    if (props.disabled || event.button !== 0) return;
    // 阻止默认，面板里的字才不会在拖动中被选中。
    event.preventDefault();
    track?.focus();
    track?.setPointerCapture(event.pointerId);
    dragPointer = event.pointerId;
    dragBefore = shown();
    applyAt(event.clientX);
  };

  const moveDrag = (event: PointerEvent): void => {
    if (dragPointer === null || dragPointer !== event.pointerId) return;
    applyAt(event.clientX);
  };

  const endDrag = (event: PointerEvent): void => {
    if (dragPointer === null || dragPointer !== event.pointerId) return;
    dragPointer = null;
    if (track?.hasPointerCapture(event.pointerId)) {
      track.releasePointerCapture(event.pointerId);
    }
    // 抬起的位置才是作者选的位置，最后一落点再算一次。
    if (event.type === "pointerup") applyAt(event.clientX);
  };

  const onTrackKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && dragPointer !== null) {
      // 只还原这次拖动；不冒泡，否则设置面板会被当成「退层」收掉。
      event.preventDefault();
      event.stopPropagation();
      if (track?.hasPointerCapture(dragPointer)) track.releasePointerCapture(dragPointer);
      dragPointer = null;
      setHeld(dragBefore);
      props.onScrub(dragBefore);
      return;
    }
    if (props.disabled) return;
    const times = event.shiftKey ? 10 : 1;
    let next: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      next = snap(shown() - props.step * times);
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      next = snap(shown() + props.step * times);
    } else if (event.key === "Home") {
      next = props.min;
    } else if (event.key === "End") {
      next = props.max;
    }
    if (next === null) return;
    event.preventDefault();
    setHeld(next);
    props.onScrub(next);
  };

  const commitTyped = (raw: string): void => {
    if (raw.trim() === "") return;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    props.onScrub(snap(parsed * props.scale.scale));
  };

  return (
    <div class="control">
      <span>
        <b>{props.label}</b>
        <output>{displayText()}</output>
      </span>
      <div class="slider-row">
        <div
          class="slider-track"
          ref={(element) => {
            track = element;
          }}
          role="slider"
          tabIndex={props.disabled ? -1 : 0}
          aria-label={props.label}
          aria-valuemin={props.min}
          aria-valuemax={props.max}
          aria-valuenow={shown()}
          aria-valuetext={displayText()}
          aria-disabled={props.disabled}
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onTrackKey}
        >
          <div class="slider-fill" style={{ width: `${fillPercent()}%` }} />
          <div class="slider-thumb" style={{ "inset-inline-start": `${fillPercent()}%` }} />
        </div>
        {/* 打字也是一连贯的 scrub，scrubField 自己管流量，所以不吃 busy：
            吃 busy 的话，第一个数字刚提交，输入框就被禁用、焦点被夺走。 */}
        <input
          class="slider-number"
          type="number"
          inputmode="decimal"
          min={displayOf(props.min)}
          max={displayOf(props.max)}
          step={props.step / props.scale.scale}
          aria-label={`${props.label}数值`}
          value={typed() ?? String(Number(displayOf(shown()).toFixed(props.scale.decimals)))}
          onFocus={(event) => setTyped(event.currentTarget.value)}
          onInput={(event) => {
            setTyped(event.currentTarget.value);
            commitTyped(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              setTyped(null);
              event.currentTarget.blur();
            }
          }}
          onBlur={() => setTyped(null)}
        />
      </div>
    </div>
  );
}

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
  const scrub = (key: NumericTypographyKey, value: number): void => session.scrubField(key, value);
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
                        {/* 空查询给全量：内置推荐一组在前，本机其余一组在后。 */}
                        <Show when={bundledFamilies(slot, visibleFamilies(slot)).length > 0}>
                          <optgroup label="内置">
                            <For each={bundledFamilies(slot, visibleFamilies(slot))}>
                              {(face) => (
                                <option
                                  value={face.family}
                                  selected={face.family === config().fonts[slot]}
                                >
                                  {face.family}
                                </option>
                              )}
                            </For>
                          </optgroup>
                        </Show>
                        <Show when={localFamilies(slot, visibleFamilies(slot)).length > 0}>
                          <optgroup label="本机">
                            <For each={localFamilies(slot, visibleFamilies(slot))}>
                              {(face) => (
                                <option
                                  value={face.family}
                                  selected={face.family === config().fonts[slot]}
                                >
                                  {face.family}
                                </option>
                              )}
                            </For>
                          </optgroup>
                        </Show>
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
                <NumberSlider
                  label="字号"
                  min={120}
                  max={360}
                  step={5}
                  scale={PX_TENTHS}
                  value={config().text_size_tenths_px}
                  disabled={busy()}
                  onScrub={(value) => scrub("text_size_tenths_px", value)}
                />
                {/* 在字体真实的档位上拖——档位就是可调极限，中间值不存在。 */}
                <NumberSlider
                  label="字重"
                  min={availableWeights()[0] ?? 100}
                  max={availableWeights()[availableWeights().length - 1] ?? 900}
                  step={1}
                  snap={(value) => nearestOf(availableWeights(), value)}
                  scale={RAW}
                  value={config().font_weight}
                  disabled={busy()}
                  onScrub={(value) => scrub("font_weight", value)}
                />
                <NumberSlider
                  label="行距"
                  min={120}
                  max={300}
                  step={5}
                  scale={RATIO_HUNDREDTHS}
                  value={config().line_height_percent}
                  disabled={busy()}
                  onScrub={(value) => scrub("line_height_percent", value)}
                />
                <NumberSlider
                  label="字距"
                  min={-100}
                  max={200}
                  step={5}
                  scale={RAW}
                  format={(value) => `${signed(value)} / 1000 em`}
                  value={config().letter_spacing_thousandths_em}
                  disabled={busy()}
                  onScrub={(value) => scrub("letter_spacing_thousandths_em", value)}
                />
                <NumberSlider
                  label="词距"
                  min={-100}
                  max={500}
                  step={10}
                  scale={RAW}
                  format={(value) => `${signed(value)} / 1000 em`}
                  value={config().word_spacing_thousandths_em}
                  disabled={busy()}
                  onScrub={(value) => scrub("word_spacing_thousandths_em", value)}
                />
                <NumberSlider
                  label="显示缩放"
                  min={50}
                  max={200}
                  step={5}
                  scale={PERCENT}
                  value={config().zoom_percent}
                  disabled={busy()}
                  onScrub={(value) => scrub("zoom_percent", value)}
                />
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
                <NumberSlider
                  label="每行宽度"
                  min={200}
                  max={960}
                  step={10}
                  scale={EM_TENTHS}
                  value={config().measure_tenths_em}
                  disabled={busy()}
                  onScrub={(value) => scrub("measure_tenths_em", value)}
                />
                <NumberSlider
                  label="首行缩进"
                  min={0}
                  max={40}
                  step={5}
                  scale={EM_TENTHS}
                  value={config().first_line_indent_tenths_em}
                  disabled={busy()}
                  onScrub={(value) => scrub("first_line_indent_tenths_em", value)}
                />
                <NumberSlider
                  label="段落间距"
                  min={0}
                  max={200}
                  step={5}
                  scale={PERCENT}
                  value={config().paragraph_spacing_percent}
                  disabled={busy()}
                  onScrub={(value) => scrub("paragraph_spacing_percent", value)}
                />
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
                <NumberSlider
                  label="顶部留白"
                  min={0}
                  max={120}
                  step={5}
                  scale={REM_TENTHS}
                  value={config().page_top_padding_tenths_rem}
                  disabled={busy()}
                  onScrub={(value) => scrub("page_top_padding_tenths_rem", value)}
                />
                <NumberSlider
                  label="底部留白"
                  min={0}
                  max={1000}
                  step={50}
                  scale={VH_TENTHS}
                  value={config().page_bottom_padding_tenths_vh}
                  disabled={busy()}
                  onScrub={(value) => scrub("page_bottom_padding_tenths_vh", value)}
                />
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
