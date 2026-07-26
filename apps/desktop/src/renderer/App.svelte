<script lang="ts">
import Agents from "./Agents.svelte";
import type { ChapterView, ProposalView, RunView, VerdictView } from "./api.ts";
import { api } from "./api.ts";
import Dispatch from "./Dispatch.svelte";
import { type Key, type Lang, translator } from "./i18n.ts";
import Ledger from "./Ledger.svelte";
import Palette, { type Command } from "./Palette.svelte";
import Review from "./Review.svelte";
import Settings from "./Settings.svelte";
import Sheet from "./Sheet.svelte";
import Typography from "./Typography.svelte";
import { DEFAULTS, measureFontLine, type TypeSettings } from "./typography.ts";

type SheetName = "dispatch" | "review" | "ledger" | "agents" | "typography" | "settings" | null;

const stored = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
};

let lang = $state<Lang>(stored("recension.lang", "zh"));
let theme = $state<"paper" | "ink">(stored("recension.theme", "paper"));
let type = $state<TypeSettings>({ ...DEFAULTS, ...stored("recension.type", DEFAULTS) });

const t = $derived(translator(lang));

let root = $state<string | null>(null);
let chapters = $state<ChapterView[]>([]);
let active = $state<string | null>(null);
let text = $state("");
let saved = $state(true);
let selection = $state("");

let sheet = $state<SheetName>(null);
let paletteOpen = $state(false);
let zen = $state(false);
let dragging = $state(false);

let proposals = $state<ProposalView[]>([]);
let comments = $state<{ target: string; text: string }[]>([]);
let runs = $state<RunView[]>([]);
let refusal = $state<{ reason: string; detail: string[] } | null>(null);
let notice = $state<string | null>(null);

$effect(() => {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("recension.theme", JSON.stringify(theme));
});
$effect(() => localStorage.setItem("recension.lang", JSON.stringify(lang)));
$effect(() => {
  localStorage.setItem("recension.type", JSON.stringify(type));
  const style = document.documentElement.style;
  const family =
    type.family === "custom" && type.customFamily.trim()
      ? type.customFamily
      : `var(--${type.family})`;

  style.setProperty("--manuscript-family", family);
  style.setProperty("--manuscript-size", `${type.size}px`);
  style.setProperty("--manuscript-weight", String(type.weight));
  style.setProperty("--manuscript-leading", String(type.leading));
  style.setProperty("--manuscript-tracking", `${type.tracking}em`);
  style.setProperty("--manuscript-word-spacing", `${type.wordSpacing}em`);
  style.setProperty("--manuscript-measure", `${type.measure}em`);
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
  setTimeout(() => (notice = null), 2600);
};

const openProject = async (path?: string): Promise<void> => {
  const chosen = path ?? (await api().openProject());
  if (!chosen) return;
  root = chosen;
  chapters = await api().loadProject(chosen);
  select(chapters[0]?.title ?? null);
};

const createProject = async (): Promise<void> => {
  const chosen = await api().createProject();
  if (!chosen) return;
  await openProject(chosen);
};

let surface = $state<HTMLElement | null>(null);

/** Paragraphs in, paragraphs out: the manuscript is blocks, not a string. */
const render = (source: string): void => {
  if (!surface) return;
  surface.replaceChildren(
    ...source.split(/\n\s*\n/).map((block) => {
      const p = document.createElement("p");
      p.textContent = block.trim();
      return p;
    }),
  );
};

const readSurface = (): string =>
  [...(surface?.children ?? [])]
    .map((node) => node.textContent?.trim() ?? "")
    .filter((block) => block.length > 0)
    .join("\n\n");

const onEdit = (): void => {
  text = readSurface();
  saved = false;
};

const select = (title: string | null): void => {
  active = title;
  text = chapters.find((c) => c.title === title)?.text ?? "";
  saved = true;
  queueMicrotask(() => render(text));
};

const newChapter = async (): Promise<void> => {
  if (!root) return;
  const name = prompt(t("chapter.new"));
  if (!name?.trim()) return;
  await api().saveChapter(root, name.trim(), "");
  chapters = await api().loadProject(root);
  select(name.trim());
};

const save = async (): Promise<void> => {
  if (!root || !active) return;
  await api().saveChapter(root, active, text);
  chapters = chapters.map((c) => (c.title === active ? { ...c, text } : c));
  saved = true;
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

const commands = $derived<Command[]>([
  {
    id: "open",
    label: "cmd.open",
    group: "group.project",
    keys: "Ctrl O",
    run: () => void openProject(),
  },
  { id: "create", label: "cmd.create", group: "group.project", run: () => void createProject() },
  {
    id: "chapter",
    label: "cmd.newChapter",
    group: "group.project",
    run: () => void newChapter(),
    when: () => root !== null,
  },
  {
    id: "save",
    label: "cmd.save",
    group: "group.write",
    keys: "Ctrl S",
    run: () => void save(),
    when: () => active !== null,
  },
  {
    id: "zen",
    label: "cmd.zen",
    group: "group.view",
    keys: "Ctrl Enter",
    run: () => void setZen(!zen),
    when: () => active !== null,
  },
  {
    id: "dispatch",
    label: "cmd.dispatch",
    group: "group.collab",
    keys: "Ctrl D",
    run: () => (sheet = "dispatch"),
    when: () => root !== null,
  },
  {
    id: "review",
    label: "cmd.review",
    group: "group.collab",
    run: () => (sheet = "review"),
    when: () => root !== null,
  },
  {
    id: "ledger",
    label: "cmd.ledger",
    group: "group.collab",
    run: () => (sheet = "ledger"),
    when: () => root !== null,
  },
  {
    id: "agents",
    label: "cmd.agents",
    group: "group.collab",
    run: () => (sheet = "agents"),
    when: () => root !== null,
  },
  {
    id: "typography",
    label: "cmd.typography",
    group: "group.view",
    run: () => (sheet = "typography"),
  },
  {
    id: "theme",
    label: "cmd.theme",
    group: "group.view",
    run: () => (theme = theme === "paper" ? "ink" : "paper"),
  },
  {
    id: "settings",
    label: "cmd.settings",
    group: "group.view",
    keys: "Ctrl ,",
    run: () => (sheet = "settings"),
  },
]);

const onKeydown = (event: KeyboardEvent): void => {
  const meta = event.ctrlKey || event.metaKey;

  if (meta && event.key.toLowerCase() === "k") {
    event.preventDefault();
    paletteOpen = !paletteOpen;
  } else if (meta && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void save();
  } else if (meta && event.key.toLowerCase() === "o") {
    event.preventDefault();
    void openProject();
  } else if (meta && event.key.toLowerCase() === "d" && root) {
    event.preventDefault();
    sheet = "dispatch";
  } else if (meta && event.key === ",") {
    event.preventDefault();
    sheet = "settings";
  } else if (meta && event.key === "Enter" && active) {
    event.preventDefault();
    void setZen(!zen);
  } else if (event.key === "Escape" && zen) {
    void setZen(false);
  }
};

// Dropping a folder opens it; dropping files opens their folder.
const onDrop = async (event: DragEvent): Promise<void> => {
  event.preventDefault();
  dragging = false;
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  const path = await api().resolveDrop(api().pathFor(file));
  if (path) await openProject(path);
};

const captureSelection = (): void => {
  selection = window.getSelection()?.toString() ?? "";
};
</script>

<svelte:window
  on:keydown={onKeydown}
  on:dragover|preventDefault={() => (dragging = true)}
  on:dragleave={() => (dragging = false)}
  on:drop|preventDefault={onDrop}
/>

{#if root === null}
  <main class="welcome" class:dragging>
    <div class="mark" aria-hidden="true"></div>
    <h1>Recension</h1>
    <p class="tagline">{t("app.tagline")}</p>

    <div class="actions">
      <button class="primary" onclick={() => void openProject()}>{t("welcome.open")}</button>
      <button onclick={() => void createProject()}>{t("welcome.create")}</button>
    </div>

    <p class="drop">{t("welcome.drop")}</p>
    <p class="fine">{t("welcome.fine")}</p>
    <p class="fine key">{t("welcome.hint")}</p>
  </main>
{:else}
  <div class="shell" class:zen class:dragging>
    {#if !zen}
      <nav class="rail">
        <button class="brand" onclick={() => (paletteOpen = true)} title={t("palette.hint")}>
          <span class="mark small" aria-hidden="true"></span>
        </button>

        <div class="chapters">
          {#each chapters as chapter (chapter.title)}
            <button class="chapter" class:on={chapter.title === active} onclick={() => select(chapter.title)}>
              {chapter.title}
            </button>
          {/each}
          {#if chapters.length === 0}
            <p class="hint">{t("chapter.empty")}</p>
          {/if}
        </div>

        <button class="add" onclick={() => void newChapter()}>
          <span aria-hidden="true">＋</span> {t("cmd.newChapter").replace("…", "")}
        </button>
      </nav>
    {/if}

    <main class="writing">
      {#if !zen}
        <header class="bar">
          <span class="title">{active ?? t("chapter.none")}</span>
          <div class="right">
            {#if proposals.length > 0}
              <button class="pending" onclick={() => (sheet = "review")}>
                {proposals.length}
              </button>
            {/if}
            <span class="state" class:dirty={!saved}>
              {saved ? t("chapter.saved") : t("chapter.unsaved")}
            </span>
          </div>
        </header>
      {/if}

      <div class="scroll" class:zen>
        <!--
          `contenteditable="true"` with paragraph elements rather than
          plaintext-only: the ruled lines are painted per paragraph, which is
          the only way they stay in step when paragraph spacing is not a whole
          number of line boxes. The IME path is unchanged — ProseMirror is not
          involved, and no framework code sits between the key and the glyph.
        -->
        <div
          class="manuscript"
          data-grid={type.grid ? "on" : "off"}
          role="textbox"
          tabindex="0"
          aria-multiline="true"
          aria-label="manuscript"
          contenteditable="true"
          spellcheck="false"
          bind:this={surface}
          oninput={onEdit}
          onmouseup={captureSelection}
          onkeyup={captureSelection}
        ></div>
      </div>

      {#if zen}
        <p class="zen-hint">{t("zen.exit")}</p>
      {/if}
    </main>
  </div>
{/if}

<Palette open={paletteOpen} {commands} {t} onClose={() => (paletteOpen = false)} />

<Sheet open={sheet === "dispatch"} title={t("dispatch.title")} onClose={() => (sheet = null)}>
  <Dispatch {root} chapter={active} {selection} {runs} {t} onDispatched={async () => { if (root) runs = await api().runs(root); }} onCollect={collect} />
</Sheet>

<Sheet open={sheet === "review"} title={t("review.title")} width="520px" onClose={() => (sheet = null)}>
  <Review {proposals} {comments} {t} {refusal} onCommit={commit} />
</Sheet>

<Sheet open={sheet === "ledger"} title={t("ledger.title")} width="480px" onClose={() => (sheet = null)}>
  <Ledger {root} {t} />
</Sheet>

<Sheet open={sheet === "agents"} title={t("agents.title")} onClose={() => (sheet = null)}>
  <Agents {root} {t} />
</Sheet>

<Sheet open={sheet === "typography"} title={t("typo.title")} onClose={() => (sheet = null)}>
  <Typography settings={type} {t} onChange={(next) => (type = next)} />
</Sheet>

<Sheet open={sheet === "settings"} title={t("set.title")} onClose={() => (sheet = null)}>
  <Settings {lang} {theme} {t} onLang={(next) => (lang = next)} onTheme={(next) => (theme = next)} />
</Sheet>

{#if notice}
  <div class="notice">{notice}</div>
{/if}

<style>
  /*
   * The mark: a seal impression. The device is the proofreader's caret — the
   * mark a human writes in a margin to say "something belongs here". Drawn
   * rather than imported, and with the border inside the impression, because a
   * real seal has no white ring around it.
   */
  .mark {
    width: 52px;
    height: 52px;
    background: var(--seal);
    position: relative;
    box-shadow: inset 0 0 0 5px var(--seal-wash);
  }

  .mark::before,
  .mark::after {
    content: "";
    position: absolute;
    background: var(--seal-wash);
  }

  /* The caret's two strokes, meeting at the baseline. */
  .mark::before {
    left: 34%;
    top: 30%;
    width: 3px;
    height: 40%;
    transform: rotate(-26deg);
    transform-origin: bottom center;
  }

  .mark::after {
    left: 55%;
    top: 30%;
    width: 3px;
    height: 40%;
    transform: rotate(26deg);
    transform-origin: bottom center;
  }

  .mark.small {
    width: 22px;
    height: 22px;
    box-shadow: inset 0 0 0 2px var(--seal-wash);
  }

  .mark.small::before,
  .mark.small::after {
    width: 1.5px;
  }

  .welcome {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    gap: 0;
    text-align: center;
    padding: 2rem;
    /* Optically centred: the block is top-heavy, so geometric centring sinks it. */
    padding-bottom: 9vh;
    transition: background 160ms var(--ease);
  }

  .welcome.dragging,
  .shell.dragging {
    background: var(--seal-wash);
  }

  /* Mark and wordmark are one lockup; the tagline is a separate thought. */
  h1 {
    font-family: var(--display);
    font-size: var(--step-4);
    font-weight: 400;
    letter-spacing: 0.04em;
    margin-top: 1.5rem;
  }

  .tagline {
    font-family: var(--serif);
    color: var(--ink-soft);
    max-width: 26em;
    line-height: 1.95;
    margin-top: 1.6rem;
  }

  .actions {
    display: flex;
    gap: 0.6rem;
    margin-top: 2.4rem;
  }

  .actions button {
    padding: 0.6rem 1.5rem;
    border: 1px solid var(--rule-strong);
    border-radius: 2px;
    font-size: var(--step--1);
    color: var(--ink-soft);
    background: var(--paper-raised);
  }

  .actions button:hover {
    border-color: var(--seal);
    color: var(--seal);
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

  /*
   * A functional affordance outranks the background note beneath it. The
   * previous build had these reversed, so the one sentence describing a real
   * capability was the faintest thing on the screen.
   */
  .drop {
    font-size: var(--step--1);
    color: var(--ink-faint);
    margin-top: 0.5rem;
  }

  .welcome.dragging .drop {
    color: var(--seal);
  }

  .fine {
    font-size: var(--step--2);
    color: var(--ink-ghost);
    max-width: 25em;
    margin-top: 3rem;
    line-height: 1.9;
  }

  /* The one keystroke that reaches everything else. Stated once, on first run. */
  .fine.key {
    margin-top: 0.6rem;
    color: var(--ink-faint);
    letter-spacing: 0.03em;
  }

  .shell {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    height: 100vh;
    transition: grid-template-columns 260ms var(--ease), background 160ms var(--ease);
  }

  .shell.zen {
    grid-template-columns: minmax(0, 1fr);
  }

  .rail {
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--rule);
    background: var(--paper);
    padding: 1.1rem 0.55rem 0.7rem;
    overflow: hidden;
  }

  .brand {
    display: flex;
    align-items: center;
    padding: 0.2rem 0.5rem 1.1rem;
  }

  .chapters {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .chapter {
    text-align: left;
    padding: 0.42rem 0.6rem;
    border-radius: 2px;
    font-size: var(--step--1);
    color: var(--ink-soft);
    border-left: 2px solid transparent;
  }

  .chapter:hover {
    background: var(--paper-sunk);
  }

  /*
   * Pure white was the only cold surface in a warm palette and read as a hole
   * punched in the paper. The rule and the ink weight carry the state instead.
   */
  .chapter.on {
    color: var(--ink);
    border-left-color: var(--seal);
    font-weight: 500;
  }

  .hint {
    padding: 0.8rem 0.6rem;
    font-size: var(--step--2);
    color: var(--ink-ghost);
    line-height: 1.7;
  }

  /* Creating a chapter is a primary act; it gets a label, not a bare glyph. */
  .add {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    color: var(--ink-faint);
    font-size: var(--step--1);
    padding: 0.5rem 0.6rem;
    margin-top: 0.4rem;
    border-top: 1px solid var(--rule);
    text-align: left;
  }

  .add:hover {
    color: var(--seal);
  }

  .writing {
    display: flex;
    flex-direction: column;
    min-width: 0;
    position: relative;
  }

  /*
   * The bar's contents align to the manuscript measure, not to the pane edge:
   * a title floating at the far left has no relationship to the text it names.
   */
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: min(var(--manuscript-measure), 100% - 4rem);
    margin: 0 auto;
    padding: 0.85rem 0;
    border-bottom: 1px solid var(--rule);
  }

  .title {
    font-family: var(--serif);
    font-size: var(--step-0);
    color: var(--ink-soft);
  }

  .right {
    display: flex;
    align-items: center;
    gap: 0.8rem;
  }

  .pending {
    font-size: var(--step--2);
    font-weight: 600;
    color: var(--paper-raised);
    background: var(--seal);
    border-radius: 9px;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
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
    padding: var(--margin-top, 3rem) 2rem var(--margin-bottom, 50vh);
  }

  /*
   * Zen: the manuscript and its rest occupy the screen. Nothing else is drawn,
   * because the point of the mode is that nothing else is there.
   *
   * The deep bottom padding is the typewriter effect: the line being written
   * stays near the middle of the screen instead of sinking to the bottom edge,
   * which is the difference between a fullscreen textarea and a writing mode.
   */
  .scroll.zen {
    padding-top: 15vh;
  }

  .zen-hint {
    position: absolute;
    bottom: 1.4rem;
    left: 50%;
    transform: translateX(-50%);
    font-size: var(--step--2);
    color: var(--ink-ghost);
    opacity: 0;
    transition: opacity 200ms var(--ease);
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
    border-radius: 2px;
    font-size: var(--step--1);
    max-width: 70vw;
    box-shadow: var(--shadow-float);
    animation: rise 180ms var(--ease);
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translate(-50%, 8px);
    }
  }
</style>
