// PROTOTYPE — non-interactive driver. Proves the model without a TTY.
// Run: bun prototypes/decision-model/drive.ts

import {
  type Proposal,
  type TextHead,
  type Verdict,
  commitBatch,
  commutes,
  nextId,
  rebuild,
  serialize,
  sliceProposal,
} from "./model.ts";

const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const D = (s: string) => `\x1b[2m${s}\x1b[0m`;

const fresh = (): TextHead => ({
  id: "h0",
  blocks: [
    { id: "b1", text: "黑暗中有人问。" },
    { id: "b2", text: "声音很熟，熟到她握剑的手松了半分。她想起十年前那个雨夜。" },
    { id: "b3", text: "剑尖垂下去，抵住青石板。" },
  ],
  cause: "initial",
});

const P = {
  kimi: {
    id: "p1", agent: "kimi", baseline: "r0",
    scope: { id: "s-b2", blockIds: ["b2"] },
    before: "声音很熟，熟到她握剑的手松了半分。她想起十年前那个雨夜。",
    after: "声音很熟。她握剑的手却紧了半分。她想起十年前那个雨夜。",
  } as Proposal,
  codex: {
    id: "p2", agent: "codex", baseline: "r0",
    scope: { id: "s-b2", blockIds: ["b2"] },
    before: "声音很熟，熟到她握剑的手松了半分。她想起十年前那个雨夜。",
    after: "这声音她十年没听到了。剑没有松。",
  } as Proposal,
  pi: {
    id: "p3", agent: "pi", baseline: "r0",
    scope: { id: "s-b3", blockIds: ["b3"] },
    before: "剑尖垂下去，抵住青石板。",
    after: "剑尖没有动。",
  } as Proposal,
};

const v = (p: Proposal, sliceId: string, kind: Verdict["kind"], finalText?: string, reason?: string): Verdict => ({
  id: `v${nextId()}`, proposalId: p.id, sliceId, kind, finalText, reason,
  baseline: p.baseline, decidedAt: "2026-07-26T00:00:00Z",
});

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? G("PASS") : R("FAIL")}  ${name}${detail ? D("  " + detail) : ""}`);
  cond ? pass++ : fail++;
};

// ── 1. Slicing ──────────────────────────────────────────────────────
console.log(B("\n1. Review slices — sentence-level"));
const sl = sliceProposal(P.kimi);
sl.forEach((s) => console.log(`     ${s.id} ${s.kind.padEnd(4)} ${s.text}`));
check("unchanged tail becomes a `same` slice", sl.some((s) => s.kind === "same" && s.text.includes("十年前")));
check("changed sentence splits into del + ins", sl.some((s) => s.kind === "del") && sl.some((s) => s.kind === "ins"));

// ── 2. Partial acceptance ───────────────────────────────────────────
console.log(B("\n2. Partial acceptance — accept the ins, keep the rest"));
{
  const staged = new Map<string, Verdict>();
  const ins = sl.filter((s) => s.kind === "ins");
  const del = sl.filter((s) => s.kind === "del");
  ins.forEach((s) => staged.set(s.id, v(P.kimi, s.id, "accept")));
  del.forEach((s) => staged.set(s.id, v(P.kimi, s.id, "accept")));
  const built = rebuild(sl, staged);
  console.log(D(`     rebuilt: ${built}`));
  check("full acceptance reproduces the agent's text", built === P.kimi.after, `got: ${built}`);

  const half = new Map<string, Verdict>();
  ins.forEach((s) => half.set(s.id, v(P.kimi, s.id, "reject")));
  del.forEach((s) => half.set(s.id, v(P.kimi, s.id, "reject")));
  const orig = rebuild(sl, half);
  check("full rejection reproduces the original", orig === P.kimi.before, `got: ${orig}`);
}

// ── 3. accept-modified ──────────────────────────────────────────────
console.log(B("\n3. accept-modified — the human's own wording wins"));
{
  const head = fresh();
  const staged = new Map<string, Verdict>();
  sl.forEach((s) => {
    if (s.kind === "del") staged.set(s.id, v(P.kimi, s.id, "accept"));
    if (s.kind === "ins")
      staged.set(s.id, v(P.kimi, s.id, "accept-modified",
        s.text.replace("却", "反而"), "「却」改「反而」，转折更硬"));
  });
  const r = commitBatch(head, [P.kimi], staged);
  check("batch commits", r.ok);
  if (r.ok) {
    console.log(D(`     ${serialize(r.head).split("\n\n")[1]}`));
    check("manuscript carries the human's wording", serialize(r.head).includes("反而"));
    check("proposal itself is unchanged (auditable)", P.kimi.after.includes("却"));
    check("verdict keeps its reason", r.verdicts.some((x) => x.reason?.includes("转折更硬")));
  }
}

// ── 4. Overlapping proposals are refused ────────────────────────────
console.log(B("\n4. Competing proposals on the same scope"));
{
  const head = fresh();
  const staged = new Map<string, Verdict>();
  sliceProposal(P.kimi).filter((s) => s.kind !== "same").forEach((s) => staged.set(s.id, v(P.kimi, s.id, "accept")));
  sliceProposal(P.codex).filter((s) => s.kind !== "same").forEach((s) => staged.set(s.id, v(P.codex, s.id, "accept")));
  const r = commitBatch(head, [P.kimi, P.codex], staged);
  check("staging two proposals on one scope is REFUSED", !r.ok);
  if (!r.ok) {
    console.log(D(`     reason: ${r.reason}`));
    r.detail.forEach((d) => console.log(D(`     ${d}`)));
    check("refusal names the overlap, not a silent winner", r.reason === "overlapping scopes");
  }
}

// ── 5. Choosing one competitor works ────────────────────────────────
console.log(B("\n5. Choosing one competitor"));
{
  const head = fresh();
  const staged = new Map<string, Verdict>();
  sliceProposal(P.codex).filter((s) => s.kind !== "same")
    .forEach((s) => staged.set(s.id, v(P.codex, s.id, "accept", undefined, "更冷，符合人物")));
  const r = commitBatch(head, [P.kimi, P.codex], staged);
  check("only the staged proposal commits", r.ok);
  if (r.ok) {
    console.log(D(`     ${serialize(r.head).split("\n\n")[1]}`));
    check("unstaged competitor left the manuscript alone", !serialize(r.head).includes("却紧了半分"));
  }
}

// ── 6. Cross-chapter disjoint batch ─────────────────────────────────
console.log(B("\n6. Disjoint proposals in one batch"));
{
  const head = fresh();
  const staged = new Map<string, Verdict>();
  sliceProposal(P.kimi).filter((s) => s.kind !== "same").forEach((s) => staged.set(s.id, v(P.kimi, s.id, "accept")));
  sliceProposal(P.pi).filter((s) => s.kind !== "same").forEach((s) => staged.set(s.id, v(P.pi, s.id, "accept")));
  const r = commitBatch(head, [P.kimi, P.pi], staged);
  check("disjoint scopes commit together", r.ok);
  if (r.ok) {
    check("ONE new head for the whole batch", r.head.id !== head.id);
    check("both changes landed",
      serialize(r.head).includes("却紧了半分") && serialize(r.head).includes("剑尖没有动"));
    console.log(D(`     verdicts in batch: ${r.verdicts.length}`));
  }
}

// ── 7. Commutativity ────────────────────────────────────────────────
console.log(B("\n7. Commutativity invariant (SPEC §7.4)"));
{
  const head = fresh();
  check("merge(A,B) == merge(B,A) for disjoint scopes",
    commutes(head, { scope: P.kimi.scope, text: "甲。" }, { scope: P.pi.scope, text: "乙。" }));
}

// ── 8. Three-way conflict ───────────────────────────────────────────
console.log(B("\n8. Manuscript drifts under a queued proposal"));
{
  const head = fresh();
  head.blocks[1].text += "（作者后来又改了一句）";
  const staged = new Map<string, Verdict>();
  sliceProposal(P.kimi).filter((s) => s.kind !== "same").forEach((s) => staged.set(s.id, v(P.kimi, s.id, "accept")));
  const r = commitBatch(head, [P.kimi], staged);
  check("stale proposal is REFUSED, not force-applied", !r.ok);
  if (!r.ok) {
    console.log(D(`     reason: ${r.reason}`));
    r.detail.forEach((d) => console.log(D(`     ${d}`)));
  }
}

// ── 9. Empty batch ──────────────────────────────────────────────────
console.log(B("\n9. Nothing staged"));
{
  const r = commitBatch(fresh(), [P.kimi], new Map());
  check("empty batch is a no-op, not an empty commit", !r.ok && r.reason === "nothing staged");
}

// ── 10. Deletion ────────────────────────────────────────────────────
console.log(B("\n10. Proposal that deletes a scope"));
{
  const head = fresh();
  const del: Proposal = { ...P.pi, id: "p4", after: null };
  const staged = new Map<string, Verdict>();
  sliceProposal(del).filter((s) => s.kind !== "same").forEach((s) => staged.set(s.id, v(del, s.id, "accept")));
  const r = commitBatch(head, [del], staged);
  check("scope deletion commits", r.ok);
  if (r.ok) {
    check("block is gone", !serialize(r.head).includes("青石板"));
    check("neighbours intact", serialize(r.head).includes("黑暗中有人问"));
  }
}

console.log(B(`\n${pass} passed, ${fail} failed\n`));
process.exit(fail > 0 ? 1 : 0);
