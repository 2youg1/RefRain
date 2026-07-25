<script lang="ts">
import type { ChapterView, ProposalView, RunView, VerdictView } from "./api.ts";
import { api } from "./api.ts";
import Dispatch from "./Dispatch.svelte";
import Ledger from "./Ledger.svelte";
import Review from "./Review.svelte";

let root = $state<string | null>(null);
let chapters = $state<ChapterView[]>([]);
let active = $state<string | null>(null);
let text = $state("");
let selection = $state("");
let panel = $state<"dispatch" | "review" | "ledger">("dispatch");

let proposals = $state<ProposalView[]>([]);
let comments = $state<{ target: string; text: string }[]>([]);
let runs = $state<RunView[]>([]);
let refusal = $state<{ reason: string; detail: string[] } | null>(null);
let saved = $state(true);

const open = async (): Promise<void> => {
  const chosen = await api().openProject();
  if (!chosen) return;
  root = chosen;
  chapters = await api().loadProject(chosen);
  select(chapters[0]?.title ?? null);
};

const select = (title: string | null): void => {
  active = title;
  text = chapters.find((c) => c.title === title)?.text ?? "";
  saved = true;
};

const save = async (): Promise<void> => {
  if (!root || !active) return;
  await api().saveChapter(root, active, text);
  chapters = chapters.map((c) => (c.title === active ? { ...c, text } : c));
  saved = true;
};

const captureSelection = (): void => {
  selection = window.getSelection()?.toString() ?? "";
};

const refresh = async (): Promise<void> => {
  if (!root) return;
  runs = await api().runs(root);
};

const collect = async (runId: string): Promise<void> => {
  if (!root) return;
  try {
    const result = await api().collect(root, runId);
    proposals = [...proposals, ...result.proposals];
    comments = [...comments, ...result.comments];
    panel = "review";
  } catch (error) {
    refusal = { reason: "结果无法解析", detail: [String(error)] };
  }
  await refresh();
};

const commit = async (verdicts: VerdictView[]): Promise<void> => {
  if (!root || !active) return;
  refusal = null;
  const result = await api().commit(root, { chapter: active, verdicts });
  if (!result.ok) {
    refusal = { reason: result.reason, detail: result.detail };
    return;
  }
  text = result.text;
  chapters = chapters.map((c) => (c.title === active ? { ...c, text: result.text } : c));
  proposals = proposals.filter((p) => !verdicts.some((v) => v.proposalId === p.id));
  saved = true;
};

// Ctrl/Cmd+S saves. Autosave is deliberately absent: a save is an act.
const onKeydown = (event: KeyboardEvent): void => {
  if ((event.ctrlKey || event.metaKey) && event.key === "s") {
    event.preventDefault();
    void save();
  }
};
</script>

<svelte:window on:keydown={onKeydown} />

{#if root === null}
  <main class="welcome">
    <h1>Recension</h1>
    <p>校勘：多个抄本送到面前，由一个人裁决，裁决被记录下来。</p>
    <button class="open" onclick={open}>打开一个项目文件夹</button>
    <p class="fine">
      项目就是一个装着 Markdown 文件的普通文件夹。这个程序不联网、不上传、不需要账号。
    </p>
  </main>
{:else}
  <div class="shell">
    <nav class="chapters">
      <header>
        <span class="label">章节</span>
        <button title="换一个项目" onclick={open}>切换</button>
      </header>
      {#each chapters as chapter (chapter.title)}
        <button class="chapter" class:on={chapter.title === active} onclick={() => select(chapter.title)}>
          {chapter.title}
        </button>
      {/each}
      {#if chapters.length === 0}
        <p class="hint">这个文件夹里还没有 .md 文件。</p>
      {/if}
    </nav>

    <main class="writing">
      <header class="bar">
        <span class="title">{active ?? "未选择章节"}</span>
        <span class="state">{saved ? "已保存" : "未保存 · Ctrl+S"}</span>
      </header>
      <div
        class="manuscript"
        role="textbox"
        tabindex="0"
        aria-multiline="true"
        aria-label="正文"
        contenteditable="plaintext-only"
        spellcheck="false"
        bind:innerText={text}
        oninput={() => (saved = false)}
        onmouseup={captureSelection}
        onkeyup={captureSelection}
      ></div>
    </main>

    <aside class="collab">
      <nav class="tabs">
        <button class:on={panel === "dispatch"} onclick={() => (panel = "dispatch")}>派发</button>
        <button class:on={panel === "review"} onclick={() => (panel = "review")}>
          审阅{proposals.length > 0 ? ` · ${proposals.length}` : ""}
        </button>
        <button class:on={panel === "ledger"} onclick={() => (panel = "ledger")}>账本</button>
      </nav>

      <div class="panel">
        {#if panel === "dispatch"}
          <Dispatch
            {root}
            chapter={active}
            {selection}
            {runs}
            onDispatched={refresh}
            onCollect={collect}
          />
        {:else if panel === "review"}
          <Review {proposals} {comments} onCommit={commit} {refusal} />
        {:else}
          <Ledger {root} />
        {/if}
      </div>
    </aside>
  </div>
{/if}

<style>
  .welcome {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    gap: 1rem;
    text-align: center;
    padding: 2rem;
  }

  .welcome h1 {
    font-family: var(--serif);
    font-size: 2.4rem;
    font-weight: 500;
    letter-spacing: 0.02em;
  }

  .welcome p {
    color: var(--ink-soft);
    font-family: var(--serif);
    max-width: 30em;
  }

  .welcome .fine {
    font-size: 12px;
    color: var(--ink-faint);
    font-family: var(--sans);
    margin-top: 0.5rem;
  }

  .open {
    margin-top: 0.75rem;
    padding: 0.6rem 1.4rem;
    background: var(--ink);
    color: var(--paper-raised);
    border-radius: 3px;
    font-size: 13px;
  }

  .shell {
    display: grid;
    grid-template-columns: 210px minmax(0, 1fr) 420px;
    height: 100vh;
  }

  .chapters {
    border-right: 1px solid var(--rule);
    padding: 2.2rem 0.6rem 1rem;
    overflow-y: auto;
    background: linear-gradient(180deg, var(--paper), #f6f4f0);
  }

  .chapters header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 0.5rem 0.6rem;
  }

  .chapters header button {
    font-size: 11px;
    color: var(--ink-faint);
  }

  .chapters header button:hover {
    color: var(--seal);
  }

  .chapter {
    display: block;
    width: 100%;
    text-align: left;
    padding: 0.45rem 0.6rem;
    border-radius: 3px;
    font-size: 13px;
    color: var(--ink-soft);
  }

  .chapter:hover {
    background: rgb(0 0 0 / 0.03);
  }

  .chapter.on {
    background: var(--paper-raised);
    color: var(--ink);
    box-shadow: inset 2px 0 0 var(--seal);
  }

  .hint {
    padding: 1rem 0.6rem;
    font-size: 12px;
    color: var(--ink-faint);
  }

  .writing {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }

  .bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.65rem 2rem;
    border-bottom: 1px solid var(--rule);
    -webkit-app-region: drag;
  }

  .title {
    font-family: var(--serif);
    font-size: 14px;
  }

  .state {
    font-size: 11px;
    color: var(--ink-faint);
  }

  .writing > .manuscript {
    flex: 1;
    overflow-y: auto;
    width: 100%;
    padding-left: 2rem;
    padding-right: 2rem;
  }

  .collab {
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--rule);
    background: #f6f4f0;
    min-width: 0;
    position: relative;
  }

  .tabs {
    display: flex;
    gap: 0.15rem;
    padding: 0.5rem 0.6rem 0;
    border-bottom: 1px solid var(--rule);
    padding-top: 2.2rem;
  }

  .tabs button {
    padding: 0.45rem 0.8rem;
    font-size: 12px;
    color: var(--ink-faint);
    border-radius: 3px 3px 0 0;
    border-bottom: 2px solid transparent;
  }

  .tabs button.on {
    color: var(--ink);
    border-bottom-color: var(--seal);
  }

  .panel {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    position: relative;
  }
</style>
