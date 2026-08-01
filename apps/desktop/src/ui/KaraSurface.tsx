// KARA 界面（SPEC 9.3）：机器在 Rust 里裁决，这个界面只做投影。
// 安静的外壳：顶部滤镜、Away 之后的回归卡片、Leaving 期间的复盘条、打断行。
// 没有时钟，没有统计（Q17）。
import { createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import type { ReturnPoint } from "../generated/bindings.gen";
import { useKara } from "../shell/kara-state";
import { browserClock, Presence } from "../shell/presence";

/** 滤镜离场的时长：向屏幕外加速，400ms——一刀切与拖沓之间的那一点。 */
const VEIL_EXIT_MS = 400;

/**
 * 纸上那层滤镜。
 *
 * 与下面那些卡片分开，因为它们的宿主不是同一个区域：卡片是压在工作台之上的
 * 临时状态（`--z-overlay`），滤镜属于**稿纸**。写在一个组件里时滤镜被关进了
 * 外壳那层的层叠上下文，`z-index` 说什么都不作数，整块连同外壳压在标题栏与
 * 侧栏之上——那正是「奇怪的全局透明」的成因。
 */
export function KaraVeil(): JSX.Element {
  const kara = useKara();
  const [tick, setTick] = createSignal(0);
  const veil = new Presence(browserClock, VEIL_EXIT_MS, () => setTick((v) => v + 1));
  const sync = (): void => {
    veil.update(kara.engaged.value);
  };
  const stop = kara.subscribe(sync);
  sync();
  onCleanup(() => {
    stop();
    veil.dispose();
  });
  return (
    <>
      {(() => {
        tick();
        return (
          <Show when={veil.shown}>
            <div class="kara-veil" classList={{ leaving: veil.leaving }} aria-hidden="true" />
          </Show>
        );
      })()}
    </>
  );
}

export function KaraSurface(): JSX.Element {
  const kara = useKara();
  const [returnCard, setReturnCard] = createSignal<ReturnPoint | null>(null);
  const [leaving, setLeaving] = createSignal(false);
  const [debriefText, setDebriefText] = createSignal<readonly string[]>([]);
  const [interruption, setInterruption] = createSignal<string | null>(null);

  const sync = (): void => {
    setReturnCard(kara.returnCard.value);
    setLeaving(kara.leaving.value);
    setDebriefText(kara.debriefText.value);
    setInterruption(kara.interruption.value);
  };
  const stop = kara.subscribe(sync);
  sync();
  onCleanup(stop);

  return (
    <div class="kara-chrome">
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
