// IME acceptance-test page: same file loaded in every shell.
// Instrumentation contract (file-based, driven externally by driver/*.ps1):
//   - window.__ime.ready === true once the 100k-char doc is loaded
//   - F13/F14/F15 keydown = phase-1/2/3 begin marks, F16 = end-of-test mark
//   - window.__getReport() -> full JSON report (polled by the shell ~1/s)
import { Schema } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema as basicSchema } from 'prosemirror-schema-basic';

const qs = new URLSearchParams(location.search);
const SHELL = qs.get('shell') || 'unknown';

// ---- build ~100,000 chars of existing Chinese text -----------------------
const PARA =
  '中文输入法与富文本编辑器的集成一直是桌面应用质量的关键环节。当文档规模扩大到十万字级别时，' +
  '编辑器对输入法组合事件的处理能力、事务提交时机以及 DOM 同步策略都会受到严峻考验。' +
  '本段文字用于构造具有真实语料特征的长文档，以模拟用户在日常写作场景中的实际负载。';
const TARGET = 100000;
const nodes = [];
let total = 0;
while (total < TARGET) {
  nodes.push({ type: 'paragraph', content: [{ type: 'text', text: PARA }] });
  total += PARA.length;
}

const docJSON = { type: 'doc', content: nodes };

// ---- instrumentation ------------------------------------------------------
const now = () => Math.round(performance.now());
const R = {
  shell: SHELL,
  ua: navigator.userAgent,
  chrome: (navigator.userAgent.match(/Chrome\/[\d.]+/) || ['?'])[0],
  loadAt: now(),
  docChars: total,
  firstPointerDown: null,
  firstFocus: null,
  marks: [],          // {t, name}
  events: [],         // {t, type, key?, data?, inputType?, docLen}
  comps: [],          // composition sessions {start, end, updates, committed, docBefore, docAfter}
  growth: [],         // {t, len} sampled 2/s
  rafMaxGap: 0,
};
let compOpen = null;
let lastRaf = now();

function push(ev) { R.events.push(ev); }

function docLen(view) { return view.state.doc.textContent.length; }

// ---- editor ----------------------------------------------------------------
const mount = document.getElementById('editor');
const view = new EditorView(mount, {
  state: EditorState.create({ schema: new Schema({
    nodes: basicSchema.spec.nodes,
    marks: basicSchema.spec.marks,
  }), doc: null }),
});
// create with doc directly (avoid plugin noise)
const state = EditorState.create({
  schema: view.state.schema,
  doc: view.state.schema.nodeFromJSON(docJSON),
});
view.updateState(state);

const dom = view.dom;
dom.setAttribute('spellcheck', 'false');

dom.addEventListener('pointerdown', () => {
  if (R.firstPointerDown === null) R.firstPointerDown = now();
}, true);
dom.addEventListener('focus', () => {
  if (R.firstFocus === null) R.firstFocus = now();
}, true);
dom.addEventListener('keydown', (e) => {
  if (e.key === 'F13') R.marks.push({ t: now(), name: 'phase1-first-word' });
  else if (e.key === 'F14') R.marks.push({ t: now(), name: 'phase2-typing-60s' });
  else if (e.key === 'F15') R.marks.push({ t: now(), name: 'phase3-punct' });
  else if (e.key === 'F16') R.marks.push({ t: now(), name: 'end' });
  else push({ t: now(), type: 'keydown', key: e.key });
}, true);
dom.addEventListener('keyup', (e) => {
  if (!/^F1[3-6]$/.test(e.key)) push({ t: now(), type: 'keyup', key: e.key });
}, true);
dom.addEventListener('beforeinput', (e) => {
  push({ t: now(), type: 'beforeinput', inputType: e.inputType, data: e.data ?? null, docLen: docLen(view) });
}, true);
dom.addEventListener('compositionstart', (e) => {
  if (R.firstCompositionStart === undefined) R.firstCompositionStart = now();
  compOpen = { start: now(), end: null, updates: 0, committed: '', docBefore: docLen(view) };
  push({ t: now(), type: 'compositionstart', data: e.data ?? '', docLen: docLen(view) });
}, true);
dom.addEventListener('compositionupdate', (e) => {
  if (compOpen) compOpen.updates++;
  push({ t: now(), type: 'compositionupdate', data: e.data ?? '', docLen: docLen(view) });
}, true);
dom.addEventListener('compositionend', (e) => {
  const t = now();
  if (compOpen) {
    compOpen.end = t;
    compOpen.committed = e.data ?? '';
    compOpen.docAfter = docLen(view);
    R.comps.push(compOpen);
    compOpen = null;
  } else {
    R.comps.push({ start: null, end: t, updates: 0, committed: e.data ?? '', docBefore: null, docAfter: docLen(view), orphan: true });
  }
  push({ t, type: 'compositionend', data: e.data ?? '', docLen: docLen(view) });
}, true);

// samplers
setInterval(() => {
  R.growth.push({ t: now(), len: docLen(view) });
  const dropped = R.comps.filter(c => c.committed.length === 0).length;
  document.title = `IME-TEST ${SHELL} comps=${R.comps.length} dropped=${dropped} docLen=${docLen(view)}`;
}, 500);
(function raf() {
  const t = now();
  const gap = t - lastRaf;
  if (gap > R.rafMaxGap) R.rafMaxGap = gap;
  lastRaf = t;
  requestAnimationFrame(raf);
})();

// ---- report -----------------------------------------------------------------
window.__getReport = function () {
  const t = now();
  const openComp = compOpen ? { age: t - compOpen.start, start: compOpen.start } : null;
  const stuck = R.comps.filter(c => c.end - c.start > 3000).length +
    (openComp && openComp.age > 3000 ? 1 : 0);
  return {
    ...R,
    firstCompositionStart: R.firstCompositionStart ?? null,
    focusLatencyMs: (R.firstFocus !== null && R.firstPointerDown !== null)
      ? R.firstFocus - R.firstPointerDown : null,
    openComp,
    stuckCompositions: stuck,
    now: t,
  };
};
window.__ime = { ready: true, shell: SHELL };
