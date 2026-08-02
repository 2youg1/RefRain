// The shortcut table (SPEC 9.9 投影): display-only — every chord the shell
// currently answers, grouped by where it works. Remapping is not a v0.2
// feature; this page exists so the chords are discoverable, not configurable.
import { For, type JSX } from "solid-js";

type ShortcutGroup = { name: string; rows: [string, string][] };

const GROUPS: ShortcutGroup[] = [
  {
    name: "写作",
    rows: [
      ["Ctrl+S", "保存"],
      ["Ctrl+Enter", "进出 KARA"],
    ],
  },
  {
    // 系统自带的编辑键：应用不接管它们，列在这里是为了让这张表成为
    // 「手上能按什么」的完整答案，而不是只有应用自己发明的那部分。
    // Ctrl+Z 例外：它归壳层（撤销的是一次正文行动，不是光标前的一步）。
    name: "编辑",
    rows: [
      ["Ctrl+Z", "撤销一步"],
      ["Ctrl+C", "复制"],
      ["Ctrl+X", "剪切"],
      ["Ctrl+V", "粘贴"],
      ["Ctrl+A", "全选"],
      ["Ctrl+Home", "到文首"],
      ["Ctrl+End", "到文末"],
      ["Ctrl+Backspace", "删除前一个词"],
      ["Ctrl+Delete", "删除后一个词"],
    ],
  },
  {
    // 与 shell/shortcuts.ts 逐条对过：命令菜单、搜索、按层直达、退层。
    name: "界面",
    rows: [
      ["Ctrl+F", "搜索"],
      ["Ctrl+K", "命令菜单"],
      ["Ctrl/Cmd+1…4", "按层直达"],
      ["Ctrl+[ 或 Escape", "退出一层"],
    ],
  },
  {
    name: "裁决（Review 内）",
    rows: [
      ["Alt+J / Alt+K", "下一条 / 上一条"],
      ["Alt+A", "采用"],
      ["Alt+X", "拒绝"],
      ["Alt+E", "改后接受"],
      ["Alt+R", "理由"],
      ["Alt+S", "入批 / 出批"],
      ["Alt+P", "换看竞争稿"],
      ["Alt+Enter", "合并入批"],
    ],
  },
];

export function ShortcutsPanel(): JSX.Element {
  return (
    <div class="shortcuts">
      <For each={GROUPS}>
        {(group) => (
          <div class="group">
            <span class="group-name">{group.name}</span>
            <For each={group.rows}>
              {(row) => (
                <div class="row">
                  <span class="action">{row[1]}</span>
                  <kbd>{row[0]}</kbd>
                </div>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}
