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
    leaveFinished: () => send({ kind: "leaveFinished" }),
    quiet: (event: QuietEvent) => send({ kind: "quiet", value: event }),
    interrupt: (
      event: "save-failed" | "disk-unwritable" | "root-identity-changed" | "external-conflict",
    ) => send({ kind: "interrupt", value: event }),
  };
}
