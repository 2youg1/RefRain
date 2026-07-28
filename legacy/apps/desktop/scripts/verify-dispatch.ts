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
  window.__saveCalls = [];
  window.__dispatchOrder = [];
  window.__agentListCalls = {};
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
      window.__agentListCalls[root] = (window.__agentListCalls[root] ?? 0) + 1;
      if (root === "/b" && window.__agentListCalls[root] === 2)
        await new Promise((resolve) => setTimeout(resolve, 200));
      if (root === "/a") return [agent("a1", "first"), agent("a2", "chosen")];
      if (root === "/b") return [agent("a2", "chosen"), agent("b1", "other")];
      if (root === "/c") return [agent("c1", "remaining")];
      return [];
    },
    saveChapter: async (...args) => {
      window.__saveCalls.push(args);
      window.__dispatchOrder.push("save");
      if (window.__saveCalls.length === 1)
        await new Promise((resolve) => (window.__finishSave = resolve));
      return { ok: true, edits: [] };
    },
    enqueue: async (root, task) => {
      window.__enqueueCalls.push([root, task]);
      window.__dispatchOrder.push("enqueue");
      if (window.__enqueueCalls.length === 1)
        await new Promise((resolve) => (window.__finishEnqueue = resolve));
      return true;
    },
    manifest: async (root) => root === "/a" && window.__enqueueCalls.length > 0 ? [{
      agentName: "chosen", harness: "command:a2", model: "unknown", reasoningEffort: "unknown",
      runCount: 1, contexts: ["chapter:01.md"], scopes: [],
      prompts: ["检查这一章并只给评论。"], drifted: [],
    }] : [],
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

  await page
    .locator(".manuscript p")
    .first()
    .evaluate((paragraph) => {
      paragraph.textContent = `${paragraph.textContent ?? ""}未保存`;
      paragraph.parentElement?.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
  await page.keyboard.press("Control+d");
  await page.locator(".dispatch .agent").filter({ hasText: "chosen" }).click();
  await page.locator(".dispatch textarea").fill("检查这一章并只给评论。");

  const queue = page.locator(".dispatch .queue");
  const noSelection = await page.locator(".dispatch .hint").first().innerText();
  if (!noSelection.includes("整章") || !noSelection.includes("不能直接改写"))
    throw new Error(
      `scope-less work is described by the obsolete selection contract: ${noSelection}`,
    );
  if (await queue.isDisabled())
    throw new Error("whole-chapter dispatch stayed disabled despite an authoritative chapter");
  await queue.click();
  await page.waitForFunction(
    () => (window as unknown as { __saveCalls: unknown[] }).__saveCalls.length === 1,
  );
  if (!(await queue.isDisabled()))
    throw new Error("Queue stayed enabled while its save-before-enqueue operation was in flight");
  await page.keyboard.press("Escape");
  await page.locator(".dispatch").waitFor({ state: "detached" });
  await page.keyboard.press("Control+d");
  await page.locator(".dispatch .agent.on").waitFor();
  if (!(await queue.isDisabled()))
    throw new Error("reopening Dispatch forgot the parent-owned in-flight task");
  await page
    .locator(".manuscript p")
    .first()
    .evaluate((paragraph) => {
      paragraph.textContent = `${paragraph.textContent ?? ""}又写`;
      paragraph.parentElement?.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
  await page.evaluate(() => (window as unknown as { __finishSave: () => void }).__finishSave());
  await page.waitForTimeout(100);
  if (
    (await page.evaluate(
      () => (window as unknown as { __enqueueCalls: unknown[] }).__enqueueCalls.length,
    )) !== 0
  )
    throw new Error("typing during the save queued a task against an older Revision");
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>(".dispatch .queue");
    return button !== null && !button.disabled;
  });

  await queue.click();
  await page.waitForFunction(
    () => (window as unknown as { __enqueueCalls: unknown[] }).__enqueueCalls.length === 1,
  );
  if (!(await queue.isDisabled()))
    throw new Error("Queue re-enabled before main accepted the in-flight task");
  await page.locator(".dispatch textarea").fill("下一条要求不能被迟到的响应清空。");
  await page.evaluate(() =>
    (window as unknown as { __finishEnqueue: () => void }).__finishEnqueue(),
  );
  await page.locator(".dispatch .manifest").waitFor();
  if (
    (await page.locator(".dispatch textarea").inputValue()) !== "下一条要求不能被迟到的响应清空。"
  )
    throw new Error("a late enqueue response erased the next instruction");
  const binding = await page.evaluate(() => {
    const state = window as unknown as {
      __saveCalls: unknown[][];
      __dispatchOrder: string[];
    };
    return { saveCalls: state.__saveCalls, order: state.__dispatchOrder };
  });
  if (binding.saveCalls.length !== 2 || binding.order.join(",") !== "save,save,enqueue")
    throw new Error(
      `dispatch did not save its current Head before enqueue: ${JSON.stringify(binding)}`,
    );
  const enqueueCalls = await page.evaluate(
    () =>
      (window as unknown as { __enqueueCalls: [string, Record<string, unknown>][] }).__enqueueCalls,
  );
  if (enqueueCalls.length !== 1)
    throw new Error(`whole-chapter task queued ${enqueueCalls.length} times`);
  const [queuedRoot, queued] = enqueueCalls[0] ?? [];
  if (queuedRoot !== "/a") throw new Error(`whole-chapter task used the wrong Root: ${queuedRoot}`);
  if (queued?.chapter !== "01.md")
    throw new Error(`whole-chapter task did not name its chapter: ${String(queued?.chapter)}`);
  if (!Array.isArray(queued?.editScopes) || queued.editScopes.length !== 0)
    throw new Error("whole-chapter task manufactured a writable Edit Scope");
  if ("baseline" in (queued ?? {})) throw new Error("renderer claimed a Revision");
  if ("contextScope" in (queued ?? {})) throw new Error("renderer claimed readable context");
  const manifest = await page.locator(".dispatch .manifest").innerText();
  if (!manifest.includes("chapter:01.md") || !manifest.includes("无（只评论）"))
    throw new Error(`send manifest hid readable context or invented write authority: ${manifest}`);

  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>(".dispatch .queue");
    return button !== null && !button.disabled;
  });
  await queue.click();
  await page.waitForFunction(() => {
    const state = window as unknown as { __saveCalls: unknown[]; __enqueueCalls: unknown[] };
    return state.__saveCalls.length === 3 && state.__enqueueCalls.length === 2;
  });
  const cleanOrder = await page.evaluate(
    () => (window as unknown as { __dispatchOrder: string[] }).__dispatchOrder,
  );
  if (cleanOrder.join(",") !== "save,save,enqueue,save,enqueue")
    throw new Error(`a clean-looking renderer bypassed the disk stamp: ${cleanOrder.join(",")}`);

  await page.locator(".root .chapter").nth(1).click();
  await page.locator(".dispatch .agent").filter({ hasText: "other" }).waitFor();
  const retained = await page.locator(".dispatch .agent.on").innerText();
  if (!retained.includes("chosen"))
    throw new Error(`roster refresh discarded an agent that still exists: ${retained}`);

  await page.locator(".root .chapter").nth(0).click();
  await page.locator(".dispatch .agent").filter({ hasText: "first" }).waitFor();
  await page.locator(".root .chapter").nth(1).click();
  await page.locator(".root .chapter").nth(2).click();
  await page.locator(".dispatch .agent").filter({ hasText: "remaining" }).waitFor();
  await page.waitForTimeout(250);
  const activeChoice = page.locator(".dispatch .agent.on");
  if ((await page.locator(".dispatch .agent").count()) !== 1 || (await activeChoice.count()) !== 1)
    throw new Error("a stale previous-Root roster overwrote the current Root");
  const active = await activeChoice.innerText();
  if (!active.includes("remaining"))
    throw new Error(`roster refresh chose the wrong remaining agent: ${active}`);

  await page.locator(".root .chapter").nth(3).click();
  await page.waitForFunction(() => document.querySelectorAll(".dispatch .agent").length === 0);
  if ((await page.locator(".dispatch .agent.on").count()) !== 0)
    throw new Error("empty roster retained an invisible chosen agent");
  if (!(await queue.isDisabled())) throw new Error("empty roster left queue enabled");
  if (pageErrors.length > 0) throw new Error(`unhandled page errors: ${pageErrors.join(" | ")}`);

  console.log("PASS  Dispatch binds whole-chapter work in main and reconciles removed agents");
} finally {
  await browser.close();
  server.stop(true);
}
