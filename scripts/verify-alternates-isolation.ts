#!/usr/bin/env bun
/**
 * 判据 2-6：并列的 Run 互不可见。
 *
 * `Alternates` 的意思是「同一个问题，几个 Agent 各答各的」。它值钱的地方正是
 * **独立**：如果第二个 Agent 能读到第一个的答案，作者拿到的就不是几个独立判断，
 * 而是一个判断加几次附和——而他无法从结果上看出这件事发生过。
 *
 * # 为什么这道门禁查的是源码而不是行为
 *
 * 「互不可见」是一条**否定性**的性质：要断言的是某样东西*没有*出现在请求里。
 * 行为测试只能证明「在我构造的这个场景里没出现」，而泄漏的路径可以有很多条：
 * 把同侪的产出读进上下文、把 Run 的工作区互相挂载、在收取时回填。逐条构造场景
 * 既写不全，也会在新增一条路径时静默放过。
 *
 * 所以这里守的是**结构**：请求的字节只能来自授权时冻结的那一份包。这不是转述
 * 架构，而是它可检查的形式——
 *
 * 1. 请求在**授权**时冻结（`stage_request`），而同侪的产出在那一刻还不存在；
 * 2. 启动时只做提升（rename），不重新编译上下文；
 * 3. 因此并列 Run 之间没有任何字节可以流动。
 *
 * 门禁检查第 2 条：启动路径不得读取任何 Run 的产出。第 1 条由 host 的等待约束
 * 保证（`Alternates` 显式不排序，见 `host.rs` 的 `LaunchRun`）。
 *
 * # 自毁保护
 *
 * 被检查的符号消失时必须报错，而不是落进「没找到就算通过」的分支——那正是
 * `verify:connections` 曾经失效的方式（`indexOf` 返回 -1 被读作「满足」）。
 */

// 顶层 await 要求这个文件是模块。没有 import 时 TypeScript 报 TS1375，
// 而这道门禁本身也要过仓库的 `check`——门禁脚本不是仓库之外的东西。
export {};

const HOST = "crates/refrain-host/src/host.rs";
const STAGING = "crates/refrain-host/src/staging.rs";

const failures: string[] = [];

const host = await Bun.file(HOST).text();
const staging = await Bun.file(STAGING).text();

/** 缺席即失败：被检查的对象不在了，这道门禁就什么也没检查。 */
function locate(text: string, needle: string, file: string): number {
  const at = text.indexOf(needle);
  if (at < 0) {
    failures.push(
      `${file} 里找不到 ${needle}：这道门禁失去了检查对象，` +
        `请更新它而不是删掉它——一条找不到目标的检查会静默通过`,
    );
  }
  return at;
}

// ① `Alternates` 必须在等待约束里被显式解释为「不等任何人」。
//
// 断言的是它**被写下来**，而不是它恰好落进某个兜底分支：一个 `_ => None` 的
// 兜底会让新增的边种类静默继承「不用等」，而那对 `Follows` 是错的。
const launch = locate(host, "HostCommand::LaunchRun", HOST);
if (launch >= 0) {
  const body = host.slice(launch, launch + 3000);
  if (!/ResolvedEdge::Alternates\s*\{[^}]*\}\s*=>\s*None/.test(body)) {
    failures.push(
      `${HOST}：启动路径里 Alternates 没有被显式写成「不等待」。` +
        `落进兜底分支会让新增的边种类继承错误的默认`,
    );
  }
  for (const ordered of ["Follows", "Verifies"]) {
    if (!body.includes(`ResolvedEdge::${ordered}`)) {
      failures.push(
        `${HOST}：启动路径里没有 ${ordered} 的等待分支。` +
          `只有 Alternates 一支时，这条规则就退化成了「谁都不用等」`,
      );
    }
  }
}

// ② 请求在授权时冻结，启动只做提升。
//
// 这是「互不可见」的结构来源：冻结发生在同侪产出存在之前，而提升是一次 rename，
// 不重新编译上下文。若启动路径开始自己拼请求，隔离就失去了依据。
// 名字要写全。第一版写的是 `fn promote`，而真实名字是 `fn promote_request` ——
// `indexOf` 命中了它的前缀，于是把函数改名成 `promote_renamed` 仍然匹配得上，
// 自毁保护整条失效。断言用的短语必须是被测对象**独有**的。
const promote = locate(staging, "fn promote_request(", STAGING);
if (promote >= 0) {
  const body = staging.slice(promote, promote + 1200);
  // 断言指向**可执行的调用**，不是「rename 这个词出现过」。同一个函数体的注释
  // 里就写着 "the rename's error is the honest answer"，于是把 `fs::rename`
  // 换成 `fs::copy` 之后，`includes("rename")` 仍被那句注释满足——注入不变红，
  // 而实现已经改变了语义。这是本轮第三次栽在「断言短语不独有」上。
  const executable = body
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  if (!executable.includes("fs::rename(&staged, &request)")) {
    failures.push(
      `${STAGING}：提升不再是 rename。请求若在启动时被重新编译，` +
        `就有了读到同侪产出的机会，而并列 Run 的独立性正来自「那时它还不存在」`,
    );
  }
}

// ③ 启动路径不得读取**别的 Run** 的工作区。
//
// 第一版规则在这里问错了问题：它禁止 `result.md` 这个字符串出现在两个文件里，
// 于是同时咬中了落地产出的正当写入路径（`land_result` 就该写这个文件）、回复
// 格式的说明文本、以及测试夹具——五条噪音，把注入 3 与 4 的真红整个盖住。
//
// 「一份产出写进自己的工作区」与「一个 Run 读进另一个 Run 的工作区」是两件事，
// 而只有后者是泄漏。所以查的是**跨 Run 的路径构造**：启动路径里出现「用别人的
// run id 拼工作区路径」才是越界。
const LAUNCH_MUST_NOT_REACH = [
  // 启动时按同侪的 id 取目录：这是把别人的工作区拿到手的唯一形状。
  /run_workspace\s*\(\s*(?:peer|other|alternate|sibling)/,
  // 直接读同侪的产出。
  /(?:peer|other|alternate|sibling)\w*\s*\.\s*join\s*\(\s*"result\.md"/,
];
if (launch >= 0) {
  const body = host.slice(launch, launch + 3000);
  for (const pattern of LAUNCH_MUST_NOT_REACH) {
    if (pattern.test(body)) {
      failures.push(
        `${HOST}：启动路径构造了另一个 Run 的工作区路径（${pattern.source}）：` +
          `并列 Run 之间不该有字节流动`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("FAIL  verify:alternates-isolation: 并列 Run 的独立性没有被结构保证");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log("PASS  verify:alternates-isolation  (并列 Run 的请求只来自冻结包)");
