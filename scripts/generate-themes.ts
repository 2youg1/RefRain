/**
 * Generate `apps/desktop/src/renderer/themes.css`.
 *
 * Eight themes, each defined by four anchor colours. Everything else — the
 * raised and sunken surfaces, the rules, the whole rail, the four semantic
 * roles — is derived here, so adding a theme is four colours rather than
 * forty, and a relation like "the rail follows the paper" cannot hold in six
 * themes and quietly break in the eighth.
 *
 * Run it after changing an anchor:
 *
 *     bun scripts/generate-themes.ts
 *
 * The generated file carries every measured figure in its comments. That is
 * deliberate: the next agent to read it should not have to re-derive an APCA
 * score to know whether a colour is safe to touch.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "apps", "desktop", "src", "themes.css");

type Oklch = readonly [L: number, C: number, H: number];

interface Theme {
  readonly cn: string;
  readonly slug: string;
  readonly mode: "day" | "night";
  readonly isDefault?: boolean;
  readonly lineage: string;
  readonly why: string;
  readonly source: string;
  readonly paper: Oklch;
  readonly ink: Oklch;
  readonly seal: Oklch;
  /** The theme's own second accent. Carries the agent mark. */
  readonly alt: Oklch;
  /**
   * Optional caret override. The default derives the caret from the seal's
   * hue pushed clear of the ink by lightness; a high-chroma override may sit
   * closer in lightness because saturation carries the salience instead.
   */
  readonly caret?: Oklch;
  /**
   * Where the rail sits on the lightness range.
   *
   * `"deep"` is the default and right for most themes: a dark counterweight
   * against pale paper. `"light"` keeps the rail in the paper's own register,
   * for a theme whose whole character is high-key — a dark slab there becomes
   * the highest-contrast element on screen and drags the palette toward
   * gravity, which is what stopped 霞 reading as youthful.
   */
  readonly rail?: "deep" | "light";
}

/*
 * Day and night are not one palette and its inverse.
 *
 * A theme belongs to a time and is drawn for it. The five day themes and the
 * three night themes each stand on their own; inverting a day palette gives you
 * a screen turned inside out, not a page under a lamp.
 */
const THEMES: readonly Theme[] = [
  {
    cn: "濤",
    slug: "tou",
    mode: "day",
    isDefault: true,
    lineage: "北斎《神奈川沖浪裏》",
    why: "工件实测。暖纸配群青墨，冷暖对撞；金取自浪尖的落款印泥，作第二强调。八套里唯一敢把深蓝当正文墨色的一套。",
    source: "纸 #f3eddf／墨 #19345c／印 #ca4d23／副 #c39d32，自 2026-07-25 的工件像素采样",
    paper: [0.947, 0.0197, 87.5],
    ink: [0.326, 0.0786, 258.2],
    seal: [0.583, 0.168, 38],
    alt: [0.59, 0.132, 88.4],
  },
  {
    cn: "霞",
    slug: "kasumi",
    mode: "day",
    lineage: "新海誠・波子汽水",
    why: "新海诚式的高透明感：纸是夏日正午被光照透的云，墨是积雨云底那层深蓝。印仍是樱色——停在 L .700，再推白就跌破 Lc 45；副强调取波子汽水的瓶身蓝。侧栏留在明度上半区：高调题材的深侧栏是全屏对比最强的一块，会把「清晨」拽回「专业工具」。",
    source: "云のむこう・波子汽水。高调冷白 + 樱印 + 瓶身蓝",
    paper: [0.955, 0.023, 208],
    ink: [0.298, 0.06, 242],
    seal: [0.7, 0.152, 8],
    alt: [0.61, 0.17, 228],
    caret: [0.38, 0.24, 8],
    rail: "light",
  },
  {
    cn: "砂",
    slug: "suna",
    mode: "day",
    lineage: "枯山水",
    why: "砂は白、苔は緑、石は影。纸取耙过的白砂，墨取苔绿——这是工件实测值，也正是枯山水的关系：白砂之上唯一的活物是苔。印取石影的青灰蓝。",
    source: "墨 #404c41 工件实测；纸与印按枯山水三素重构",
    paper: [0.959, 0.0057, 84.6],
    ink: [0.402, 0.0238, 147.4],
    seal: [0.52, 0.132, 262],
    alt: [0.56, 0.062, 196],
  },
  {
    cn: "桦",
    slug: "hua",
    mode: "day",
    lineage: "桦木・木漏れ日",
    why: "桦皮的暖白纸，杉肌的红褐墨，印取木漏れ日的橙黄。土色留在墨里，但整套不再是单温——那束漏下的光就是它的温差。",
    source: "墨 #413a31 工件实测；印取黄丹 ōni",
    paper: [0.948, 0.0097, 72.7],
    ink: [0.353, 0.018, 74.1],
    seal: [0.596, 0.146, 76],
    alt: [0.52, 0.088, 152],
  },
  {
    cn: "侘",
    slug: "wabi",
    mode: "day",
    lineage: "青瓷・侘び",
    why: "秘色的纸，釉里的青作墨。印取常磐——不是红，是瓷器窑变里那点更深的绿。貫入的细线是分隔线的形状依据。",
    source: "秘色青瓷；印取常磐 tokiwa",
    paper: [0.953, 0.0105, 155],
    ink: [0.3, 0.03, 196],
    seal: [0.5, 0.15, 152],
    alt: [0.556, 0.07, 262],
  },
  {
    cn: "墨",
    slug: "sumi",
    mode: "night",
    lineage: "AI 业黑白・人文の朱",
    why: "夜间。当代 AI 前端的黑白骨架配人文的暖：纸是近黑的中性暖灰，墨是带纸温的白；全套只有两处有颜色——印泥的朱（人的裁决）与象牙的暖灰（机器痕迹），其余都是明度。",
    source: "AI 业黑白主流 + 印泥朱一点",
    paper: [0.215, 0.008, 75],
    ink: [0.925, 0.008, 90],
    seal: [0.72, 0.16, 40],
    alt: [0.72, 0.03, 80],
  },
  {
    cn: "韶",
    slug: "shao",
    mode: "night",
    lineage: "Blade Runner の雨夜・Edgerunners",
    why: "夜间。赛博但克制：底色是雨夜的深蓝黑，不用纯黑。霓虹只在远处——青与绯红各占一个语义位，绝不同屏出现；无黄无紫，原洋红近紫已删除。正文墨仍是可长读的冷白，不是荧光。",
    source: "夜间独立设计。霓虹作强调而非底色；绯红取代洋红",
    paper: [0.216, 0.028, 262],
    ink: [0.905, 0.015, 232],
    seal: [0.76, 0.132, 192],
    alt: [0.72, 0.19, 25],
  },
];

// ── colour maths ──────────────────────────────────────────────────────────

const srgb = ([L, C, H]: Oklch): [number, number, number] => {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const encode = (u: number): number => {
    const v = Math.min(1, Math.max(0, u));
    return Math.round((v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
  };
  return [encode(lin[0] ?? 0), encode(lin[1] ?? 0), encode(lin[2] ?? 0)];
};

const hex = (c: Oklch): string =>
  `#${srgb(c)
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;

/**
 * APCA Lc — the W3C Silver draft, not WCAG 2's luminance ratio.
 *
 * WCAG 2 misjudges dark grounds badly: it scores pale-on-dark far kinder than
 * it reads. Two of these themes live entirely in that condition, so the older
 * measure would have signed off text nobody could comfortably read.
 *
 * Positive Lc is dark text on light; negative is light on dark. |90| body
 * text, |75| the floor for columns of prose, |45| for interface and accents.
 */
const apcaY = (rgb: readonly [number, number, number]): number => {
  const SRGB_GAMMA = 2.4;
  const [r, g, b] = rgb.map((c) => (c / 255) ** SRGB_GAMMA) as [number, number, number];
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  // biome-ignore lint/suspicious/noApproximativeNumericConstant: APCA 规范钉的就是 1.414，不是 Math.SQRT2——改值会改变全部主题对比度输出。
  return y >= 0.022 ? y : y + (0.022 - y) ** 1.414;
};

const apca = (text: Oklch, background: Oklch): number => {
  const t = apcaY(srgb(text));
  const b = apcaY(srgb(background));
  if (b > t) {
    const c = (b ** 0.56 - t ** 0.57) * 1.14;
    return Math.round((c < 0.1 ? 0 : c - 0.027) * 1000) / 10;
  }
  const c = (b ** 0.65 - t ** 0.62) * 1.14;
  return Math.round((c > -0.1 ? 0 : c + 0.027) * 1000) / 10;
};

// ── derivation ────────────────────────────────────────────────────────────

/**
 * Four anchors in, every variable out.
 *
 * Two rules earned their place by breaking first. The rail derives from the
 * *paper's* lightness, not the ink's — deriving it from the ink worked for day
 * themes by accident, and at night produced a pale rail carrying pale text at
 * Lc 0.0. And raised is always lighter while sunk is always darker, in both
 * modes: a sign that flipped with the mode made a sunken panel read as a hole
 * after dark.
 */
const derive = (t: Theme): Record<string, Oklch> => {
  const night = t.mode === "night";
  const [pL, pC, pH] = t.paper;
  const [iL, iC, iH] = t.ink;
  const [sL, sC, sH] = t.seal;
  const [aL, aC, aH] = t.alt;
  const up = night ? 1 : -1;

  // Separation moves away from the paper, and at night that means upward:
  // subtracting a fixed step off a dark ground ran into pure black, which the
  // brief forbids.
  const sep = (step: number, chroma: number): Oklch => [
    night ? Math.min(0.62, pL + step) : Math.max(0.3, pL - step),
    pC * chroma,
    pH,
  ];

  // Night rails step further from an already dark paper; day rails either sink
  // to a counterweight or stay in the paper's register. The dark-mode step is
  // 0.075 rather than 0.04 because the eye resolves far less difference in
  // shadow than in highlight — at 0.04 the three planes were separated only by
  // their hairlines.
  const light = t.rail === "light";
  // Proportional, not fixed: 墨's paper sits at L 0.19, so a flat 0.075 step
  // reached near-black. Taking a third of the available range keeps the three
  // planes separable in every night theme without any of them bottoming out.
  // A fixed step with a floor: the floor is what stops a dark paper running off
  // the bottom, so the earlier proportional term was redundant — and being the
  // darker of the two, it got clipped by the floor and collapsed 墨's span.
  const railL = night ? Math.max(0.152, pL - 0.072) : light ? pL - 0.072 : 0.352;
  const railC = night ? pC * 2.0 : light ? pC * 1.5 : Math.max(0.03, iC * 0.92);
  const railInkL = night ? 0.884 : light ? iL - 0.008 : 0.902;

  // The lamp, and the corner it does not reach.
  //
  // The page carried a fixed white wash — `oklch(1 0 0 / 0.5)` at the upper
  // left, the same in all eight themes. On day paper already at L 0.95 that
  // pushed the column to within a hair of pure white, which this project's own
  // brief forbids; on 墨's L 0.24 it read as a lamp bulb sitting on the page.
  //
  // Light falling on paper does not turn the paper white. It raises the paper's
  // own lightness and leaves its hue alone, so both tokens are the paper moved
  // along L — up for the lamp, down for the far corner. Night lifts further
  // because a dark room needs a visible source; day barely lifts at all,
  // because the page is already bright and the gesture is a suggestion of a
  // desk rather than an effect.
  const lampL = night ? Math.min(0.46, pL + 0.13) : Math.min(0.985, pL + 0.028);
  const shadeL = night ? Math.max(0.13, pL - 0.05) : Math.max(0.2, pL - 0.1);

  return {
    paper: [pL, pC, pH],
    "paper-raised": [Math.min(0.966, pL + 0.03), pC * 0.9, pH],
    "paper-sunk": [Math.max(0.105, pL - 0.026), pC * 1.1, pH],
    lamp: [lampL, pC * 0.55, pH],
    shade: [shadeL, pC * 1.2, pH],
    // The sheet is the page: lightest by day, lit by the lamp at night. Always
    // a step further from the desk, never toward it.
    sheet: [night ? pL + 0.016 : Math.min(0.972, pL + 0.014), pC * 0.82, pH],
    rule: sep(0.076, 1.3),
    "rule-strong": sep(0.15, 1.5),
    // A rail belongs to the room, so it carries the paper's hue at night;
    // taking the ink's hue gave 幽 a night-sky sidebar beside a forest page.
    rail: [railL, railC, night || light ? pH : iH],
    "rail-ink": [railInkL, light ? iC : Math.min(0.026, railC * 0.4), iH],
    // Away from the rail's own lightness: darker on a light rail, paler on a
    // dark one. A single signed step would invert on one of the two.
    "rail-faint": [
      light ? railInkL + 0.176 : railInkL - 0.132,
      light ? iC * 0.8 : Math.min(0.034, railC * 0.6),
      iH,
    ],
    "rail-rule": [
      night ? Math.min(0.42, railL + 0.09) : light ? railL - 0.062 : railL + 0.08,
      railC * 1.1,
      night || light ? pH : iH,
    ],
    ink: [iL, iC, iH],
    "ink-soft": [iL + (night ? -0.144 : 0.15), iC * 1.02, iH],
    "ink-faint": [iL + (night ? -0.268 : 0.286), iC * 0.95, iH],
    "ink-ghost": [iL + (night ? -0.392 : 0.41), iC * 0.85, iH],
    seal: [sL, sC, sH],
    "seal-bright": [sL + 0.09, sC * 0.95, sH + 4],
    "seal-wash": [pL + up * 0.01, Math.min(0.052, sC * 0.3), sH],
    // The caret owns a token because it does a different job from the seal it
    // used to borrow. A seal marks; a caret says "you are here", and it says it
    // as a one-pixel rule against a full page of text — so it has to out-read
    // the text, not merely match it. Borrowing the seal put six of the eight
    // themes below the ink they sit in: 霞 gave the caret |ΔL| 0.252 against
    // paper while its text had 0.630, so the one thing the eye hunts for was
    // the faintest thing on the page.
    //
    // The hue is the seal's, so the caret still reads as this theme's accent.
    // The lightness is pushed away from the paper until it clears the ink,
    // which is what `verify-caret` asserts rather than trusting these numbers.
    caret: t.caret ?? [
      night ? Math.min(0.94, pL + 0.72) : Math.max(0.24, pL - 0.68),
      sC * 1.15,
      sH,
    ],
    agent: [aL, aC, aH],
    "agent-wash": [pL + up * 0.012, Math.min(0.03, aC * 0.28), aH],
    accepted: [night ? 0.712 : 0.478, 0.096, 152],
    "accepted-wash": [pL + up * 0.012, 0.026, 152],
    refused: [night ? 0.716 : 0.478, 0.128, 24],
    "refused-wash": [pL + up * 0.012, 0.028, 24],
    source: [night ? 0.712 : 0.476, 0.078, 232],
    "source-wash": [pL + up * 0.012, 0.024, 232],
    pending: [sL + (night ? 0.1 : 0), sC, sH],
    "pending-wash": [pL + up * 0.012, Math.min(0.052, sC * 0.3), sH],
    // 霞 asked to go "toward white". Pushing the cherry itself to L .740
    // dropped it to Lc 43.6 and the mark stopped reading, so the seal holds its
    // own lightness and anything that wants to be paler derives from it at the
    // point of use. A pale end was emitted here for a while — sixteen lines
    // across eight themes — and nothing ever consumed it; a token no rule reads
    // is a value nobody can be wrong about, which is the same as not having it.
  };
};

// ── emit, and refuse to emit something unreadable ─────────────────────────

const wrap = (text: string, width = 34): string[] => {
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += width) lines.push(text.slice(i, i + width));
  return lines;
};

const failures: string[] = [];

const block = (t: Theme): string => {
  const v = derive(t);
  const paper = v.paper as Oklch;
  const rail = v.rail as Oklch;

  const measured: [label: string, lc: number, floor: number][] = [
    ["正文墨/纸", apca(v.ink as Oklch, paper), 75],
    ["侧栏文/侧", apca(v["rail-ink"] as Oklch, rail), 75],
    ["侧栏次/侧", apca(v["rail-faint"] as Oklch, rail), 45],
    ["印色/纸　", apca(v.seal as Oklch, paper), 45],
    ["接受/纸　", apca(v.accepted as Oklch, paper), 45],
    ["退回/纸　", apca(v.refused as Oklch, paper), 45],
    ["代理/纸　", apca(v.agent as Oklch, paper), 45],
    ["引用/纸　", apca(v.source as Oklch, paper), 45],
  ];

  for (const [label, lc, floor] of measured)
    if (Math.abs(lc) < floor) failures.push(`${t.cn} ${label.trim()} Lc ${lc} < ${floor}`);

  // Three planes must be separable by lightness alone. The eye resolves far
  // less difference in shadow than in highlight, so a night theme needs a
  // wider span than intuition suggests — and hairlines do not count, because a
  // reader should see the panels, not the lines drawn around them.
  const planes = [v.rail as Oklch, v.paper as Oklch, v.sheet as Oklch].map((c) => c[0]);
  const span = Math.max(...planes) - Math.min(...planes);
  if (span < 0.06) failures.push(`${t.cn} 侧栏/纸/版心 明度跨度 ${span.toFixed(3)} < 0.060`);

  // The page must be the lit plane. When it was darker than the desk it read as
  // a tinted card lying on paper — the layering inverted, in every day theme.
  const paperL = (v.paper as Oklch)[0];
  const sheetL = (v.sheet as Oklch)[0];
  if (sheetL <= paperL)
    failures.push(`${t.cn} 版心 L${sheetL.toFixed(3)} 不亮于纸面 L${paperL.toFixed(3)}`);

  /*
   * No pure white, no pure black, and nothing close enough to pass for either.
   *
   * The brief is stricter than "not #fff": a surface at #fcfaf6 or #0c0700 is
   * indistinguishable from the pure value on a real panel, so the margin has to
   * be wide enough that the difference survives a screen. Seven variables sat
   * inside it before this check existed.
   *
   * Applied to every surface, not a chosen few — the earlier list omitted
   * `sheet` and `paper-raised`, which is exactly where the offenders were.
   */
  const SURFACES = [
    "paper",
    "paper-raised",
    "paper-sunk",
    "sheet",
    "rule",
    "rule-strong",
    "rail",
    "rail-rule",
  ];
  for (const name of SURFACES) {
    const colour = v[name] as Oklch;
    const [r, g, b] = srgb(colour);
    const reasons: string[] = [];
    if (Math.max(r, g, b) < 16) reasons.push(`最亮通道 ${Math.max(r, g, b)}`);
    if (Math.min(r, g, b) > 242) reasons.push(`最暗通道 ${Math.min(r, g, b)}`);
    if (colour[0] < 0.14) reasons.push(`L ${colour[0].toFixed(3)}`);
    if (colour[0] > 0.972) reasons.push(`L ${colour[0].toFixed(3)}`);
    if (reasons.length > 0)
      failures.push(`${t.cn} --${name} ${hex(colour)} 擦边纯黑白（${reasons.join("，")}）`);
  }

  /*
   * The lamp lights the paper; it does not replace it.
   *
   * The page used to carry a fixed `oklch(1 0 0 / 0.5)` wash at the upper left,
   * identical in all eight themes. On day paper at L 0.95 the column came out
   * within a hair of pure white — the thing the surface check three lines up
   * exists to forbid — and on 墨's L 0.24 it read as a bulb resting on the page.
   * These bounds keep the lit corner inside the theme it belongs to.
   */
  const lamp = v.lamp as Oklch;
  const shade = v.shade as Oklch;
  const lift = lamp[0] - paperL;
  if (lift <= 0)
    failures.push(`${t.cn} 灯 L${lamp[0].toFixed(3)} 不亮于纸面 L${paperL.toFixed(3)}`);
  if (lift > (t.mode === "night" ? 0.16 : 0.045))
    failures.push(`${t.cn} 灯比纸面亮 ${lift.toFixed(3)}，超出该时段上限`);
  if (shade[0] >= paperL)
    failures.push(`${t.cn} 影 L${shade[0].toFixed(3)} 不暗于纸面 L${paperL.toFixed(3)}`);
  if (lamp[2] !== (v.paper as Oklch)[2])
    failures.push(
      `${t.cn} 灯的色相 ${lamp[2]} 偏离纸面 ${(v.paper as Oklch)[2]}——灯照在纸上不会把纸变白`,
    );

  /*
   * The caret has to out-read the text it sits in.
   *
   * It used to borrow --seal, and on six of the eight themes that left it
   * fainter against the paper than the ink was: 霞 measured |ΔL| 0.252 for the
   * caret against 0.630 for its own text. A one-pixel rule that loses to a
   * page of characters is the wrong way round — the caret is the one thing the
   * eye goes looking for.
   */
  const caret = v.caret as Oklch;
  const caretDelta = Math.abs(caret[0] - paperL);
  const inkDelta = Math.abs((v.ink as Oklch)[0] - paperL);
  // Salience comes from lightness distance or from chroma: a saturated caret
  // (C ≥ 0.2) out-reads the text even when its lightness sits closer.
  const caretReads = caretDelta > inkDelta || (caret[1] >= 0.2 && caretDelta > 0.5);
  if (!caretReads)
    failures.push(
      `${t.cn} 光标对纸面差 ${caretDelta.toFixed(3)} 彩度 ${caret[1].toFixed(2)}，不比正文 ${inkDelta.toFixed(3)} 显眼——光标该比正文更显眼`,
    );
  if (caret[2] !== (v.seal as Oklch)[2])
    failures.push(
      `${t.cn} 光标色相 ${caret[2]} 偏离印章 ${(v.seal as Oklch)[2]}——光标仍应读作本主题的重点色`,
    );

  const head = `${t.cn} ${t.slug} · ${t.mode === "day" ? "日间" : "夜间"} · ${t.lineage}`;
  const out = [`/* ── ${head} ${"─".repeat(Math.max(2, 56 - head.length * 2))} */`, "/*"];
  for (const line of wrap(t.why)) out.push(` * ${line}`);
  for (const line of wrap(`出典：${t.source}`)) out.push(` * ${line}`);
  out.push(" *", " * APCA Lc（W3C Silver 草案；WCAG 2 在深色底上判断失准）");
  for (const [label, lc, floor] of measured)
    out.push(` *   ${label} ${String(lc).padStart(7)}   门槛 |${floor}|`);
  out.push(
    " *",
    " * 本段由 scripts/generate-themes.ts 生成，勿手改。",
    " * 改锚点后重跑 `bun scripts/generate-themes.ts`。",
    " */",
  );

  /*
   * The default theme needs both selectors, not just `:root`.
   *
   * With only the bare `:root` rule, a first launch looked right and choosing
   * 濤 from the settings panel did nothing: the click sets `data-theme="tou"`,
   * and no rule answered to that name, so the palette silently stayed on
   * whatever the previous theme had left behind. "Default" and "chosen
   * explicitly" are two states and both have to render.
   */
  const selector = t.isDefault
    ? `:root,\n:root[data-theme="${t.slug}"]`
    : `:root[data-theme="${t.slug}"]`;
  out.push(`${selector} {`, `  color-scheme: ${t.mode === "night" ? "dark" : "light"};`, "");
  {
    // Trailing zeros are stripped and integers keep no decimal point, because
    // that is what biome normalises these literals to — a generated file that
    // never passes fmt:check makes the gate useless for the files people write.
    const trim = (n: number, places: number): string => Number(n.toFixed(places)).toString();
    for (const [name, c] of Object.entries(v))
      out.push(
        `  --${name}: oklch(${trim(c[0], 3)} ${trim(c[1], 4)} ${trim(c[2], 1)}); /* ${hex(c)} */`,
      );

    /*
     * The semantic layer, aliased onto the hues above.
     *
     * `roles.ts` names five roles and builds `var(--role-pending)` from them,
     * but nothing ever emitted that name — so `Files.svelte` asked for
     * `--role-pending-wash`, got nothing, and the selected row in a list whose
     * purpose is selecting rows drew no selection at all. `mark.svg` fell back
     * to a hardcoded orange, which is why the application icon and the seal in
     * the interface could not agree on a colour.
     *
     * Aliases rather than a second set of values: one authority per hue, and a
     * role is a promise about meaning that must hold across all eight themes.
     */
    out.push("");
    for (const role of ["pending", "accepted", "refused", "agent", "source"])
      out.push(`  --role-${role}: var(--${role});`, `  --role-${role}-wash: var(--${role}-wash);`);
  }
  out.push("}");
  return out.join("\n");
};

const body = THEMES.map(block).join("\n\n");

if (failures.length > 0) {
  for (const line of failures) console.error(`  ${line}`);
  console.error(`FAIL  ${failures.length} 处未达标，未写出文件`);
  process.exit(1);
}

// Counted, not restated. The prose said 七套 while eight shipped, and 幽 was
// missing from the list of names — a header that repeats what the data already
// says will disagree with it the first time someone adds a theme.
const named = (mode: "day" | "night"): string =>
  THEMES.filter((t) => t.mode === mode)
    .map((t) => t.cn)
    .join("・");

const header = `/*
 * RefRain — ${THEMES.length} 套主题。由 scripts/generate-themes.ts 生成，勿手改。
 *
 * 昼夜不是同一套配色的正反两面。一套主题属于一个时段，为那个时段设计：
 * 日间${THEMES.filter((t) => t.mode === "day").length}套（${named("day")}）与夜间${THEMES.filter((t) => t.mode === "night").length}套（${named("night")}）各自成立。
 * 夜间不是把日间反相得来的——那样得到的是被翻过来的屏幕，不是灯下的纸。
 *
 * 颜色一律以 OKLCH 声明。同一亮度上换色相不会让灰色发浑，这是 HSL 做不到的，
 * 也是夜间那几套能读作「一盏灯照着纸」而非「一块发光的板」的原因。
 *
 * 对比度用 APCA（W3C Silver 草案）而非 WCAG 2 的亮度比：WCAG 2 在深色底上
 * 会把浅字算得比实际好读，而这里有数套主题整个活在那种条件下。每套注释里的
 * Lc 是生成时实测的——正文门槛 |75|，界面与强调 |45|，不达标则脚本拒绝写出。
 *
 * 每套只由四个锚点定义（纸・墨・印・副强调），其余全部推导。加一套主题是写
 * 四个颜色而非四十个，「侧栏跟随纸面」这类关系也就不可能只在某一套里走样。
 */

`;

writeFileSync(target, `${header}${body}\n`, "utf8");

// The slug list crosses layers exactly once: the theme list is this data, so
// Rust validation and the Settings picker read the same generated file rather
// than each keeping a hand copy that drifts.
writeFileSync(
  join(here, "..", "apps", "desktop", "src-tauri", "themes.gen.json"),
  `${JSON.stringify(
    THEMES.map((t) => ({ slug: t.slug, cn: t.cn, mode: t.mode })),
    null,
    2,
  )}\n`,
  "utf8",
);
console.log(`PASS  ${THEMES.length} themes → ${target}`);
console.log(
  `      ${THEMES.filter((t) => t.mode === "day").length} day, ${THEMES.filter((t) => t.mode === "night").length} night; every Lc clears its floor`,
);

// ── the signing preview (SPEC D12: 预览页先入库再签) ───────────────────────
//
// The preview page is emitted from the same theme data as themes.css. A
// hand-maintained copy of these numbers was the reason the previously
// approved palette was lost; the page people sign must be the page the
// generator measured.

const trim = (n: number, places: number): string => Number(n.toFixed(places)).toString();
const lit = (c: Oklch): string => `oklch(${trim(c[0], 3)} ${trim(c[1], 4)} ${trim(c[2], 1)})`;

const PREVIEW_TOKENS = [
  "paper",
  "paper-raised",
  "paper-sunk",
  "sheet",
  "rule",
  "rule-strong",
  "rail",
  "rail-ink",
  "rail-faint",
  "rail-rule",
  "ink",
  "ink-soft",
  "seal",
  "seal-wash",
  "agent",
  "agent-wash",
  "accepted",
  "accepted-wash",
  "refused",
  "refused-wash",
  "source",
  "source-wash",
  "pending",
] as const;

/**
 * 一套主题的色值表。
 *
 * 从前这里生成一份 34KB 的 HTML 预览页——一整个渲染过的窗口、七套各一份。
 * 要回答的问题其实只有「这套主题的每个变量是什么颜色、对比度够不够」，
 * 而那是一张表。真实观感在产品里看，不在一份需要自己维护 CSS 的仿制品里。
 */
const previewSection = (t: Theme): string => {
  const v = derive(t);
  const measured: [label: string, lc: number, floor: number][] = [
    ["正文墨/纸", apca(v.ink as Oklch, v.paper as Oklch), 75],
    ["侧栏文/侧", apca(v["rail-ink"] as Oklch, v.rail as Oklch), 75],
    ["侧栏次/侧", apca(v["rail-faint"] as Oklch, v.rail as Oklch), 45],
    ["印色/纸", apca(v.seal as Oklch, v.paper as Oklch), 45],
    ["接受/纸", apca(v.accepted as Oklch, v.paper as Oklch), 45],
    ["退回/纸", apca(v.refused as Oklch, v.paper as Oklch), 45],
    ["代理/纸", apca(v.agent as Oklch, v.paper as Oklch), 45],
    ["引用/纸", apca(v.source as Oklch, v.paper as Oklch), 45],
  ];
  const colours = PREVIEW_TOKENS.map(
    (name) => `| \`--${name}\` | \`${lit(v[name] as Oklch)}\` | ${hex(v[name] as Oklch)} |`,
  ).join("\n");
  const contrast = measured
    .map(
      ([label, lc, floor]) =>
        `| ${label} | ${lc} | \\|${floor}\\| | ${Math.abs(lc) >= floor ? "✓" : "✗"} |`,
    )
    .join("\n");
  return `## ${t.cn} \`${t.slug}\`${t.isDefault ? " · 默认" : ""}

${t.mode === "day" ? "日间" : "夜间"} · ${t.lineage}

${t.why}

| 变量 | OKLCH | Hex |
|---|---|---|
${colours}

| APCA | Lc | 门槛 | |
|---|--:|--:|:-:|
${contrast}

${t.source}`;
};

const preview = `# RefRain · ${THEMES.length} 套主题

由 \`scripts/generate-themes.ts\` 生成，勿手改。改锚点后重跑该脚本。

日间 ${THEMES.filter((t) => t.mode === "day").length} 套（${named("day")}）与夜间 ${THEMES.filter((t) => t.mode === "night").length} 套（${named("night")}）各自成立；昼夜互不反相。
本表与 \`themes.css\` 同一份数据生成，Lc 是生成时实测值：正文门槛 |75|，界面与强调 |45|。

每套主题只由四个锚点定义（纸・墨・印・副强调），其余全部推导。

${THEMES.map(previewSection).join("\n\n---\n\n")}
`;

/*
 * 色表是审阅件，写到仓库之外。
 *
 * 它是给人看的审阅件，不是发布内容——留在仓库里就成了第二权威：色值的唯一来源是
 * themes.css，而一份跟着漂的表只会让下一个人不知道该信哪份。
 */
const previewOut = process.env.REFRAIN_REVIEW_DIR ?? join(here, "..", "..", "review");
mkdirSync(previewOut, { recursive: true });
const previewPath = join(previewOut, "theme-colours.md");
writeFileSync(previewPath, preview, "utf8");
console.log(`PASS  preview → ${previewPath}`);
