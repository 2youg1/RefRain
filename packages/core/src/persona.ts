/**
 * An agent's standing identity — what it is for, written by the author.
 *
 * This replaces an earlier `summarizeTaste`, which claimed to compile a taste
 * profile out of the verdict ledger. That was a false claim and worth stating
 * plainly: reducing a hundred scattered judgments to "what this writer wants"
 * is an act of induction, and an application that makes no network calls and
 * holds no model cannot perform one. What the function actually did was
 * concatenate the twelve most recent stated reasons. A list is not a profile,
 * and a name that overstates what the code does is the kind of thing that
 * quietly becomes a lie in the product copy.
 *
 * So identity is authored, not inferred. The author writes it once, edits it
 * when their standard moves, and reuses it across agents. Two consequences
 * follow, both of them wanted:
 *
 *   A single harness and a single model now yield several distinct
 *   collaborators, because identity — not the runtime binding — is what makes
 *   an agent one agent rather than another. One session as a line editor,
 *   another as a structural reader, a third as a translator's second eye.
 *
 *   Nothing is injected that the author did not write and cannot see. The old
 *   design spent tokens on a compiled digest every single round, which is the
 *   opposite of the transparency this application promises.
 *
 * The ledger keeps its own job: an audit record, searchable over stated
 * reasoning. It informs the author when they revise a persona. It no longer
 * pretends to write one for them.
 */

export interface Persona {
  readonly id: string;
  readonly name: string;
  /** The instruction text itself, in the author's own words. */
  readonly brief: string;
  /** A built-in the author started from, when they did. */
  readonly basedOn?: string;
}

/**
 * When a persona travels. Per-agent rather than global, because a structural
 * reader and a proofreader want different amounts of standing instruction, and
 * because the author paying for those tokens should choose per collaborator.
 */
export type PersonaCarry = "every-round" | "first-round" | "never";

/**
 * Starting points, not a taxonomy. Each is short on purpose: a standing brief
 * is paid for on every round it travels, and a long one crowds out the
 * manuscript it is supposed to be reading.
 */
export const PRESETS: readonly Persona[] = [
  {
    id: "line-editor",
    name: "文字编辑",
    brief:
      "逐句读，只动确实有问题的地方。作者的用词优先于你的偏好；改一个词要能说出原词错在哪。不重写没有毛病的句子。",
  },
  {
    id: "structural",
    name: "结构读者",
    brief:
      "读整章，只看结构：论证顺序、段落承接、该详处是否略了。不改字词——那不是你的活。指出问题在哪一段，说清为什么。",
  },
  {
    id: "second-eye",
    name: "译稿二读",
    brief: "对照原文核校译文。术语前后必须一致；拿不准的地方标出来问，不要替作者决定。",
  },
  {
    id: "proofreader",
    name: "校对",
    brief: "只管标点、错字、格式、术语拼写。不碰语气，不碰句式，不提改写建议。",
  },
];

const xmlText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The persona as it appears in a prompt, or nothing when the brief is empty. */
export const renderPersona = (persona: Persona): string | undefined =>
  persona.brief.trim().length === 0
    ? undefined
    : `<persona name="${xmlText(persona.name)}">\n${xmlText(persona.brief.trim())}\n</persona>`;

/**
 * Whether the persona travels on this round.
 *
 * `first-round` exists because a harness that holds its own session already
 * has the brief in context after round one; re-sending it is paying twice for
 * the same instruction. Harnesses that cannot prove session continuity should
 * use `every-round` instead.
 */
export const carriesOn = (carry: PersonaCarry, roundNumber: number): boolean =>
  carry === "every-round" || (carry === "first-round" && roundNumber === 1);
