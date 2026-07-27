/**
 * Result Artifact codec (SPEC 7.1).
 *
 * Hand-written rather than delegated to an XML library. The grammar is four
 * elements wide, while a general parser brings DTDs, entities, namespaces, and
 * external resolution — the exact surface this format exists to refuse. Fewer
 * lines here than the configuration needed to lock a library down, and
 * `packages/core` keeps its near-zero dependency budget.
 */

export interface AgentReplacement {
  readonly scope: string;
  /** null deletes the scope. */
  readonly text: string | null;
}

export interface AgentComment {
  readonly target: string;
  readonly text: string;
}

/**
 * What the agent chose to remember from this run.
 *
 * Written by the agent, not compiled by the app — which is why it can exist at
 * all. This application makes no network calls and holds no model, so it
 * cannot induce a working memory from a pile of verdicts; the only party
 * present with that capacity is the agent itself, at the moment it still has
 * the full context in hand.
 *
 * Its value is continuity across a discontinuity. A session that gets cloned,
 * compacted, or replaced loses its native context, and the successor picks up
 * the memo instead of starting from nothing. The author can read it, edit it,
 * and refuse it, because an agent's account of its own work is a claim rather
 * than evidence.
 */
export interface AgentMemo {
  /** Free prose: what this agent now believes about the manuscript and the author. */
  readonly text: string;
  /** Optional label, so several runs' memos stay tellable apart. */
  readonly topic?: string;
}

export interface AgentResult {
  readonly replacements: readonly AgentReplacement[];
  readonly comments: readonly AgentComment[];
  readonly memos: readonly AgentMemo[];
}

export type ArtifactErrorCode =
  | "missing-root"
  | "text-outside-root"
  | "dtd-forbidden"
  | "unsupported-version"
  | "unknown-element"
  | "missing-scope"
  | "duplicate-replacement"
  | "malformed"
  | "too-deep";

export interface ArtifactError {
  readonly code: ArtifactErrorCode;
  readonly detail: string;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ArtifactError };

const REPLY_HEADING = /^#\s+Agent reply\s*$/m;
const ROOT = /<agent-result\b([^>]*)>([\s\S]*?)<\/agent-result\s*>/;
const SELF_CLOSING_ROOT = /<agent-result\b[^>]*\/>/;
const ATTRIBUTE = /(\w+)\s*=\s*"([^"]*)"/g;
const MAX_DEPTH = 8;

const fail = (code: ArtifactErrorCode, detail: string): ParseResult<never> => ({
  ok: false,
  error: { code, detail },
});

const attributes = (source: string): Map<string, string> =>
  new Map([...source.matchAll(ATTRIBUTE)].map((m) => [m[1] ?? "", m[2] ?? ""]));

/**
 * Element scanner for the artifact body. CDATA is consumed as an opaque run so
 * that markup inside agent prose never reaches the tag scanner — the common
 * case for text about code or about this very format.
 */
interface Element {
  readonly name: string;
  readonly attrs: Map<string, string>;
  readonly body: string;
}

const CDATA_OPEN = "<![CDATA[";
const CDATA_CLOSE = "]]>";

const scan = (source: string): ParseResult<Element[]> => {
  const elements: Element[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const open = source.indexOf("<", cursor);
    if (open === -1) {
      if (source.slice(cursor).trim().length > 0)
        return fail("text-outside-root", "text between elements");
      break;
    }
    if (source.slice(cursor, open).trim().length > 0)
      return fail("text-outside-root", `stray text: ${source.slice(cursor, open).trim()}`);

    // A CDATA run is skipped whole. The module comment above has claimed this
    // since it was written and the scanner never did it, so an agent that
    // mentioned `</replacement>` while explaining this format to its successor
    // had the entire run refused — with the error pointing at that sentence and
    // calling it stray text.
    if (source.startsWith(CDATA_OPEN, open)) {
      const finish = source.indexOf(CDATA_CLOSE, open + CDATA_OPEN.length);
      if (finish === -1) return fail("malformed", "unterminated CDATA");
      cursor = finish + CDATA_CLOSE.length;
      continue;
    }

    const close = source.indexOf(">", open);
    if (close === -1) return fail("malformed", "unterminated tag");

    const raw = source.slice(open + 1, close);
    const selfClosing = raw.endsWith("/");
    const [name = ""] = raw.replace(/\/$/, "").trim().split(/\s+/, 1);
    const attrs = attributes(raw);

    if (selfClosing) {
      elements.push({ name, attrs, body: "" });
      cursor = close + 1;
      continue;
    }

    const end = source.indexOf(`</${name}`, close);
    if (end === -1) return fail("malformed", `unclosed <${name}>`);
    const body = source.slice(close + 1, end);

    // The closing tag has to finish. `indexOf` answering -1 used to become
    // `cursor = 0`, and the loop rescanned the same element until the array
    // exhausted memory — reachable from any harness that wrote one truncated
    // byte, which is the single untrusted input this parser exists to survive.
    const after = source.indexOf(">", end);
    if (after === -1) return fail("malformed", `unterminated </${name}>`);

    elements.push({ name, attrs, body });
    cursor = after + 1;
  }

  return { ok: true, value: elements };
};

/** CDATA is the only way agent text carries markup; anything else is literal. */
const content = (body: string): string => {
  const cdata = body.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata?.[1] ?? body.trim();
};

const nestingDepth = (source: string): number => {
  let depth = 0;
  let max = 0;
  for (const tag of source.matchAll(/<(\/?)(\w+)[^>]*?(\/?)>/g)) {
    if (tag[1] === "/") depth--;
    else if (tag[3] !== "/") max = Math.max(max, ++depth);
  }
  return max;
};

export const parseAgentResult = (artifact: string): ParseResult<AgentResult> => {
  const reply = artifact.split(REPLY_HEADING)[1] ?? artifact;

  // Checked on the raw text: a DTD must never reach a parser, because refusing
  // it after expansion is refusing it too late.
  if (/<!DOCTYPE/i.test(reply) || /<!ENTITY/i.test(reply))
    return fail("dtd-forbidden", "DTD and entity declarations are not accepted");

  if (SELF_CLOSING_ROOT.test(reply) && !ROOT.test(reply))
    return fail("missing-root", "<agent-result> carries no content");

  const root = reply.match(ROOT);
  if (!root) return fail("missing-root", "no <agent-result> element");

  const outside = reply.slice(0, root.index ?? 0) + reply.slice((root.index ?? 0) + root[0].length);
  if (outside.trim().length > 0)
    return fail("text-outside-root", "prose outside <agent-result>; use <comment>");

  const version = attributes(root[1] ?? "").get("version");
  if (version !== "1") return fail("unsupported-version", `version=${version ?? "absent"}`);

  const body = root[2] ?? "";
  if (nestingDepth(body) > MAX_DEPTH) return fail("too-deep", `nesting exceeds ${MAX_DEPTH}`);

  const scanned = scan(body);
  if (!scanned.ok) return scanned;

  const replacements: AgentReplacement[] = [];
  const comments: AgentComment[] = [];
  const memos: AgentMemo[] = [];
  const seen = new Set<string>();

  for (const element of scanned.value) {
    if (element.name === "replacement") {
      const scope = element.attrs.get("scope");
      if (scope === undefined) return fail("missing-scope", "<replacement> without scope");
      if (seen.has(scope)) return fail("duplicate-replacement", `scope ${scope} replaced twice`);
      seen.add(scope);
      const text = content(element.body);
      replacements.push({ scope, text: text.length === 0 ? null : text });
      continue;
    }

    if (element.name === "comments") {
      const inner = scan(element.body);
      if (!inner.ok) return inner;
      for (const child of inner.value) {
        if (child.name !== "comment") return fail("unknown-element", `<${child.name}>`);
        const target = child.attrs.get("target");
        if (target === undefined) return fail("missing-scope", "<comment> without target");
        comments.push({ target, text: content(child.body) });
      }
      continue;
    }

    if (element.name === "memo") {
      const topic = element.attrs.get("topic");
      const text = content(element.body);
      if (text.length > 0) memos.push({ text, ...(topic === undefined ? {} : { topic }) });
      continue;
    }

    return fail("unknown-element", `<${element.name}>`);
  }

  return { ok: true, value: { replacements, comments, memos } };
};
