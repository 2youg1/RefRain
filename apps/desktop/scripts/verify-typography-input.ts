/**
 * Typography settings refuse what would break the page.
 *
 * Three inputs reach the manuscript's own style, and all three used to take
 * whatever the field held. An emptied number box reads back as `Number("")`,
 * which is 0: an author who cleared the size to retype it watched the
 * manuscript collapse to 0px under them. A half-typed "-" or "1e" is NaN and
 * blanked the page. A family name goes into a `style` attribute, where a quote
 * closes the string and a semicolon starts a new declaration.
 *
 * Driven through the real panel, because these are facts about what the
 * browser resolved. A unit test on the clamp function would assert the
 * arithmetic and miss whether the input is wired to it.
 */
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

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.addInitScript(`
  localStorage.clear();
  localStorage.setItem("refrain.roots", JSON.stringify(["/p"]));
  ${BRIDGE_STUB}
  Object.assign(window.refrain, {
    openProject: async () => "/p",
    openFile: async () => null,
    createProject: async () => null,
    loadProject: async () => [],
    loadWorkspace: async () => ({
      roots: [{ id: "r1", path: "/p", name: "p", kind: "folder" }],
      chapters: [{ id: "01.md", title: "01", text: "他走了。天亮了。\\n",
        rootId: "r1", root: "/p", role: "chapter", path: "/p/01.md" }],
    }),
    saveChapter: async () => ({ ok: true, edits: [] }),
    resolveConflict: async () => ({ ok: false, reason: "not expected" }),
    pathFor: () => "",
    resolveDrop: async () => null,
    fullscreen: async () => true,
    onCloseRequest: () => () => {},
    // A family name that would escape the style attribute if it were trusted.
    systemFonts: async () => ["Honest Face", "Evil'; color: red; font-family: 'x"],
    openProjectUrl: async () => true,
    listAgents: async () => [],
    probeAgent: async () => ({ ok: true }),
    removeAgent: async () => true,
    addAgent: async () => ({}),
    enqueue: async () => true,
    manifest: async () => [],
    send: async () => [],
    collect: async () => ({ proposals: [], comments: [] }),
    runs: async () => [],
    commit: async () => ({ ok: true, text: "" }),
    ledger: async () => [],
    reply: async () => "",
    searchLedger: async () => [],
    revertEdit: async (t) => t,
    revertAll: async (t) => t,
    describeEdits: async () => "",
  });
`);

const failures: string[] = [];

try {
  await page.goto(`http://localhost:${server.port}`);
  await page.waitForTimeout(600);

  await page.keyboard.press("Control+,");
  await page.waitForTimeout(400);
  // Settings opens on appearance; typography is its own section.
  await page.getByRole("button", { name: /^排版$|^Typography$/ }).click();
  await page.waitForTimeout(400);

  const sizeBox = page.locator('input[type="number"]').first();
  if ((await sizeBox.count()) === 0) {
    failures.push("the typography panel never opened — the fixture is stale");
  } else {
    // `fill` insists the control be editable, and this one is driven purely by
    // `oninput`; set the value and dispatch the event the component listens for.
    const type = (raw: string) =>
      page.evaluate((value) => {
        const box = document.querySelector<HTMLInputElement>("input[type=number]");
        if (!box) throw new Error("the size box vanished");
        box.value = value;
        box.dispatchEvent(new Event("input", { bubbles: true }));
      }, raw);

    const sizeOf = () =>
      page.evaluate(() => {
        const node = document.querySelector<HTMLElement>(".manuscript");
        return node ? Number.parseFloat(getComputedStyle(node).fontSize) : 0;
      });

    const before = await sizeOf();
    if (before <= 0) failures.push(`the manuscript started at ${before}px`);

    // Clearing the field to retype: nothing is written until it parses again.
    await type("");
    await page.waitForTimeout(250);
    const cleared = await sizeOf();
    if (cleared <= 0)
      failures.push(`clearing the size box collapsed the manuscript to ${cleared}px`);

    // A half-typed negative is not a number yet.
    await type("-");
    await page.waitForTimeout(250);
    const partial = await sizeOf();
    if (!Number.isFinite(partial) || partial <= 0)
      failures.push(`a half-typed "-" left the manuscript at ${partial}px`);

    // Past the control's own maximum: clamped, not obeyed.
    const max = Number(await sizeBox.getAttribute("max"));
    await type(String(max + 500));
    await page.waitForTimeout(250);
    const clamped = await sizeOf();
    if (clamped > max)
      failures.push(
        `typing ${max + 500} set the manuscript to ${clamped}px, past its max of ${max}`,
      );
  }

  // A family name carrying a quote and a semicolon must not become CSS.
  const injected = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll<HTMLElement>("[style]")];
    return nodes.some((node) => (node.getAttribute("style") ?? "").includes("color: red"));
  });
  if (injected) failures.push("a font name escaped its style attribute and added a declaration");
} finally {
  await browser.close();
  server.stop(true);
}

if (failures.length > 0) {
  console.error("FAIL  the typography panel accepted what it should refuse");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  "PASS  typography refuses an unparsed number, clamps past its range, and cannot inject CSS",
);
