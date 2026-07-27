/**
 * Chords Windows has already spoken for, and what they mean there.
 *
 * Two different failures hide behind "pick a shortcut". Taking Ctrl+S for
 * anything but Save fights muscle memory the author brought with them; taking
 * a bare letter fights the manuscript, because in a Chinese text every letter
 * key is being typed constantly and an IME candidate window is often open on
 * top of it. So: reuse the standard chord where our command means the same
 * thing, and reach for Alt+ where it doesn't.
 *
 * Source: Microsoft's "Shortcut Keys: UI Text Guidelines", whose table is
 * explicit that these assignments are not to be reused for other tasks.
 */

export interface ReservedChord {
  readonly chord: string;
  /** What Windows does with it, in the author's language. */
  readonly meaning: string;
  /**
   * True when our command legitimately means the same thing. Reuse is correct
   * here — inventing a different chord for Save would be the actual mistake.
   */
  readonly reusableAs?: string;
}

export const RESERVED: readonly ReservedChord[] = [
  { chord: "Ctrl+A", meaning: "全选" },
  { chord: "Ctrl+C", meaning: "复制" },
  { chord: "Ctrl+V", meaning: "粘贴" },
  { chord: "Ctrl+X", meaning: "剪切" },
  { chord: "Ctrl+P", meaning: "打印" },
  { chord: "Ctrl+Z", meaning: "撤销", reusableAs: "undo" },
  { chord: "Ctrl+Y", meaning: "重做", reusableAs: "redo" },
  { chord: "Ctrl+S", meaning: "保存", reusableAs: "save" },
  { chord: "Ctrl+O", meaning: "打开", reusableAs: "open" },
  { chord: "Ctrl+N", meaning: "新建", reusableAs: "newChapter" },
  { chord: "Ctrl+F", meaning: "查找", reusableAs: "find" },
  { chord: "F1", meaning: "帮助" },
  { chord: "Shift+F10", meaning: "上下文菜单" },
  { chord: "Alt+Tab", meaning: "切换窗口" },
  { chord: "Alt+F4", meaning: "关闭窗口" },
  { chord: "Alt+Space", meaning: "窗口菜单" },
  { chord: "Esc", meaning: "取消" },
];

export type ChordProblem =
  | { readonly kind: "reserved"; readonly meaning: string }
  | { readonly kind: "duplicate"; readonly otherCommand: string }
  | { readonly kind: "bare-key" };

/**
 * A single unmodified key is rejected outright: it would fire mid-sentence,
 * and under an IME it would fire while the candidate window is deciding what
 * the author actually typed.
 */
const isBare = (chord: string): boolean => !chord.includes("+");

export const inspectChord = (
  chord: string,
  command: string,
  bindings: Readonly<Record<string, string>>,
): ChordProblem | undefined => {
  const reserved = RESERVED.find((r) => r.chord.toLowerCase() === chord.toLowerCase());
  if (reserved && reserved.reusableAs !== command)
    return { kind: "reserved", meaning: reserved.meaning };

  if (isBare(chord)) return { kind: "bare-key" };

  const clash = Object.entries(bindings).find(
    ([id, keys]) => id !== command && keys.toLowerCase() === chord.toLowerCase(),
  );
  return clash ? { kind: "duplicate", otherCommand: clash[0] } : undefined;
};
