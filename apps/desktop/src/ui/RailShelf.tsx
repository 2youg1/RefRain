import { createMemo, createSignal, For, Show } from "solid-js";
import type { Disclosure, DocumentRow } from "../generated/bindings.gen";
import { railWindow } from "../shell/rail-window";

/** 名录行高，与 `.rail li button` 的盒高一致。 */
export const RAIL_ROW_HEIGHT = 32;

/**
 * 书架向名录要下一页的那一面。
 *
 * 只有这两件事：还有没有、再给一页。翻页游标、请求代次、过期结果丢弃全都留在
 * 名录里——书架不该知道「一页是 256 条」这种事。
 */
export interface RailCatalog {
  readonly hasMore: boolean;
  loadNext(): Promise<void>;
}

/**
 * 一行的右键菜单能干的事。归调用方：书架只发意图，过桥刷新名录是
 * ProjectSession 的事（INV-6 的文件去向也写在那一侧）。
 */
export interface RailRowMenu {
  /** 移入回收站——删除只有一个去处，菜单措辞照实说。 */
  readonly onRemove: (row: DocumentRow) => void;
  /** 范围：下次派发时这份资料可见多少。 */
  readonly onDisclosure: (row: DocumentRow, disclosure: Disclosure) => void;
}

/** 范围的三态与界面措辞。null（从未问过）读作枚举默认值，与桥另一侧一致。 */
const DISCLOSURES: readonly { value: Disclosure; label: string }[] = [
  { value: "outline-only", label: "仅大纲" },
  { value: "retrievable", label: "可检索" },
  { value: "full", label: "全文" },
];

const disclosureOf = (row: DocumentRow): Disclosure => row.disclosure ?? "retrievable";

export interface RailShelfProps {
  readonly label: string;
  readonly shelf: string;
  readonly rows: readonly DocumentRow[];
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly currentPath: string | null;
  readonly onSelect: (path: string) => void;
  /** 视野逼近末尾时，书架自己去要下一页——作者不该看见「继续加载」按钮。 */
  readonly catalog: RailCatalog;
  /** 给了才有右键菜单：原稿架与资料架今天只有后者需要。 */
  readonly rowMenu?: RailRowMenu | undefined;
}

/**
 * 一架文档，只挂看得见的那几行。
 *
 * 书架自己知道它在滚动容器里的位置（`offsetTop`），所以两架前后排列时不会共用
 * 一个坐标系——上面那架滚过去之后，下面那架的第一行才刚进入视野。
 */
export function RailShelf(props: RailShelfProps) {
  let element: HTMLDivElement | undefined;
  const view = createMemo(() => {
    const offset = element?.offsetTop ?? 0;
    const window = railWindow(
      props.scrollTop - offset,
      props.viewportHeight,
      props.rows.length,
      RAIL_ROW_HEIGHT,
    );
    if (window.nearEnd && props.catalog.hasMore) void props.catalog.loadNext();
    return window;
  });

  /** 右键菜单：落在哪一行、什么位置。null 收拢。 */
  const [menu, setMenu] = createSignal<{ row: DocumentRow; x: number; y: number } | null>(null);
  /**
   * 「移入回收站」的两步：第一下把菜单项换成确认句，第二下才执行。
   * 回收站虽可找回，但「找」要去系统里翻——一步误点的代价不该由作者付。
   */
  const [confirming, setConfirming] = createSignal(false);

  const openMenu = (event: MouseEvent, row: DocumentRow): void => {
    if (props.rowMenu === undefined) return;
    event.preventDefault();
    setConfirming(false);
    setMenu({ row, x: event.clientX, y: event.clientY });
  };

  return (
    // 菜单浮在行上，指针整个离开这架才收——与信箱菜单同一个手势。
    <div class="shelf" data-shelf={props.shelf} ref={element} onPointerLeave={() => setMenu(null)}>
      <div class="rail-group">{props.label}</div>
      <ul>
        <li class="rail-spacer" style={{ height: `${view().padTop}px` }} />
        <For each={props.rows.slice(view().first, view().first + view().count)}>
          {(row) => (
            <li>
              <button
                type="button"
                classList={{ current: props.currentPath === row.path }}
                onClick={() => props.onSelect(row.path)}
                onContextMenu={(event) => openMenu(event, row)}
              >
                {row.path}
              </button>
            </li>
          )}
        </For>
        <li class="rail-spacer" style={{ height: `${view().padBottom}px` }} />
      </ul>

      <Show when={menu()}>
        {(current) => {
          /**
           * 正在编辑的文档不许移入回收站：文档会话还握着它的修订号，下一次
           * 保存会把刚收走的文件原样写回来——回收站成了假装删掉的舞台。
           * 守卫钉在这里而不是调用方：两个事实（这一行、当前打开的那篇）
           * 只有这个菜单同时握着。
           */
          const isCurrent = (): boolean => props.currentPath === current().row.path;
          return (
            <div
              class="mailbox-menu"
              role="menu"
              style={{ left: `${current().x}px`, top: `${current().y}px` }}
            >
              <button
                type="button"
                role="menuitem"
                disabled={isCurrent()}
                onClick={() => {
                  if (!confirming()) {
                    setConfirming(true);
                    return;
                  }
                  props.rowMenu?.onRemove(current().row);
                  setMenu(null);
                }}
              >
                {confirming() ? "确认移入回收站？" : "移入回收站"}
              </button>
              <Show when={isCurrent()}>
                <div class="menu-section" role="presentation">
                  先关闭正在编辑的文档
                </div>
              </Show>
              <div class="menu-section" role="presentation">
                范围
              </div>
              <For each={DISCLOSURES}>
                {(option) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={disclosureOf(current().row) === option.value}
                    onClick={() => {
                      props.rowMenu?.onDisclosure(current().row, option.value);
                      setMenu(null);
                    }}
                  >
                    {disclosureOf(current().row) === option.value ? "✓ " : ""}
                    {option.label}
                    {current().row.disclosure === null && option.value === "retrievable"
                      ? "（默认）"
                      : ""}
                  </button>
                )}
              </For>
            </div>
          );
        }}
      </Show>
    </div>
  );
}
