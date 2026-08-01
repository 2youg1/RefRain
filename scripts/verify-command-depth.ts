#!/usr/bin/env bun
import { readFileSync } from "node:fs";

const SOURCE = "apps/desktop/src-tauri/src/lib.rs";

/** Longest command body we accept from a layer that only maps onto use cases. */
const BODY_CEILING = 40;

/**
 * A command builds a `RefrainError` in place when it decides what kind of
 * failure something is. That decision belongs to the concept the error
 * describes, where it can be stated once and tested. Zero is the target; the
 * entries below are what the gate measured when it landed.
 */
const ERROR_CEILING = 0;

/**
 * Commands still carrying pre-gate debt, with the figure measured when this
 * gate landed. A command may not exceed its recorded numbers; lowering them is
 * the only permitted edit. Delete the entry once the command clears the
 * ceilings, which the gate enforces by failing on a stale entry.
 */
const DEBT: Readonly<Record<string, { readonly lines: number; readonly errors: number }>> = {
  commit_decision_batch: { lines: 30, errors: 1 },
  cancel_run: { lines: 60, errors: 3 },
  upsert_annotation: { lines: 76, errors: 5 },
  inject_fixture_proposal: { lines: 71, errors: 4 },
  list_harnesses: { lines: 66, errors: 2 },
  upsert_agent: { lines: 62, errors: 5 },
  // 63：编排的边。两行——解构里一行，命令构造里一行 DTO→领域的翻译。
  // 试过把翻译收进 `AuthorizeDispatchRequest` 自己（`update_preferences`
  // 走的就是这条路），结果是 61→64：解构必须先取值再消耗 request，多出的
  // 一行比省下的多。棘轮的意义是让每次上调写下理由，不是把行数挪到别处。
  authorize_dispatch: { lines: 63, errors: 1 },
  agent_reading_ledger: { lines: 57, errors: 0 },
  // 24：DTO→领域的翻译搬进 `PreferencesChangeDto::into_change`。它本来就是
  // DTO 自己的事，留在命令体里只是让「加一个偏好」看起来像在动装配层。
  update_preferences: { lines: 24, errors: 2 },
  list_agents: { lines: 55, errors: 0 },
  apply_editor_action: { lines: 53, errors: 3 },
  upsert_harness_connection: { lines: 45, errors: 4 },
  probe_connection: { lines: 42, errors: 4 },
  record_verdict: { lines: 41, errors: 1 },
  commit_material_action: { lines: 39, errors: 1 },
  preview_dispatch: { lines: 37, errors: 1 },
  draft_review_task: { lines: 33, errors: 1 },
  current_document: { lines: 24, errors: 1 },
  choose_and_adopt_root: { lines: 25, errors: 1 },
  set_universal_icon: { lines: 24, errors: 2 },
  list_annotations: { lines: 24, errors: 1 },
  choose_and_import_material: { lines: 23, errors: 1 },
  choose_and_create_project: { lines: 22, errors: 1 },
  read_config: { lines: 22, errors: 3 },
  remove_harness_connection: { lines: 21, errors: 2 },
  remove_agent: { lines: 21, errors: 2 },
  set_review_batch: { lines: 18, errors: 1 },
  list_fonts: { lines: 14, errors: 1 },
  kara_state: { lines: 10, errors: 1 },
};

interface Command {
  readonly name: string;
  readonly lines: number;
  readonly errors: number;
}

/**
 * Read every `#[tauri::command]` body out of the composition layer.
 *
 * The body runs from the `fn` line to the first line that is exactly `}`,
 * which is where rustfmt closes a top-level item. Nested blocks are indented,
 * so they cannot end the scan early.
 */
function commands(source: string): readonly Command[] {
  const lines = source.split("\n");
  const found: Command[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    // 两种形态都要认：`#[tauri::command]` 与 `#[tauri::command(async)]`（重 I/O
    // 命令移出 UI 主线程的那批）。只认前者会让 async 命令从每个门禁里蒸发。
    if (!/^#\[tauri::command(\(async\))?\]/.test(lines[index] ?? "")) continue;

    let signature = index;
    while (signature < lines.length && !/^(pub )?(async )?fn /.test(lines[signature] ?? "")) {
      signature += 1;
    }
    let close = signature;
    while (close < lines.length && lines[close] !== "}") close += 1;

    const body = lines.slice(signature, close + 1);
    found.push({
      name: (lines[signature] ?? "").replace(/^(pub )?(async )?fn /, "").split("(")[0] ?? "",
      lines: body.length,
      errors: body.filter((line) => line.includes("RefrainError::new")).length,
    });
  }

  return found;
}

const found = commands(readFileSync(SOURCE, "utf8"));
const failures: string[] = [];

for (const command of found) {
  const debt = DEBT[command.name];

  const lineAllowance = debt?.lines ?? BODY_CEILING;
  if (command.lines > lineAllowance) {
    failures.push(
      `${command.name}: body ${command.lines} lines exceeds ${lineAllowance} — move the use case into refrain-app`,
    );
  } else if (debt !== undefined && command.lines < debt.lines) {
    failures.push(
      `${command.name}: body is now ${command.lines}; lower its DEBT lines entry from ${debt.lines}`,
    );
  }

  const errorAllowance = debt?.errors ?? ERROR_CEILING;
  if (command.errors > errorAllowance) {
    failures.push(
      `${command.name}: builds ${command.errors} RefrainError(s) in place, over ${errorAllowance} — the failure belongs to the concept it describes`,
    );
  } else if (debt !== undefined && command.errors < debt.errors) {
    failures.push(
      `${command.name}: only ${command.errors} in-place error(s) remain; lower its DEBT errors entry from ${debt.errors}`,
    );
  }
}

// A debt entry naming a command that no longer exists is a ratchet that
// stopped ratcheting: the name may have been reused elsewhere, and the entry
// would silently license the growth it was recording.
const names = new Set(found.map((command) => command.name));
for (const name of Object.keys(DEBT)) {
  if (!names.has(name)) failures.push(`DEBT names ${name}, which is no longer a command`);
}

if (found.length === 0) {
  failures.push(`no commands were found in ${SOURCE} — the gate is looking nowhere`);
}

if (failures.length > 0) {
  console.error("FAIL  verify:command-depth");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

const total = found.reduce((sum, command) => sum + command.lines, 0);
console.log(
  `PASS  verify:command-depth  (${found.length} commands, ${total} lines, ceiling ${BODY_CEILING}, ${Object.keys(DEBT).length} carrying recorded debt)`,
);
