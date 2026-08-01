import { type Browser, chromium } from "playwright";
import { ensureNodeDriver } from "../../../scripts/pw-chromium.ts";

ensureNodeDriver(import.meta.url);

const bundle = await Bun.build({
  entrypoints: ["packages/editor/src/index.ts"],
  target: "browser",
  format: "esm",
  minify: false,
});
if (!bundle.success || bundle.outputs[0] === undefined) {
  throw new Error(`editor bundle failed: ${bundle.logs.map(String).join("\n")}`);
}
const editorJavaScript = await bundle.outputs[0].text();
const html = `<!doctype html>
<meta charset="utf-8">
<div id="editor"></div>
<script type="module">
  import * as editor from "/editor.js";
  window.editorApi = editor;
</script>`;
const server = await Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/editor.js") {
      return new Response(editorJavaScript, { headers: { "content-type": "text/javascript" } });
    }
    return new Response(html, { headers: { "content-type": "text/html" } });
  },
});

let browser: Browser | null = null;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "networkidle" });
  const result = await page.evaluate(async () => {
    type Action = {
      baseRevision: string;
      changes: Array<{
        kind: "replace";
        blocks: string[];
        text: string | null;
      }>;
    };
    type Context = {
      blockId: string;
      canFormat: boolean;
      canDeleteEmpty: boolean;
      punctuation: Array<{
        id: string;
        blockId: string;
        start: number;
        end: number;
        original: string;
        suggested: string;
        rule: string;
      }>;
      anchor: { left: number; top: number; right: number; bottom: number };
    };
    const api = window as unknown as {
      editorApi: {
        mountEditor(
          element: HTMLElement,
          document: {
            revision: string;
            blocks: Array<{ id: string; text: string }>;
          },
          port: { submit: (action: Action) => void },
        ): {
          context(target: EventTarget | null): Context | null;
          formatSelection(kind: "strong" | "emphasis"): boolean;
          deleteEmptyBlock(): boolean;
          applyPunctuation(finding: Context["punctuation"][number]): boolean;
          setAnnotations(
            annotations: Array<{
              id: string;
              blockId: string;
              start: number;
              end: number;
              kind: "highlight" | "comment";
              anchorState: "anchored" | "drifted";
            }>,
          ): void;
          whenSettled(): Promise<void>;
          destroy(): void;
        };
      };
    };
    const host = document.querySelector<HTMLElement>("#editor");
    if (host === null) throw new Error("editor host missing");
    const actions: Action[] = [];
    const handle = api.editorApi.mountEditor(
      host,
      {
        revision: "revision-1",
        blocks: [
          { id: "block-a", text: "Alpha beta" },
          { id: "block-b", text: "Gamma delta" },
          { id: "block-c", text: "" },
          { id: "block-d", text: "你好,世界" },
        ],
      },
      { submit: (action) => actions.push(action) },
    );
    const first = host.querySelector<HTMLElement>('[data-block-id="block-a"]');
    const second = host.querySelector<HTMLElement>('[data-block-id="block-b"]');
    if (first?.firstChild === null || first?.firstChild === undefined) {
      throw new Error("first block missing");
    }
    if (second?.firstChild === null || second?.firstChild === undefined) {
      throw new Error("second block missing");
    }
    const selection = document.getSelection();
    if (selection === null) throw new Error("selection unavailable");
    const select = (startNode: Node, start: number, endNode: Node, end: number): void => {
      const range = document.createRange();
      range.setStart(startNode, start);
      range.setEnd(endNode, end);
      selection.removeAllRanges();
      selection.addRange(range);
    };

    select(first.firstChild, 0, first.firstChild, 5);
    const context = handle.context(first);
    const formatted = handle.formatSelection("strong");
    const firstAction = actions[0] ?? null;
    const formattedText = first.textContent;

    // Toggle, not wrap: press bold again over the same characters and the text
    // must return to what the author typed. The marker moved the selection, so
    // the second request re-reads the context from the marked range.
    const boldedText = first.firstChild;
    if (boldedText === null) throw new Error("bolded block text missing");
    select(boldedText, 2, boldedText, 7);
    handle.context(first);
    const unformatted = handle.formatSelection("strong");
    const unformattedText = first.textContent;
    const unformatAction = actions[1] ?? null;

    const firstText = first.firstChild;
    const secondText = second.firstChild;
    if (firstText === null || secondText === null) throw new Error("block text missing");
    select(firstText, 0, firstText, 0);
    const collapsed = handle.context(first);
    const collapsedFormatted = handle.formatSelection("emphasis");

    select(firstText, 0, secondText, 5);
    const crossBlock = handle.context(first);
    const crossBlockFormatted = handle.formatSelection("emphasis");

    first.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const composing = handle.context(first);
    const composingFormatted = handle.formatSelection("strong");
    // A save asked for mid-composition must wait for the author to finish
    // choosing candidates. Prove it waits on the event, not on a timer: the
    // promise stays pending across a macrotask longer than any guess would be,
    // and settles only once `compositionend` fires.
    let settledDuringComposition = false;
    const settling = handle.whenSettled().then(() => {
      settledDuringComposition = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const pendingWhileComposing = !settledDuringComposition;
    first.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await settling;
    const settledAfterCompositionEnd = settledDuringComposition;

    const unknown = handle.context(host);
    const empty = host.querySelector<HTMLElement>('[data-block-id="block-c"]');
    if (empty === null) throw new Error("empty block missing");
    const emptyContext = handle.context(empty);
    const emptyDeleted = handle.deleteEmptyBlock();
    const emptyAction = actions[2] ?? null;

    const punctuationBlock = host.querySelector<HTMLElement>('[data-block-id="block-d"]');
    if (punctuationBlock === null) throw new Error("punctuation block missing");
    const punctuationContext = handle.context(punctuationBlock);
    const punctuationFinding = punctuationContext?.punctuation[0];
    const punctuationApplied =
      punctuationFinding === undefined ? false : handle.applyPunctuation(punctuationFinding);
    const punctuationAction = actions[3] ?? null;
    const punctuationText = punctuationBlock.textContent;
    handle.setAnnotations([
      {
        id: "annotation-1",
        blockId: "block-d",
        start: 0,
        end: 2,
        kind: "highlight",
        anchorState: "anchored",
      },
      {
        id: "annotation-drifted",
        blockId: "block-a",
        start: 0,
        end: 2,
        kind: "comment",
        anchorState: "drifted",
      },
    ]);
    const projectedAnnotation = punctuationBlock.dataset.annotation;
    const highlightRegistered = (
      CSS as unknown as { highlights?: { has(name: string): boolean } }
    ).highlights?.has("refrain-highlight");
    const driftedProjected = first.dataset.annotation;
    handle.destroy();
    return {
      context,
      formatted,
      firstAction,
      formattedText,
      unformatted,
      unformattedText,
      unformatAction,
      collapsed,
      collapsedFormatted,
      crossBlock,
      crossBlockFormatted,
      composing,
      composingFormatted,
      pendingWhileComposing,
      settledAfterCompositionEnd,
      unknown,
      emptyContext,
      emptyDeleted,
      emptyAction,
      punctuationContext,
      punctuationApplied,
      punctuationAction,
      punctuationText,
      projectedAnnotation,
      highlightRegistered,
      driftedProjected,
      actionCount: actions.length,
    };
  });

  const failures: string[] = [];
  console.log(JSON.stringify(result));
  if (result.context?.blockId !== "block-a" || !result.context.canFormat) {
    failures.push("single-block selection did not produce a format context");
  }
  if (!result.formatted || result.formattedText !== "**Alpha** beta") {
    failures.push("strong formatting did not update the editor projection");
  }
  if (
    JSON.stringify(result.firstAction) !==
    JSON.stringify({
      baseRevision: "revision-1",
      changes: [{ kind: "replace", blocks: ["block-a"], text: "**Alpha** beta" }],
    })
  ) {
    failures.push("strong formatting did not submit exactly one replace action");
  }
  if (
    !result.unformatted ||
    result.unformattedText !== "Alpha beta" ||
    JSON.stringify(result.unformatAction) !==
      JSON.stringify({
        baseRevision: "revision-1",
        changes: [{ kind: "replace", blocks: ["block-a"], text: "Alpha beta" }],
      })
  ) {
    failures.push(
      `bolding twice did not restore the original text (got ${JSON.stringify(result.unformattedText)})`,
    );
  }
  if (result.formattedText?.includes("****") || result.unformattedText?.includes("****")) {
    failures.push("formatting produced a doubled empty marker");
  }
  if (result.collapsed?.canFormat !== false || result.collapsedFormatted) {
    failures.push("a collapsed selection was format-capable");
  }
  if (result.crossBlock?.canFormat !== false || result.crossBlockFormatted) {
    failures.push("a cross-block selection was format-capable");
  }
  if (result.composing?.canFormat !== false || result.composingFormatted) {
    failures.push("composition exposed candidate text to formatting");
  }
  if (!result.pendingWhileComposing) {
    failures.push("a save settled during composition instead of waiting for the author");
  }
  if (!result.settledAfterCompositionEnd) {
    failures.push("a save never settled after compositionend");
  }
  if (result.unknown !== null) failures.push("an unknown target produced editor context");
  if (
    result.emptyContext?.canDeleteEmpty !== true ||
    !result.emptyDeleted ||
    JSON.stringify(result.emptyAction) !==
      JSON.stringify({
        baseRevision: "revision-1",
        changes: [{ kind: "replace", blocks: ["block-c"], text: null }],
      })
  ) {
    failures.push("empty-block deletion did not submit one explicit-range action");
  }
  if (
    !result.punctuationApplied ||
    result.punctuationText !== "你好，世界" ||
    JSON.stringify(result.punctuationAction) !==
      JSON.stringify({
        baseRevision: "revision-1",
        changes: [{ kind: "replace", blocks: ["block-d"], text: "你好，世界" }],
      })
  ) {
    failures.push("punctuation confirmation did not submit one local replace action");
  }
  if (
    result.projectedAnnotation !== "highlight" ||
    result.highlightRegistered !== true ||
    result.driftedProjected !== undefined
  ) {
    failures.push("anchored highlights or drift refusal were not projected correctly");
  }
  if (result.actionCount !== 4) failures.push(`${result.actionCount} actions were submitted`);
  if (failures.length > 0) throw new Error(failures.join("; "));
  console.log("PASS  editor context owns selection, formatting, empty blocks, and punctuation");
} finally {
  await browser?.close();
  server.stop(true);
}
