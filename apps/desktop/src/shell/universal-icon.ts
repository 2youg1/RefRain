/**
 * 万用键的图标，从后端到能贴进 `src` 的一个字符串。
 *
 * 这个文件此前只有五行：把字节数组转成 data URL。那是一层浅封装——它取的名字
 * (`iconDataUrl`) 只是把三行标准转换换了个说法，而调用方真正要做的事一件都没接走：
 *
 *     const bytes = await commands.universalIcon();
 *     if (!disposed) setIconUrl(bytes === null ? null : iconDataUrl(bytes));
 *     // ……再加上订阅 config-changed、卸载时取消订阅、disposed 守卫
 *
 * 这一整套在 `UniversalButton` 与 `IconPicker` 里各抄了一遍，而且**已经漂开**：
 * 一个先取图标再订阅，另一个反过来；一个把取图标的异常吞在 refresh 里，另一个
 * 包了一层 refreshSafely。两份实现回答同一个问题却给出不同的时序，这是复制粘贴
 * 存活太久的确证。
 *
 * 所以模块的边界应当切在「这个图标现在是什么」，而不是「怎么把字节变成字符串」。
 * 调用方拿到一个读起来就是当前值的信号，取图标、跟随配置变更、卸载时收摊，
 * 全部在里面。
 */

import type { UnlistenFn } from "@tauri-apps/api/event";
import { listen } from "@tauri-apps/api/event";
import { createSignal, onCleanup, onMount } from "solid-js";

import { describe } from "../bridge";
import { commands } from "../generated/bindings.gen";

/** 字节到 data URL。留作导出是因为门禁按名字盯着这个投影的所有者。 */
export function iconDataUrl(bytes: readonly number[]): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}

export interface UniversalIcon {
  /** 当前图标的 data URL；没有设过图标时是 null。 */
  readonly url: () => string | null;
  /** 取图标失败时的说明；成功一次就清空。 */
  readonly error: () => string | null;
  /** 作者刚换过图标时调用，立刻重取，不必等配置事件绕一圈。 */
  readonly refresh: () => Promise<void>;
  /**
   * 由外部记下一次失败。
   *
   * 选图标这件事有一半在模块之外——读本地文件、送去后端归一化——那两步失败时
   * 作者要看到的仍是同一处说明，所以措辞的落点归模块，触发的时机归调用方。
   */
  readonly fail: (cause: unknown) => void;
}

/**
 * 跟随配置的图标。
 *
 * 组件挂载时取一次，此后每次 `config-changed` 重取；组件卸载后到达的响应一律丢弃
 * ——这是 `disposed` 守卫存在的唯一理由，此前两个组件各自维护一份。
 *
 * 失败的措辞由 `describe` 给，模块自己取——调用方不必知道错误怎么变成句子。
 */
export function universalIcon(): UniversalIcon {
  const [url, setUrl] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let stop: UnlistenFn | null = null;
  let disposed = false;

  const refresh = async (): Promise<void> => {
    try {
      const bytes = await commands.universalIcon();
      if (disposed) return;
      setUrl(bytes === null ? null : iconDataUrl(bytes));
      setError(null);
    } catch (cause) {
      if (!disposed) setError(describe(cause));
    }
  };

  onMount(async () => {
    // 先订阅再取图标：反过来的话，两者之间到达的一次配置变更会被漏掉，
    // 而作者看到的是换了图标却没反应。此前两个组件在这一点上是相反的。
    try {
      const unlisten = await listen("config-changed", () => void refresh());
      if (disposed) unlisten();
      else stop = unlisten;
    } catch (cause) {
      if (!disposed) setError(describe(cause));
    }
    await refresh();
  });

  onCleanup(() => {
    disposed = true;
    stop?.();
  });

  return {
    url,
    error,
    refresh,
    fail: (cause) => {
      if (!disposed) setError(describe(cause));
    },
  };
}
