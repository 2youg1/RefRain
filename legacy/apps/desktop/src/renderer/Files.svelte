<script lang="ts">
/**
 * The file browser.
 *
 * Rows are windowed: the list renders what fits on screen plus a small margin,
 * regardless of whether the workspace holds forty files or forty thousand. The
 * index itself never crosses into the renderer — the native layer holds it, and
 * this asks for one page at a time.
 *
 * Delete goes to the system trash. The control says so, because a delete that
 * looks permanent and a delete that is recoverable should not look alike.
 */

import { onDestroy } from "svelte";
import type { Key } from "./i18n.ts";

export interface FileEntry {
  path: string;
  name: string;
  kind: "file" | "directory" | "symlink";
  size: number;
  modifiedMs: number;
  depth: number;
  manuscript: boolean;
}

export type SortOrder = "name" | "modified" | "size" | "kind";

interface Props {
  t: (key: Key) => string;
  entries: FileEntry[];
  total: number;
  /** Absent while the platform binary is missing; the browser says so and the editor carries on. */
  unavailable: string | null;
  active: string | null;
  order: SortOrder;
  descending: boolean;
  query: string;
  onSelect: (entry: FileEntry) => void;
  onQuery: (query: string) => void;
  onSort: (order: SortOrder) => void;
  onTrash: (paths: string[]) => void;
  onNeedPage: (offset: number, limit: number) => void;
}

const {
  t,
  entries,
  total,
  unavailable,
  active,
  order,
  descending,
  query,
  onSelect,
  onQuery,
  onSort,
  onTrash,
  onNeedPage,
}: Props = $props();

/** One row's height in CSS pixels. Fixed, because a windowed list needs to know
 * where row N sits without measuring rows 0..N-1. */
const ROW = 26;
/** Rows rendered beyond the viewport, so a fast scroll does not show a gap. */
const MARGIN = 8;
/** Long enough to coalesce ordinary typing, short enough to stay below a deliberate pause. */
const SEARCH_DEBOUNCE_MS = 200;

let viewport = $state<HTMLElement | null>(null);
let scrollTop = $state(0);
/**
 * Zero until the element measures itself. Starting at a guess makes the first
 * page a guess too — too many rows on a short pane, too few on a tall one — and
 * the guess is what reaches the DOM before anyone can see the mistake.
 */
let height = $state(0);
let selected = $state(new Set<string>());
let focusedIndex = $state<number | null>(null);
let queryTimer: ReturnType<typeof setTimeout> | undefined;

const first = $derived(Math.max(0, Math.floor(scrollTop / ROW) - MARGIN));
const visible = $derived(Math.ceil(height / ROW) + MARGIN * 2);
const focusedId = $derived(
  focusedIndex !== null && focusedIndex >= first && focusedIndex < first + entries.length
    ? `files-option-${focusedIndex}`
    : undefined,
);

// Asking for the page is an effect of where the viewport is, not of a click:
// scrolling with the keyboard has to fetch as readily as scrolling with a wheel.
$effect(() => {
  if (unavailable || !viewport) return;
  // Measure before asking. `clientHeight` is only meaningful once the element
  // is in the layout, which is why this reads it here rather than at mount.
  if (height === 0) height = viewport.clientHeight;
  onNeedPage(first, visible);
});

const onScroll = (event: Event) => {
  const target = event.currentTarget as HTMLElement;
  scrollTop = target.scrollTop;
  height = target.clientHeight;
};

const queueQuery = (next: string): void => {
  clearTimeout(queryTimer);
  queryTimer = undefined;
  if (next.trim() === "") {
    onQuery(next);
    return;
  }
  queryTimer = setTimeout(() => {
    queryTimer = undefined;
    onQuery(next);
  }, SEARCH_DEBOUNCE_MS);
};

onDestroy(() => clearTimeout(queryTimer));

const focus = (index: number) => {
  if (!viewport || total === 0) return;
  focusedIndex = Math.max(0, Math.min(total - 1, index));
  const top = focusedIndex * ROW;
  if (top < viewport.scrollTop) viewport.scrollTop = top;
  else if (top + ROW > viewport.scrollTop + viewport.clientHeight)
    viewport.scrollTop = top + ROW - viewport.clientHeight;
  scrollTop = viewport.scrollTop;
  height = viewport.clientHeight;
};

const onListKey = (event: KeyboardEvent) => {
  const page = Math.max(1, Math.floor(height / ROW));
  const current = focusedIndex ?? first;
  const target =
    event.key === "ArrowDown"
      ? current + (focusedIndex === null ? 0 : 1)
      : event.key === "ArrowUp"
        ? current - (focusedIndex === null ? 0 : 1)
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? total - 1
            : event.key === "PageDown"
              ? current + page
              : event.key === "PageUp"
                ? current - page
                : null;
  if (target !== null) {
    event.preventDefault();
    focus(target);
    return;
  }
  if (event.key !== "Enter" && event.key !== " ") return;
  const entry = focusedIndex === null ? undefined : entries[focusedIndex - first];
  if (!entry) return;
  event.preventDefault();
  toggle(entry, event.metaKey || event.ctrlKey);
};

const toggle = (entry: FileEntry, additive: boolean) => {
  const next = additive ? new Set(selected) : new Set<string>();
  if (next.has(entry.path)) next.delete(entry.path);
  else next.add(entry.path);
  selected = next;
  onSelect(entry);
};

const trashSelected = () => {
  if (selected.size === 0) return;
  onTrash([...selected]);
  selected = new Set();
};

/**
 * A date at the resolution a writer cares about: today shows a clock, this year
 * shows a day, anything older shows the year. A full timestamp on every row is
 * noise that pushes the name column narrower for no gain.
 */
const readableDate = (ms: number): string => {
  if (!ms) return "";
  const when = new Date(ms);
  const now = new Date();
  const sameDay = when.toDateString() === now.toDateString();
  if (sameDay) {
    return `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  }
  if (when.getFullYear() === now.getFullYear()) {
    return `${when.getMonth() + 1}/${when.getDate()}`;
  }
  return String(when.getFullYear());
};

/** Bytes as a reader reads them. Kilobyte thresholds, not a precise SI table. */
const readableSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const columns: { order: SortOrder; label: Key }[] = [
  { order: "name", label: "files.name" },
  { order: "modified", label: "files.modified" },
  { order: "size", label: "files.size" },
];
</script>

<section class="files" aria-label={t("files.title")}>
  {#if unavailable}
    <!-- The editor works without this pane; saying which platform lacks a build
         is more useful than an empty tree that reads as a broken project. -->
    <p class="unavailable" role="status">{unavailable}</p>
  {:else}
    <header>
      <input
        type="search"
        placeholder={t("files.search")}
        value={query}
        oninput={(event) => queueQuery((event.currentTarget as HTMLInputElement).value)}
        aria-label={t("files.search")}
      />
      <div class="columns" role="group" aria-label={t("files.sort")}>
        {#each columns as column (column.order)}
          <button
            type="button"
            class:active={order === column.order}
            onclick={() => onSort(column.order)}
            aria-pressed={order === column.order}
          >
            {t(column.label)}{#if order === column.order}<span aria-hidden="true"
                >{descending ? " ↓" : " ↑"}</span
              >{/if}
          </button>
        {/each}
      </div>
    </header>

    <div
      class="viewport"
      bind:this={viewport}
      onscroll={onScroll}
      onkeydown={onListKey}
      role="listbox"
      tabindex="0"
      aria-label={t("files.title")}
      aria-multiselectable="true"
      aria-activedescendant={focusedId}
    >
      <!-- One spacer holds the full scroll height so the scrollbar reflects the
           whole workspace while only the visible rows exist in the DOM. -->
      <div class="spacer" style="height: {total * ROW}px">
        {#each entries as entry, index (entry.path)}
          <div
            id={`files-option-${first + index}`}
            class="row"
            class:selected={selected.has(entry.path)}
            class:focused={focusedIndex === first + index}
            class:active={active === entry.path}
            class:directory={entry.kind === "directory"}
            style="top: {(first + index) * ROW}px"
            role="option"
            aria-selected={selected.has(entry.path)}
            tabindex="-1"
            onclick={(event) => {
              focusedIndex = first + index;
              toggle(entry, event.metaKey || event.ctrlKey);
            }}
            onkeydown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              focusedIndex = first + index;
              toggle(entry, event.metaKey || event.ctrlKey);
            }}
          >
            <span
              class="name"
              class:manuscript={entry.manuscript}
              style="text-indent: {(entry.depth - 1) * 12}px"
            >{entry.name}</span>
            <span class="modified">{readableDate(entry.modifiedMs)}</span>
            <span class="size">{entry.kind === "directory" ? "" : readableSize(entry.size)}</span>
          </div>
        {/each}
      </div>
    </div>

    <footer>
      <span class="count">{total} {t("files.count")}</span>
      <button
        type="button"
        class="trash"
        disabled={selected.size === 0}
        onclick={trashSelected}
      >
        {t("files.trash")}
      </button>
    </footer>
  {/if}
</section>

<style>
.files {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  font-size: 0.8125rem;
}

header {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  /* One device pixel at every density: a 1px rule on a 300% panel is a blurry
     three-pixel smear, and this application is built out of hairlines. */
  border-bottom: var(--hairline, 1px) solid var(--rule);
}

input[type="search"] {
  width: 100%;
  padding: 4px 6px;
  font: inherit;
  color: var(--ink);
  background: var(--paper);
  border: var(--hairline, 1px) solid var(--rule-strong);
  border-radius: 2px;
}

/*
 * Header and rows share one column template. Letting the header lay itself out
 * independently put the size label well left of the figures it named — a
 * defect invisible in the geometry checks because each half was internally
 * consistent.
 */
.columns,
.row {
  display: grid;
  /* `minmax(0, 1fr)` rather than `1fr`: a bare fr track takes its minimum from
     the content, so a long filename widened the row's first track past the
     header's and the two grids stopped agreeing on where the name column is. */
  grid-template-columns: minmax(0, 1fr) 4.5rem 4rem;
  align-items: center;
  gap: 8px;
}

.columns {
  /* No gutter of its own: `header` already supplies 8px, and the rows supply
     their own. Adding a second here made the header's tracks 16px narrower
     than the rows', which is the whole of the column drift. */
  padding: 0;
}

.columns button {
  padding: 2px 0;
  font: inherit;
  font-size: 0.75rem;
  color: var(--ink-soft);
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  /* Motion in frames, so the same gesture reads identically at 60 and 165 Hz. */
  transition: color var(--motion-quick, 66ms) ease;
}

/* Numeric columns are right-aligned, so their headers must be too. */
.columns button:nth-child(2),
.columns button:nth-child(3) {
  text-align: right;
}

.columns button.active {
  color: var(--ink);
}

.viewport {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  position: relative;
  /* The first row was rendering half-clipped against the header. A row sits on
     an absolute grid, so it needs the container's own padding box to start
     from rather than the edge the header ends at. */
  padding-top: 2px;
  contain: paint;
}

.viewport:focus-visible {
  outline: var(--hairline, 1px) solid var(--rule-strong);
  outline-offset: calc(-1 * var(--hairline, 1px));
}

.spacer {
  position: relative;
}

.row {
  position: absolute;
  left: 0;
  right: 0;
  height: 26px;
  /* Same gutters as the header, so the two grids resolve identical tracks. */
  padding: 0 8px;
  cursor: default;
  transition: background var(--motion-quick, 66ms) ease;
}

.row:hover {
  background: var(--paper-sunk);
}

.row.selected {
  background: var(--role-pending-wash);
}

.row.focused {
  outline: var(--hairline, 1px) solid var(--role-pending);
  outline-offset: calc(-1 * var(--hairline, 1px));
}

.row.active {
  box-shadow: inset 2px 0 0 var(--role-pending);
}

.name {
  /* Fill the track explicitly. A shrink-wrapped box gets centred in its cell,
     which drifted the name right of its header even after the two grids agreed
     on track widths — the last and least visible step of that bug. */
  justify-self: stretch;
  display: block;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-soft);
}

/* A file this application can open reads as text; everything else recedes. */
.name.manuscript {
  color: var(--ink);
}

.row.directory .name {
  font-weight: 500;
  color: var(--ink);
}

.modified,
.size {
  display: block;
  font-variant-numeric: tabular-nums;
  font-size: 0.6875rem;
  text-align: right;
  color: var(--ink-faint);
}

footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-top: var(--hairline, 1px) solid var(--rule);
}

.count {
  font-variant-numeric: tabular-nums;
  font-size: 0.6875rem;
  color: var(--ink-faint);
}

.trash {
  padding: 2px 8px;
  font: inherit;
  font-size: 0.75rem;
  color: var(--ink-soft);
  background: none;
  border: var(--hairline, 1px) solid var(--rule-strong);
  border-radius: 2px;
  cursor: pointer;
}

.trash:disabled {
  opacity: 0.4;
  cursor: default;
}

.unavailable {
  margin: 0;
  padding: 12px;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--ink-faint);
}
</style>
