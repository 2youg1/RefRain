//! 判据 1-6：一个 Task 里，所有 Run 的工具契约必须逐字相同。
//!
//! 依据是 `Stage6-Plan.md` §4.4，它引的是 Manus 的反面实测：**按轮次动态增删
//! Agent 的工具集会使其后全部 KV-cache 失效，且历史里引用过、现在不存在的工具
//! 会诱发幻觉。** 落到 RefRain，「工具契约」就是这一轮请求里那份
//! `# Reply format` —— 它告诉 Agent 有哪些动作可用、产出写成什么形状。
//!
//! 三个档位（`Short` / `Full` / `Pointer`）说的是同一套动作、详略不同。同一个
//! Task 里换档，Agent 看到的可用动作集合就变了：`Pointer` 只有一行「按 RefRain
//! 兼容格式输出」，一个此前读过 `Full` 的 Agent 尚能靠上下文补上，一个第一轮就
//! 拿到 `Pointer` 的 Agent 则无从知道 `<memo>` 存在。
//!
//! # 为什么这道门禁查的是代码而不是跑一遍
//!
//! 危险的形状不是「某次派发真的换了档」，而是**档位由一个可以在 Task 内变化的
//! 东西决定**。当前 `contract_mode()` 按 `agent_id` 是否跑过来算：
//!
//! ```ignore
//! Ok(if host.runs().iter().any(|run| run.agent_id == agent) {
//!     ContractMode::Pointer   // 这个 agent 跑过
//! } else {
//!     ContractMode::Full      // 没跑过
//! })
//! ```
//!
//! 同一个 Task 里派两个 agent —— 一个跑过、一个没跑过 —— 两个 Run 的契约档位
//! 就不同。这不需要任何人「犯错」，是这段代码的正常行为。
//!
//! 跑一遍能不能发现它？要看夹具恰好用了两个新旧不同的 agent。而这道门禁要守的
//! 是**结构**：`contract_mode` 的输入里不得含有能在 Task 内变化的东西。
//!
//! # 自毁保护
//!
//! 被检查的符号消失时必须报错，而不是落进「没找到就算通过」的分支。

import { readFileSync } from "node:fs";

const BRIDGE = "apps/desktop/src-tauri/src/lib.rs";

const failures: string[] = [];
const source = readFileSync(BRIDGE, "utf8");

/** 缺席即失败：找不到检查对象，这道门禁就什么也没检查。 */
function locate(needle: string): number {
  const at = source.indexOf(needle);
  if (at < 0) {
    failures.push(
      `${BRIDGE} 里找不到 ${needle}：这道门禁失去了检查对象，` +
        `请更新它而不是删掉它——一条找不到目标的检查会静默通过`,
    );
  }
  return at;
}

// ① 档位不得取决于任何**在 Task 内会变化**的东西。
//
// 这是这道门禁的全部内容，而它的措辞改过一次，值得记下来。
//
// 第一版断言「`contract_mode` 的签名里要有 `task_id`」。写完去读调用点才发现
// 那是问错了问题：两个调用点（`preview_dispatch` 与授权）都在 Task 的 Run 被
// 铸出来**之前**执行——授权这一步本身才是铸 Run 的时刻——所以那里根本没有
// task_id 可传，而「按 Task 算」在这个时序上无法表达。
//
// 真正要守的不变量与 task_id 无关：档位是**这个项目**的属性，不是某个 agent 的
// 属性。只要它取决于「这个 agent 以前跑过没有」，同一个 Task 里派两个 agent
// （`Alternates` 的常态）就会一个拿 Pointer、一个拿 Full。
const signature = locate("fn contract_mode(");
if (signature >= 0) {
  const body = source.slice(signature, signature + 1200);

  // 只滤注释行：上面那段文档注释本身就引用了这些代码形状。
  const executable = body
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  // 逐个 Run 地问「是不是这个 agent」——这正是把 Run 级的差异带进档位的形状。
  if (/runs\(\)[\s\S]{0,120}agent_id\s*==/.test(executable)) {
    failures.push(
      `${BRIDGE}：contract_mode 按「这个 agent 跑过没有」决定档位。` +
        `同一个 Task 里派两个 agent 时，跑过的拿 Pointer、没跑过的拿 Full，` +
        `两个 Run 的工具契约就不同——Stage6-Plan §4.4 禁止的动态工具集`,
    );
  }
}

// ② 三个档位都还在。
//
// 这一条防的是另一个方向：有人为了让 ① 通过，把 Pointer 整个删掉。那样档位确实
// 不再变化，但代价是每轮都发全文契约——省 token 的设计被悄悄撤销，而没有任何
// 东西会说。删除是一个正当的决定，只是它该被看见。
for (const tier of ["Short", "Full", "Pointer"]) {
  if (!source.includes(`ContractMode::${tier}`)) {
    failures.push(
      `${BRIDGE}：契约档位 ${tier} 不见了。` +
        `如果这是有意的，请同时更新 Stage6-Plan §4.4 与这道门禁`,
    );
  }
}

if (failures.length > 0) {
  console.error("FAIL  verify:contract-tier-per-task: 工具契约会在一个 Task 内变化");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log("PASS  verify:contract-tier-per-task  (契约档位由 Task 决定，三档俱在)");
