/**
 * Semantic colour (SPEC 11).
 *
 * A theme supplies hues; this layer supplies meaning. Before it existed one
 * accent — `--seal` — carried thirteen components at once: agent status,
 * pending judgment, progress, focus, brand. Everything that wanted attention
 * asked in the same voice, so nothing arrived. Colour was decorating rather
 * than telling the author anything.
 *
 * Five roles, and a component may not invent a sixth. The restraint is the
 * point: Zen here is not the absence of colour but the absence of colour that
 * means nothing.
 *
 *   pending   — waits for you. The only role permitted to be saturated.
 *   accepted  — you took it.
 *   refused   — you turned it down. Never alarm red; a refusal is routine.
 *   agent     — a machine, not a person, produced this.
 *   source    — quoted, cited, or backed up. Never to be edited casually.
 *
 * Themes bind these to their own hues in `theme.css`. A role is a promise
 * about meaning, so the same role keeps the same meaning across all nine.
 */
export type Role = "pending" | "accepted" | "refused" | "agent" | "source";

/**
 * Wash and edge derive from the role rather than being authored per theme:
 * a hand-picked tint per role per theme is 45 values to keep in sync, and the
 * first one to drift is the one nobody notices.
 */
export const roleVar = (role: Role, tone: "solid" | "wash" | "edge" = "solid"): string =>
  tone === "solid" ? `var(--role-${role})` : `var(--role-${role}-${tone})`;

/** Percentages are the mix against the paper, tuned once for all themes. */
export const ROLE_TONES = { wash: 8, edge: 34 } as const;
