import { createMemo, For } from "solid-js";
import type { DocumentRow } from "../generated/bindings.gen";
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

  return (
    <div class="shelf" data-shelf={props.shelf} ref={element}>
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
              >
                {row.path}
              </button>
            </li>
          )}
        </For>
        <li class="rail-spacer" style={{ height: `${view().padBottom}px` }} />
      </ul>
    </div>
  );
}
