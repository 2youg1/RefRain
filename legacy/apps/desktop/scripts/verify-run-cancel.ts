/** A dispatched Run has a visible stop action that reaches the public cancel channel. */
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

const bridge = `
localStorage.setItem("refrain.roots", JSON.stringify(["/work"]));
window.__cancelled = [];
${BRIDGE_STUB}
Object.assign(window.refrain, {
  loadWorkspace: async () => ({
    roots: [{ id: "r-work", path: "/work", name: "work", kind: "folder" }],
    chapters: [{ id: "01.md", title: "第一章", text: "正文。", rootId: "r-work",
      root: "/work", role: "chapter", path: "/work/01.md" }],
  }),
  listAgents: async () => [],
  runs: async () => [{
    id: "run1",
    state: window.__cancelled.length === 0 ? "dispatched" : "cancelled",
    resultPath: "/result",
    agentId: "a1",
  }],
  cancel: async (root, runId) => {
    window.__cancelled.push([root, runId]);
    return true;
  },
});`;

const failures: string[] = [];
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await page.addInitScript(bridge);
await page.goto(`http://localhost:${server.port}`);
await page.waitForTimeout(700);
await page.keyboard.press("Control+d");
await page.locator(".run-state.dispatched").waitFor();

const cancel = page.locator(".run button", { hasText: /停止|Cancel/ });
await page.screenshot({ path: join(desktop, "shots", "run-cancel.png"), fullPage: true });
if ((await cancel.count()) !== 1) failures.push("a dispatched Run has no single cancel action");
else await cancel.click();
await page.waitForTimeout(200);

const observed = await page.evaluate(
  () => (window as unknown as { __cancelled: string[][] }).__cancelled,
);
if (JSON.stringify(observed) !== JSON.stringify([["/work", "run1"]]))
  failures.push(`cancel channel observed ${JSON.stringify(observed)}`);
if ((await page.locator(".run-state.cancelled").count()) !== 1)
  failures.push("the Run did not refresh to cancelled");
if ((await page.locator(".run button").count()) !== 0)
  failures.push("a cancelled Run still offers an action");

await browser.close();
server.stop(true);

if (failures.length > 0) {
  console.error("FAIL an author cannot reliably cancel a dispatched Run");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("PASS a dispatched Run stops through the public cancel channel");
