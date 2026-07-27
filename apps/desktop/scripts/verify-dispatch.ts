import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIDGE_STUB, launchBrowser } from "./browser.ts";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    return new Response(
      Bun.file(join(desktop, "dist", "renderer", path === "/" ? "index.html" : path)),
      { headers: { "cache-control": "no-store" } },
    );
  },
});

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors: string[] = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
await page.addInitScript(`
  ${BRIDGE_STUB}
  localStorage.clear();
  window.__openCount = 0;
  window.__enqueueCalls = [];
  const roots = [
    { id: "r-a", path: "/a", name: "a", kind: "folder" },
    { id: "r-b", path: "/b", name: "b", kind: "folder" },
    { id: "r-c", path: "/c", name: "c", kind: "folder" },
    { id: "r-d", path: "/d", name: "d", kind: "folder" },
  ];
  const chapters = [
    { id: "01.md", title: "01", text: "第一个根的正文。", root: "/a", rootId: "r-a",
      role: "chapter", path: "/a/01.md" },
    { id: "02.md", title: "02", text: "第二个根的正文。", root: "/b", rootId: "r-b",
      role: "chapter", path: "/b/02.md" },
    { id: "03.md", title: "03", text: "第三个根的正文。", root: "/c", rootId: "r-c",
      role: "chapter", path: "/c/03.md" },
    { id: "04.md", title: "04", text: "第四个根的正文。", root: "/d", rootId: "r-d",
      role: "chapter", path: "/d/04.md" },
  ];
  const agent = (id, name) => ({
    id, name, binding: { harness: "command:" + id, model: "unknown", reasoningEffort: "unknown" },
  });
  Object.assign(window.refrain, {
    openProject: async () => ["/a", "/b", "/c", "/d"][window.__openCount++] ?? null,
    loadWorkspace: async (open) => ({
      roots: roots.filter((root) => open.includes(root.path)),
      chapters: chapters.filter((chapter) => open.includes(chapter.root)),
    }),
    listAgents: async (root) => {
      if (root === "/a") return [agent("a1", "first"), agent("a2", "chosen")];
      if (root === "/b") return [agent("a2", "chosen"), agent("b1", "other")];
      if (root === "/c") return [agent("c1", "remaining")];
      return [];
    },
    enqueue: async (root, task) => {
      window.__enqueueCalls.push([root, task]);
      return true;
    },
  });
`);

try {
  await page.goto(`http://localhost:${server.port}`);
  await page.waitForTimeout(300);
  await page.locator(".actions .primary").click();
  await page.waitForTimeout(300);
  await page.locator(".rail-foot button").first().click();
  await page.locator(".rail-foot button").first().click();
  await page.locator(".rail-foot button").first().click();
  await page.waitForTimeout(300);

  await page.keyboard.press("Control+d");
  await page.locator(".dispatch .agent").filter({ hasText: "chosen" }).click();
  await page.locator(".dispatch textarea").fill("检查这一章并只给评论。");

  const queue = page.locator(".dispatch .queue");
  if (!(await queue.isDisabled()))
    throw new Error("no-selection dispatch became queueable without authoritative chapter context");
  await queue.evaluate((button: HTMLButtonElement) => button.click());
  const enqueueCount = await page.evaluate(
    () => (window as unknown as { __enqueueCalls: unknown[] }).__enqueueCalls.length,
  );
  if (enqueueCount !== 0) throw new Error("no-selection dispatch invented a task payload");

  await page.locator(".root .chapter").nth(1).click();
  await page.locator(".dispatch .agent").filter({ hasText: "other" }).waitFor();
  const retained = await page.locator(".dispatch .agent.on").innerText();
  if (!retained.includes("chosen"))
    throw new Error(`roster refresh discarded an agent that still exists: ${retained}`);

  await page.locator(".root .chapter").nth(2).click();
  await page.locator(".dispatch .agent").filter({ hasText: "remaining" }).waitFor();
  const activeChoice = page.locator(".dispatch .agent.on");
  if ((await activeChoice.count()) !== 1)
    throw new Error("roster refresh retained a removed agent and left no valid choice visible");
  const active = await activeChoice.innerText();
  if (!active.includes("remaining"))
    throw new Error(`roster refresh chose the wrong remaining agent: ${active}`);

  await page.locator(".root .chapter").nth(3).click();
  await page.waitForFunction(() => document.querySelectorAll(".dispatch .agent").length === 0);
  if ((await page.locator(".dispatch .agent.on").count()) !== 0)
    throw new Error("empty roster retained an invisible chosen agent");
  if (!(await queue.isDisabled())) throw new Error("empty roster left queue enabled");
  if (pageErrors.length > 0) throw new Error(`unhandled page errors: ${pageErrors.join(" | ")}`);

  console.log(
    "PASS  Dispatch reconciles removed agents and refuses scope-less work without chapter context",
  );
} finally {
  await browser.close();
  server.stop(true);
}
