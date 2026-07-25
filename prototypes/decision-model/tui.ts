// PROTOTYPE — throwaway TUI shell. Drive the model by hand.
// Run: bun prototypes/decision-model/tui.ts

import {
  type Proposal,
  type ReviewSlice,
  type TextHead,
  type Verdict,
  commitBatch,
  commutes,
  mapOnto,
  nextId,
  rebuild,
  scopeText,
  sliceProposal,
} from "./model.ts";

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const D = (s: string) => `\x1b[2m${s}\x1b[0m`;
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const C = (s: string) => `\x1b[36m${s}\x1b[0m`;

// ── Scenario ────────────────────────────────────────────────────────

let head: TextHead = {
  id: "h0",
  blocks: [
    { id: "b1", text: "黑暗中有人问。" },
    { id: "b2", text: "声音很熟，熟到她握剑的手松了半分。她想起十年前那个雨夜。" },
    { id: "b3", text: "剑尖垂下去，抵住青石板。" },
  ],
  cause: "initial",
};
let baseline = { id: "r0", head: "h0" };
const revisions = [baseline];

const proposals: Proposal[] = [
  {
    id: "p1",
    agent: "kimi",
    baseline: "r0",
    scope: { id: "s-b2", blockIds: ["b2"] },
    before: "声音很熟，熟到她握剑的手松了半分。她想起十年前那个雨夜。",
    after: "声音很熟。她握剑的手却紧了半分。她想起十年前那个雨夜。",
  },
  {
    id: "p2",
    agent: "codex",
    baseline: "r0",
    scope: { id: "s-b2", blockIds: ["b2"] },
    before: "声音很熟，熟到她握剑的手松了半分。她想起十年前那个雨夜。",
    after: "这声音她十年没听到了。剑没有松。",
  },
  {
    id: "p3",
    agent: "pi",
    baseline: "r0",
    scope: { id: "s-b3", blockIds: ["b3"] },
    before: "剑尖垂下去，抵住青石板。",
    after: "剑尖没有动。",
  },
];

const staged = new Map<string, Verdict>();
let cursor = 0;
let log: string[] = ["prototype ready — stage verdicts, then commit"];

const allSlices = (): { p: Proposal; s: ReviewSlice }[] =>
  proposals.flatMap((p) => sliceProposal(p).map((s) => ({ p, s })));

// ── Render ──────────────────────────────────────────────────────────

const render = () => {
  console.clear();
  const rows = allSlices();
  const w = (s: string) => s.length > 46 ? s.slice(0, 45) + "…" : s;

  console.log(B("  RECENSION · decision-model prototype"));
  console.log(D(`  head ${head.id}  ·  revision ${baseline.id}  ·  ${revisions.length} pinned`));
  console.log();

  console.log(B("  MANUSCRIPT"));
  for (const b of head.blocks) console.log(`    ${D(b.id.padEnd(6))} ${b.text}`);
  console.log();

  console.log(B("  PROPOSALS") + D("   (slices: del = agent removes, ins = agent adds)"));
  let last = "";
  rows.forEach(({ p, s }, i) => {
    if (p.id !== last) {
      const drifted = scopeText(head, p.scope) !== p.before;
      console.log(
        `    ${C(p.id)} ${D(`${p.agent} → ${p.scope.id}`)}` +
          (drifted ? ` ${Y("[drifted]")}` : ""),
      );
      last = p.id;
    }
    if (s.kind === "same") {
      console.log(`      ${D("  ")} ${D("·")} ${D(w(s.text))}`);
      return;
    }
    const v = staged.get(s.id);
    const mark =
      v?.kind === "accept" ? G("✓") :
      v?.kind === "accept-modified" ? Y("✎") :
      v?.kind === "reject" ? R("✗") : D("·");
    const tag = s.kind === "del" ? R("del") : G("ins");
    const sel = i === cursor ? B("▸") : " ";
    const reason = v?.reason ? D(`  「${v.reason}」`) : "";
    console.log(`    ${sel} ${mark} ${tag} ${w(s.text)}${reason}`);
  });
  console.log();

  console.log(B("  PREVIEW") + D("  (what each proposal becomes if committed now)"));
  for (const p of proposals) {
    const built = rebuild(sliceProposal(p), staged);
    const m = mapOnto(head, p, built);
    console.log(
      `    ${C(p.id)} ${m.ok ? G("mappable") : R(m.why)}  ${D(built || "(deletes scope)")}`,
    );
  }
  console.log();

  console.log(D(`  ${log.slice(-3).join("\n  ")}`));
  console.log();
  console.log(
    D("  [↑↓/jk] move  [a] accept  [x] reject  [m] accept-modified  [r] reason") + "\n" +
    D("  [c] commit batch  [e] external edit b2  [t] test commutativity  [u] unstage  [q] quit"),
  );
};

// ── Actions ─────────────────────────────────────────────────────────

const stage = (kind: Verdict["kind"], finalText?: string) => {
  const row = allSlices()[cursor];
  if (!row || row.s.kind === "same") return void (log.push("context slice — nothing to stage"));
  staged.set(row.s.id, {
    id: `v${nextId()}`,
    proposalId: row.p.id,
    sliceId: row.s.id,
    kind,
    finalText,
    baseline: row.p.baseline,
    decidedAt: new Date().toISOString(),
  });
  log.push(`staged ${kind} on ${row.s.id}`);
};

const prompt = async (q: string): Promise<string> => {
  process.stdout.write(`\n  ${B(q)} `);
  process.stdin.setRawMode(false);
  const line = await new Promise<string>((res) => {
    const on = (d: Buffer) => {
      process.stdin.off("data", on);
      res(d.toString().trim());
    };
    process.stdin.on("data", on);
  });
  process.stdin.setRawMode(true);
  return line;
};

const commit = () => {
  const r = commitBatch(head, proposals, staged);
  if (!r.ok) {
    log.push(R(`REFUSED: ${r.reason}`));
    r.detail.forEach((d) => log.push(`  ${d}`));
    return;
  }
  head = r.head;
  baseline = r.revision;
  revisions.push(r.revision);
  log.push(G(`committed ${r.verdicts.length} verdicts → ${head.id}, pinned ${baseline.id}`));
  staged.clear();
};

const externalEdit = () => {
  const b = head.blocks.find((x) => x.id === "b2");
  if (!b) return void log.push("b2 is gone — nothing to drift");
  b.text += "（外部改动）";
  log.push(Y("b2 edited outside the batch — proposals on it now drift"));
};

const testCommutativity = () => {
  const a = { scope: proposals[0].scope, text: "甲。" };
  const b = { scope: proposals[2].scope, text: "乙。" };
  log.push(
    commutes(head, a, b)
      ? G("disjoint scopes commute ✓")
      : R("NOT commutative ✗ — invariant broken"),
  );
};

// ── Loop ────────────────────────────────────────────────────────────

process.stdin.setRawMode(true);
process.stdin.resume();
render();

for await (const chunk of process.stdin) {
  const k = chunk.toString();
  const rows = allSlices();
  if (k === "q" || k === "\x03") break;
  else if (k === "j" || k === "\x1b[B") cursor = Math.min(cursor + 1, rows.length - 1);
  else if (k === "k" || k === "\x1b[A") cursor = Math.max(cursor - 1, 0);
  else if (k === "a") stage("accept");
  else if (k === "x") stage("reject");
  else if (k === "m") {
    const t = await prompt("replacement text:");
    stage("accept-modified", t);
  } else if (k === "r") {
    const row = rows[cursor];
    const v = row && staged.get(row.s.id);
    if (!v) log.push("stage a verdict first");
    else v.reason = await prompt("why:");
  } else if (k === "u") {
    const row = rows[cursor];
    if (row) staged.delete(row.s.id), log.push(`unstaged ${row.s.id}`);
  } else if (k === "c") commit();
  else if (k === "e") externalEdit();
  else if (k === "t") testCommutativity();
  render();
}

process.stdin.setRawMode(false);
console.clear();
console.log(B("prototype closed."), D(`${revisions.length} revisions pinned.`));
process.exit(0);
