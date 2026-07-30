// 每个随包分发的字体都必须在 LICENSE-THIRD-PARTY 里有它自己的条目。
//
// 这些字体是 SIL OFL 1.1，OFL 第 2 条要求每份副本都带上版权声明与许可全文。
// 义务在**分发**时产生，而不是在有人想起来的时候——所以它需要一道门禁，
// 而不是一句约定：加一个字体却忘了补声明，是不会有任何症状的。
//
// 两条规则都从磁盘与二进制取域，不从这份脚本里的清单取：
// 我列出的表恰好会漏掉我忘了的那一个。

import { readdir, readFile } from "node:fs/promises";

const FONT_DIR = "apps/desktop/src/fonts";
const NOTICE = "LICENSE-THIRD-PARTY";

const failures: string[] = [];
const notice = await readFile(NOTICE, "utf8").catch(() => null);
if (notice === null) {
  console.error(`FAIL  verify:font-licenses\n      ${NOTICE} is missing; shipped fonts require it`);
  process.exit(1);
}

const shipped = (await readdir(FONT_DIR)).filter((name) => name.endsWith(".woff2")).sort();
if (shipped.length === 0) {
  failures.push(`${FONT_DIR} holds no fonts; this gate would pass vacuously`);
}

for (const file of shipped) {
  if (!notice.includes(file)) {
    failures.push(`${file} is shipped but has no entry in ${NOTICE}`);
  }
}

// 反向：声明里列了已经不再分发的字体，说明清单过期。
for (const line of notice.split("\n")) {
  const match = line.match(/`([A-Za-z0-9-]+\.woff2)`/);
  if (match?.[1] !== undefined && !shipped.includes(match[1])) {
    failures.push(`${NOTICE} lists ${match[1]}, which is no longer shipped`);
  }
}

// OFL 全文必须在场：只列版权行不满足第 2 条。
for (const clause of [
  "SIL OPEN FONT LICENSE Version 1.1",
  "PERMISSION & CONDITIONS",
  "TERMINATION",
  "DISCLAIMER",
]) {
  if (!notice.includes(clause)) {
    failures.push(`${NOTICE} omits the OFL section "${clause}"; the licence must appear in full`);
  }
}

if (failures.length > 0) {
  console.error(`FAIL  verify:font-licenses\n      ${failures.join("\n      ")}`);
  process.exit(1);
}
console.log(
  `PASS  verify:font-licenses  (${shipped.length} shipped fonts, each with a notice and the full OFL)`,
);
