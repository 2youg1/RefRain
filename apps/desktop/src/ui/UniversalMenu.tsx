import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js";
import {
  filterCommands,
  type WorkbenchCommand,
  type WorkbenchCommandGroup,
  type WorkbenchCommandId,
} from "../shell/workbench-commands";

interface UniversalMenuProps {
  entries: readonly WorkbenchCommand[];
  onChoose: (id: WorkbenchCommandId) => void;
  onClose: () => void;
}

const GROUP_NAME: Record<WorkbenchCommandGroup, string> = {
  continue: "继续当前工作",
  project: "项目",
  work: "工作",
  reference: "资料与连接",
  agents: "Agents",
  appearance: "外观",
  application: "应用",
};

export function UniversalMenu(props: UniversalMenuProps) {
  let dialog: HTMLElement | undefined;
  let input: HTMLInputElement | undefined;
  const [query, setQuery] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  const visible = createMemo(() => filterCommands(props.entries, query()));
  const groups = createMemo(() => {
    const rows = new Map<WorkbenchCommandGroup, WorkbenchCommand[]>();
    for (const entry of visible()) {
      const current = rows.get(entry.group) ?? [];
      current.push(entry);
      rows.set(entry.group, current);
    }
    return [...rows.entries()].map(([id, entries]) => ({ id, label: GROUP_NAME[id], entries }));
  });

  const choose = (entry: WorkbenchCommand): void => {
    if (!entry.available) return;
    props.onChoose(entry.id);
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (event.key === "Tab") {
      const focusable = [
        ...(dialog?.querySelectorAll<HTMLElement>("input, button:not(:disabled)") ?? []),
      ];
      if (focusable.length === 0) return;
      event.preventDefault();
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      const delta = event.shiftKey ? -1 : 1;
      focusable[(current + delta + focusable.length) % focusable.length]?.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const rows = visible();
      setCursor(rows.length === 0 ? 0 : (cursor() + delta + rows.length) % rows.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const entry = visible()[cursor()];
      if (entry) choose(entry);
    }
  };

  // 结果集一变，高亮回到首项。
  createEffect(on(visible, () => setCursor(0), { defer: true }));

  onMount(() => input?.focus());

  const currentId = (): WorkbenchCommandId | undefined => visible()[cursor()]?.id;

  return (
    <div
      class="command-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <section
        ref={dialog}
        class="command-menu"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-title"
        onKeyDown={(event) => {
          event.stopPropagation();
          onKeydown(event);
        }}
      >
        <h2 id="command-title">现在要做什么？</h2>
        <div class="command-search">
          <span aria-hidden="true">⌘</span>
          <input
            ref={input}
            type="search"
            autocomplete="off"
            placeholder="输入动作、对象或命令名"
            aria-label="搜索命令"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <kbd>Esc</kbd>
        </div>
        <div class="command-results" role="listbox" aria-label="命令">
          <For each={groups()}>
            {(group) => (
              <>
                <h3>{group.label}</h3>
                <For each={group.entries}>
                  {(entry) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={currentId() === entry.id}
                      classList={{ current: currentId() === entry.id }}
                      disabled={!entry.available}
                      onPointerEnter={() =>
                        setCursor(visible().findIndex((candidate) => candidate.id === entry.id))
                      }
                      onClick={() => choose(entry)}
                    >
                      <span>{entry.label}</span>
                      <Show when={entry.nextStep}>
                        <small>{entry.nextStep}</small>
                      </Show>
                    </button>
                  )}
                </For>
              </>
            )}
          </For>
          <Show when={visible().length === 0}>
            <p class="command-empty">没有匹配动作。换一个对象或动词。</p>
          </Show>
        </div>
      </section>
    </div>
  );
}
