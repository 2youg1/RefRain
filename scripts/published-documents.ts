/**
 * Every document this repository publishes, and why it exists.
 *
 * One authority. Two gates ask different questions of this list —
 * `verify:no-spec-upload` checks the git index, `verify:text-surface` also
 * scans the working tree and covers `.html` — and a repository cannot hold two
 * lists of what it publishes without them drifting apart, each gate passing
 * against its own stale copy.
 *
 * This module holds data and nothing else: importing it must never run a gate.
 * An earlier version exported the list from one of the gate scripts, and
 * importing that script executed its checks as a side effect, so one gate's
 * failure was reported under the other one's name.
 *
 * Adding a row is a deliberate act. The file becomes public and, because git
 * keeps history, stays public.
 */
export const PUBLISHED = {
  "README.md": "what RefRain is, and how to install it",
  "AGENTS.md": "root pointer stub: sends every non-Claude harness to docs/AGENTS.md",
  "CLAUDE.md": "root pointer stub: imports docs/AGENTS.md into Claude Code sessions",
  "docs/ARCHITECTURE.md": "modules, glossary, and where problems live",
  "docs/CONTRIBUTING.md": "how to propose a change",
  "docs/EFFECT.md": "where Effect runs and which patterns are canonical",
  "docs/AGENTS.md": "working discipline for agents",
  "docs/SKILL.md": "the agent protocol (generated)",
  "e2e/native/README.md": "how to record and replay the session E2E journals",
  "e2e/native-input/README.md": "how to drive the shipping binary with real OS input",
} as const satisfies Record<string, string>;

/** The published paths, for a gate that only needs membership. */
export const publishedPaths: ReadonlySet<string> = new Set(Object.keys(PUBLISHED));
