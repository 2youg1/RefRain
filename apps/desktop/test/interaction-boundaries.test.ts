import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (name: string): string =>
  readFileSync(new URL(`../src/renderer/${name}`, import.meta.url), "utf8");

const app = read("App.svelte");

test("one global owner consumes Escape once and never exits 空", () => {
  const sheet = read("Sheet.svelte");
  const palette = read("Palette.svelte");

  expect(sheet).not.toContain("<svelte:window");
  expect(sheet).not.toContain("const onKeydown");
  expect(app).toContain("else if (sheet !== null) sheet = null");
  expect(app).not.toContain("if (zen) return void setZen(false)");
  expect(palette).toContain("event.stopPropagation()");
});

test("Ctrl-wheel belongs to the writing surface rather than the whole window", () => {
  const windowTag = app.match(/<svelte:window[\s\S]*?\/>/)?.[0];
  expect(windowTag).toBeDefined();
  expect(windowTag).not.toContain("wheel");
  expect(app).toContain('<main class="writing" onwheel={onWheel}>');
});
