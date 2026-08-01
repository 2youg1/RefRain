#!/usr/bin/env bun
/**
 * 收起式窗口边框：默认不在正文上方，贴到屏幕最上沿才落下来。
 *
 * 这道门禁量的是**渲染后的位置**，不是 CSS 里写了什么类名：一条 `transform`
 * 被后面某条规则盖掉、或者触发带被别的层挡住，源码读起来仍然完全正确，而作者
 * 看到的是一条永远压在正文上的横杠。
 *
 * 它同时守住三件事，缺一条都能让「收起」名存实亡：
 *   ① 写字时边框不占正文上方（收起）
 *   ② 指针到最上沿时它真的落下来（可达）
 *   ③ 正文不因边框的开合而位移（收起不是把正文推来推去）
 * 第三条尤其重要——把边框做成 `display:none`/`block` 也能过前两条，
 * 但每次它出现整篇稿子都会跳一下。
 */

import { chromium } from "playwright";
import { ensureNodeDriver } from "./pw-chromium.ts";
import { stubScript } from "./stub-backend.ts";

ensureNodeDriver(import.meta.url);

const URL_ = process.env.REFRAIN_DEV_URL ?? "http://127.0.0.1:5173/";

interface Reading {
  readonly top: number;
  readonly height: number;
  readonly opacity: number;
  readonly editorTop: number | null;
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(stubScript({}));
const page = await context.newPage();
const failures: string[] = [];

try {
  await page.goto(URL_, { waitUntil: "networkidle" });
  const welcome = page.locator("button.welcome-open");
  if (await welcome.count()) {
    await welcome.click();
    await page.waitForTimeout(800);
  }
  const doc = page.locator(".shelf li button").first();
  if (await doc.count()) {
    await doc.click();
    await page.waitForTimeout(700);
  }

  const read = async (): Promise<Reading | null> =>
    (await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(".window-chrome");
      if (el === null) return null;
      const box = el.getBoundingClientRect();
      const host = document.querySelector(".editor-host")?.getBoundingClientRect();
      return {
        top: Math.round(box.top),
        height: Math.round(box.height),
        opacity: Number(getComputedStyle(el).opacity),
        editorTop: host === undefined ? null : Math.round(host.top),
      };
    })) as Reading | null;

  /* 指针停在正文上——作者写字时的常态。 */
  await page.mouse.move(700, 500);
  await page.waitForTimeout(500);
  const resting = await read();

  /* 指针推到屏幕最上沿。 */
  await page.mouse.move(700, 2);
  await page.waitForTimeout(600);
  const revealed = await read();

  /* 再离开，确认它收得回去（只落不收也是一种坏掉）。 */
  await page.mouse.move(700, 500);
  await page.waitForTimeout(600);
  const again = await read();

  if (resting === null || revealed === null || again === null) {
    failures.push("量不到 .window-chrome——门禁取不到被测对象时必须红，而不是悄悄通过");
  } else {
    /* ① 收起：不能有任何一像素压在正文上方。 */
    if (resting.top + resting.height > 0 || resting.opacity > 0.01) {
      failures.push(
        `写字时边框仍在屏幕内：top=${resting.top} height=${resting.height} opacity=${resting.opacity}`,
      );
    }
    /* ② 可达：贴上沿必须落下来，且落到完整高度。 */
    if (revealed.top !== 0 || revealed.opacity < 0.99) {
      failures.push(
        `指针贴到最上沿时边框没有完全落下：top=${revealed.top} opacity=${revealed.opacity}`,
      );
    }
    if (revealed.height < 24) {
      failures.push(`边框落下后高度只有 ${revealed.height}px，窗口按钮放不下`);
    }
    /* ③ 收得回去。 */
    if (again.top + again.height > 0 || again.opacity > 0.01) {
      failures.push(`指针离开后边框没有收回：top=${again.top} opacity=${again.opacity}`);
    }
    /* ④ 正文不随边框开合位移。 */
    if (resting.editorTop !== null && revealed.editorTop !== resting.editorTop) {
      failures.push(
        `边框开合让正文位移了：收起 ${resting.editorTop} → 落下 ${revealed.editorTop}；` +
          `边框应当浮在正文之上，而不是把正文推下去`,
      );
    }
    console.log(
      `chrome reveal — 收起 top=${resting.top} / 落下 top=${revealed.top} ` +
        `height=${revealed.height} / 正文顶 ${resting.editorTop}（开合不变）`,
    );
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(failures.map((line) => `  ✗ ${line}`).join("\n"));
  process.exit(1);
}
