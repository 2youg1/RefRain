// inject.js: wrap the esbuild bundle into a single self-contained editor.html
import { readFileSync, writeFileSync } from "node:fs";

const bundle = readFileSync(new URL("./editor.bundle.js", import.meta.url), "utf8");
const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>IME-TEST boot</title>
<style>
  html,body{margin:0;padding:0;height:100%;background:#fff;font-family:"Microsoft YaHei",sans-serif}
  #status{position:sticky;top:0;background:#111;color:#0f0;font:14px/1.6 monospace;padding:4px 10px;z-index:9}
  #editor{padding:16px 24px;outline:none;font-size:16px;line-height:1.9}
  .ProseMirror-focused{outline:none}
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
