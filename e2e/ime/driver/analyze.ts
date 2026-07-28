#!/usr/bin/env bun
/**
 * Merge results/<shell>/final.json into results/summary.json and summary.md.
 * v0.2 has exactly one shell: wv2 (WebView2), the engine the product ships.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const shells = ["wv2"] as const;
const PUNCT: Record<string, string> = { ",": "，", ".": "。", "?": "？", "!": "！" };
const CH_PUNCT = ["，", "。", "？", "！"];

interface Mark {
  t: number;
  name: string;
}
interface Ev {
  t: number;
  type: string;
  key?: string;
  data?: string | null;
  inputType?: string;
}
interface Report {
  marks: Mark[];
  events: Ev[];
  comps: { start: number | null; end: number | null }[];
  chrome: string;
  ua: string;
  docChars: number;
  focusLatencyMs: number | null;
  firstPointerDown: number | null;
  firstCompositionStart: number | null;
  openComp: { age: number } | null;
  rafMaxGap: number;
}

function sliceByMarks(rep: Report, from: string, to: string): { evs: Ev[] } {
  const m = Object.fromEntries(rep.marks.map((x) => [x.name, x.t]));
  const t0 = m[from] ?? 0;
  const t1 = m[to] ?? Infinity;
  return { evs: rep.events.filter((e) => e.t >= t0 && e.t < t1) };
}

function analyze(shell: string): Record<string, unknown> {
  const p = `${ROOT}/results/${shell}/final.json`;
  if (!existsSync(p)) return { shell, error: "missing final.json" };
  const rep = JSON.parse(readFileSync(p, "utf8")) as Report;

  const p2 = sliceByMarks(rep, "phase2-typing-60s", "phase3-punct");
  const p2Ends = p2.evs.filter((e) => e.type === "compositionend");
  const p2Dropped = p2Ends.filter((e) => !e.data || e.data.length === 0).length;
  const p2Chars = p2Ends.reduce((a, e) => a + (e.data ? [...e.data].length : 0), 0);
  const p2Keys = p2.evs.filter((e) => e.type === "keydown" && /^[a-z ]$/.test(e.key ?? "")).length;

  const p3 = sliceByMarks(rep, "phase3-punct", "end");
  const punctKeys = p3.evs.filter(
    (e) => e.type === "keydown" && (PUNCT[e.key ?? ""] !== undefined || e.key === "Process"),
  );
  let firstPressOK = 0;
  const fails: { key?: string; t: number }[] = [];
  const perChar: Record<string, number> = {};
  for (const k of punctKeys) {
    const hit = p3.evs.find(
      (e) =>
        e.t > k.t &&
        e.t - k.t < 900 &&
        ((e.type === "beforeinput" &&
          e.inputType === "insertCompositionText" &&
          CH_PUNCT.includes(e.data ?? "")) ||
          (e.type === "beforeinput" && CH_PUNCT.includes(e.data ?? "")) ||
          (e.type === "compositionend" && CH_PUNCT.includes(e.data ?? ""))),
    );
    if (hit) {
      firstPressOK += 1;
      perChar[hit.data ?? ""] = (perChar[hit.data ?? ""] ?? 0) + 1;
    } else {
      fails.push({ key: k.key, t: k.t });
    }
  }

  const m1 = rep.marks.find((x) => x.name === "phase1-first-word");
  const cs1 = m1 ? rep.events.find((e) => e.t >= m1.t && e.type === "compositionstart") : null;

  const stuckComps = rep.comps.filter(
    (c) => c.start != null && c.end != null && c.end - c.start > 3000,
  ).length;
  const openComp = rep.openComp && rep.openComp.age > 3000 ? 1 : 0;

  return {
    shell,
    chrome: rep.chrome,
    docChars: rep.docChars,
    focusLatencyMs: rep.focusLatencyMs,
    firstClickToCompositionMs:
      rep.firstPointerDown != null && rep.firstCompositionStart != null
        ? rep.firstCompositionStart - rep.firstPointerDown
        : null,
    phase1MarkToCompositionMs: m1 && cs1 ? cs1.t - m1.t : null,
    p2Words: p2Ends.length,
    p2DroppedWords: p2Dropped,
    p2Chars,
    p2Keys,
    punctTotal: punctKeys.length,
    punctFirstPressOK: firstPressOK,
    punctPerChar: perChar,
    punctFails: fails,
    stuckComps: stuckComps + openComp,
    rafMaxGapMs: rep.rafMaxGap,
    compsTotal: rep.comps.length,
    eventsTotal: rep.events.length,
  };
}

const rows = shells.map(analyze);
writeFileSync(`${ROOT}/results/summary.json`, JSON.stringify(rows, null, 2));

const line = (label: string, f: (r: Record<string, unknown>) => unknown, unit = "") =>
  `| ${label} | ` + rows.map((r) => (r.error ? "N/A" : `${f(r)}${unit}`)).join(" | ") + " |";

let md = `# IME 验收（direct DOM 适配器,10 万字,WebView2）\n\n`;
md += `| 指标 | ${rows.map((r) => r.shell).join(" | ")} |\n`;
md += `|${"---|".repeat(rows.length + 1)}\n`;
md += line("Chromium", (r) => r.chrome);
md += line("文档字数", (r) => r.docChars);
md += line("首击→聚焦延迟", (r) => r.focusLatencyMs ?? "-", " ms");
md += line("首击→首个组合事件", (r) => r.phase1MarkToCompositionMs ?? "-", " ms");
md += line("连打词组数", (r) => r.p2Words);
md += line("吃字词组数", (r) => r.p2DroppedWords);
md += line("连打上屏字数", (r) => r.p2Chars);
md += line("标点测试数", (r) => r.punctTotal);
md += line("标点首击即上屏", (r) => `${r.punctFirstPressOK}/${r.punctTotal}`);
md += line("标点分布", (r) =>
  Object.entries((rows[0]?.punctPerChar as Record<string, number>) ?? {})
    .map(([k, v]) => `${k}×${v}`)
    .join(" "),
);
md += line(">3s 疑似冻结组合", (r) => r.stuckComps);
md += line("rAF 最大停顿", (r) => r.rafMaxGapMs, " ms");
md += `\n`;
writeFileSync(`${ROOT}/results/summary.md`, md);
console.log(md);
