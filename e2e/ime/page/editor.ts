/**
 * IME acceptance page for v0.2: the real direct-DOM adapter under a ~100k-char
 * document, in the same engine the product ships (WebView2).
 *
 * Instrumentation contract (file-based, driven externally by driver/drive.ps1):
 *   - window.__ime.ready === true once the document is mounted
 *   - F13/F14/F15 keydown = phase-1/2/3 begin marks, F16 = end-of-test mark
 *   - window.__getReport() -> full JSON report (polled by the shell ~1/s)
 *
 * The page is engine-only: the adapter's port is a no-op, because what this
 * gate measures is the DOM/IME behaviour — composition events, focus latency,
 * rendering stalls — not the bridge (the writing slice e2e owns that).
 */
import { mountEditor } from "../../../packages/editor/src/index.ts";

const qs = new URLSearchParams(location.search);
const SHELL = qs.get("shell") ?? "unknown";

// ---- build ~100,000 chars of existing Chinese text -------------------------
const PARA =
  "中文输入法与富文本编辑器的集成一直是桌面应用质量的关键环节。当文档规模扩大到十万字级别时," +
  "编辑器对输入法组合事件的处理能力、事务提交时机以及 DOM 同步策略都会受到严峻考验。" +
  "本段文字用于构造具有真实语料特征的长文档,以模拟用户在日常写作场景中的实际负载。";
const TARGET = 100_000;
const blocks: { id: string; text: string }[] = [];
let total = 0;
while (total < TARGET) {
  blocks.push({ id: `b${blocks.length}`, text: PARA });
  total += PARA.length;
}

// ---- instrumentation -------------------------------------------------------
const now = (): number => Math.round(performance.now());
interface CompSession {
  start: number | null;
  end: number | null;
  updates: number;
  committed: string;
  docBefore: number | null;
  docAfter: number;
  orphan?: boolean;
}
const report = {
  shell: SHELL,
  ua: navigator.userAgent,
  chrome: /Chrome\/[\d.]+/.exec(navigator.userAgent)?.[0] ?? "?",
  loadAt: now(),
  docChars: total,
  firstPointerDown: null as number | null,
  firstFocus: null as number | null,
  firstCompositionStart: undefined as number | undefined,
  marks: [] as { t: number; name: string }[],
  events: [] as {
    t: number;
    type: string;
    key?: string;
    data?: string | null;
    inputType?: string;
    docLen: number;
  }[],
  comps: [] as CompSession[],
  growth: [] as { t: number; len: number }[],
  rafMaxGap: 0,
};
let compOpen: CompSession | null = null;
let lastRaf = now();

const docLen = (): number =>
  [...document.querySelectorAll("p[data-block-id]")].reduce(
    (sum, el) => sum + (el.textContent ?? "").length,
    0,
  );

const push = (ev: (typeof report.events)[number]): void => {
  report.events.push(ev);
};

// ---- mount the real adapter --------------------------------------------------
const mount = document.getElementById("editor");
if (!(mount instanceof HTMLElement)) throw new Error("no #editor");
const handle = mountEditor(mount, { revision: "ime-probe", blocks }, { submit: () => {} });
mount.setAttribute("spellcheck", "false");
// The driver clicks the window for the foreground; the caret must already be
// in the text, or keystrokes land on chrome rather than the page.
handle.focus();

mount.addEventListener(
  "pointerdown",
  () => {
    report.firstPointerDown ??= now();
  },
  true,
);
mount.addEventListener(
  "focus",
  () => {
    report.firstFocus ??= now();
  },
  true,
);
mount.addEventListener(
  "keydown",
  (event) => {
    const e = event as KeyboardEvent;
    if (e.key === "F13") report.marks.push({ t: now(), name: "phase1-first-word" });
    else if (e.key === "F14") report.marks.push({ t: now(), name: "phase2-typing-60s" });
    else if (e.key === "F15") report.marks.push({ t: now(), name: "phase3-punct" });
    else if (e.key === "F16") report.marks.push({ t: now(), name: "end" });
    else push({ t: now(), type: "keydown", key: e.key, docLen: docLen() });
  },
  true,
);
mount.addEventListener(
  "keyup",
  (event) => {
    const e = event as KeyboardEvent;
    if (!/^F1[3-6]$/.test(e.key)) push({ t: now(), type: "keyup", key: e.key, docLen: docLen() });
  },
  true,
);
mount.addEventListener(
  "beforeinput",
  (event) => {
    const e = event as InputEvent;
    push({
      t: now(),
      type: "beforeinput",
      inputType: e.inputType,
      data: e.data ?? null,
      docLen: docLen(),
    });
  },
  true,
);
mount.addEventListener(
  "compositionstart",
  (event) => {
    const e = event as CompositionEvent;
    report.firstCompositionStart ??= now();
    compOpen = {
      start: now(),
      end: null,
      updates: 0,
      committed: "",
      docBefore: docLen(),
      docAfter: 0,
    };
    push({ t: now(), type: "compositionstart", data: e.data ?? "", docLen: docLen() });
  },
  true,
);
mount.addEventListener(
  "compositionupdate",
  (event) => {
    const e = event as CompositionEvent;
    if (compOpen) compOpen.updates += 1;
    push({ t: now(), type: "compositionupdate", data: e.data ?? "", docLen: docLen() });
  },
  true,
);
mount.addEventListener(
  "compositionend",
  (event) => {
    const e = event as CompositionEvent;
    const t = now();
    if (compOpen) {
      compOpen.end = t;
      compOpen.committed = e.data ?? "";
      compOpen.docAfter = docLen();
      report.comps.push(compOpen);
      compOpen = null;
    } else {
      report.comps.push({
        start: null,
        end: t,
        updates: 0,
        committed: e.data ?? "",
        docBefore: null,
        docAfter: docLen(),
        orphan: true,
      });
    }
    push({ t, type: "compositionend", data: e.data ?? "", docLen: docLen() });
  },
  true,
);

// samplers
setInterval(() => {
  report.growth.push({ t: now(), len: docLen() });
  const dropped = report.comps.filter((c) => c.committed.length === 0).length;
  document.title = `IME-TEST ${SHELL} comps=${report.comps.length} dropped=${dropped} docLen=${docLen()}`;
}, 500);
(function raf(): void {
  const t = now();
  const gap = t - lastRaf;
  if (gap > report.rafMaxGap) report.rafMaxGap = gap;
  lastRaf = t;
  requestAnimationFrame(raf);
})();

// ---- report ------------------------------------------------------------------
declare global {
  interface Window {
    __ime: { ready: boolean; shell: string };
    __getReport: () => unknown;
  }
}

window.__getReport = () => {
  const t = now();
  const openComp = compOpen ? { age: t - (compOpen.start ?? t), start: compOpen.start } : null;
  const stuck =
    report.comps.filter((c) => c.start !== null && c.end !== null && c.end - c.start > 3000)
      .length + (openComp && openComp.age > 3000 ? 1 : 0);
  return {
    ...report,
    firstCompositionStart: report.firstCompositionStart ?? null,
    focusLatencyMs:
      report.firstFocus !== null && report.firstPointerDown !== null
        ? report.firstFocus - report.firstPointerDown
        : null,
    openComp,
    stuckCompositions: stuck,
    now: t,
  };
};
window.__ime = { ready: true, shell: SHELL };
