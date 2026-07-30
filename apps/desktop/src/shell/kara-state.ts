/**
 * The KARA projection (SPEC 9.10): the machine lives in Rust; this composable
 * applies transitions, feeds facts (caret, blur), and renders effects. It
 * never re-derives a state the machine already owns (INV-10).
 */

import { describe, unwrap } from "../bridge";
import {
  commands,
  type KaraEffect,
  type KaraEvent,
  type KaraMachine,
  type KaraTransition,
  type QuietEvent,
  type ReturnPoint,
} from "../generated/bindings.gen";
import { cell, derived } from "./cell";

const machine = cell<KaraMachine | null>(null);
const lastEffects = cell<KaraEffect[]>([]);
const returnCard = cell<ReturnPoint | null>(null);
const debrief = cell<QuietEvent[] | null>(null);
const interruption = cell<string | null>(null);

const state = derived(() => machine.value?.state ?? { kind: "off" });
const engaged = derived(() => state.value.kind !== "off");
const away = derived(() => state.value.kind === "away");
const leaving = derived(() => state.value.kind === "leaving");

const QUIET_TEXT: Record<string, string> = {
  "save-succeeded": "已保存",
  "agent-completed": "Agent 完成了",
  "proposal-arrived": "提案到了",
  "index-refreshed": "索引刷新了",
};

const debriefText = derived(() => (debrief.value ?? []).map((event) => QUIET_TEXT[event] ?? event));

/**
 * 回来时那张卡片上写什么。
 *
 * 作者离开前正在写的那半句话，是他重新落座时唯一需要的线索——比块号和偏移量
 * 都管用。取末尾 18 个字：够认出是哪句，又不至于把卡片撑成一段正文。
 *
 * 这个数字属于 KARA，不属于调用者。外壳只知道光标在哪、那一块的字是什么。
 */
const RETURN_TAIL_CHARS = 18;

const returnPointAt = (
  caret: { blockId: string; offset: number },
  blockText: string,
): ReturnPoint => ({
  blockId: caret.blockId,
  offset: caret.offset,
  sentenceTail: blockText.slice(0, caret.offset).slice(-RETURN_TAIL_CHARS),
});

const perform = (effects: KaraEffect[]): void => {
  for (const effect of effects) {
    switch (effect.kind) {
      case "showReturnCard":
        returnCard.value = effect.value.point;
        window.setTimeout(() => {
          returnCard.value = null;
        }, 600);
        break;
      case "showDebrief":
        debrief.value = effect.value.queued;
        break;
      case "interruptNow":
        interruption.value = effect.value;
        window.setTimeout(() => {
          interruption.value = null;
        }, 4000);
        break;
      default:
        break;
    }
  }
};

const apply = (transition: KaraTransition | null | undefined): void => {
  if (!transition) return;
  machine.value = transition.machine;
  lastEffects.value = transition.effects;
  perform(transition.effects);
};

const send = async (event: KaraEvent): Promise<void> => {
  try {
    apply(await unwrap(commands.karaEvent(event)));
  } catch (error) {
    interruption.value = describe(error);
  }
};

// Focus lost for 8 seconds is Away (SPEC 9.3); coming back shows the card.
// Listeners register once per window, at module scope — a second useKara()
// call shares the machine, it must not double-fire GoneAway.
let awayTimer: number | null = null;
const onBlur = (): void => {
  if (!engaged.value) return;
  awayTimer = window.setTimeout(() => {
    void send({ kind: "goneAway" });
  }, 8000);
};
const onFocus = (): void => {
  if (awayTimer !== null) {
    window.clearTimeout(awayTimer);
    awayTimer = null;
  }
  if (away.value) void send({ kind: "returned" });
};

let bootstrapped = false;
const bootstrap = (): void => {
  if (bootstrapped) return;
  bootstrapped = true;
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus);
  void (async () => {
    try {
      machine.value = await unwrap(commands.karaState());
    } catch {
      // KARA is optional chrome: a broken machine read must not block writing.
    }
  })();
};

export function useKara() {
  bootstrap();
  return {
    state,
    engaged,
    away,
    leaving,
    returnCard,
    debriefText,
    interruption,
    subscribe: (listener: () => void) => {
      const stops = [
        machine.subscribe(listener),
        returnCard.subscribe(listener),
        debrief.subscribe(listener),
        interruption.subscribe(listener),
      ];
      return () => {
        for (const stop of stops) stop();
      };
    },
    apply,
    toggle: () => send({ kind: "manualToggle" }),
    setReturnPoint: (point: ReturnPoint) => send({ kind: "setReturnPoint", value: point }),
    /**
     * 记下作者此刻写到哪里。KARA 没engage 时什么也不做——返回卡片只在离开
     * 之后才有意义，让调用者去判断这件事等于把 KARA 的状态机漏出去。
     */
    markPosition: (
      caret: { blockId: string; offset: number } | null | undefined,
      blockText: string,
    ) => {
      if (!engaged.value || caret === null || caret === undefined) return;
      void send({ kind: "setReturnPoint", value: returnPointAt(caret, blockText) });
    },
    leaveFinished: () => send({ kind: "leaveFinished" }),
    quiet: (event: QuietEvent) => send({ kind: "quiet", value: event }),
    interrupt: (
      event: "save-failed" | "disk-unwritable" | "root-identity-changed" | "external-conflict",
    ) => send({ kind: "interrupt", value: event }),
  };
}
