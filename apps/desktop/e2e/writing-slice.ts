/**
 * The writing slice against the real window (C5 evidence).
 *
 * Everything here is observed, not mocked: a built WebView2 shell driven over
 * CDP, real key events for typing, the real filesystem for persistence and
 * conflict. The one stubbed seam is the OS folder picker, which WebDriver
 * cannot reach; the app reads the planted answer through its single picker
 * seam (`src/shell/pick.ts`), and everything after the picker — Vue,
 * commands, store — runs untouched.
 *
 * The composition invariant is asserted through the save state: text typed
 * mid-composition never reaches the domain (INV-7), so it cannot change the
 * save state; only `compositionend` may.
 *
 * Run: `bun apps/desktop/e2e/writing-slice.ts <path-to-refrain.exe>`.
 */

import { type ChildProcess, execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";

const exe = process.argv[2];
if (!exe) {
  console.error("usage: bun apps/desktop/e2e/writing-slice.ts <refrain.exe>");
  process.exit(2);
}

const PORT = 9322;
const fixture = mkdtempSync(join(tmpdir(), "refrain-e2e-"));
const chapterPath = join(fixture, "第一章.md");
writeFileSync(chapterPath, "原来的第一句。\n\n原来的第二句。\n");

const failures: string[] = [];
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    console.error(`FAIL  ${name}${detail === undefined ? "" : `: ${String(detail)}`}`);
    failures.push(name);
  }
};

let app: ChildProcess | null = null;
const appLog: string[] = [];

const launch = (): Promise<Page> =>
  new Promise((resolve, reject) => {
    app = execFile(
      exe,
      [],
      {
        env: {
          ...process.env,
          WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
        },
      },
      (error) => {
        if (error) reject(error);
      },
    );
    // The app must tell us why it could not serve CDP; a silent process is
    // how a runner-only failure stays invisible forever.
    app.stdout?.on("data", (chunk: Buffer) => appLog.push(chunk.toString()));
    app.stderr?.on("data", (chunk: Buffer) => appLog.push(chunk.toString()));

    let attempts = 0;
    const poll = async (): Promise<void> => {
      attempts += 1;
      if (attempts > 60) {
        console.error("app stdout/stderr so far:\n" + appLog.join(""));
        return reject(new Error("the window never came up over CDP"));
      }
      try {
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
        const page = browser.contexts()[0]?.pages()[0];
        if (!page) throw new Error("no page");
        await page.waitForLoadState("load");
        resolve(page);
      } catch {
        setTimeout(() => void poll(), 500);
      }
    };
    void poll();
  });

const stop = async (): Promise<void> => {
  app?.kill();
  await new Promise((resolve) => setTimeout(resolve, 800));
};

const statusText = async (page: Page): Promise<string> =>
  (await page.locator(".status-line").textContent()) ?? "";

const run = async (): Promise<void> => {
  // --- First session: adopt, open, type, save. ---
  let page = await launch();
  await page.getByRole("button", { name: "打开文件夹" }).waitFor({ timeout: 30_000 });
  await page.evaluate((path) => window.localStorage.setItem("refrain.e2e.pick", path), fixture);
  check("the welcome screen offers the one primary action", true);

  await page.getByRole("button", { name: "打开文件夹" }).click();
  await page.getByRole("button", { name: "第一章.md" }).waitFor({ timeout: 15_000 });
  check("adopting lists the chapter in the rail", true);

  await page.getByRole("button", { name: "第一章.md" }).click();
  const blocks = page.locator("p[data-block-id]");
  await blocks.first().waitFor({ timeout: 15_000 });
  check(
    "opening renders two blocks from the byte-authoritative layout",
    (await blocks.count()) === 2,
    await blocks.count(),
  );
  check(
    "block text is exactly the disk text",
    (await blocks.nth(0).textContent()) === "原来的第一句。" &&
      (await blocks.nth(1).textContent()) === "原来的第二句。",
  );

  await blocks.nth(1).click();
  await page.keyboard.insertText("加一句结尾。");
  await page.waitForTimeout(600);
  check("typing marks the document unsaved", (await statusText(page)).includes("未保存"));

  await page.keyboard.press("Control+s");
  await page.waitForFunction(
    () => document.querySelector(".status-line")?.textContent?.includes("已保存"),
    { timeout: 10_000 },
  );
  const onDisk = readFileSync(chapterPath, "utf8");
  check("save writes the confirmed text to disk", onDisk.includes("加一句结尾。"), onDisk);
  check(
    "untouched bytes survive the save (INV-5)",
    onDisk.startsWith("原来的第一句。\n\n原来的第二句。"),
  );

  // A composition contributes nothing the save state can see; its text
  // becomes an action — and only then a change — at compositionend.
  await blocks.nth(1).evaluate((block) => {
    block.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  });
  await page.keyboard.insertText("候选字");
  await page.waitForTimeout(500);
  check(
    "mid-composition text never reaches the domain (INV-7)",
    (await statusText(page)).includes("已保存"),
    await statusText(page),
  );
  await blocks.nth(1).evaluate((block) => {
    block.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  });
  await page.waitForTimeout(700);
  check(
    "the settled candidate becomes one action at compositionend",
    (await statusText(page)).includes("未保存"),
  );
  await page.keyboard.press("Control+s");
  await page.waitForFunction(
    () => document.querySelector(".status-line")?.textContent?.includes("已保存"),
    { timeout: 10_000 },
  );
  check(
    "the candidate reached disk through the settled action",
    readFileSync(chapterPath, "utf8").includes("候选字"),
  );

  await stop();

  // --- Second session: reopen from disk. ---
  page = await launch();
  await page.getByRole("button", { name: "打开文件夹" }).waitFor({ timeout: 30_000 });
  await page.evaluate((path) => window.localStorage.setItem("refrain.e2e.pick", path), fixture);
  await page.getByRole("button", { name: "打开文件夹" }).click();
  await page.getByRole("button", { name: "第一章.md" }).click();
  const blocks2 = page.locator("p[data-block-id]");
  await blocks2.first().waitFor({ timeout: 15_000 });
  const reopened = await blocks2.nth(1).textContent();
  check(
    "close and reopen finds the saved text",
    reopened?.includes("加一句结尾。") === true && reopened.includes("候选字"),
    reopened,
  );

  // --- Conflict: the file moved on underneath. ---
  writeFileSync(chapterPath, "别处改写的一句。\n");
  await blocks2.nth(1).click();
  await page.keyboard.insertText("这边仍在写。");
  await page.waitForTimeout(600);
  await page.keyboard.press("Control+s");
  await page.getByRole("heading", { name: "磁盘上的版本已经变了" }).waitFor({ timeout: 10_000 });
  check("an outside edit surfaces as a Safety conflict", true);
  check(
    "the refusal kept the other edit",
    readFileSync(chapterPath, "utf8") === "别处改写的一句。\n",
  );
  await page.getByRole("button", { name: "用我的覆盖磁盘" }).click();
  await page.waitForFunction(
    () => document.querySelector(".status-line")?.textContent?.includes("已保存"),
    { timeout: 10_000 },
  );
  check(
    "resolving for mine writes through a CAS on the shown stamp",
    readFileSync(chapterPath, "utf8").includes("这边仍在写。"),
  );

  await stop();

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log("\nwriting slice: all checks passed");
  rmSync(fixture, { recursive: true, force: true });
  process.exit(0);
};

void run();
