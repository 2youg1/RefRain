import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { ensureNodeDriver } from "../../../scripts/pw-chromium.ts";

ensureNodeDriver(import.meta.url);

interface Sample {
  readonly mountMs: number;
  readonly mountSyncMs: number;
  readonly mountFirstFrameMs: number;
  readonly mountedParagraphs: number;
  readonly focusMs: number;
  readonly focusSyncMs: number;
  readonly focusFirstFrameMs: number;
  readonly focusedBlock: string | null;
  readonly focusedAfterScroll: string | null;
  readonly compositionPinned: boolean;
  readonly tailMounted: boolean;
  readonly mountedRangeAfterScroll: readonly [string | null, string | null];
  readonly scrollTopDuringComposition: number;
  readonly scrollHeightDuringComposition: number;
  readonly scrollTopAfterScroll: number;
  readonly scrollHeightAfterScroll: number;
  readonly scrollFrames: readonly number[];
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
/**
 * Median scroll-frame limit. Headless Chromium measures 1.9ms without a frame floor
 * and 16.8ms at display cadence. A forty-screen injection exceeds 25ms in both modes.
 */
const MAX_SCROLL_FRAME_MS = 25;

const percentile = (values: readonly number[], fraction: number): number => {
  const ordered = values.toSorted((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * fraction) - 1] ?? Number.POSITIVE_INFINITY;
};

const bundle = await Bun.build({
  // Windows 上 URL.pathname 是 "/C:/..."——不是合法路径。fileURLToPath 才是。
  entrypoints: [fileURLToPath(new URL("../../../packages/editor/src/index.ts", import.meta.url))],
  target: "browser",
  format: "esm",
  write: false,
  minify: false,
});
if (!bundle.success || bundle.outputs[0] === undefined) {
  throw new Error(`editor bundle failed: ${bundle.logs.map(String).join("\n")}`);
}
const editorJavaScript = await bundle.outputs[0].text();
const editorFont = Bun.file(fileURLToPath(new URL("../src/fonts/Jost.woff2", import.meta.url)));
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
const server = await Bun.serve({
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
  browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-dev-shm-usage",
      // 拆掉 60Hz 的地板。
      //
      // 默认合成器按显示器节拍出帧，于是「一帧多久」恒为 16.7ms，只要不掉帧就
      // 测不出渲染快慢——注入一个四十倍大的窗口，帧间隔仍然纹丝不动。这两个
      // 开关让合成器以确定性方式尽快出帧，帧间隔于是变成渲染耗时本身。
      "--disable-frame-rate-limit",
      "--disable-gpu-vsync",
    ],
  });
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
          const mountSyncMs = performance.now() - mountedAt;
          const mountFirstFrameAt = await new Promise<number>((resolve) =>
            requestAnimationFrame(() => resolve(performance.now())),
          );
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const mountFirstFrameMs = mountFirstFrameAt - mountedAt;
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
          const focusSyncMs = performance.now() - focusedAt;
          const focusFirstFrameAt = await new Promise<number>((resolve) =>
            requestAnimationFrame(() => resolve(performance.now())),
          );
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const focusFirstFrameMs = focusFirstFrameAt - focusedAt;
          const focusMs = performance.now() - focusedAt;
          // The manuscript is one editing host, so activeElement is the host.
          // What the author sees as "where I am" is the caret, so ask that.
          const caretBlock = (): string | null => {
            const anchor = document.getSelection()?.anchorNode ?? null;
            if (anchor === null) return null;
            const node =
              anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement;
            return node?.closest("[data-block-id]")?.getAttribute("data-block-id") ?? null;
          };
          const focusedBlock = caretBlock();
          const focused = host.querySelector<HTMLElement>('[data-block-id="b:50000"]');
          if (!(focused instanceof HTMLElement)) throw new Error("focused editor block missing");
          focused.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
          viewport.scrollTop = viewport.scrollHeight;
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
          const compositionPinned =
            caretBlock() === "b:50000" && host.querySelector('[data-block-id="b:99999"]') === null;
          const scrollTopDuringComposition = viewport.scrollTop;
          const scrollHeightDuringComposition = viewport.scrollHeight;
          focused.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
          const focusedAfterScroll = caretBlock();
          const mountedAfterScroll = [...host.querySelectorAll<HTMLElement>("p[data-block-id]")];
          const tailMounted = host.querySelector('[data-block-id="b:99999"]') !== null;
          const paragraphsAfterScroll = mountedAfterScroll.length;
          const mountedRangeAfterScroll = [
            mountedAfterScroll[0]?.dataset.blockId ?? null,
            mountedAfterScroll.at(-1)?.dataset.blockId ?? null,
          ] as const;
          const scrollTopAfterScroll = viewport.scrollTop;
          const scrollHeightAfterScroll = viewport.scrollHeight;

          // 连续阅读时每一帧要多久。
          //
          // 上面量的是挂载与聚焦，都是一次性的动作；作者真正长时间经历的是滚动。
          // 渲染改成只动差集之后，这里才是收益所在——不测它，将来有人改回整窗
          // 替换也不会有人发现。每次前进约三分之一屏，模拟连着往下读。
          viewport.scrollTop = 0;
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const scrollFrames: number[] = [];
          for (let step = 1; step <= 60; step += 1) {
            viewport.scrollTop = step * 240;
            // 量的是帧间隔：滚动时有没有掉帧。
            //
            // 三个测法试过，记下来免得再犯。在 rAF 之前起表得 16.7ms、帧到帧也是
            // 16.7ms——那是 60Hz 的节拍，只要不掉帧就恒为此值；在 rAF 回调里起表
            // 得 0.00ms，因为编辑器的渲染同样排在 rAF 里，此刻还没轮到它。
            //
            // 结论是：这个位置量不出「渲染有多快」，只量得出「有没有慢到掉帧」。
            // 后者仍然值得守——渲染一旦退回整窗替换，帧间隔会成倍跳起来。渲染
            // 本身的耗时由 e2e/probe-window-diff.ts 单独对拍（整窗 p50 1.90ms、
            // 差集 p50 0.20ms）。
            const before = await new Promise<number>((resolve) =>
              requestAnimationFrame(() => resolve(performance.now())),
            );
            const after = await new Promise<number>((resolve) =>
              requestAnimationFrame(() => resolve(performance.now())),
            );
            scrollFrames.push(after - before);
          }

          observer.disconnect();
          handle.destroy();
          return {
            mountMs,
            mountSyncMs,
            mountFirstFrameMs,
            mountedParagraphs: Math.max(mountedParagraphs, paragraphsAfterScroll),
            focusMs,
            focusSyncMs,
            focusFirstFrameMs,
            focusedBlock,
            focusedAfterScroll,
            compositionPinned,
            tailMounted,
            mountedRangeAfterScroll,
            scrollTopDuringComposition,
            scrollHeightDuringComposition,
            scrollTopAfterScroll,
            scrollHeightAfterScroll,
            scrollFrames,
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
  const mountSyncP95 = percentile(
    samples.map((sample) => sample.mountSyncMs),
    0.95,
  );
  const mountFirstFrameP95 = percentile(
    samples.map((sample) => sample.mountFirstFrameMs),
    0.95,
  );
  const focusSyncP95 = percentile(
    samples.map((sample) => sample.focusSyncMs),
    0.95,
  );
  const focusFirstFrameP95 = percentile(
    samples.map((sample) => sample.focusFirstFrameMs),
    0.95,
  );
  const maxParagraphs = Math.max(...samples.map((sample) => sample.mountedParagraphs));
  const repeatableLongTasks = samples.filter((sample) =>
    sample.longTasks.some((ms) => ms > 50),
  ).length;
  const allScrollFrames = samples.flatMap((sample) => [...sample.scrollFrames]);
  const scrollFrameP50 = percentile(allScrollFrames, 0.5);
  const scrollFrameP95 = percentile(allScrollFrames, 0.95);

  const result = {
    runs: RUNS,
    blocks: BLOCKS,
    mountP95,
    mountSyncP95,
    mountFirstFrameP95,
    focusP95,
    focusSyncP95,
    focusFirstFrameP95,
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
    scrollFrameP95: scrollFrameP95.toFixed(2),
    scrollFrameP50: scrollFrameP50.toFixed(2),
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
  if (scrollFrameP50 >= MAX_SCROLL_FRAME_MS)
    failures.push(`scroll frame p50 ${scrollFrameP50.toFixed(2)}ms`);
  if (repeatableLongTasks > 1)
    failures.push(`long tasks recurred in ${repeatableLongTasks}/${RUNS} runs`);
  if (failures.length > 0)
    throw new Error(`editor performance contract failed: ${failures.join("; ")}`);
} finally {
  await browser?.close();
  server.stop(true);
}
