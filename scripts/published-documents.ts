// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

/**
 * Every document this repository publishes, and why it exists.
 *
 * One authority. `verify:no-spec-upload` is its only reader: it holds every
 * tracked `.md` and `.html` file to this list, in both directions.
 *
 * This comment used to name a second reader, `verify:text-surface`, which the
 * Native rewrite deleted (46d9f9b) without touching the sentence. That left a
 * published file advertising coverage no machine provided — and the coverage
 * was real: `.html` went unguarded from that commit until the surviving gate
 * was widened to cover it. A named gate that does not exist is worse than an
 * unnamed gap, because it answers the question nobody then asks.
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
