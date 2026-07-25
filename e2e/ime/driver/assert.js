// assert.js: gate the run — exit 1 if any shell violates an acceptance criterion.
import { readFileSync, existsSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const p = `${ROOT}/results/summary.json`;
if (!existsSync(p)) { console.error('summary.json missing — run analyze.js first'); process.exit(1); }
const rows = JSON.parse(readFileSync(p, 'utf8'));

let bad = 0;
for (const r of rows) {
  if (r.error) { console.error(`FAIL ${r.shell}: ${r.error}`); bad++; continue; }
  const checks = [
    ['dropped words === 0', r.p2DroppedWords === 0],
    ['typing produced text', r.p2Chars > 0],
    ['punctuation first-press all ok', r.punctTotal > 0 && r.punctFirstPressOK === r.punctTotal],
    ['no stuck compositions', r.stuckComps === 0],
    ['no rendering stall > 1s', r.rafMaxGapMs < 1000],
    ['focused on first click', r.focusLatencyMs !== null],
  ];
  for (const [name, ok] of checks) {
    if (!ok) { console.error(`FAIL ${r.shell}: ${name}`); bad++; }
  }
}
if (bad) { console.error(`ime-gate: ${bad} violation(s)`); process.exit(1); }
console.log(`ime-gate: all ${rows.length} shells pass`);
