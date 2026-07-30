// KARA 界面（SPEC 9.3）：机器在 Rust 里裁决，这个界面只做投影。
// 安静的外壳：Away 之后的回归卡片、Leaving 期间的复盘条、打断行。
// 没有时钟，没有统计（Q17）。
import { createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import type { ReturnPoint } from "../generated/bindings.gen";
import { useKara } from "../shell/kara-state";

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
        {(point) => <div class="return-card">你停在这里:{point().sentenceTail}</div>}
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
