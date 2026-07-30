// 每个随包分发的东西——字体，以及进产物的第三方软件——都必须在
// LICENSE-THIRD-PARTY 里有它自己的条目。
//
// 这些字体是 SIL OFL 1.1，OFL 第 2 条要求每份副本都带上版权声明与许可全文。
// 义务在**分发**时产生，而不是在有人想起来的时候——所以它需要一道门禁，
// 而不是一句约定：加一个字体却忘了补声明，是不会有任何症状的。
//
// 全部规则都从磁盘、二进制与 package.json 取域，不从这份脚本里的清单取：
// 我列出的表恰好会漏掉我忘了的那一个。
//
// 软件那半边同理：Shiki 是 MIT，MIT 要求「在软件的所有副本或重要部分中保留
// 版权声明与许可声明」。它随前端产物一起分发，因此义务在每一次分发时成立，
// 而不是在发布日才成立。

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

// —— 随产物分发的第三方软件 ——
//
// 域取自 package.json 的依赖，不取自这份脚本：装了一个新依赖却忘了补声明，
// 与加一个字体忘了补声明是同一件事，且同样没有任何症状。
const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
  dependencies?: Record<string, string>;
};
// devDependencies 不进产物，因此不产生分发义务。
const shippedPackages = Object.keys(manifest.dependencies ?? {}).sort();

for (const name of shippedPackages) {
  const declared = await readFile(`node_modules/${name}/package.json`, "utf8")
    .then((raw) => (JSON.parse(raw) as { license?: string }).license ?? "")
    .catch(() => "");
  // 宽松许可里，只有需要保留声明的那几种产生义务。
  if (!/^(MIT|BSD|Apache|ISC)/i.test(declared)) continue;
  if (!notice.includes(`\`${name}\``)) {
    failures.push(`${name} (${declared}) ships in the bundle but has no entry in ${NOTICE}`);
  }
}

// 许可全文必须在场：只写一行「MIT」不满足保留声明的要求。
// 断言句必须是 MIT 独有的——OFL 里也有 "WITHOUT WARRANTY OF ANY KIND"，
// 拿它做判据时删掉 MIT 那份仍会命中 OFL 那份，门禁永远不会红。
if (shippedPackages.includes("shiki")) {
  for (const clause of [
    "Pine Wu",
    "Anthony Fu",
    "MIT License",
    "The above copyright notice and this permission notice shall be included in all",
  ]) {
    if (!notice.includes(clause)) {
      failures.push(`${NOTICE} omits "${clause}"; the MIT notice must appear in full`);
    }
  }
}

if (failures.length > 0) {
  console.error(`FAIL  verify:font-licenses\n      ${failures.join("\n      ")}`);
  process.exit(1);
}
console.log(
  `PASS  verify:font-licenses  (${shipped.length} fonts with the full OFL, ${shippedPackages.length} shipped packages checked)`,
);
