/**
 * 搜索命中列表：作者搜的那个词，连同它周围的话。
 *
 * 在这之前结果只有一列文件路径，而查询词不在路径里——作者搜「风景的发现」，
 * 看到的是「章.md」，还得挨个点开找。
 */

import { For, Show } from "solid-js";

import type { BlockHit } from "../generated/bindings.gen";
import { excerptAround, splitOnQuery } from "./search-excerpt";

export interface SearchHitsProps {
  readonly query: string;
  readonly hits: readonly BlockHit[];
  readonly onSelect: (path: string, ordinal: number) => void;
}

/** 命中列表。查询为空或一条都没有时整块不出现。 */
export function SearchHits(props: SearchHitsProps) {
  return (
    <Show when={props.query.trim().length > 0 && props.hits.length > 0}>
      <ul class="search-hits" aria-label="搜索命中">
        <For each={props.hits}>
          {(hit) => (
            <li>
              <button
                type="button"
                onClick={() => props.onSelect(hit.path, hit.ordinal)}
                title={hit.path}
              >
                <span class="search-hit-path">{hit.path}</span>
                <span class="search-hit-text">
                  <For each={splitOnQuery(excerptAround(hit.text, props.query), props.query)}>
                    {(piece) =>
                      piece.matched ? <mark>{piece.text}</mark> : <span>{piece.text}</span>
                    }
                  </For>
                </span>
              </button>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
