import { describe, expect, test } from "bun:test";

import { measure, optimizedLineStarts, presetOf } from "../src/index.ts";

/**
 * 行内标记符不能被断行甩到行首。
 *
 * 标记符留在正文里画淡，于是它参与断行。不挡的话断点会落在标记符与内容之间，
 * 屏幕上就是行首孤零零一个 `**`——读起来像误输入的标点。所有者点名要修这个。
 */

const preset = presetOf("zh-Hans");

/** 按给定版心断行，返回每一行的文本。 */
function linesOf(text: string, em: number): string[] {
  const measured = measure(text, preset);
  const starts = [...optimizedLineStarts(measured, preset, em)];
  const characters = [...text];
  return starts.map((from, index) =>
    characters.slice(from, starts[index + 1] ?? measured.length).join(""),
  );
}

describe("标记符不可断", () => {
  test("标记符与相邻字符成为一个不可分单元", () => {
    // `unbreakableRanges` 不在包的公开出口里（它是断行器的内部规则），所以
    // 从外部行为验证：窄到极限时断点也不落进 `**加` 与 `粗**` 之间。
    // 为测试而放宽封装，测的就不再是调用方看得见的那个接口了。
    const lines = linesOf("有**加**在", 3);
    for (const line of lines) {
      expect(line).not.toMatch(/^[*`~_]/);
      expect(line).not.toMatch(/[*`~_]$/);
    }
  });

  test("行首不会出现孤立的标记符", () => {
    const text =
      "《日本近代文学の起源》里柄谷说，**风景的发现**并非自然而然——它是*被制度化的知觉*。";
    let sampled = 0;
    for (const em of [10, 12, 14, 16, 18, 20, 24]) {
      const lines = linesOf(text, em);
      for (const line of lines) {
        // 这条断言就是所有者看到的那个现象：em=16 时第二行原本以 `**` 开头。
        expect(line).not.toMatch(/^[*`~_]/);
        sampled += 1;
      }
    }
    // 分档断言先断样本数：一行都没断出来时上面的循环什么也没测。
    expect(sampled).toBeGreaterThan(10);
  });

  test("行尾也不会留下孤立的标记符", () => {
    // 反向：开标记若被留在上一行末尾，它的内容在下一行，同样是断开的。
    const text = "前面一段文字然后**加粗的内容**后面继续写还要更长一些才够断行";
    let sampled = 0;
    for (const em of [10, 12, 14, 16, 18, 20]) {
      const lines = linesOf(text, em);
      for (const line of lines.slice(0, -1)) {
        expect(line).not.toMatch(/[*`~_]$/);
        sampled += 1;
      }
    }
    expect(sampled).toBeGreaterThan(5);
  });

  test("长加粗不整体跳行——只绑一个字符，不绑整个区间", () => {
    // 把整个标记区间设为不可断会让一段长加粗因放不下而整体跳到下一行，
    // 右缘出现大片空白。那比行首一个星号更难看，所以只绑一个字符。
    const text = `**${"很长的加粗内容".repeat(6)}**`;
    const lines = linesOf(text, 12);
    // 断得出多行，说明没有被当成一个不可分的巨块。
    expect(lines.length).toBeGreaterThan(3);
  });

  test("不影响没有标记的文本", () => {
    // 反向断言：新模式不该把普通中文也变成不可断。
    const plain = "排版的目的不是把字放进版心，而是让读者的眼睛在换行时不必重新寻找位置。";
    expect(linesOf(plain, 12).length).toBeGreaterThan(2);
  });
});
