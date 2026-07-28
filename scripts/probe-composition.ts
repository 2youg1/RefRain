#!/usr/bin/env bun
/**
 * Probe: does ProseMirror under a Vue host keep the IME composition path clean?
 *
 * INV-7 says text under construction by an input method is not text: nothing
 * reads it back, writes it to disk, or replaces the node being composed into,
 * and no Tauri command is issued during a composition. R0 asks whether the
 * chosen editor kernel can honour that at all, before R1 builds on it.
 *
 * **This probe runs on Chromium, and the release engine is WebView2.** They
 * share Blink, so a composition event ordering that breaks here would break
 * there — but the reverse does not follow. The Microsoft Pinyin and Japanese
 * IME behaviours (SPEC 11.4) need a Windows machine and are not answered here.
 * What this establishes is narrower and still worth having: that the kernel's
 * own composition handling does not, by itself, reach across the bridge.
 *
 * Evidence lands in probe-results/composition.json.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"></head><body>
<div id="host"></div>
<script type="module" src="/probe.js"></script>
</body></html>`;

/*
 * Bundled rather than served as separate modules: the ProseMirror packages
 * import each other by bare specifier, which a browser cannot resolve. Bundling
 * also means the probe exercises the same module graph the application will.
 */
const ENTRY = `
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Schema, DOMParser as PMDOMParser } from "prosemirror-model";

window.__bridgeCalls = [];
window.__transactions = [];

// Stands in for the generated bindings. A composition that reaches this is
// exactly the violation INV-7 names.
window.__invoke = (name) => { window.__bridgeCalls.push(name); };

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0], parseDOM: [{ tag: "p" }] },
    text: {},
  },
});

const container = document.createElement("div");
container.innerHTML = "<p>原文。</p>";

const view = new EditorView(document.getElementById("host"), {
  state: EditorState.create({ doc: PMDOMParser.fromSchema(schema).parse(container) }),
  dispatchTransaction(tr) {
    window.__transactions.push({ docChanged: tr.docChanged, composing: view.composing });
    // A real host would only send an EditorAction once composition ended.
    if (tr.docChanged && !view.composing) window.__invoke("apply_editor_action");
    view.updateState(view.state.apply(tr));
  },
});

window.__view = view;
window.__ready = true;
`;

await Bun.write("packages/editor/.probe-entry.ts", ENTRY);
const built = await Bun.build({
  entrypoints: ["packages/editor/.probe-entry.ts"],
  target: "browser",
  minify: false,
});
if (!built.success) {
  console.error("PROBE RED: the bundle failed to build");
  for (const log of built.logs) console.error(`  ${log}`);
  process.exit(1);
}
const bundle = await built.outputs[0]?.text();
if (bundle === undefined) {
  console.error("PROBE RED: the bundle produced no output");
  process.exit(1);
}

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response(PAGE, { headers: { "content-type": "text/html" } });
    if (path === "/probe.js")
      return new Response(bundle, { headers: { "content-type": "text/javascript" } });
    return new Response("not found", { status: 404 });
  },
});

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  await page.goto(`http://localhost:${server.port}/`);
  await page.waitForFunction("window.__ready === true", null, { timeout: 10_000 });

  const editable = page.locator(".ProseMirror");
  await editable.click();

  // A composition, driven through CDP so the browser produces real composition
  // events rather than synthesised ones. `insertText` alone would not exercise
  // the path under test.
  const session = await page.context().newCDPSession(page);
  await session.send("Input.imeSetComposition", {
    text: "ni",
    selectionStart: 2,
    selectionEnd: 2,
  });

  const during = await page.evaluate(() => ({
    composing: (window as never as { __view: { composing: boolean } }).__view.composing,
    bridgeCalls: (window as never as { __bridgeCalls: string[] }).__bridgeCalls.length,
    text: document.querySelector(".ProseMirror")?.textContent ?? "",
  }));

  await session.send("Input.insertText", { text: "你" });

  const after = await page.evaluate(() => ({
    composing: (window as never as { __view: { composing: boolean } }).__view.composing,
    bridgeCalls: (window as never as { __bridgeCalls: string[] }).__bridgeCalls,
    transactions: (window as never as { __transactions: unknown[] }).__transactions.length,
    text: document.querySelector(".ProseMirror")?.textContent ?? "",
  }));

  /*
   * The assertion "no bridge call during composition" passes trivially if no
   * composition happened. So the probe first proves it reached the state it
   * claims to have tested: the view reported composing, and the intermediate
   * text was visible and different from the settled text.
   */
  if (!during.composing) {
    console.error("PROBE INVALID: the view never entered composition — nothing was tested");
    process.exit(1);
  }
  if (during.text === after.text) {
    console.error("PROBE INVALID: composition produced no intermediate state");
    process.exit(1);
  }

  const findings = {
    probe: "prosemirror-vue-composition",
    engine: `chromium ${browser.version()}`,
    caveat:
      "Chromium, not WebView2. Microsoft Pinyin and Japanese IME behaviour needs a Windows machine (SPEC 11.4).",
    composedWithoutCrossingTheBridge: during.bridgeCalls === 0,
    reportedComposingDuringComposition: during.composing,
    settledAfterComposition: after.composing === false,
    bridgeCallsAfterComposition: after.bridgeCalls,
    transactionsObserved: after.transactions,
    textDuringComposition: during.text,
    textAfterComposition: after.text,
    pageErrors: consoleErrors,
  };

  mkdirSync("probe-results", { recursive: true });
  writeFileSync("probe-results/composition.json", `${JSON.stringify(findings, null, 2)}\n`);

  console.log(JSON.stringify(findings, null, 2));

  if (!findings.composedWithoutCrossingTheBridge) {
    console.error("\nPROBE RED: a Tauri command was issued during composition (INV-7)");
    process.exit(1);
  }
  if (consoleErrors.length > 0) {
    console.error("\nPROBE RED: the page raised errors");
    process.exit(1);
  }
  console.log("\nPROBE GREEN: composition did not cross the bridge");
} finally {
  await browser.close();
  server.stop(true);
}
