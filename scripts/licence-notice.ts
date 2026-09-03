// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

/**
 * The one authority for the MPL 2.0 notice this repository attaches to files.
 *
 * Three consumers read it and none of them restates it: the two generators
 * emit it into their output, and `verify:licence-headers` both checks and
 * writes it. A second copy of the wording would be a second answer to the
 * question "is this file covered", which is the only question the notice
 * exists to answer.
 *
 * Why the notice is not decoration: MPL 2.0 defines Covered Software as
 * Source Code Form "to which the initial Contributor has attached the notice
 * in Exhibit A" (Sec. 1.4). Attaching the notice is the act that places a
 * file under the licence. A file without it is not a licence violation — it
 * is a file whose licence status a recipient cannot determine.
 */

/**
 * Exhibit A of the Mozilla Public License 2.0, verbatim.
 *
 * Copy from https://www.mozilla.org/en-US/MPL/2.0/ and change nothing. A
 * paraphrase, a reflowed line, or the shorter `SPDX-License-Identifier:
 * MPL-2.0` form that the Mozilla FAQ also permits all leave Sec. 1.4 arguing
 * about whether "the notice in Exhibit A" was attached. The three lines cost
 * nothing and end the argument.
 */
export const NOTICE_LINES = [
  "This Source Code Form is subject to the terms of the Mozilla Public",
  "License, v. 2.0. If a copy of the MPL was not distributed with this",
  "file, You can obtain one at https://mozilla.org/MPL/2.0/.",
] as const;

/**
 * Who holds the rights the licence goes on to grant.
 *
 * Exhibit A closes with "You may add additional accurate notices of copyright
 * ownership", and this is that notice. Exhibit A alone names no owner, so
 * without this line a recipient learns the terms and not the party offering
 * them. It sits below the notice, not above it: Sec. 3.4 forbids altering the
 * substance of a licence notice, so the three Exhibit A rows are the part that
 * must stay verbatim and unsplit, and they lead. No blank comment row divides
 * them from this line — the four rows are one head.
 *
 * The year is first publication, not today: the first commit landed
 * 2026-08-16. Widen it to a range when a later year's work is substantial
 * enough to claim, and never let it track the calendar, which would rewrite
 * every file each January for nothing.
 *
 * "and the RefRain contributors" names people who do not exist yet on purpose.
 * Contributors hold copyright in what they write and grant it downstream
 * themselves under Sec. 2.1, so the clause transfers nothing; what it buys is
 * that the first outside contribution does not oblige anyone to rewrite every
 * header in the tree. Exhibit A allows "additional accurate notices", and a
 * standing class is accurate in a way an enumerated list is not — Mozilla
 * dropped the per-file contributor list in the 1.1 to 2.0 upgrade because it
 * was "neither a complete nor accurate list" and a source of merge conflicts.
 *
 * sprawling and kusanagi carry the same four rows with their own project name.
 * Anyone changing the shape here changes it in all three.
 */
export const COPYRIGHT_LINE = "Copyright (c) 2026 2youg1 and the RefRain contributors";

/** How a file family spells a comment. */
export type NoticeSyntax = "slash" | "hash" | "block" | "dash";

interface CommentShape {
  /** Opens the first line. */
  readonly first: string;
  /** Opens every later line. */
  readonly rest: string;
  /** Closes the last line. */
  readonly suffix: string;
}

/** A missing member fails to compile, so a new syntax cannot arrive unrendered. */
const SHAPES: Readonly<Record<NoticeSyntax, CommentShape>> = {
  slash: { first: "// ", rest: "// ", suffix: "" },
  hash: { first: "# ", rest: "# ", suffix: "" },
  block: { first: "/* ", rest: " * ", suffix: " */" },
  dash: { first: "-- ", rest: "-- ", suffix: "" },
};

/** Why a tracked file carries no notice of its own. */
export type ExemptReason =
  | "licence-text"
  | "no-comment-syntax"
  | "binary"
  | "third-party"
  | "tool-owned"
  | "prose";

/**
 * The sentence each exemption stands on, shown when the gate reports coverage.
 *
 * Every one of them rests on the same clause of Exhibit A: "If it is not
 * possible or desirable to put the notice in a particular file, then You may
 * include the notice in a location (such as a LICENSE file in a relevant
 * directory) where a recipient would be likely to look for such a notice."
 * The root `LICENSE` and the licence section of `README.md` are that location.
 */
export const EXEMPT_REASONS: Readonly<Record<ExemptReason, string>> = {
  "licence-text": "the licence document itself; altering it is what Sec. 3.4 forbids",
  "no-comment-syntax": "the format has no comment syntax to hold a notice",
  binary: "not Source Code Form; a notice would corrupt the bytes",
  "third-party": "the content is not this project's to place under its licence",
  "tool-owned": "a tool rewrites the whole file and would drop the notice",
  prose: "README.md carries the repository-wide declaration a reader looks for",
};

/** What the gate decided about one path. */
export type Classification =
  | { readonly kind: "notice"; readonly syntax: NoticeSyntax }
  | { readonly kind: "exempt"; readonly reason: ExemptReason }
  | { readonly kind: "unknown" };

/**
 * File families that carry the notice, keyed by extension.
 *
 * `.zon` is here because the Native SDK's parser already accepts `//`
 * comments — `apps/native/app.zon` has carried them since before this table
 * existed.
 *
 * `.hs` is the black-box gate language (`gates/`). Haskell has no line comment
 * other than `--`, and a `{- -}` block would put the three Exhibit A rows
 * inside a construct a reader can nest and comment out; `dash` keeps them as
 * three top-level rows, which is what Sec. 3.4 asks to stay unsplit.
 *
 * `.tsv` carries the notice rather than claiming an exemption because a gate's
 * recorded data is Source Code Form in the sense that matters here: a human
 * edits it, and `gates/line-budget-debt.tsv` states why in the rows above its
 * data. Its reader skips `#` rows, which is the same convention `.toml` uses.
 */
const CARRIES: Readonly<Record<string, NoticeSyntax>> = {
  ".hs": "dash",
  ".tsv": "hash",
  ".rs": "slash",
  ".ts": "slash",
  ".zig": "slash",
  ".zon": "slash",
  ".h": "block",
  ".toml": "hash",
  ".yml": "hash",
  ".sh": "hash",
  ".ps1": "hash",
};

/**
 * File families that do not, each with the reason it does not.
 *
 * `.def` declares which symbols to import from Microsoft's `combase.dll`. The
 * three names in it are Microsoft's, so a RefRain copyright notice above them
 * would assert something untrue.
 */
const EXEMPT: Readonly<Record<string, ExemptReason>> = {
  ".json": "no-comment-syntax",
  ".md": "prose",
  ".txt": "licence-text",
  LICENSE: "licence-text",
  "LICENSE-THIRD-PARTY": "licence-text",
  ".lock": "tool-owned",
  ".ttf": "binary",
  ".png": "binary",
  ".journal": "binary",
  ".patch": "third-party",
  ".def": "third-party",
  ".gitignore": "no-comment-syntax",
  ".gitattributes": "no-comment-syntax",
};

/**
 * The notice as it appears at the top of a file, without a trailing newline.
 *
 * The first Exhibit A line always opens the block and the copyright line always
 * closes it. `NOTICE_LINES` is a tuple, so index 0 is in bounds by its type and
 * survives `noUncheckedIndexedAccess`. The tail is joined with `concat` rather
 * than a spread because ScriptC rejects spreading into an array literal
 * (SC1090), and this module compiles into `verify:licence-headers` as a tier A
 * executable.
 */
export function noticeBlock(syntax: NoticeSyntax): string {
  const shape = SHAPES[syntax];
  const below = NOTICE_LINES.slice(1)
    .map((line) => `${shape.rest}${line}`)
    .concat(`${shape.rest}${COPYRIGHT_LINE}${shape.suffix}`);
  return `${shape.first}${NOTICE_LINES[0]}\n${below.join("\n")}`;
}

/**
 * The lookup key for a path: the final extension, or the whole file name when
 * it has none. A dotfile such as `.gitignore` keys on its own name.
 */
function key(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : name;
}

/**
 * Decide what one tracked path owes.
 *
 * `unknown` is the fail-closed answer: a file family nobody has ruled on is
 * reported rather than skipped, so adding `.kt` to the tree forces a decision
 * about its licence status instead of silently getting none.
 */
export function classify(path: string): Classification {
  const extension = key(path);
  const syntax = CARRIES[extension];
  if (syntax !== undefined) return { kind: "notice", syntax };
  const reason = EXEMPT[extension];
  if (reason !== undefined) return { kind: "exempt", reason };
  return { kind: "unknown" };
}

/**
 * A byte-order mark and a shebang both outrank the notice and must stay first,
 * and they are kept apart because only one of them ends in a line break.
 */
interface Preamble {
  readonly mark: string;
  readonly shebang: string;
  readonly body: string;
}

/**
 * Compared by code point, never against a `"\uFEFF"` literal.
 *
 * ScriptC compiles that literal to a zero-length string while leaving a mark
 * read from disk as a real code unit, so `startsWith("\uFEFF")` answers true,
 * `"\uFEFF".length` answers 0, and the mark survives the slice that was meant
 * to remove it. Measured against ScriptC 0.0.35: the two CRLF PowerShell
 * drivers passed under Bun and failed as compiled executables, which is the
 * disagreement tier A exists to make impossible.
 */
const BYTE_ORDER_MARK = 0xfeff;

function splitPreamble(text: string): Preamble {
  const mark = text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(0, 1) : "";
  const rest = text.slice(mark.length);
  if (!rest.startsWith("#!")) return { mark, shebang: "", body: rest };
  const breakAt = rest.indexOf("\n");
  if (breakAt < 0) return { mark, shebang: rest, body: "" };
  return { mark, shebang: rest.slice(0, breakAt + 1), body: rest.slice(breakAt + 1) };
}

function newlineOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Line endings folded to `\n` so one comparison serves both checkouts. */
function folded(text: string): string {
  return text.split("\r\n").join("\n");
}

/**
 * Whether the notice already stands where a recipient reads it first.
 *
 * The three lines must be the three lines after the byte-order mark and the
 * shebang, in order. Anywhere else is not "attached" in the sense Sec. 1.4
 * means, and a match further down would let a quotation of the licence inside
 * a comment pass for the notice itself.
 */
export function hasNotice(text: string, syntax: NoticeSyntax): boolean {
  return folded(splitPreamble(text).body).startsWith(noticeBlock(syntax));
}

/**
 * The same file with the notice attached, preserving its line endings.
 *
 * One blank line follows the notice unless the file already opens with one,
 * so the notice never reads as the first line of the module documentation
 * beneath it.
 */
export function withNotice(text: string, syntax: NoticeSyntax): string {
  if (hasNotice(text, syntax)) return text;
  const newline = newlineOf(text);
  const { mark, shebang, body } = splitPreamble(text);
  const opening = shebang === "" || shebang.endsWith("\n") ? shebang : `${shebang}${newline}`;
  const notice = folded(noticeBlock(syntax)).split("\n").join(newline);
  const gap = body === "" || body.startsWith(newline) ? "" : newline;
  return `${mark}${opening}${notice}${newline}${gap}${body}`;
}
