/**
 * Keyboard commands, and the author's overrides.
 *
 * The defaults follow what a writer already has in their fingers from Word,
 * VS Code, and Obsidian, because a writing tool that invents its own chords
 * makes the author pay for the software's originality.
 */

export interface Binding {
  readonly id: string;
  readonly keys: string;
}

export const DEFAULT_BINDINGS: Record<string, string> = {
  palette: "Ctrl+K",
  open: "Ctrl+O",
  newChapter: "Ctrl+N",
  save: "Ctrl+S",
  zen: "Ctrl+Enter",
  settings: "Ctrl+,",
  bold: "Ctrl+B",
  italic: "Ctrl+I",
  dispatch: "Ctrl+D",
  review: "Ctrl+R",
  edits: "Ctrl+H",
  ledger: "Ctrl+L",
  zoomIn: "Ctrl+=",
  zoomOut: "Ctrl+-",
  zoomReset: "Ctrl+0",
};

/*
 * Eight verdict chords used to live here — Alt+J, Alt+A, Alt+Enter and the
 * rest — with no handler in any component. They were worse than absent:
 * `commandFor` matches by iteration order, so a chord claimed by a dead
 * binding was shadowed for whatever the author had rebound it to, and then
 * nothing ran. They come back when Review has keyboard adjudication, together
 * with it, and not before.
 *
 * Five more went the same way, for the same reason — every one of them was
 * listed in Settings as a rebindable chord that did nothing when pressed:
 *
 *   Ctrl+Shift+S  saveAll   Switching chapters saves first and refuses to move
 *                           on failure, so no chapter but the active one can
 *                           hold unsaved text. Saving "all" of them is a
 *                           concept borrowed from editors that let a document
 *                           go stale in a background tab; here it is Ctrl+S.
 *   Ctrl+M        annotate  Comments arrive from a run and are read; there is
 *                           no way for an author to write one yet.
 *   Ctrl+F        find      No search over the manuscript exists.
 *   Ctrl+Z/Ctrl+Y undo/redo The manuscript is a contenteditable surface with
 *                           no history plugin. These claimed the chords the
 *                           browser's own undo answers to, and gave nothing
 *                           back in return.
 *
 * Each returns with the feature it names, not before it.
 */

/** Normalise an event into the same shape as a stored binding. */
export const chordOf = (event: KeyboardEvent): string => {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");

  const key =
    event.key.length === 1 ? event.key.toUpperCase() : event.key === "Escape" ? "Esc" : event.key;

  if (!["Control", "Shift", "Alt", "Meta"].includes(event.key)) parts.push(key);
  return parts.join("+");
};

export const loadBindings = (): Record<string, string> => {
  try {
    const raw = localStorage.getItem("refrain.keys");
    return raw === null
      ? { ...DEFAULT_BINDINGS }
      : { ...DEFAULT_BINDINGS, ...(JSON.parse(raw) as Record<string, string>) };
  } catch {
    return { ...DEFAULT_BINDINGS };
  }
};

export const saveBindings = (bindings: Record<string, string>): void => {
  localStorage.setItem("refrain.keys", JSON.stringify(bindings));
};

/** Which command a chord invokes, or nothing when the chord is unbound. */
export const commandFor = (bindings: Record<string, string>, chord: string): string | undefined =>
  Object.entries(bindings).find(([, keys]) => keys.toLowerCase() === chord.toLowerCase())?.[0];
