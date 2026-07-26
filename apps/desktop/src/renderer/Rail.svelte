<script lang="ts">
import type { ChapterView } from "./api.ts";
import type { Key } from "./i18n.ts";
import Palette, { type Command } from "./Palette.svelte";

interface Props {
  t: (key: Key) => string;
  icon: string | null;
  commands: Command[];
  paletteOpen: boolean;
  roots: string[];
  chapters: ChapterView[];
  active: string | null;
  onSelect: (path: string) => void;
  onAddRoot: () => void;
  onRemoveRoot: (path: string) => void;
  onNewChapter: () => void;
  onPaletteOpen: () => void;
  onPaletteClose: () => void;
}

const {
  t,
  icon,
  commands,
  paletteOpen,
  roots,
  chapters,
  active,
  onSelect,
  onAddRoot,
  onRemoveRoot,
  onNewChapter,
  onPaletteOpen,
  onPaletteClose,
}: Props = $props();

/** The last path segment, whichever separator the platform uses. */
const nameOf = (path: string): string => path.split(/[/\\]/).pop() ?? path;
</script>

<nav class="rail">
  <header class="rail-head">
    <Palette
      open={paletteOpen}
      {commands}
      {t}
      {icon}
      inverted
      onOpen={onPaletteOpen}
      onClose={onPaletteClose}
    />
    <span class="wordmark">RefRain</span>
  </header>

  <div class="tree">
    {#each roots as path (path)}
      {@const rootChapters = chapters.filter((c) => c.root === path)}
      <div class="root">
        <div class="root-head">
          <span class="root-name">{nameOf(path)}</span>
          <button class="drop-root" onclick={() => onRemoveRoot(path)} aria-label="remove">✕</button>
        </div>
        {#each rootChapters as chapter (chapter.path)}
          <button
            class="chapter"
            class:on={chapter.path === active}
            onclick={() => onSelect(chapter.path)}
          >
            {chapter.title}
          </button>
        {/each}
        {#if rootChapters.length === 0}
          <p class="root-empty">{t("chapter.empty")}</p>
        {/if}
      </div>
    {/each}
  </div>

  <div class="rail-foot">
    <button onclick={onAddRoot}>＋ {t("welcome.open")}</button>
    {#if active}
      <button onclick={onNewChapter}>＋ {t("cmd.newChapter").replace("…", "")}</button>
    {/if}
  </div>
</nav>

<style>
/*
 * The rail is a different material from the page — a dark board the sheets sit
 * against. Two shades of the same paper never separated properly; this does,
 * and it gives the cinnabar somewhere to be bright.
 */
.rail {
  display: flex;
  flex-direction: column;
  background: var(--rail);
  color: var(--rail-ink);
  padding: 0.7rem 0.5rem 0.7rem;
  overflow: hidden;
  flex: none;
  /*
   * The seam. A 5:1 drop in lightness cannot be joined by a hairline: the eye
   * refocuses on the boundary. A warm highlight on the rail's own edge gives
   * the two surfaces a note in common, and the shadow spreads far enough into
   * the warm side to be seen rather than merely specified.
   */
  box-shadow:
    inset -1px 0 0 oklch(0.986 0.006 76 / 0.13),
    1px 0 0 oklch(0.164 0.03 254),
    12px 0 26px -12px oklch(0.164 0.03 254 / 0.42);
  position: relative;
  z-index: 2;
}

.rail-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0 0.15rem 0.9rem;
}

.wordmark {
  font-family: var(--display);
  font-size: var(--step--1);
  letter-spacing: 0.06em;
  color: var(--rail-ink);
}

.tree {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.root-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 0 0.5rem 0.25rem;
}

.root-name {
  font-size: var(--step--2);
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--rail-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drop-root {
  font-size: var(--step--2);
  color: var(--ink-ghost);
  opacity: 0;
  transition: opacity 140ms var(--ease);
}

.root:hover .drop-root {
  opacity: 1;
}

.drop-root:hover {
  color: var(--refused);
}

.chapter {
  display: block;
  width: 100%;
  text-align: left;
  padding: 0.4rem 0.6rem;
  border-radius: 3px;
  font-size: var(--step--1);
  color: var(--rail-faint);
  border-left: 2px solid transparent;
}

.chapter:hover {
  background: color-mix(in oklab, var(--rail-ink) 8%, transparent);
  color: var(--rail-ink);
}

/* The cinnabar earns its place here: it marks where the author is. */
.chapter.on {
  color: var(--rail-ink);
  background: color-mix(in oklab, var(--seal) 26%, transparent);
  border-left-color: var(--seal-bright);
  font-weight: 500;
}

/*
 * Upright, not italic. CJK has no italic; the browser slants the glyphs
 * geometrically and the strokes collapse. Weight and value carry the
 * de-emphasis instead.
 */
.root-empty {
  padding: 0.25rem 0.6rem 0.2rem;
  font-size: var(--step--2);
  color: var(--rail-faint);
  opacity: 0.66;
  line-height: 1.7;
}

.rail-foot {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-top: 0.5rem;
  margin-top: 0.5rem;
  border-top: 1px solid var(--rail-rule);
  /* Never compressed away: these two commands create everything else. */
  flex: none;
  padding-bottom: 0.2rem;
}

.rail-foot button {
  text-align: left;
  padding: 0.42rem 0.6rem;
  font-size: var(--step--2);
  color: var(--rail-faint);
  border-radius: 3px;
}

.rail-foot button:hover {
  color: var(--seal-bright);
  background: color-mix(in oklab, var(--rail-ink) 8%, transparent);
}
</style>
