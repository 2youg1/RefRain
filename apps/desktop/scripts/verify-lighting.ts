/**
 * The lamp lights the paper; it does not replace it.
 *
 * The page carried `oklch(1 0 0 / 0.5)` at the upper left — pure white at half
 * opacity, the same value in all eight themes. On day paper already at L 0.95
 * that pushed the column to within a hair of the pure white this project's own
 * palette rules forbid, and on 墨's L 0.24 it read as a bulb resting on the
 * page: one bright corner and the rest of the manuscript in shadow.
 *
 * Sampling happens inside the page, through `html2canvas`-free means: the
 * gradient is re-created in a canvas from the same custom properties the
 * stylesheet uses, so what is measured is what the compositor was given. Source
 * cannot answer this question — the defect was a stylesheet that read
 * reasonably and composited wrong.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIDGE_STUB, launchBrowser } from "./browser.ts";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const html = (await Bun.file(join(desktop, "dist", "renderer", "index.html")).text()).replace(
  /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
  "",
);

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    return new Response(Bun.file(join(desktop, "dist", "renderer", path)));
  },
});

const DAY = ["tou", "kasumi", "kare", "hayashi", "seiji"];
const NIGHT = ["sumi", "yu", "shigure"];

const bridge = `
localStorage.setItem("refrain.roots", JSON.stringify(["/work"]));
${BRIDGE_STUB}
Object.assign(window.refrain, {
  openProject: async () => "/work", openFile: async () => null, createProject: async () => null,
  pathFor: () => "", resolveDrop: async () => ({ ok: true, path: "/work" }),
  fullscreen: async () => true, onCloseRequest: () => () => {},
  loadProject: async () => [],
  saveChapter: async () => ({ ok: true, edits: [] }),
  loadWorkspace: async (roots) => {
    const p = roots[0]; const id = "r-work";
    const body = Array.from({ length: 40 }, (_, i) => "第" + i + "段正文，用来把版心铺满。").join("\\n\\n");
    return { roots: [{ id, path: p, name: "work", kind: "folder" }],
      chapters: [{ id: "01.md", title: "第一章", text: body, rootId: id, root: p,
        role: "chapter", path: p + "/01.md" }] };
  },
  listAgents: async () => [], addAgent: async () => ({}), enqueue: async () => true,
  manifest: async () => [], send: async () => [], runs: async () => [],
  collect: async () => ({ proposals: [], comments: [] }),
  commit: async () => ({ ok: true, text: "" }),
  ledger: async () => ({ ok: true, verdicts: [] }), reply: async () => "",
  displayProfile: async () => ({ refreshHz: 60, scaleFactor: 1, css: {} }),
  onDisplayChange: () => () => {}, fonts: async () => [], systemFonts: async () => [],
});`;

interface Sample {
  readonly label: string;
  readonly lightness: number;
}

const failures: string[] = [];
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.addInitScript(bridge);
await page.goto(`http://localhost:${server.port}`);
await page.waitForTimeout(800);

for (const theme of [...DAY, ...NIGHT]) {
  const night = NIGHT.includes(theme);
  await page.evaluate((id) => document.documentElement.setAttribute("data-theme", id), theme);
  await page.waitForTimeout(250);

  // The rendered pixels, not a reconstruction of them. An earlier version of
  // this gate rebuilt the gradient in a canvas and measured that, which made it
  // a test of its own arithmetic — every sample came back identical because the
  // reconstruction silently painted nothing.
  const box = await page.evaluate(() => {
    const surface = document.querySelector(".writing");
    if (!surface) return null;
    const { x, y, width, height } = surface.getBoundingClientRect();
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    };
  });
  if (!box || box.width < 200) {
    failures.push(`${theme}: no writing surface to sample`);
    continue;
  }

  const shot = await page.screenshot({ clip: box });
  const measured = await page.evaluate(
    async ({ png, points }) => {
      const blob = await (await fetch(`data:image/png;base64,${png}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(bitmap, 0, 0);

      // Chromium answers `oklch(L C H)` for a custom property declared that
      // way, so L is read straight off rather than round-tripped through sRGB.
      const surface = document.querySelector<HTMLElement>(".writing");
      const declared = getComputedStyle(surface ?? document.documentElement)
        .getPropertyValue("--paper")
        .trim();
      const parsed = /oklch\(\s*([\d.]+)(%?)/.exec(declared);
      const paperL = parsed ? Number(parsed[1]) / (parsed[2] === "%" ? 100 : 1) : Number.NaN;

      return {
        paperL,
        points: points.map(({ label, fx, fy }) => {
          const data = context.getImageData(
            Math.min(bitmap.width - 1, Math.floor(bitmap.width * fx)),
            Math.min(bitmap.height - 1, Math.floor(bitmap.height * fy)),
            1,
            1,
          ).data;
          return { label, rgb: [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0] };
        }),
      };
    },
    {
      png: shot.toString("base64"),
      points: [
        { label: "lit corner", fx: 0.18, fy: 0.1 },
        { label: "centre", fx: 0.5, fy: 0.5 },
        { label: "far corner", fx: 0.92, fy: 0.9 },
      ],
    },
  );

  if (!measured || Number.isNaN(measured.paperL)) {
    failures.push(`${theme}: could not read the paper this theme is built on`);
    continue;
  }

  const lightness = ([r, g, b]: readonly [number, number, number]): number => {
    const linear = (u: number): number => {
      const c = u / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const [R, G, B] = [linear(r), linear(g), linear(b)];
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  };

  const paper = measured.paperL;
  const samples: Sample[] = measured.points.map((point) => ({
    label: point.label,
    lightness: lightness(point.rgb as [number, number, number]),
  }));

  for (const { label, lightness: L } of samples) {
    const drift = L - paper;

    // The lit corner is a lamp on this paper, not a different paper.
    if (Math.abs(drift) > 0.1)
      failures.push(
        `${theme} ${label}: L ${L.toFixed(3)} drifts ${drift.toFixed(3)} from paper ${paper.toFixed(3)}`,
      );
    if (!night && L > 0.97)
      failures.push(`${theme} ${label}: L ${L.toFixed(3)} passes for pure white`);
    if (night && L > 0.44)
      failures.push(`${theme} ${label}: L ${L.toFixed(3)} — a night page lit like a bulb`);
    if (night && L < 0.13)
      failures.push(`${theme} ${label}: L ${L.toFixed(3)} passes for pure black`);
  }

  // And the lamp has to be doing something, or the token is decoration.
  const lit = samples.find((sample) => sample.label === "lit corner")?.lightness ?? 0;
  const far = samples.find((sample) => sample.label === "far corner")?.lightness ?? 0;
  if (lit <= far)
    failures.push(`${theme}: the lit corner is not lighter than the far one (${lit} vs ${far})`);
}

await browser.close();
server.stop(true);

if (failures.length > 0) {
  console.error("FAIL the lit corner does not belong to the theme it is in");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("PASS eight themes light their own paper, in their own register");
