<script lang="ts">
import type { ChapterView, RootView } from "./api.ts";
import type { Key } from "./i18n.ts";
import Palette, { type Command } from "./Palette.svelte";

interface Props {
  t: (key: Key) => string;
  icon: string | null;
  commands: Command[];
  paletteOpen: boolean;
  paletteShortcut: string;
  rootViews: RootView[];
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
  paletteShortcut,
  rootViews,
  chapters,
  active,
  onSelect,
  onAddRoot,
  onRemoveRoot,
  onNewChapter,
  onPaletteOpen,
  onPaletteClose,
}: Props = $props();

/**
 * Chapters and material, grouped by root identity.
 *
 * Grouping on `chapter.root === path` was the defect: a file opened on its own
 * records the file as the root while its chapter was filed under the parent
 * folder, so the comparison never matched and the rail drew a workspace with
 * no chapters in it. Identity cannot drift that way.
 */
const under = (root: RootView, role: "chapter" | "material"): ChapterView[] =>
  chapters.filter((c) => c.rootId === root.id && c.role === role);

/** Material folds away by default: it is reference, not the sequence. */
let openMaterial = $state<Record<string, boolean>>({});
</script>

<nav class="rail">
  <header class="rail-head">
    <Palette
      open={paletteOpen}
      {commands}
      {t}
      {icon}
      shortcut={paletteShortcut}
      inverted
      onOpen={onPaletteOpen}
      onClose={onPaletteClose}
    />
    <span class="wordmark">RefRain</span>
  </header>

  <div class="tree">
    {#each rootViews as root (root.id)}
      {@const chapterFiles = under(root, "chapter")}
      {@const materialFiles = under(root, "material")}
      <div class="root">
        <div class="root-head">
          <span class="root-name">{root.name}</span>
          <button
            class="drop-root"
            onclick={() => onRemoveRoot(root.path)}
            aria-label={t("agents.remove")}>✕</button
          >
        </div>

        {#if root.missing}
          <!-- A moved or unmounted folder is named rather than shown as empty:
               an empty rail reads as "the work is gone". -->
          <p class="root-missing">{t("root.missing")}</p>
        {:else}
          {#each chapterFiles as chapter (chapter.path)}
            <button
              class="chapter"
              class:on={chapter.path === active}
              onclick={() => onSelect(chapter.path)}
            >
              {chapter.title}
            </button>
          {/each}

          {#if materialFiles.length > 0}
            <button
              class="material-head"
              aria-expanded={openMaterial[root.id] ?? false}
              onclick={() =>
                (openMaterial = { ...openMaterial, [root.id]: !openMaterial[root.id] })}
            >
              {(openMaterial[root.id] ?? false) ? "▾" : "▸"}
              {t("rail.material")}
              <span class="count">{materialFiles.length}</span>
            </button>
            {#if openMaterial[root.id] ?? false}
              {#each materialFiles as file (file.path)}
                <button
                  class="chapter material"
                  class:on={file.path === active}
                  onclick={() => onSelect(file.path)}
                  title={file.id}
                >
                  {file.title}
                </button>
              {/each}
            {/if}
          {/if}

          {#if chapterFiles.length === 0 && materialFiles.length === 0}
            <p class="root-empty">{t("chapter.empty")}</p>
          {/if}
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

.root-missing {
  margin: 0.2rem 0 0.5rem;
  padding: 0 0.9rem;
  font-size: 0.72rem;
  line-height: 1.5;
  color: var(--rail-faint);
}

/* Material is reference, so it sits a step back from the chapter sequence. */
.material-head {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  width: 100%;
  padding: 0.3rem 0.9rem;
  border: 0;
  background: none;
  color: var(--rail-faint);
  font-size: 0.74rem;
  text-align: left;
  cursor: pointer;
}

.material-head .count {
  margin-left: auto;
  opacity: 0.7;
}

.chapter.material {
  padding-left: 1.6rem;
  color: var(--rail-faint);
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
