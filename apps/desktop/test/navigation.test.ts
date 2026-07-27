import { expect, test } from "bun:test";
import { mayOpenExternally, rendererMayNavigate } from "../src/main/navigation";

test("a packaged renderer only navigates to its own file", () => {
  expect(rendererMayNavigate("file:///opt/RefRain/index.html", false)).toBe(true);
  expect(rendererMayNavigate("http://localhost:5173", false)).toBe(false);
});

test("development admits one exact dev-server origin", () => {
  expect(rendererMayNavigate("http://localhost:5173/chapter", true)).toBe(true);
  expect(rendererMayNavigate("http://localhost:5174", true)).toBe(false);
  expect(rendererMayNavigate("http://localhost.evil.test:5173", true)).toBe(false);
  expect(rendererMayNavigate("http://127.0.0.1:5173", true)).toBe(false);
});

test("a malformed or active scheme never becomes renderer navigation", () => {
  for (const url of ["https-evil.com", "javascript:alert(1)", "data:text/html,x", "not a url"])
    expect(rendererMayNavigate(url, true), url).toBe(false);
});

test("only exact web protocols leave through the system browser", () => {
  expect(mayOpenExternally("https://example.com/path")).toBe(true);
  expect(mayOpenExternally("http://example.com")).toBe(true);
  for (const url of ["https-evil.com", "httpx://example.com", "javascript:alert(1)", "file:///x"])
    expect(mayOpenExternally(url), url).toBe(false);
});
