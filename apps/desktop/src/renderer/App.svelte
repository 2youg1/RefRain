<script lang="ts">
import Agents from "./Agents.svelte";
import type { ChapterView, EditView, ProposalView, RunView, VerdictView } from "./api.ts";
import { api } from "./api.ts";
import ContextMenu from "./ContextMenu.svelte";
import Dispatch from "./Dispatch.svelte";
import { applyProfile, type DisplayProfile, FALLBACK, trackDisplay } from "./display.ts";
import Edits from "./Edits.svelte";
import Files, { type FileEntry, type SortOrder } from "./Files.svelte";
import { type Key, type Lang, translator } from "./i18n.ts";
import { chordOf, commandFor } from "./keys.ts";
import Ledger from "./Ledger.svelte";
import Mark from "./Mark.svelte";
import Palette, { type Command } from "./Palette.svelte";
import Progress from "./Progress.svelte";
import {
  applyAppearance,
  applyTypography,
  type Layout,
  loadPreferences,
  persist,
  persistBindings,
  type SheetStyle,
  type Surface,
  type Theme,
} from "./preferences.ts";
import Rail from "./Rail.svelte";
import Review from "./Review.svelte";
import Settings, { type Section } from "./Settings.svelte";
import Sheet from "./Sheet.svelte";
import Shortcuts from "./Shortcuts.svelte";
import Typography from "./Typography.svelte";
import { DEFAULTS, measureFontLine, type TypeSettings } from "./typography.ts";
import Welcome from "./Welcome.svelte";

type SheetName = "dispatch" | "review" | "ledger" | "edits" | "settings" | "files" | null;

// Durable choices live in preferences.ts: they answer a different question
// from anything on screen, and keeping them together puts every storage key
// in one file.
const saved0 = loadPreferences();

let lang = $state<Lang>(saved0.lang);
let theme = $state<Theme>(saved0.theme);
let surface = $state<Surface>(saved0.surface);
let sheetStyle = $state<SheetStyle>(saved0.sheet);
let layout = $state<Layout>(saved0.layout);
let icon = $state<string | null>(saved0.icon);
let type = $state<TypeSettings>(saved0.type);
let bindings = $state<Record<string, string>>(saved0.bindings);

const t = $derived(translator(lang));

/** Several roots, so an empty folder for tidiness does not lock out the manuscripts. */
let roots = $state<string[]>(saved0.roots);
let chapters = $state<ChapterView[]>([]);
/** The active chapter's absolute path; titles are not unique across workspace roots. */
let active = $state<string | null>(null);
let text = $state("");
let saved = $state(true);
/** From package.json at build time; a hand-typed version goes stale. */
const version = __APP_VERSION__;

let selection = $state("");
/** The whole blocks the selection touches; see `selectedBlocks`. */
let scope = $state<{ ids: string[]; text: string }>({ ids: [], text: "" });
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
/** The project that owns the visible Run list; chapter titles cannot identify it. */
let runOwner = $state<string | null>(null);
let refusal = $state<{ reason: string; detail: string[] } | null>(null);
let notice = $state<string | null>(null);
let surfaceEl = $state<HTMLElement | null>(null);
let conflictEl = $state<HTMLElement | null>(null);
let scrollEl = $state<HTMLElement | null>(null);

/*
 * The file browser. The index lives in the native layer; this holds only the
 * page currently on screen, which is what keeps a workspace of any size from
 * crossing the bridge on every keystroke.
 */
let fileEntries = $state<FileEntry[]>([]);
let fileTotal = $state(0);
let fileUnavailable = $state<string | null>(null);
let fileQuery = $state("");
let fileOrder = $state<SortOrder>("name");
let fileDescending = $state(false);
/**
 * How many rows the viewport last asked for. The list measures itself and
 * reports it, so a refresh after a sort or a trash fetches what is on screen
 * rather than a fixed page that is either short on a tall monitor or wasteful
 * on a short one.
 */
let visibleRows = $state(40);

/*
 * The panel this window sits on. Motion durations are expressed in frames of
 * this profile, so a gesture reads the same on a 60 Hz laptop and a 165 Hz
 * desktop instead of being quantised to whichever the developer owned.
 */
let display = $state<DisplayProfile>(FALLBACK);

const root = $derived(roots[0] ?? null);
const activeChapter = $derived(chapters.find((chapter) => chapter.path === active) ?? null);

// Every durable choice is written back the moment it changes; the storage
// keys and the CSS custom properties both live in preferences.ts.
$effect(() => {
  applyAppearance(theme, surface, sheetStyle);
  persist("theme", theme);
  persist("surface", surface);
  persist("sheet", sheetStyle);
});
$effect(() => persist("lang", lang));
$effect(() => persist("layout", layout));
$effect(() => persist("icon", icon));
$effect(() => persist("roots", roots));
$effect(() => persistBindings(bindings));

$effect(() => {
  persist("type", type);
  applyTypography(type, measureFontLine(`"${type.latinFamily}", "${type.cjkFamily}", serif`, type.size));
});

/*
 * Track the panel and write its variables onto :root. The unsubscribe matters:
 * without it, moving the window between monitors accumulates listeners on one
 * channel and the leak is invisible until it is large.
 */
$effect(() =>
  trackDisplay(window.refrain ?? {}, (profile) => {
    display = profile;
    applyProfile(profile, document.documentElement);
  }),
);

/*
 * Opening collaboration restores the project's visible Run history. A reload
 * used to recover the Host on disk but leave the panel empty until another send.
 */
$effect(() => {
  const owner = sheet === "dispatch" ? (activeChapter?.root ?? root) : null;
  if (!owner) return;
  let current = true;
  runOwner = owner;
  void api()
    .runs(owner)
    .then((next) => {
      if (current && runOwner === owner) runs = next;
    })
    .catch(() => undefined);
  return () => {
    current = false;
  };
});

/*
 * Only in-flight Runs poll. Terminal state stops the effect, so ordinary editing
 * and an idle panel do no background work. The owner is captured to keep two
 * workspace roots from replacing each other's status list.
 */
$effect(() => {
  const owner = runOwner;
  if (!owner || !runs.some((run) => run.state === "dispatched")) return;
  const timer = setTimeout(() => {
    void api()
      .runs(owner)
      .then((next) => {
        if (runOwner === owner) runs = next;
      })
      .catch(() => undefined);
  }, 400);
  return () => clearTimeout(timer);
});

/**
 * Open the browser, scanning on first use.
 *
 * The walk is deferred to the moment the pane is opened rather than run at
 * project load: a writer who never opens the browser should never pay for it.
 */
const openFiles = async () => {
  sheet = "files";
  if (!root || fileUnavailable || fileTotal > 0) return;

  const scanned = await api().files.scan(root);
  if (!scanned.ok) {
    fileUnavailable = t("files.unavailable");
    return;
  }
  await api().files.sort(root, fileOrder, fileDescending);
  // The viewport asks for its own rows once it has measured itself; seeding a
  // fixed page here would put rows in the DOM that no one can see.
  fileTotal = scanned.count;
};

/** Ask the native layer for the rows the viewport can actually show. */
const needFilePage = async (offset: number, limit: number) => {
  visibleRows = limit;
  if (!root || fileUnavailable) return;
  const result = await api().files.page(root, offset, limit);
  if (!result.ok) {
    fileUnavailable = t("files.unavailable");
    return;
  }
  fileEntries = result.entries;
  fileTotal = result.total;
};

const searchFiles = async (query: string) => {
  fileQuery = query;
  if (!root) return;

  // An empty query returns to the ordered index rather than ranking nothing:
  // clearing the box should show the folder, not an empty list.
  if (query.trim() === "") {
    const scanned = await api().files.scan(root);
    if (!scanned.ok) {
      fileUnavailable = t("files.unavailable");
      return;
    }
    await api().files.sort(root, fileOrder, fileDescending);
    fileTotal = scanned.count;
    await needFilePage(0, visibleRows);
    return;
  }

  const result = await api().files.search(root, query, 200);
  if (!result.ok) {
    fileUnavailable = t("files.unavailable");
    return;
  }
  fileEntries = result.hits.map((hit) => hit.entry);
  fileTotal = result.hits.length;
};

const sortFiles = async (order: SortOrder) => {
  // Clicking the active column reverses it; clicking another switches to it
  // ascending, which is what every file manager does and what a hand expects.
  fileDescending = order === fileOrder ? !fileDescending : false;
  fileOrder = order;
  if (!root) return;
  await api().files.sort(root, order, fileDescending);
  await needFilePage(0, visibleRows);
};

const trashFiles = async (paths: string[]) => {
  if (!root) return;
  const result = await api().files.trash(root, paths);
  if (!result.ok) {
    notice = result.detail;
    return;
  }

  // Report per path: one locked file must not read as a failure of the batch,
  // and a writer needs to know exactly which chapter is still there.
  const failed = result.outcomes.filter((outcome) => !outcome.trashed);

  // SPEC Q8. A volume whose root is not writable cannot hold a trash, and the
  // refusal is correct — but it used to be a dead end. The file can still go
  // to the trash on the volume holding the author's home, so the offer is
  // made and the author decides. Nothing is moved without them choosing it.
  const noTrash = failed.filter((outcome) => outcome.code === "NO_TRASH_HERE");
  if (noTrash.length > 0) {
    trashOffer = noTrash.map((outcome) => outcome.path);
  } else if (failed.length > 0) {
    // The separator follows the interface language: a Chinese enumeration
    // comma in an English build is the software speaking the wrong language.
    notice = t("files.trashFailed") + failed.map((outcome) => outcome.path).join(t("list.join"));
  }
  await needFilePage(0, visibleRows);
  chapters = await api().loadWorkspace(roots);
};

/** Paths the author may send to the trash on another volume (SPEC Q8). */
let trashOffer = $state<string[]>([]);

const trashViaHome = async (): Promise<void> => {
  if (!root) return;
  const paths = trashOffer;
  trashOffer = [];
  const stayed: string[] = [];
  for (const path of paths) {
    const outcome = await api().files.trashViaHome(root, path);
    if (!outcome.ok) stayed.push(path);
  }
  if (stayed.length > 0) say(t("files.noTrashAnywhere") + stayed.join(t("list.join")));
  await needFilePage(0, visibleRows);
  chapters = await api().loadWorkspace(roots);
};

/** The timer for the visible notice; a second message must cancel the first. */
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

const say = (message: string): void => {
  // Without clearing, two notices in quick succession shared one deadline and
  // the first one's timer wiped the second off the screen early.
  clearTimeout(noticeTimer);
  notice = message;
  noticeTimer = setTimeout(() => (notice = null), 2800);
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
  if (!chapters.some((chapter) => chapter.path === active)) select(chapters[0]?.path ?? null);
};

const createProject = async (): Promise<void> => {
  const chosen = await api().createProject();
  if (chosen) await addRoot(chosen);
};

const select = (path: string | null): void => {
  // Unsaved text used to disappear here: `render()` overwrote the surface with
  // the newly selected chapter and the old paragraphs were simply gone. The
  // manuscript is the one thing this application may never lose, so the switch
  // saves first rather than asking.
  if (!saved && active !== null && active !== path) {
    void save().then(() => selectNow(path));
    return;
  }
  selectNow(path);
};

const selectNow = (path: string | null): void => {
  active = path;
  text = chapters.find((chapter) => chapter.path === path)?.text ?? "";
  saved = true;
  edits = [];
  queueMicrotask(() => render(text));
};
const newChapter = async (): Promise<void> => {
  const owner = activeChapter?.root ?? roots[0];
  if (!owner) return;
  const name = prompt(t("chapter.new"));
  if (!name?.trim()) return;
  const title = name.trim();
  await api().saveChapter(owner, `${title}.md`, "");
  await reload();
  select(
    chapters.find((chapter) => chapter.root === owner && chapter.title === title)?.path ?? null,
  );
};

const save = async (): Promise<void> => {
  const chapter = activeChapter;
  if (!chapter) return;

  // Snapshot before awaiting. Typing during the write used to leave `saved`
  // true over text that had never reached disk, and recorded an edit against
  // characters that were never saved.
  const written = text;
  try {
    const outcome = await api().saveChapter(chapter.root, chapter.id, written);

    // The file moved on: someone else wrote to it since this session read it.
    // Nothing is decided here — the author is shown both and chooses. Silently
    // winning would destroy an edit they made somewhere else.
    if (!outcome.ok) {
      conflict = {
        id: chapter.id,
        title: chapter.title,
        root: chapter.root,
        mine: written,
        theirs: outcome.onDisk,
        path: outcome.path,
      };
      return;
    }

    const recorded = await api().editsBetween(chapter.text, written);
    edits = [...edits, ...recorded];
    chapters = chapters.map((entry) =>
      entry.path === chapter.path ? { ...entry, text: written } : entry,
    );
    if (text === written && active === chapter.path) saved = true;
  } catch (error) {
    saved = false;
    say(error instanceof Error ? error.message : String(error));
  }
};

/** An unresolved disagreement between this session and the disk (#49). */
let conflict = $state<{
  id: string;
  title: string;
  root: string;
  mine: string;
  theirs: string;
  path: string;
} | null>(null);

$effect(() => {
  const dialog = conflictEl;
  if (!conflict || !dialog) return;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  queueMicrotask(() => dialog.querySelector<HTMLElement>("button")?.focus());
  return () => {
    queueMicrotask(() => {
      if (previous?.isConnected) previous.focus();
      else surfaceEl?.focus();
    });
  };
});

const trapConflictFocus = (event: KeyboardEvent): void => {
  if (event.key !== "Tab" || !conflictEl) return;
  const controls = [...conflictEl.querySelectorAll<HTMLElement>("button:not([disabled])")];
  const first = controls[0];
  const last = controls.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
};

/** Resolve exactly the two versions currently visible in the conflict dialog. */
const resolveConflict = async (choice: "mine" | "disk"): Promise<void> => {
  const pending = conflict;
  if (!pending) return;
  if (active === pending.path && text !== pending.mine) {
    conflict = null;
    await save();
    if (conflict) say(t("conflict.stillChanging"));
    return;
  }
  const outcome = await api().resolveConflict(pending.root, pending.id, choice);

  if (!outcome.ok) {
    saved = false;
    if (outcome.onDisk !== undefined && outcome.path !== undefined) {
      conflict = { ...pending, theirs: outcome.onDisk, path: outcome.path };
      say(t("conflict.stillChanging"));
    } else {
      conflict = null;
      say(outcome.reason);
    }
    return;
  }

  conflict = null;
  chapters = chapters.map((chapter) =>
    chapter.path === pending.path ? { ...chapter, text: outcome.text } : chapter,
  );
  if (active === pending.path) {
    text = outcome.text;
    render(outcome.text);
    saved = true;
  }
};

const takeTheirs = async (): Promise<void> => resolveConflict("disk");
const keepMine = async (): Promise<void> => resolveConflict("mine");

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
  const owner = runOwner ?? activeChapter?.root ?? root;
  if (!owner) return;
  try {
    const result = await api().collect(owner, runId);
    proposals = [...proposals, ...result.proposals];
    comments = [...comments, ...result.comments];
    sheet = "review";
  } catch (error) {
    say(String(error));
  }
  runs = await api().runs(owner);
};

const commit = async (verdicts: VerdictView[]): Promise<void> => {
  // The main process merges against its own head. With unsaved text in the
  // editor that head is stale, and `result.text` would overwrite characters
  // the author had just typed.
  if (!saved) {
    await save();
    if (!saved) return;
  }
  const chapter = activeChapter;
  if (!chapter) return;
  refusal = null;
  const result = await api().commit(chapter.root, { chapter: chapter.id, verdicts });
  if (!result.ok) {
    refusal = { reason: result.reason, detail: result.detail };
    return;
  }
  text = result.text;
  render(result.text);
  chapters = chapters.map((entry) =>
    entry.path === chapter.path ? { ...entry, text: result.text } : entry,
  );
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
  { id: "files", label: "cmd.files", group: "group.project", run: () => void openFiles(), when: () => root !== null },
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

/**
 * The paragraphs a selection touches, as whole blocks.
 *
 * Two failures made every merge from the interface impossible, and both are
 * fixed by answering this one question properly.
 *
 * The Edit Scope used to carry a fabricated block id — `${chapter}:sel` —
 * while core's real ids are `${chapter}:b${index}` (project.ts). A Decision
 * Batch looks its scope up by id, never found it, and refused with
 * stale-baseline every single time.
 *
 * And the Proposal's `before` used to be the literal characters the author
 * had highlighted, while the batch compares against the *whole block*. Half a
 * sentence could never match. So a selection snaps outward to the paragraphs
 * it intersects: the author still marks a phrase, and the scope is the block
 * that contains it.
 *
 * The index in `surfaceEl.children` is the block index, because `render` lays
 * out one element per block and `readSurface` reads them back in the same
 * order.
 */
const selectedBlocks = (): { ids: string[]; text: string } => {
  const selected = window.getSelection();
  if (!selected || selected.rangeCount === 0 || !surfaceEl || !activeChapter)
    return { ids: [], text: "" };

  const range = selected.getRangeAt(0);
  const touched = [...surfaceEl.children].filter((node) => range.intersectsNode(node));
  const blocks = touched.length > 0 ? touched : [];

  return {
    ids: blocks.map(
      (node) => `${activeChapter.id}:b${[...surfaceEl.children].indexOf(node)}`,
    ),
    text: blocks.map((node) => node.textContent?.trim() ?? "").join("\n\n"),
  };
};

const captureSelection = (): void => {
  const selected = window.getSelection()?.toString() ?? "";
  selection = selected;
  // Kept beside the visible selection so Dispatch sends what the batch will
  // actually compare against, rather than what the author's mouse covered.
  scope = selected.trim().length > 0 ? selectedBlocks() : { ids: [], text: "" };
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
  <Welcome
    {t}
    {icon}
    {commands}
    {paletteOpen}
    {dragging}
    onOpenFolder={() => void addRoot()}
    onOpenFile={() => void openFile()}
    onCreate={() => void createProject()}
    onPaletteOpen={() => (paletteOpen = true)}
    onPaletteClose={() => (paletteOpen = false)}
  />
{:else}
  <div class="shell" class:zen class:dragging>
    {#if !zen}
      <Rail
        {t}
        {icon}
        {commands}
        {paletteOpen}
        {roots}
        {chapters}
        {active}
        onSelect={select}
        onAddRoot={() => void addRoot()}
        onRemoveRoot={(path) => void removeRoot(path)}
        onNewChapter={() => void newChapter()}
        onPaletteOpen={() => (paletteOpen = true)}
        onPaletteClose={() => (paletteOpen = false)}
      />
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
          <span class="title">{activeChapter?.title ?? t("chapter.none")}</span>
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
    root={activeChapter?.root ?? root}
    chapter={activeChapter?.id ?? null}
    {selection}
    {scope}
    {runs}
    {t}
    onDispatched={async () => {
      const owner = activeChapter?.root ?? root;
      if (owner) {
        runOwner = owner;
        runs = await api().runs(owner);
      }
    }}
    onCollect={collect}
  />
</Sheet>

<Sheet open={sheet === "review"} title={t("review.title")} width="540px" onClose={() => (sheet = null)}>
  <Review {proposals} {comments} {t} {refusal} onCommit={commit} />
</Sheet>

<Sheet open={sheet === "files"} title={t("files.title")} width="420px" onClose={() => (sheet = null)}>
  <Files
    {t}
    entries={fileEntries}
    total={fileTotal}
    unavailable={fileUnavailable}
    {active}
    order={fileOrder}
    descending={fileDescending}
    query={fileQuery}
    onSelect={(entry) => {
      // Only a manuscript opens in the editor; clicking a folder or an image
      // selects it for a move or a trash without changing what is on screen.
      // This called `open()`, which is not defined here — it resolved to
      // `window.open`, took the chapter title as a URL, and was denied by the
      // window-open handler. Clicking a file appeared to do nothing at all.
      const chapter = chapters.find((c) => c.path === entry.path);
      if (chapter) select(chapter.path);
    }}
    onQuery={searchFiles}
    onSort={sortFiles}
    onTrash={trashFiles}
    onNeedPage={needFilePage}
  />
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
    {version}
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
    onOpenUrl={(url) => void api().openProjectUrl(url)}
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

<!--
  An outside edit (#49). Modal by necessity, not by habit: two versions of the
  author's own writing exist and only they can say which one is the manuscript.
  Both texts are shown, because a choice between things you cannot see is not a
  choice. Nothing is written until a button is pressed.
-->
{#if conflict}
  <div class="conflict-scrim">
    <div
      class="conflict"
      role="alertdialog"
      tabindex="-1"
      aria-label={t("conflict.title")}
      bind:this={conflictEl}
      onkeydown={trapConflictFocus}
    >
      <h2>{t("conflict.title")}</h2>
      <p class="path">{conflict.path}</p>
      <p class="why">{t("conflict.body")}</p>
      <!--
        Each action sits under the version it keeps. They used to be reversed
        against the panes — left button taking the right pane — which on an
        irreversible choice is how a person loses work to muscle memory.
      -->
      <div class="versions">
        <section>
          <span class="label">{t("conflict.mineLabel")}</span>
          <pre>{conflict.mine}</pre>
          <span class="cost">{t("conflict.mineCost")}</span>
          <button class="choose" onclick={() => void keepMine()}>{t("conflict.mine")}</button>
        </section>
        <section>
          <span class="label">{t("conflict.theirsLabel")}</span>
          <pre>{conflict.theirs}</pre>
          <span class="cost">{t("conflict.theirsCost")}</span>
          <button class="choose" onclick={() => void takeTheirs()}>{t("conflict.theirs")}</button>
        </section>
      </div>
      <!--
        A way out that decides nothing. The file is not yet overwritten and the
        editor still holds the author's text, so leaving the question open is a
        legitimate answer — they may want to look at the file first.
      -->
      <div class="conflict-actions">
        <button
          class="quiet"
          onclick={() => {
            conflict = null;
            // Still unsaved, and the author has to know: the indicator would
            // otherwise sit on "saved" over text that never reached disk.
            saved = false;
            say(t("conflict.postponed"));
          }}>{t("conflict.later")}</button
        >
      </div>
    </div>
  </div>
{/if}

<!--
  SPEC Q8. Not a toast: it waits for an answer, because the file is still
  sitting where the author tried to delete it and they need to decide. The
  offer names the other volume rather than doing anything silently.
-->
{#if trashOffer.length > 0}
  <div class="offer" role="alertdialog" aria-label={t("files.noTrashHere")}>
    <p>{t("files.noTrashHere")}</p>
    <p class="paths">{trashOffer.join(t("list.join"))}</p>
    <div class="offer-actions">
      <button class="quiet" onclick={() => (trashOffer = [])}>{t("files.keepHere")}</button>
      <button class="go" onclick={() => void trashViaHome()}>{t("files.trashViaHome")}</button>
    </div>
  </div>
{/if}

<style>
.shell.dragging {
  background: var(--seal-wash);
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
/*
 * SPEC Q5. The header and the manuscript must hang from one line.
 *
 * They drifted 289px because three differences stacked: the header capped its
 * width at `100% - 6rem` while the sheet used `100% - 2rem`, one centred with
 * `align-self` and the other with `margin: auto`, and the header sits outside
 * `.scroll` so it never paid that element's 2rem padding. Matching only one of
 * the three — which earlier attempts did — leaves the other two.
 *
 * `--column-slot` is the single width both resolve against, and the header now
 * carries `.scroll`'s horizontal padding itself so both measure from the same
 * origin.
 */
.bar {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  box-sizing: border-box;
  flex: none;
  width: var(--column-slot);
  margin: 0 auto;
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

/*
 * The width both the header and the sheet resolve against. `.scroll` subtracts
 * its own 2rem of horizontal padding before the sheet sees the space, so the
 * header — which sits outside it — has to subtract the same amount to land on
 * the same left edge.
 */
.writing {
  --column-slot: min(var(--column-width), calc(100% - 6rem));
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
  width: var(--column-slot);
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

/*
 * An outside edit. The only modal in the application, because it is the only
 * moment where two versions of the manuscript exist and the software genuinely
 * cannot choose. The scrim is there to stop the author typing into a document
 * whose identity is unresolved.
 */
.conflict-scrim {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: grid;
  place-items: center;
  background: color-mix(in oklab, var(--ink) 34%, transparent);
  backdrop-filter: blur(2px);
}

.conflict {
  width: min(56rem, 92vw);
  max-height: 86vh;
  overflow: auto;
  padding: 1.4rem 1.5rem 1.2rem;
  background: var(--paper-raised);
  border: 1px solid var(--rule-strong);
  border-radius: 4px;
  box-shadow: var(--shadow-float);
}

.conflict h2 {
  font-family: var(--serif);
  font-size: var(--step-1);
  font-weight: 500;
}

.conflict .path {
  font-family: var(--mono);
  font-size: var(--step--2);
  color: var(--ink-faint);
  margin-top: 0.3rem;
  overflow-wrap: anywhere;
}

.conflict .why {
  font-size: var(--step--1);
  color: var(--ink-soft);
  line-height: 1.8;
  margin-top: 0.7rem;
}

.versions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
  margin-top: 1rem;
}

.versions pre {
  margin-top: 0.35rem;
  padding: 0.7rem 0.8rem;
  max-height: 40vh;
  overflow: auto;
  background: var(--sheet);
  border: 1px solid var(--rule);
  border-radius: 3px;
  font-family: var(--serif);
  font-size: var(--step--1);
  line-height: 1.85;
  /* The author's own prose: wrap it as prose, not as code. */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--ink);
}

/*
 * A filled button, not a coloured word. These two carry an irreversible choice,
 * and text-only actions read as links: no hit area a hand can aim at, and no
 * hover or focus to confirm which one is under the cursor.
 */
.versions .choose {
  display: block;
  width: 100%;
  margin-top: 0.5rem;
  padding: 0.5rem 0.8rem;
  background: var(--seal);
  color: var(--paper);
  border-radius: 3px;
  font-size: var(--step--1);
  font-weight: 600;
}

.versions .choose:hover {
  background: var(--seal-bright);
}

.versions .choose:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

/*
 * What it costs, above the button that costs it. Below, the reading order was
 * action-then-consequence — the eye reached the button first and the loss
 * afterwards. Held at --ink-soft rather than --ink-faint because this is the
 * sentence that stops an author destroying their own work.
 */
.versions .cost {
  display: block;
  margin-top: 0.6rem;
  font-size: var(--step--1);
  color: var(--ink-soft);
  line-height: 1.65;
}

.conflict-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 1.1rem;
}

.conflict-actions .quiet {
  font-size: var(--step--1);
  color: var(--ink-faint);
  text-decoration: underline;
  text-underline-offset: 0.24em;
  text-decoration-thickness: 1.5px;
  text-decoration-color: color-mix(in oklab, var(--ink-faint) 45%, transparent);
}

.conflict-actions .quiet:hover {
  color: var(--ink);
}

@media (max-width: 720px) {
  .versions {
    grid-template-columns: 1fr;
  }
}

/*
 * The Q8 offer. Wider and stiller than a notice, and it does not time out:
 * the author's file is still sitting undeleted and the software is asking a
 * question, not announcing something.
 */
.offer {
  position: fixed;
  bottom: 1.5rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 96;
  max-width: 34rem;
  padding: 0.9rem 1.1rem;
  background: var(--paper-raised);
  color: var(--ink);
  border: 1px solid var(--rule-strong);
  border-radius: 3px;
  box-shadow: var(--shadow-float);
  font-size: var(--step--1);
  line-height: 1.7;
}

.offer .paths {
  font-family: var(--mono);
  font-size: var(--step--2);
  color: var(--ink-faint);
  margin-top: 0.3rem;
  overflow-wrap: anywhere;
}

.offer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 1rem;
  margin-top: 0.8rem;
}

.offer-actions .quiet {
  color: var(--ink-faint);
}

.offer-actions .go {
  color: var(--seal);
  font-weight: 600;
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
