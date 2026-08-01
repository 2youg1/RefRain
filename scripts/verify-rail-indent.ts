#!/usr/bin/env bun
/**
 * 侧栏的缩进必须读得出层级。
 *
 * 这道门禁存在的理由是一次实测：组标题的文字起点在 22，而挂在它下面的
 * 「待发送/未读/已裁决」起点在 **20**——子项比父项还靠左，于是层级被读反；
 * 同一屏里文档行在 26、空态在 32，四档四个数，彼此之间没有任何关系。
 * 每一条 CSS 单看都成立，**只有把四个数排成一列才看得见那个矛盾**，
 * 所以这件事必须由一道跨组件的断言来守，而不是靠改样式时顺手记得。
 *
 * 它量的是**渲染后的文字起点**，不是源码里的 padding 值：真正决定起点的是
 * 层叠的结果（`.rail button` 的特指度高于 `.mailbox-head`，组件那边写多少都
 * 不作数），读源码得不出这个结论。
 */

import { chromium } from "playwright";
import { ensureNodeDriver } from "./pw-chromium.ts";
import { stubScript } from "./stub-backend.ts";

ensureNodeDriver(import.meta.url);

const URL_ = process.env.REFRAIN_DEV_URL ?? "http://127.0.0.1:5173/";

interface Rung {
  readonly kind: string;
  readonly text: string;
  readonly left: number;
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
    await page.waitForTimeout(900);
  }

  /*
   * 先给二级那一档播一颗种子，再开始量。
   *
   * 信箱空着时 `.mailbox-row` 一行都没有，于是「二级必须比一级更靠右」这条断言
   * 取不到任何输入——它不会红，也不会绿，它根本没有运行。实测见过这个形状：
   * 删掉空态那一行之后门禁打印「二级 null」并照常放行。种子行走的是产品自己的
   * 类名，所以它量到的仍然是产品的规则，只是保证这一档有输入。
   */
  const seeded = await page.evaluate(() => {
    const list = document.querySelector(".mailbox-group ul");
    if (list === null) return false;
    const row = document.createElement("li");
    const button = document.createElement("button");
    button.className = "mailbox-row";
    button.textContent = "取样行";
    row.appendChild(button);
    list.appendChild(row);
    return true;
  });
  if (!seeded) {
    failures.push("信箱里没有可插入的列表，二级那一档取不到样本——这一档等于没测");
  }

  const rungs = (await page.evaluate(() => {
    /* 文字起点，而不是盒子左缘：padding 与图标槽都要算进去。 */
    const textLeft = (el: Element, skipTwist: boolean): number => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (
        node !== null &&
        ((node.textContent ?? "").trim() === "" ||
          (skipTwist && node.parentElement?.classList.contains("mailbox-twist") === true))
      ) {
        node = walker.nextNode();
      }
      if (node === null) return el.getBoundingClientRect().left;
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect().left;
    };
    const rows: { kind: string; text: string; left: number }[] = [];
    const collect = (selector: string, kind: string, skipTwist = false): void => {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        rows.push({
          kind,
          text: (el.textContent ?? "").trim().slice(0, 10),
          left: Math.round(textLeft(el, skipTwist)),
        });
      }
    };
    collect(".rail-group", "group");
    collect(".shelf li button", "item");
    collect(".mailbox-head", "item", true);
    collect(".rail-actions button", "item");
    collect(".rail-foot button", "item");
    collect(".mailbox-row", "child");
    return rows;
  })) as Rung[];

  const of = (kind: string): Rung[] => rungs.filter((row) => row.kind === kind);
  const render = (rows: readonly Rung[]): string =>
    rows.map((row) => `${row.text}@${row.left}`).join(" ");

  for (const kind of ["group", "item", "child"]) {
    if (of(kind).length === 0) {
      failures.push(
        `「${kind}」这一档一行都没量到，关于它的断言全部取不到输入。` +
          `门禁量不到东西时必须红——量到 0 条与「全部通过」在断言里分不出来。`,
      );
    }
  }
  /* 一、同一档的每一行必须对齐。五种一级条目来自四个组件，最容易各漂各的。 */
  for (const kind of ["group", "item", "child"]) {
    const rows = of(kind);
    if (rows.length === 0) continue;
    const lefts = new Set(rows.map((row) => row.left));
    if (lefts.size > 1) {
      failures.push(`同一档「${kind}」没有对齐：${render(rows)}`);
    }
  }

  /* 二、档与档之间必须**递增**。这条直接对着那次读反的层级。 */
  const at = (kind: string): number | null => of(kind)[0]?.left ?? null;
  const group = at("group");
  const item = at("item");
  const child = at("child");
  if (group !== null && item !== null && !(group < item)) {
    failures.push(`一级条目没有比组标题更靠右：组标题 ${group}，条目 ${item}`);
  }
  if (item !== null && child !== null && !(item < child)) {
    failures.push(`二级条目没有比一级更靠右：一级 ${item}，二级 ${child}`);
  }

  /* 三、每一档之间要拉开到看得出来。差 2px 是噪声，读者读不出层级。 */
  const STEP_MIN = 6;
  if (group !== null && item !== null && item - group < STEP_MIN) {
    failures.push(`组标题与一级之间只差 ${item - group}px，不足 ${STEP_MIN}px，读不出层级`);
  }
  if (item !== null && child !== null && child - item < STEP_MIN) {
    failures.push(`一级与二级之间只差 ${child - item}px，不足 ${STEP_MIN}px，读不出层级`);
  }

  console.log(
    `rail indent — 组标题 ${group} / 一级 ${item} / 二级 ${child}` +
      `（${rungs.length} 行，${of("item").length} 行一级来自四个组件）`,
  );
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(failures.map((line) => `  ✗ ${line}`).join("\n"));
  process.exit(1);
}
