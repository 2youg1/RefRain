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

export default ShortcutsPanel;
