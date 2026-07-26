<script lang="ts">
import Agents from "./Agents.svelte";
import type { ChapterView, EditView, ProposalView, RunView, VerdictView } from "./api.ts";
import { api } from "./api.ts";
import ContextMenu from "./ContextMenu.svelte";
import Dispatch from "./Dispatch.svelte";
import Edits from "./Edits.svelte";
import { type Key, type Lang, translator } from "./i18n.ts";
import { chordOf, commandFor, loadBindings, saveBindings } from "./keys.ts";
import Ledger from "./Ledger.svelte";
import Mark from "./Mark.svelte";
import Palette, { type Command } from "./Palette.svelte";
import Progress from "./Progress.svelte";
import Review from "./Review.svelte";
import Settings, { type Section } from "./Settings.svelte";
import Sheet from "./Sheet.svelte";
import Shortcuts from "./Shortcuts.svelte";
import Typography from "./Typography.svelte";
import { DEFAULTS, measureFontLine, type TypeSettings } from "./typography.ts";

type SheetName = "dispatch" | "review" | "ledger" | "edits" | "settings" | null;

const stored = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
};

let lang = $state<Lang>(stored("refrain.lang", "zh"));
let theme = $state<"rain" | "kozo" | "ink">(stored("refrain.theme", "rain"));
let surface = $state<"opaque" | "translucent" | "glass">(stored("refrain.surface", "opaque"));
let sheetStyle = $state<"none" | "hairline" | "paper">(stored("refrain.sheet", "none"));
let layout = $state<"page" | "canvas">(stored("refrain.layout", "page"));
let icon = $state<string | null>(stored("refrain.icon", null));
let type = $state<TypeSettings>({ ...DEFAULTS, ...stored("refrain.type", DEFAULTS) });
let bindings = $state<Record<string, string>>(loadBindings());

const t = $derived(translator(lang));

/** Several roots, so an empty folder for tidiness does not lock out the manuscripts. */
let roots = $state<string[]>(stored("refrain.roots", []));
let chapters = $state<ChapterView[]>([]);
let active = $state<string | null>(null);
let text = $state("");
let saved = $state(true);
let selection = $state("");
let progress = $state(0);
let paragraphMarks = $state<number[]>([]);

let sheet = $state<SheetName>(null);
let section = $state<Section>("appearance");
let paletteOpen = $state(false);
let zen = $state(false);
let dragging = $state(false);
let menuAt = $state<{ x: number; y: number } | null>(null);

let edits = $state<EditView[]>([]);
let proposals = $state<ProposalView[]>([]);
let comments = $state<{ target: string; text: string }[]>([]);
let runs = $state<RunView[]>([]);
let refusal = $state<{ reason: string; detail: string[] } | null>(null);
let notice = $state<string | null>(null);
let surfaceEl = $state<HTMLElement | null>(null);
let scrollEl = $state<HTMLElement | null>(null);

const root = $derived(roots[0] ?? null);

$effect(() => {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.surface = surface;
  document.documentElement.dataset.sheet = sheetStyle;
  localStorage.setItem("refrain.theme", JSON.stringify(theme));
  localStorage.setItem("refrain.surface", JSON.stringify(surface));
  localStorage.setItem("refrain.sheet", JSON.stringify(sheetStyle));
});
$effect(() => localStorage.setItem("refrain.lang", JSON.stringify(lang)));
$effect(() => localStorage.setItem("refrain.layout", JSON.stringify(layout)));
$effect(() => localStorage.setItem("refrain.icon", JSON.stringify(icon)));
$effect(() => localStorage.setItem("refrain.roots", JSON.stringify(roots)));
$effect(() => saveBindings(bindings));

$effect(() => {
  localStorage.setItem("refrain.type", JSON.stringify(type));
  const style = document.documentElement.style;
  const family = `"${type.latinFamily}", "${type.cjkFamily}", serif`;

  style.setProperty("--manuscript-family", family);
  style.setProperty("--manuscript-size", `${type.size * type.zoom}px`);
  style.setProperty("--manuscript-weight", String(type.weight));
  style.setProperty("--manuscript-leading", String(type.leading));
  style.setProperty("--manuscript-tracking", `${type.tracking}em`);
  style.setProperty("--manuscript-word-spacing", `${type.wordSpacing}em`);
  style.setProperty("--manuscript-measure", `${type.measure}em`);
  /*
   * The column's width as an absolute length.
   *
   * `measure` is em, which resolves against whichever element reads it — so
   * the header at one font size and the manuscript at another produced two
   * different widths from the same variable, and centring them gave two
   * different left edges. One pixel value, shared, removes the whole class of
   * bug.
   */
  style.setProperty("--column-width", `${type.measure * type.size * type.zoom + 144}px`);
  style.setProperty("--manuscript-indent", `${type.indent}em`);
  style.setProperty("--manuscript-align", type.align);
  style.setProperty("--paragraph-spacing", String(type.paragraphSpacing));
  style.setProperty("--margin-top", `${type.marginTop}rem`);
  style.setProperty("--margin-bottom", `${type.marginBottom}vh`);
  style.setProperty("--grid-every", String(type.gridEvery));
  style.setProperty("--font-line", measureFontLine(family, type.size).toFixed(4));
});

const say = (message: string): void => {
  notice = message;
  setTimeout(() => (notice = null), 2800);
};

/** Paragraphs in, paragraphs out: the manuscript is blocks, not a string. */
const render = (source: string): void => {
  if (!surfaceEl) return;
  surfaceEl.replaceChildren(
    ...source.split(/\n\s*\n/).map((block) => {
      const p = document.createElement("p");
      p.textContent = block.trim();
      return p;
    }),
  );
  measureParagraphs();
};

const readSurface = (): string =>
  [...(surfaceEl?.children ?? [])]
    .map((node) => node.textContent?.trim() ?? "")
    .filter((block) => block.length > 0)
    .join("\n\n");

const measureParagraphs = (): void => {
  const height = surfaceEl?.scrollHeight ?? 1;
  paragraphMarks = [...(surfaceEl?.children ?? [])].map(
    (node) => (node as HTMLElement).offsetTop / height,
  );
};

const onEdit = (): void => {
  text = readSurface();
  saved = false;
};

const addRoot = async (path?: string): Promise<void> => {
  const chosen = path ?? (await api().openProject());
  if (!chosen || roots.includes(chosen)) return;
  roots = [...roots, chosen];
  await reload();
};

const openFile = async (): Promise<void> => {
  const chosen = await api().openFile();
  if (!chosen || roots.includes(chosen)) return;
  roots = [...roots, chosen];
  await reload();
};

const removeRoot = async (path: string): Promise<void> => {
  roots = roots.filter((r) => r !== path);
  await reload();
};

const reload = async (): Promise<void> => {
  if (roots.length === 0) {
    chapters = [];
    return select(null);
  }
  chapters = await api().loadWorkspace(roots);
  if (!chapters.some((c) => c.title === active)) select(chapters[0]?.title ?? null);
};

const createProject = async (): Promise<void> => {
  const chosen = await api().createProject();
  if (chosen) await addRoot(chosen);
};

const select = (title: string | null): void => {
  active = title;
  text = chapters.find((c) => c.title === title)?.text ?? "";
  saved = true;
  edits = [];
  queueMicrotask(() => render(text));
};

const newChapter = async (): Promise<void> => {
  if (!root) return;
  const name = prompt(t("chapter.new"));
  if (!name?.trim()) return;
  await api().saveChapter(root, name.trim(), "");
  await reload();
  select(name.trim());
};

const save = async (): Promise<void> => {
  if (!root || !active) return;
  const previous = chapters.find((c) => c.title === active)?.text ?? "";
  await api().saveChapter(root, active, text);
  const recorded = await api().editsBetween(previous, text);
  edits = [...edits, ...recorded];
  chapters = chapters.map((c) => (c.title === active ? { ...c, text } : c));
  saved = true;
};

const revert = async (id: string): Promise<void> => {
  const edit = edits.find((e) => e.id === id);
  if (!edit) return;
  text = await api().revertEdit(text, edit);
  render(text);
  edits = edits.filter((e) => e.id !== id);
  saved = false;
};

const revertAll = async (): Promise<void> => {
  text = await api().revertAll(text, edits);
  render(text);
  edits = [];
  saved = false;
};

const setZen = async (on: boolean): Promise<void> => {
  zen = on;
  await api().fullscreen(on);
};

const collect = async (runId: string): Promise<void> => {
  if (!root) return;
  try {
    const result = await api().collect(root, runId);
    proposals = [...proposals, ...result.proposals];
    comments = [...comments, ...result.comments];
    sheet = "review";
  } catch (error) {
    say(String(error));
  }
  runs = await api().runs(root);
};

const commit = async (verdicts: VerdictView[]): Promise<void> => {
  if (!root || !active) return;
  refusal = null;
  const result = await api().commit(root, { chapter: active, verdicts });
  if (!result.ok) {
    refusal = { reason: result.reason, detail: result.detail };
    return;
  }
  text = result.text;
  render(result.text);
  chapters = chapters.map((c) => (c.title === active ? { ...c, text: result.text } : c));
  proposals = proposals.filter((p) => !verdicts.some((v) => v.proposalId === p.id));
  saved = true;
  if (proposals.length === 0) sheet = null;
};

/** Wrap the selection in a Markdown mark, the way an editor expects. */
const format = (mark: "bold" | "italic" | "strike" | "code"): void => {
  const wrap = { bold: "**", italic: "*", strike: "~~", code: "`" }[mark];
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const chosen = range.toString();
  if (chosen.length === 0) return;
  range.deleteContents();
  range.insertNode(document.createTextNode(`${wrap}${chosen}${wrap}`));
  menuAt = null;
  onEdit();
};

const openSettings = (at: Section): void => {
  section = at;
  sheet = "settings";
};

const commands = $derived<Command[]>([
  { id: "open", label: "cmd.open", group: "group.project", keys: bindings.open, run: () => void addRoot() },
  { id: "openFile", label: "cmd.openFile", group: "group.project", run: () => void openFile() },
  { id: "create", label: "cmd.create", group: "group.project", run: () => void createProject() },
  { id: "chapter", label: "cmd.newChapter", group: "group.project", keys: bindings.newChapter, run: () => void newChapter(), when: () => root !== null },
  { id: "save", label: "cmd.save", group: "group.write", keys: bindings.save, run: () => void save(), when: () => active !== null },
  { id: "edits", label: "cmd.edits", group: "group.write", keys: bindings.edits, run: () => (sheet = "edits"), when: () => root !== null },
  { id: "zen", label: "cmd.zen", group: "group.view", keys: bindings.zen, run: () => void setZen(!zen), when: () => active !== null },
  { id: "dispatch", label: "cmd.dispatch", group: "group.collab", keys: bindings.dispatch, run: () => (sheet = "dispatch"), when: () => root !== null },
  { id: "review", label: "cmd.review", group: "group.collab", keys: bindings.review, run: () => (sheet = "review"), when: () => root !== null },
  { id: "ledger", label: "cmd.ledger", group: "group.collab", keys: bindings.ledger, run: () => (sheet = "ledger"), when: () => root !== null },
  { id: "agents", label: "cmd.agents", group: "group.collab", run: () => openSettings("agents"), when: () => root !== null },
  { id: "typography", label: "cmd.typography", group: "group.view", run: () => openSettings("typography") },
  { id: "theme", label: "cmd.theme", group: "group.view", run: () => { theme = theme === "rain" ? "kozo" : theme === "kozo" ? "ink" : "rain"; } },
  { id: "settings", label: "cmd.settings", group: "group.view", keys: bindings.settings, run: () => openSettings("appearance") },
]);

const onKeydown = (event: KeyboardEvent): void => {
  const chord = chordOf(event);
  const command = commandFor(bindings, chord);

  if (chord === bindings.palette) {
    event.preventDefault();
    return void (paletteOpen = !paletteOpen);
  }
  if (event.key === "Escape") {
    if (zen) return void setZen(false);
    if (menuAt) return void (menuAt = null);
  }
  if (!command) return;

  const handlers: Record<string, () => void> = {
    open: () => void addRoot(),
    newChapter: () => void newChapter(),
    save: () => void save(),
    zen: () => void setZen(!zen),
    settings: () => openSettings("appearance"),
    dispatch: () => (sheet = "dispatch"),
    review: () => (sheet = "review"),
    ledger: () => (sheet = "ledger"),
    edits: () => (sheet = "edits"),
    bold: () => format("bold"),
    italic: () => format("italic"),
    zoomIn: () => (type = { ...type, zoom: Math.min(type.zoom + 0.1, 3) }),
    zoomOut: () => (type = { ...type, zoom: Math.max(type.zoom - 0.1, 0.5) }),
    zoomReset: () => (type = { ...type, zoom: 1 }),
  };

  const handler = handlers[command];
  if (handler) {
    event.preventDefault();
    handler();
  }
};

/** Ctrl and the wheel scales the manuscript, as every editor does. */
const onWheel = (event: WheelEvent): void => {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  const next = type.zoom - Math.sign(event.deltaY) * 0.08;
  type = { ...type, zoom: Math.max(0.5, Math.min(3, Number(next.toFixed(2)))) };
};

const onDrop = async (event: DragEvent): Promise<void> => {
  event.preventDefault();
  dragging = false;
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  const path = await api().resolveDrop(api().pathFor(file));
  if (path) await addRoot(path);
};

const captureSelection = (): void => {
  selection = window.getSelection()?.toString() ?? "";
  markCurrentParagraph();
};

/** Which paragraph the cursor is in, so breathing knows what to hold. */
const markCurrentParagraph = (): void => {
  if (!type.breathe || !surfaceEl) return;
  const node = window.getSelection()?.anchorNode;
  const paragraph = node
    ? (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest("p")
    : null;

  for (const child of surfaceEl.children) child.classList.toggle("here", child === paragraph);
};

const onScroll = (): void => {
  if (!scrollEl) return;
  const max = scrollEl.scrollHeight - scrollEl.clientHeight;
  progress = max > 0 ? scrollEl.scrollTop / max : 0;
};
</script>

<svelte:window
  on:keydown={onKeydown}
  on:wheel|nonpassive={onWheel}
  on:dragover|preventDefault={() => (dragging = true)}
  on:dragleave={() => (dragging = false)}
  on:drop|preventDefault={onDrop}
/>

{#if roots.length === 0}
  <main class="welcome" class:dragging>
    <Mark size={54} custom={icon} />
    <h1>RefRain</h1>
    <p class="tagline">{t("app.tagline")}</p>

    <div class="actions">
      <button class="primary" onclick={() => void addRoot()}>{t("welcome.open")}</button>
      <button onclick={() => void openFile()}>{t("welcome.openFile")}</button>
      <button onclick={() => void createProject()}>{t("welcome.create")}</button>
    </div>

    <p class="drop">{t("welcome.drop")}</p>
    <p class="fine">{t("welcome.fine")}</p>
    <p class="fine key">{t("welcome.hint")}</p>

    <div class="hidden-entry">
      <Palette
        open={paletteOpen}
        {commands}
        {t}
        {icon}
        onOpen={() => (paletteOpen = true)}
        onClose={() => (paletteOpen = false)}
      />
    </div>
  </main>
{:else}
  <div class="shell" class:zen class:dragging>
    {#if !zen}
      <nav class="rail">
        <header class="rail-head">
          <Palette
            open={paletteOpen}
            {commands}
            {t}
            {icon}
            inverted
            onOpen={() => (paletteOpen = true)}
            onClose={() => (paletteOpen = false)}
          />
          <span class="wordmark">RefRain</span>
        </header>

        <div class="tree">
          {#each roots as path (path)}
            {@const rootChapters = chapters.filter((c) => c.root === path)}
            <div class="root">
              <div class="root-head">
                <span class="root-name">{path.split(/[/\\]/).pop()}</span>
                <button class="drop-root" onclick={() => void removeRoot(path)} aria-label="remove">
                  ✕
                </button>
              </div>
              {#each rootChapters as chapter (chapter.title)}
                <button
                  class="chapter"
                  class:on={chapter.title === active}
                  onclick={() => select(chapter.title)}
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
          <button onclick={() => void addRoot()}>＋ {t("welcome.open")}</button>
          {#if active}
            <button onclick={() => void newChapter()}>
              ＋ {t("cmd.newChapter").replace("…", "")}
            </button>
          {/if}
        </div>
      </nav>
    {/if}

    <main class="writing">
      <Progress
        value={progress}
        style={type.progress}
        place={type.progressPlace}
        marks={paragraphMarks}
      />

      {#if !zen && active}
          <header class="bar">
          <span class="title">{active ?? t("chapter.none")}</span>
          <div class="right">
            {#if edits.length > 0}
              <button class="chip" onclick={() => (sheet = "edits")}>
                {edits.length} {t("edits.count")}
              </button>
            {/if}
            {#if proposals.length > 0}
              <button class="chip accent" onclick={() => (sheet = "review")}>
                {proposals.length}
              </button>
            {/if}
            {#if active}
              <span class="state" class:dirty={!saved}>
                {saved ? t("chapter.saved") : t("chapter.unsaved")}
              </span>
            {/if}
          </div>
          </header>
      {/if}

      <div class="scroll" class:zen bind:this={scrollEl} onscroll={onScroll}>
        <div class="sheet-surface">
          {#if !active}
            <div class="blank">
              <p>{t("chapter.pickOne")}</p>
              <button onclick={() => void newChapter()}>
                {t("cmd.newChapter").replace("…", "")}
              </button>
            </div>
          {/if}

          <div class="page" class:numbered={type.lineNumbers} class:hidden={!active}>
          <div
            class="manuscript"
            data-grid={type.grid ? "on" : "off"}
            data-breathe={type.breathe ? "on" : "off"}
            role="textbox"
            tabindex="0"
            aria-multiline="true"
            aria-label="manuscript"
            contenteditable="true"
            spellcheck="false"
            bind:this={surfaceEl}
            oninput={onEdit}
            onmouseup={captureSelection}
            onkeyup={captureSelection}
            oncontextmenu={(e) => {
              e.preventDefault();
              captureSelection();
              menuAt = { x: e.clientX, y: e.clientY };
            }}
          ></div>
          </div>
        </div>
      </div>

      {#if zen}
        <p class="zen-hint">{t("zen.exit")}</p>
      {/if}
    </main>
  </div>
{/if}

{#if menuAt}
  <ContextMenu
    x={menuAt.x}
    y={menuAt.y}
    {selection}
    {t}
    onFormat={format}
    onAnnotate={() => {
      menuAt = null;
      sheet = "edits";
    }}
    onDispatch={() => {
      menuAt = null;
      sheet = "dispatch";
    }}
    onClose={() => (menuAt = null)}
  />
{/if}

<Sheet open={sheet === "dispatch"} title={t("dispatch.title")} onClose={() => (sheet = null)}>
  <Dispatch
    {root}
    chapter={active}
    {selection}
    {runs}
    {t}
    onDispatched={async () => {
      if (root) runs = await api().runs(root);
    }}
    onCollect={collect}
  />
</Sheet>

<Sheet open={sheet === "review"} title={t("review.title")} width="540px" onClose={() => (sheet = null)}>
  <Review {proposals} {comments} {t} {refusal} onCommit={commit} />
</Sheet>

<Sheet open={sheet === "edits"} title={t("edits.title")} width="480px" onClose={() => (sheet = null)}>
  <Edits
    {edits}
    {t}
    onRevert={revert}
    onRevertAll={revertAll}
    onNote={(id, note) => {
      edits = edits.map((e) => (e.id === id ? { ...e, note } : e));
    }}
    onSendToAgent={() => {
      sheet = "dispatch";
      say(t("edits.attached"));
    }}
  />
</Sheet>

<Sheet open={sheet === "ledger"} title={t("ledger.title")} width="500px" onClose={() => (sheet = null)}>
  <Ledger {root} {t} />
</Sheet>

<Sheet open={sheet === "settings"} title={t("set.title")} width="600px" onClose={() => (sheet = null)}>
  <Settings
    {lang}
    {theme}
    {surface}
    sheet={sheetStyle}
    {layout}
    {t}
    {section}
    onSection={(next) => (section = next)}
    onLang={(next) => (lang = next)}
    onTheme={(next) => (theme = next)}
    onSurface={(next) => (surface = next)}
    onSheet={(next) => (sheetStyle = next)}
    onLayout={(next) => (layout = next)}
    onIcon={(next) => (icon = next)}
  >
    {#snippet typography()}
      <Typography settings={type} {t} onChange={(next) => (type = next)} />
    {/snippet}
    {#snippet agents()}
      <Agents {root} {t} />
    {/snippet}
    {#snippet shortcuts()}
      <Shortcuts {bindings} {t} onChange={(next) => (bindings = next)} />
    {/snippet}
  </Settings>
</Sheet>

{#if notice}
  <div class="notice">{notice}</div>
{/if}

<style>
.welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100vh;
  gap: 0;
  text-align: center;
  padding: 2rem 2rem 9vh;
  transition: background 200ms var(--ease);
}

.welcome.dragging,
.shell.dragging {
  background: var(--seal-wash);
}

h1 {
  font-family: var(--display);
  font-size: var(--step-4);
  font-weight: 400;
  letter-spacing: 0.04em;
  margin-top: 1.4rem;
}

.tagline {
  font-family: var(--serif);
  color: var(--ink-soft);
  max-width: 26em;
  line-height: 1.95;
  margin-top: 1.5rem;
}

.actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 2.3rem;
}

.actions button {
  padding: 0.58rem 1.3rem;
  border: 1px solid var(--rule-strong);
  border-radius: 3px;
  font-size: var(--step--1);
  color: var(--ink-soft);
  background: var(--paper-raised);
  transition: transform 200ms var(--spring), border-color 160ms var(--ease), color 160ms var(--ease);
}

.actions button:hover {
  border-color: var(--seal);
  color: var(--seal);
  transform: translateY(-1px);
}

.actions .primary {
  background: var(--ink);
  border-color: var(--ink);
  color: var(--paper-raised);
}

.actions .primary:hover {
  background: var(--seal);
  border-color: var(--seal);
  color: var(--paper-raised);
}

.drop {
  font-size: var(--step--1);
  color: var(--ink-faint);
  margin-top: 0.9rem;
}

.welcome.dragging .drop {
  color: var(--seal);
}

.fine {
  font-size: var(--step--2);
  color: var(--ink-ghost);
  max-width: 25em;
  margin-top: 2.6rem;
  line-height: 1.9;
}

.fine.key {
  margin-top: 0.5rem;
  color: var(--ink-faint);
  letter-spacing: 0.03em;
}

.shell {
  display: grid;
  grid-template-columns: 208px minmax(0, 1fr);
  height: 100vh;
  transition: grid-template-columns 300ms var(--ease), background 200ms var(--ease);
}

.shell.zen {
  grid-template-columns: minmax(0, 1fr);
}

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
  /* The seam: a dark edge and a short gradient, so the cool and warm surfaces
   * meet rather than collide. A hard butt joint makes the eye refocus. */
  /*
   * The seam. A 5:1 drop in lightness cannot be joined by a hairline: the eye
   * refocuses on the boundary. A warm highlight on the rail's own edge gives
   * the two surfaces a note in common, and the shadow spreads far enough into
   * the warm side to be seen rather than merely specified.
   */
  box-shadow:
    inset -1px 0 0 oklch(0.986 0.006 76 / 0.13),
    1px 0 0 oklch(0.164 0.030 254),
    12px 0 26px -12px oklch(0.164 0.030 254 / 0.42);
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

/* The welcome screen needs the palette mounted but not shown as a button. */
.hidden-entry {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
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

/*
 * A desk, and on it a sheet.
 *
 * Flooding the viewport with paper colour gives the eye no edge to read, so it
 * concludes it is looking at a screen. The sheet has a width, a border, and a
 * shadow — which is what makes the surrounding colour a desk rather than more
 * paper.
 */
.writing {
  display: flex;
  flex-direction: column;
  min-width: 0;
  position: relative;
  background: var(--paper);
  overflow: hidden;
}

/* A trace of fibre on the desk, so it is a material and not a fill. */
/*
 * Fibre, and a direction to it.
 *
 * Paper stock has a grain; a uniform noise field reads as screen dither. The
 * turbulence is stretched vertically to suggest one, and the whole is strong
 * enough to survive a screenshot — an earlier value was technically present
 * and visually absent, which is the same as not having done it.
 */
/*
 * Volume, not grain.
 *
 * A noise tile is the obvious way to make a surface feel like paper and it
 * does not survive: at 2× the tile is resampled and the particles wash out, so
 * the texture is present in the stylesheet and absent on screen. A large, very
 * shallow luminance gradient reads as a lit surface at any pixel density —
 * one lamp, upper left, the way a desk actually is.
 */
.writing::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(120% 90% at 22% 0%, oklch(1 0 0 / 0.5), transparent 58%),
    radial-gradient(100% 80% at 96% 100%, oklch(0.2 0.02 60 / 0.045), transparent 62%);
}

/*
 * The column has a home, not a centre.
 *
 * Centring an 800px column in a 2400px window leaves it floating with no
 * relationship to anything; anchoring it a fixed distance from the rail gives
 * the eye a left edge to return to, which is what reading a column requires.
 */
/*
 * One vertical line, and everything hangs from it.
 *
 * The whole value of anchoring a column to the left is that invisible line;
 * an earlier version had the title at one x and the body at another, which
 * spent the cost of the decision without collecting any of it.
 */
/*
 * Identical width to the sheet, or the two centre to different left edges and
 * the anchor line the layout is built on stops existing. This is exactly how
 * the header ended up 57px right of the body it names.
 */
/*
 * The header sits in the same padded box as the scroll area and takes the same
 * width, so both centre against the same container and share one left edge.
 * Measured rather than eyeballed: `scripts/verify-anchor.ts` fails the build
 * if they ever drift apart again.
 */
/*
 * The rail owns the geometry; the header just fills it. Both this and the
 * sheet resolve `measure + 9rem` inside a box padded by 2rem, so they centre
 * against the same width and land on the same left edge. Checked by
 * `scripts/verify-anchor.ts`, which fails when they drift.
 */
/*
 * The header carries its own geometry and matches the sheet exactly.
 *
 * `align-self: center` rather than `margin: auto`: `.writing` is a flex
 * column, so its children stretch to full width by default and an auto margin
 * has nothing left to distribute. That is why the header stayed pinned to the
 * pane's edge through several attempts to centre it.
 *
 * The width comes from `--column-width`, a pixel value computed once, because
 * `measure` is em and resolves differently at each element's own font size —
 * one variable, two widths, two left edges.
 */
.bar {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  box-sizing: border-box;
  align-self: center;
  flex: none;
  width: min(var(--column-width), calc(100% - 6rem));
  padding: 0.9rem 4.5rem 0.7rem;
  border-bottom: 1px solid var(--rule);
  position: relative;
  z-index: 1;
}

.title {
  font-family: var(--serif);
  font-size: var(--step-0);
  color: var(--ink-soft);
}

.right {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.chip {
  font-size: var(--step--2);
  padding: 0.14rem 0.45rem;
  border-radius: 9px;
  color: var(--ink-faint);
  background: var(--paper-sunk);
}

.chip:hover {
  color: var(--ink);
}

.chip.accent {
  color: var(--paper-raised);
  background: var(--seal);
  font-weight: 600;
}

.state {
  font-size: var(--step--2);
  color: var(--ink-faint);
}

.state.dirty {
  color: var(--seal);
}

.scroll {
  flex: 1;
  overflow-y: auto;
  padding: 1.4rem 2rem 2rem;
}

/* Zen recentres: with no rail there is no left edge to anchor to. */
.scroll.zen .sheet-surface {
  margin: 0 auto;
}

/* Four edges when there is a sheet at all: three read as a column, not a page. */
/*
 * On a wide window the column centres inside the writing area rather than
 * clinging to the rail: pinned left, two thirds of a 2400px screen sits empty
 * to the right and the application reads as stuck to one edge.
 */
.sheet-surface {
  width: min(var(--column-width), calc(100% - 2rem));
  margin: 0 auto;
  position: relative;
  z-index: 1;
  padding: var(--margin-top, 3rem) 4.5rem var(--margin-bottom, 50vh);
  background: var(--sheet-fill, transparent);
  border: 1px solid var(--sheet-border, transparent);
  border-radius: 2px;
  box-shadow: var(--sheet-shadow, none);
}

.scroll.zen .sheet-surface {
  border: none;
  box-shadow: none;
  background: transparent;
}

/*
 * Zen: the manuscript and its rest occupy the screen. The deep bottom padding
 * is the typewriter effect — the line being written stays near the middle
 * rather than sinking to the bottom edge.
 */
.scroll.zen {
  padding-top: 15vh;
}

.page {
  position: relative;
}

.page.hidden {
  display: none;
}

/* An empty canvas should say what to do, not merely be empty. */
/*
 * Optically centred, slightly above the geometric middle, and held as one
 * block. Split across the height — a header pinned to the top, a sentence
 * floating at 30%, a thousand pixels of nothing below — the eye has nowhere
 * to land and the screen reads as unfinished rather than as quiet.
 */
.blank {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 0.9rem;
  min-height: min(62vh, 34rem);
  color: var(--ink-faint);
  font-family: var(--serif);
  line-height: 2;
}

/* The one action on an empty page carries the most weight on it, but stays
 * in the page's own language: ink and a rule, not a filled pill. */
.blank button {
  padding: 0 0 0.18rem;
  font-size: var(--step-0);
  font-family: var(--serif);
  color: var(--seal);
  border-bottom: 1px solid color-mix(in oklab, var(--seal) 40%, transparent);
  border-radius: 0;
  transition: border-color 200ms var(--ease), letter-spacing 260ms var(--ease);
}

.blank button:hover {
  border-bottom-color: var(--seal);
  letter-spacing: 0.06em;
}

/* Line numbers sit outside the measure, so they never narrow the text. */
.page.numbered .manuscript {
  counter-reset: line;
}

.page.numbered :global(.manuscript > p) {
  position: relative;
}

.page.numbered :global(.manuscript > p)::before {
  counter-increment: line;
  content: counter(line);
  position: absolute;
  left: -3.2em;
  width: 2.4em;
  text-align: right;
  font-family: var(--mono);
  font-size: 0.7em;
  color: var(--ink-ghost);
  user-select: none;
}

.zen-hint {
  position: absolute;
  bottom: 1.4rem;
  left: 50%;
  transform: translateX(-50%);
  font-size: var(--step--2);
  color: var(--ink-ghost);
  opacity: 0;
  transition: opacity 220ms var(--ease);
  pointer-events: none;
}

.writing:hover .zen-hint {
  opacity: 1;
}

.notice {
  position: fixed;
  bottom: 1.5rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 95;
  padding: 0.6rem 1.1rem;
  background: var(--ink);
  color: var(--paper-raised);
  border-radius: 3px;
  font-size: var(--step--1);
  max-width: 70vw;
  box-shadow: var(--shadow-float);
  animation: rise 200ms var(--spring);
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translate(-50%, 10px);
  }
}
</style>
