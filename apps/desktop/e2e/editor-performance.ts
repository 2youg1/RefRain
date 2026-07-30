import { type Browser, chromium, type Page } from "playwright";

interface Sample {
  readonly mountMs: number;
  readonly mountedParagraphs: number;
  readonly focusMs: number;
  readonly focusedBlock: string | null;
  readonly focusedAfterScroll: string | null;
  readonly compositionPinned: boolean;
  readonly tailMounted: boolean;
  readonly mountedRangeAfterScroll: readonly [string | null, string | null];
  readonly scrollTopDuringComposition: number;
  readonly scrollHeightDuringComposition: number;
  readonly scrollTopAfterScroll: number;
  readonly scrollHeightAfterScroll: number;
  readonly longBlockHeight: number;
  readonly shortBlockHeight: number;
  readonly logicalHeightRatio: number;
  readonly longTasks: readonly number[];
}

const RUNS = 20;
const BLOCKS = 100_000;
const MAX_PARAGRAPHS = 260;
const MAX_MOUNT_P95_MS = 50;
const MAX_FOCUS_P95_MS = 50;

const percentile = (values: readonly number[], fraction: number): number => {
  const ordered = values.toSorted((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * fraction) - 1] ?? Number.POSITIVE_INFINITY;
};

const bundle = await Bun.build({
  entrypoints: [new URL("../../../packages/editor/src/index.ts", import.meta.url).pathname],
  target: "browser",
  format: "esm",
  write: false,
  minify: false,
});
if (!bundle.success || bundle.outputs[0] === undefined) {
  throw new Error(`editor bundle failed: ${bundle.logs.map(String).join("\n")}`);
}
const editorJavaScript = await bundle.outputs[0].text();
const editorFont = Bun.file(new URL("../src/fonts/Jost.woff2", import.meta.url).pathname);
const html = `<!doctype html>
<meta charset="utf-8">
<style>
@font-face { font-family: EditorPerf; src: url('/font.woff2') format('woff2'); font-display: block; }
html, body { margin: 0; height: 100%; font-family: EditorPerf, sans-serif; }
#viewport { height: 720px; overflow-y: auto; }
#editor { max-width: 720px; margin: 0 auto; }
p { margin: 0 0 12px; line-height: 1.6; }
p[data-block-id$="0"] { min-height: 320px !important; }
</style>
<div id="viewport"><main id="editor"></main></div>
<script type="module">
import { mountEditor } from "/editor.js";
window.mountEditor = mountEditor;
window.editorReady = true;
</script>`;
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/font.woff2") {
      return new Response(editorFont, {
        headers: { "content-type": "font/woff2", "cache-control": "no-store" },
      });
    }
    if (path === "/editor.js") {
      return new Response(editorJavaScript, {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
      });
    }
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  },
});

let browser: Browser | null = null;
try {
  browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  const page: Page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
  await page.waitForFunction(
    () => (window as unknown as Record<string, unknown>).editorReady === true,
  );
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  const samples: Sample[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    samples.push(
      await page.evaluate(
        async ({ blocksCount, runIndex }) => {
          const api = window as unknown as {
            mountEditor: (
              element: HTMLElement,
              document: { revision: string; blocks: Array<{ id: string; text: string }> },
              port: { submit: (action: unknown) => void },
            ) => {
              focus(blockId?: string, offset?: number): void;
              destroy(): void;
            };
          };
          const viewport = document.createElement("div");
          viewport.id = "viewport";
          const host = document.createElement("main");
          host.id = "editor";
          viewport.append(host);
          document.body.replaceChildren(viewport);
          const longParagraph = "Long editorial paragraph with mixed punctuation，。\n".repeat(12);
          const blocks = Array.from({ length: blocksCount }, (_, index) => ({
            id: `b:${index}`,
            text:
              index % 10 === 0
                ? longParagraph
                : `Paragraph ${index} keeps enough text for an ordinary editorial line.`,
          }));
          const longTasks: number[] = [];
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) longTasks.push(entry.duration);
          });
          try {
            observer.observe({ type: "longtask" });
          } catch {
            // A browser without Long Task support still supplies deterministic mount and DOM evidence.
          }
          const mountedAt = performance.now();
          const handle = api.mountEditor(
            host,
            { revision: `r:${runIndex}`, blocks },
            { submit: () => undefined },
          );
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
          const mountMs = performance.now() - mountedAt;
          const mountedParagraphs = host.querySelectorAll("p[data-block-id]").length;
          const outerHeight = (blockId: string): number => {
            const paragraph = host.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`);
            if (paragraph === null) throw new Error(`measured paragraph ${blockId} missing`);
            const style = getComputedStyle(paragraph);
            return (
              paragraph.getBoundingClientRect().height +
              Number.parseFloat(style.marginTop) +
              Number.parseFloat(style.marginBottom)
            );
          };
          const longBlocks = Math.ceil(blocksCount / 10);
          const longBlockHeight = outerHeight("b:0");
          const shortBlockHeight = outerHeight("b:1");
          const expectedLogicalHeight =
            longBlocks * longBlockHeight + (blocksCount - longBlocks) * shortBlockHeight;
          const logicalHeightRatio = viewport.scrollHeight / expectedLogicalHeight;
          const focusedAt = performance.now();
          handle.focus("b:50000", 4);
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
          const focusMs = performance.now() - focusedAt;
          const focusedBlock = document.activeElement?.getAttribute("data-block-id") ?? null;
          const focused = document.activeElement;
          if (!(focused instanceof HTMLElement)) throw new Error("focused editor block missing");
          focused.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
          viewport.scrollTop = viewport.scrollHeight;
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
          const compositionPinned =
            document.activeElement?.getAttribute("data-block-id") === "b:50000" &&
            host.querySelector('[data-block-id="b:99999"]') === null;
          const scrollTopDuringComposition = viewport.scrollTop;
          const scrollHeightDuringComposition = viewport.scrollHeight;
          focused.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
          const focusedAfterScroll = document.activeElement?.getAttribute("data-block-id") ?? null;
          const mountedAfterScroll = [...host.querySelectorAll<HTMLElement>("p[data-block-id]")];
          const tailMounted = host.querySelector('[data-block-id="b:99999"]') !== null;
          const paragraphsAfterScroll = mountedAfterScroll.length;
          const mountedRangeAfterScroll = [
            mountedAfterScroll[0]?.dataset.blockId ?? null,
            mountedAfterScroll.at(-1)?.dataset.blockId ?? null,
          ] as const;
          const scrollTopAfterScroll = viewport.scrollTop;
          const scrollHeightAfterScroll = viewport.scrollHeight;
          observer.disconnect();
          handle.destroy();
          return {
            mountMs,
            mountedParagraphs: Math.max(mountedParagraphs, paragraphsAfterScroll),
            focusMs,
            focusedBlock,
            focusedAfterScroll,
            compositionPinned,
            tailMounted,
            mountedRangeAfterScroll,
            scrollTopDuringComposition,
            scrollHeightDuringComposition,
            scrollTopAfterScroll,
            scrollHeightAfterScroll,
            longBlockHeight,
            shortBlockHeight,
            logicalHeightRatio,
            longTasks,
          };
        },
        { blocksCount: BLOCKS, runIndex: run },
      ),
    );
  }

  const mountP95 = percentile(
    samples.map((sample) => sample.mountMs),
    0.95,
  );
  const focusP95 = percentile(
    samples.map((sample) => sample.focusMs),
    0.95,
  );
  const maxParagraphs = Math.max(...samples.map((sample) => sample.mountedParagraphs));
  const repeatableLongTasks = samples.filter((sample) =>
    sample.longTasks.some((ms) => ms > 50),
  ).length;
  const result = {
    runs: RUNS,
    blocks: BLOCKS,
    mountP95,
    focusP95,
    maxParagraphs,
    repeatableLongTasks,
    focused: samples.every((sample) => sample.focusedBlock === "b:50000"),
    focusSurvivedScroll: samples.every((sample) => sample.focusedAfterScroll === "b:50000"),
    compositionPinned: samples.every((sample) => sample.compositionPinned),
    tailMounted: samples.every((sample) => sample.tailMounted),
    tailMountedRuns: samples.filter((sample) => sample.tailMounted).length,
    mountedRangeAfterScroll: samples[0]?.mountedRangeAfterScroll ?? [null, null],
    mountedEndsAfterScroll: [
      ...new Set(samples.map((sample) => sample.mountedRangeAfterScroll[1])),
    ],
    scrollDuringComposition: {
      top: samples[0]?.scrollTopDuringComposition ?? 0,
      height: samples[0]?.scrollHeightDuringComposition ?? 0,
    },
    scrollAfterScroll: {
      top: samples[0]?.scrollTopAfterScroll ?? 0,
      height: samples[0]?.scrollHeightAfterScroll ?? 0,
    },
    measuredBlockHeights: {
      long: samples[0]?.longBlockHeight ?? 0,
      short: samples[0]?.shortBlockHeight ?? 0,
    },
    logicalHeightRatio: {
      min: Math.min(...samples.map((sample) => sample.logicalHeightRatio)),
      max: Math.max(...samples.map((sample) => sample.logicalHeightRatio)),
    },
    focusedBlocks: [...new Set(samples.map((sample) => sample.focusedBlock))],
  };
  console.log(JSON.stringify(result));

  const failures: string[] = [];
  if (maxParagraphs > MAX_PARAGRAPHS)
    failures.push(`${maxParagraphs} manuscript paragraphs mounted`);
  if (mountP95 >= MAX_MOUNT_P95_MS) failures.push(`mount p95 ${mountP95.toFixed(2)}ms`);
  if (focusP95 >= MAX_FOCUS_P95_MS) failures.push(`focus p95 ${focusP95.toFixed(2)}ms`);
  if (!result.focused) failures.push("middle block did not receive the caret");
  if (!result.focusSurvivedScroll) failures.push("scrolling discarded the editing caret");
  if (!result.compositionPinned) failures.push("scrolling rebuilt the composing block");
  if (!result.tailMounted) failures.push("scrolling did not mount the final block");
  if (result.logicalHeightRatio.min < 0.85 || result.logicalHeightRatio.max > 1.15) {
    failures.push(
      `logical height ratio ${result.logicalHeightRatio.min.toFixed(2)}–${result.logicalHeightRatio.max.toFixed(2)}`,
    );
  }
  if (repeatableLongTasks > 1)
    failures.push(`long tasks recurred in ${repeatableLongTasks}/${RUNS} runs`);
  if (failures.length > 0)
    throw new Error(`editor performance contract failed: ${failures.join("; ")}`);
} finally {
  await browser?.close();
  server.stop(true);
}
