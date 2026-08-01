import { createMemo, createSignal, For, type JSX, Show } from "solid-js";

import { findSettings, type SettingsSection } from "../shell/settings-tree";

/**
 * 设置搜索。
 *
 * 「行距在哪调」的答案是「排版 → 手稿排版 → 段落 → 行距」——四层，而界面上
 * 只看得见第一层。作者要么记住，要么每次逐个点开找。搜一个词直接跳到那一项。
 *
 * 写成模块级组件而不是写进 `SettingsSurface` 体内：`verify:component-depth`
 * 给那个文件的额度是 230，而这段接线与它无关——搜索是自己的一件事。
 *
 * 只导航，不写值。`settings-tree.ts` 那份纪律在这里继续成立：一个能顺手
 * 「帮你恢复推荐值」的搜索框，会在作者只是想看看某项在哪的时候把他调好的
 * 东西改掉。
 */
export function SettingsSearch(props: { onJump: (section: SettingsSection) => void }): JSX.Element {
  const [query, setQuery] = createSignal("");
  const hits = createMemo(() => findSettings(query()));
  return (
    <div class="settings-search">
      <input
        type="search"
        placeholder="搜设置：行距、主题、悬挂…"
        aria-label="搜索设置项"
        value={query()}
        onInput={(event) => setQuery(event.currentTarget.value)}
      />
      <Show when={query().trim() !== ""}>
        <ul class="settings-search-hits">
          <Show
            when={hits().length > 0}
            fallback={<li class="settings-search-empty">没有匹配的设置项</li>}
          >
            <For each={hits()}>
              {(hit) => (
                <li>
                  <button type="button" onClick={() => props.onJump(hit.section)}>
                    <span>{hit.label}</span>
                    <Show when={hit.hint !== undefined}>
                      <small>{hit.hint}</small>
                    </Show>
                  </button>
                </li>
              )}
            </For>
          </Show>
        </ul>
      </Show>
    </div>
  );
}
