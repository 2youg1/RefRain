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
  saveAll: "Ctrl+Shift+S",
  zen: "Ctrl+Enter",
  settings: "Ctrl+,",
  find: "Ctrl+F",
  bold: "Ctrl+B",
  italic: "Ctrl+I",
  annotate: "Ctrl+M",
  dispatch: "Ctrl+D",
  review: "Ctrl+R",
  edits: "Ctrl+H",
  ledger: "Ctrl+L",
  zoomIn: "Ctrl+=",
  zoomOut: "Ctrl+-",
  zoomReset: "Ctrl+0",
  undo: "Ctrl+Z",
  redo: "Ctrl+Y",
};

/*
 * Eight verdict chords used to live here — Alt+J, Alt+A, Alt+Enter and the
 * rest — with no handler in any component. They were worse than absent:
 * `commandFor` matches by iteration order, so a chord claimed by a dead
 * binding was shadowed for whatever the author had rebound it to, and then
 * nothing ran. They come back when Review has keyboard adjudication, together
 * with it, and not before.
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
