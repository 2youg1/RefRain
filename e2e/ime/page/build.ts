#!/usr/bin/env bun
/**
 * Build the IME acceptance page: bundle the adapter-mounted editor and wrap it
 * into a single self-contained editor.html the wv2 shell can load from file://.
 * Output is generated, not committed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const outdir = new URL("./dist/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(outdir, { recursive: true });

const built = await Bun.build({
  entrypoints: [new URL("./editor.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
  outdir,
  target: "browser",
  format: "iife",
  minify: false,
});
if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}

const bundle = readFileSync(`${outdir}/editor.js`, "utf8");
const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>IME-TEST boot</title>
<style>
  html,body{margin:0;padding:0;height:100%;background:#fff;font-family:"Microsoft YaHei",sans-serif}
  #status{position:sticky;top:0;background:#111;color:#0f0;font:14px/1.6 monospace;padding:4px 10px;z-index:9}
  #editor{padding:16px 24px;outline:none;font-size:16px;line-height:1.9}
  #editor p[data-block-id]{margin:0 0 1em;min-height:1em;white-space:pre-wrap;outline:none}
</style>
</head>
<body>
<div id="status">ime acceptance page</div>
<div id="editor"></div>
<script>
${bundle}
</script>
</body>
</html>`;
writeFileSync(new URL("./editor.html", import.meta.url), html);
console.log("editor.html written,", html.length, "bytes");
