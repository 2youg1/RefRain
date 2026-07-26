import type { TextHead } from "./domain.ts";
import type { Edit } from "./edits.ts";
import { describeEditsForAgent } from "./edits.ts";
import type { Persona, PersonaCarry } from "./persona.ts";
import { carriesOn, renderPersona } from "./persona.ts";
import { serializeVerdicts } from "./reply.ts";
import { currentText } from "./text-engine.ts";
import type { Verdict } from "./verdict.ts";
import { xmlText } from "./xml.ts";

/**
 * What a run carries into the harness, and in what order (SPEC 7.3).
 *
 * The ordering is the whole design. Everything stable goes first — the agent's
 * standing persona, then the manuscript — and everything that changes per
 * round goes last. A harness matches a prompt prefix byte for byte, so a
 * changelog appended at the end leaves the expensive part of the prompt
 * unchanged, while the same changelog inserted at the top would invalidate
 * every token behind it on every round.
 */

export type Carry = "diff" | "full" | "none";

export interface RoundInput {
  /** The agent's standing identity, authored by the writer. */
  readonly persona?: Persona;
  readonly personaCarry?: PersonaCarry;
  /** 1 for an agent's first dispatch. Decides whether a first-round persona travels. */
  readonly roundNumber: number;
  readonly baseline: TextHead;
  /** Edits the author made since the agent last read the text. */
  readonly edits: readonly Edit[];
  /** Verdicts on the previous round's proposals. */
  readonly verdicts: readonly Verdict[];
  readonly prompt: string;
}

const personaSection = (input: RoundInput): string | undefined =>
  input.persona !== undefined && carriesOn(input.personaCarry ?? "first-round", input.roundNumber)
    ? renderPersona(input.persona)
    : undefined;

/**
 * `diff` suits a long collaboration: the agent already holds the text, so only
 * the delta is new information. `full` suits a fresh agent or one whose
 * context was compacted. `none` suits a single agent owning a single
 * paragraph, where a changelog of the rest of the manuscript is noise it pays
 * tokens to ignore.
 */
export const composeRound = (input: RoundInput, carry: Carry): string => {
  const sections: string[] = [];

  const persona = personaSection(input);
  if (persona !== undefined) sections.push(persona);

  if (carry === "full")
    sections.push(`<manuscript>\n${xmlText(currentText(input.baseline))}\n</manuscript>`);
  if (input.verdicts.length > 0) sections.push(serializeVerdicts(input.verdicts));
  if (carry === "diff" && input.edits.length > 0) sections.push(describeEditsForAgent(input.edits));

  sections.push(`<request>\n${xmlText(input.prompt)}\n</request>`);

  return sections.join("\n\n");
};

/**
 * What the send manifest shows before the author commits: which sections
 * travel and how large each is, in characters. Not tokens — tokenisation
 * belongs to the harness, and estimating it here would be the billing math
 * this application refuses to perform.
 */
export interface CarryBreakdown {
  readonly section: string;
  readonly chars: number;
}

export const breakdown = (input: RoundInput, carry: Carry): readonly CarryBreakdown[] => {
  const rows: CarryBreakdown[] = [];

  const persona = personaSection(input);
  if (persona !== undefined) rows.push({ section: "persona", chars: persona.length });
  if (carry === "full")
    rows.push({ section: "manuscript", chars: currentText(input.baseline).length });
  if (input.verdicts.length > 0)
    rows.push({ section: "verdicts", chars: serializeVerdicts(input.verdicts).length });
  if (carry === "diff" && input.edits.length > 0)
    rows.push({ section: "changelog", chars: describeEditsForAgent(input.edits).length });
  rows.push({ section: "request", chars: input.prompt.length });

  return rows;
};
