/** The Verdict Ledger is searchable by the author's stated reasons through the real renderer. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIDGE_STUB, launchBrowser } from "./browser.ts";

declare global {
  interface Window {
    __ledgerSearches: string[];
  }
}

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const html = (await Bun.file(join(desktop, "dist", "renderer", "index.html")).text()).replace(
  /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
  "",
);
const verdicts = [
  {
    id: "v-slow",
    proposalId: "p-slow",
    kind: "reject",
    reason: "这一段节奏太慢。",
    baseline: "r1",
    decidedAt: "2026-07-28T00:00:00.000Z",
  },
  {
    id: "v-tone",
    proposalId: "p-tone",
    kind: "accept-modified",
    reason: "语气应当更冷。",
    baseline: "r1",
    decidedAt: "2026-07-28T00:01:00.000Z",
  },
];

const bridge = `
window.__ledgerSearches = [];
${BRIDGE_STUB}
Object.assign(window.refrain, {
  loadWorkspace: async (roots) => ({
    roots: roots.map((path) => ({ id: "r-ledger", path, name: "novel", kind: "folder" })),
    chapters: [],
  }),
  ledger: async () => ({ ok: true, verdicts: ${JSON.stringify(verdicts)} }),
  searchLedger: async (_root, fragment) => {
    window.__ledgerSearches.push(fragment);
    if (fragment === "锁")
      return { ok: false, reason: "ledger-unavailable", detail: "SQLITE_BUSY: ledger locked" };
    return {
      ok: true,
      verdicts: ${JSON.stringify(verdicts)}.filter((verdict) => verdict.reason.includes(fragment)),
    };
  },
});
localStorage.setItem("refrain.roots", JSON.stringify(["/home/author/novel"]));
`;

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    return new Response(Bun.file(join(desktop, "dist", "renderer", path)));
  },
});

const failures: string[] = [];
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await page.addInitScript(bridge);
await page.goto(`http://localhost:${server.port}`);
await page.waitForTimeout(400);
await page.keyboard.press("Control+k");
await page.locator("nav.menu input").fill("账本");
const command = page.locator("nav.menu button.row").filter({ hasText: "账本" });
if ((await command.count()) === 0) failures.push("the palette did not expose the Ledger");
else await command.first().click();
await page.waitForTimeout(300);

const ledger = page.locator(".ledger");
if ((await ledger.locator("article").count()) !== 2)
  failures.push("the Ledger did not begin with both recorded judgments");
const search = ledger.getByRole("searchbox", { name: "按裁决理由搜索" });
await search.fill("节奏");
await ledger.getByRole("button", { name: "搜索" }).click();
await page.waitForTimeout(100);
if ((await ledger.locator("article").count()) !== 1)
  failures.push("reason search did not narrow the Verdict list");
if (!(await ledger.textContent())?.includes("这一段节奏太慢"))
  failures.push("the matching stated reason was not visible");
if (JSON.stringify(await page.evaluate(() => window.__ledgerSearches)) !== JSON.stringify(["节奏"]))
  failures.push("the renderer did not send the exact reason fragment");
await page.screenshot({ path: join(desktop, "shots", "ledger-search.png") });

await search.fill("不存在");
await ledger.getByRole("button", { name: "搜索" }).click();
await page.waitForTimeout(100);
if (!(await ledger.textContent())?.includes("没有裁决理由包含这段文字"))
  failures.push("an empty search result looked like an empty Ledger");

await search.fill("锁");
await ledger.getByRole("button", { name: "搜索" }).click();
await page.waitForTimeout(100);
if (!(await ledger.textContent())?.includes("SQLITE_BUSY: ledger locked"))
  failures.push("a failed Ledger search hid the storage failure");

await browser.close();
server.stop(true);
if (failures.length > 0) {
  console.error("FAIL the Verdict Ledger search is not a complete renderer path");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("PASS the Verdict Ledger searches stated reasons and reports storage failure");
