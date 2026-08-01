/**
 * 万用键的图标。
 *
 * 这个模块此前只有五行（字节转 data URL），而取图标、跟随配置变更、卸载后丢弃响应
 * 这一整套在两个组件里各抄了一遍——**并且已经漂开**：一个先取图标再订阅，另一个
 * 反过来。先取后订会漏掉两步之间到达的那次变更，作者看到的是换了图标却没反应。
 *
 * 所以这里钉的第一件事就是顺序。
 */

import { expect, describe as group, test } from "bun:test";

import { iconDataUrl } from "../src/shell/universal-icon";

group("字节到 data URL", () => {
  test("给出 img 能直接吃的 PNG data URL", () => {
    // CSP 是 img-src 'self' data:，所以必须是 data URL 而不是 blob。
    expect(iconDataUrl([137, 80, 78, 71])).toBe("data:image/png;base64,iVBORw==");
  });

  test("空字节给出空负载而不是抛错", () => {
    expect(iconDataUrl([])).toBe("data:image/png;base64,");
  });

  test("高位字节不被截断", () => {
    // 逐字符拼串的写法在 >127 时最容易出错，而 PNG 头第一个字节就是 137。
    expect(iconDataUrl([255, 254, 253])).toBe("data:image/png;base64,//79");
  });
});

group("订阅与取值的顺序", () => {
  test("模块先订阅 config-changed，再取第一次图标", async () => {
    // 反过来的话，两步之间到达的一次配置变更会被漏掉。两个组件此前的实现在这一点上
    // 是相反的，这条断言钉住合并后的那一个。
    const source = await Bun.file("apps/desktop/src/shell/universal-icon.ts").text();
    const body = source.slice(source.indexOf("onMount("));
    const subscribe = body.indexOf('listen("config-changed"');
    const first = body.indexOf("await refresh()");
    expect(subscribe).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(-1);
    expect(subscribe).toBeLessThan(first);
  });

  test("卸载后到达的响应被丢弃", () => {
    // disposed 守卫此前在两个组件里各有一份，现在只此一处。
    const source = require("node:fs").readFileSync(
      "apps/desktop/src/shell/universal-icon.ts",
      "utf8",
    ) as string;
    expect(source).toContain("if (disposed) return;");
    expect(source).toContain("onCleanup(");
  });

  test("图标组件不再自己订阅配置事件", () => {
    // 它曾自己 listen 一次、自己维护 UnlistenFn 与 disposed。
    const fs = require("node:fs") as typeof import("node:fs");
    const source = fs.readFileSync("apps/desktop/src/ui/IconPicker.tsx", "utf8");
    expect(source).not.toContain('listen("config-changed"');
    expect(source).toContain("universalIcon()");
  });
});
