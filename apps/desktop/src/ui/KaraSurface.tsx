// KARA 界面（SPEC 9.3）：机器在 Rust 里裁决，这个界面只做投影。
// 安静的外壳：顶部滤镜、Away 之后的回归卡片、Leaving 期间的复盘条、打断行。
// 没有时钟，没有统计（Q17）。
import { createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import type { ReturnPoint } from "../generated/bindings.gen";
import { useKara } from "../shell/kara-state";
import { browserClock, Presence } from "../shell/presence";

/** 滤镜离场的时长：向屏幕外加速，400ms——一刀切与拖沓之间的那一点。 */
const VEIL_EXIT_MS = 400;

export function KaraSurface(): JSX.Element {
  const kara = useKara();
  const [returnCard, setReturnCard] = createSignal<ReturnPoint | null>(null);
  const [leaving, setLeaving] = createSignal(false);
  const [debriefText, setDebriefText] = createSignal<readonly string[]>([]);
  const [interruption, setInterruption] = createSignal<string | null>(null);
  // 滤镜的离场比状态本身多活 400ms：关掉 KARA 不是滤镜凭空消失。
  const [veilTick, setVeilTick] = createSignal(0);
  const veil = new Presence(browserClock, VEIL_EXIT_MS, () => setVeilTick((v) => v + 1));

  const sync = (): void => {
    setReturnCard(kara.returnCard.value);
    setLeaving(kara.leaving.value);
    setDebriefText(kara.debriefText.value);
    setInterruption(kara.interruption.value);
    veil.update(kara.engaged.value);
  };
  const stop = kara.subscribe(sync);
  sync();
  onCleanup(() => {
    stop();
    veil.dispose();
  });

  return (
    <div class="kara-chrome">
      {/* 顶部 20% 的渐透明滤镜：其余一切不受影响（不是逐行聚焦）。 */}
      {(() => {
        veilTick();
        return (
          <Show when={veil.shown}>
            <div class="kara-veil" classList={{ leaving: veil.leaving }} aria-hidden="true" />
          </Show>
        );
      })()}

      <Show when={returnCard()}>
        {(point) => <div class="return-card">你停在这里：{point().sentenceTail}</div>}
      </Show>

      <Show when={leaving()}>
        <div class="debrief" role="status">
          <For each={debriefText()}>{(line) => <span>{line}</span>}</For>
          <Show when={debriefText().length === 0}>
            <span>这一段很安静。</span>
          </Show>
        </div>
      </Show>

      <Show when={interruption()}>
        {(message) => (
          <div class="interruption" role="alert">
            {message()}
          </div>
        )}
      </Show>
    </div>
  );
}
