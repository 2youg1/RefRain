<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used only in
// the template are real usage; biome does not parse Vue templates.
// The dispatch ticket (SPEC 9.6): scope → prompt → agent → range → send, the
// manifest the author reads, the click that authorizes, and the L0 file
// channel's collect. Nothing here derives state Rust owns; every fact comes
// back over the bridge.

import { computed, onMounted, onUnmounted, ref } from "vue";
import { describe, unwrap } from "../bridge";
import {
  type AgentReadingDto,
  type BlockDto,
  commands,
  type DispatchPreviewDto,
  type DocumentRow,
  type HostStateDto,
  type MaterialDraftRow_Serialize,
  type RunDto,
} from "../generated/bindings.gen";

const props = defineProps<{
  rootId: string;
  path: string;
  blocks: BlockDto[];
  materials: { path: string; label: string }[];
}>();

const emit = defineEmits<{
  collected: [count: number];
  materialSaved: [row: DocumentRow];
  closed: [];
}>();

type Phase = { kind: "editing" } | { kind: "previewing" } | { kind: "dispatched" };

const selected = ref<Set<string>>(new Set());
const materialsSelected = ref<Set<string>>(new Set());
const prompt = ref("");
const agentId = ref<string | null>(null);
const agents = ref<{ id: string; label: string }[]>([]);
const copies = ref(1);
const taskId = ref<string | null>(null);
const phase = ref<Phase>({ kind: "editing" });
const preview = ref<DispatchPreviewDto | null>(null);
const host = ref<HostStateDto | null>(null);
const ledger = ref<AgentReadingDto[]>([]);
const drafts = ref<MaterialDraftRow_Serialize[]>([]);
const editingDraft = ref<string | null>(null);
const editedBody = ref("");
const notice = ref<string | null>(null);
const busy = ref(false);
const showRequest = ref(false);
let poll: number | null = null;

const fail = (error: unknown): void => {
  notice.value = describe(error);
};

const scopeIds = computed<string[]>(() =>
  props.blocks.filter((block) => selected.value.has(block.id)).map((block) => block.id),
);

// The five cells (SPEC 9.6): each shows its value when met, — when not, and
// only the first blocker speaks.
const cells = computed(() => {
  const scope = selected.value.size;
  const requirement = prompt.value.trim().length;
  const agent = agents.value.find((candidate) => candidate.id === agentId.value) ?? null;
  return {
    scope: scope > 0 ? `${scope} 块` : "—",
    requirement: requirement > 0 ? `${requirement} 字` : "—",
    agent: agent ? agent.label : "—",
    range: scope > 0 ? `所选 ${scope} 块` : "—",
    ready: scope > 0 && requirement > 0 && agent,
  };
});

const runs = computed<RunDto[]>(() => {
  if (!host.value) return [];
  const taskIds = new Set(
    host.value.tasks.filter((task) => task.document === props.path).map((task) => task.id),
  );
  return host.value.runs.filter((run) => taskIds.has(run.taskId));
});

const refresh = async (): Promise<void> => {
  try {
    host.value = await unwrap(commands.hostState(props.rootId));
    drafts.value = await unwrap(commands.listMaterialDrafts(props.rootId));
    ledger.value = await unwrap(commands.agentReadingLedger(props.rootId));
  } catch (error) {
    fail(error);
  }
};

// The ticket's top hint (C12): what the picked agent has read of this
// document, and whether the manuscript has moved since.
const reading = computed<AgentReadingDto | null>(
  () =>
    ledger.value.find((row) => row.agentId === agentId.value && row.document === props.path) ??
    null,
);

const toggle = (id: string): void => {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
};

const toggleMaterial = (path: string): void => {
  const next = new Set(materialsSelected.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  materialsSelected.value = next;
};

const materialPaths = computed<string[]>(() =>
  props.materials
    .filter((material) => materialsSelected.value.has(material.path))
    .map((material) => material.path),
);

const wholeChapter = (): void => {
  selected.value = new Set(props.blocks.map((block) => block.id));
};

const send = async (): Promise<void> => {
  if (!cells.value.ready || busy.value) return;
  busy.value = true;
  notice.value = null;
  try {
    const task = await unwrap(
      commands.draftReviewTask(props.rootId, props.path, prompt.value.trim()),
    );
    taskId.value = task.id;
    preview.value = await unwrap(
      commands.previewDispatch(
        props.rootId,
        props.path,
        scopeIds.value,
        materialPaths.value,
        prompt.value.trim(),
      ),
    );
    phase.value = { kind: "previewing" };
  } catch (error) {
    fail(error);
  } finally {
    busy.value = false;
  }
};

const authorize = async (): Promise<void> => {
  if (!preview.value || !taskId.value || !agentId.value || busy.value) return;
  busy.value = true;
  notice.value = null;
  try {
    const runs = await unwrap(
      commands.authorizeDispatch({
        rootId: props.rootId,
        taskId: taskId.value,
        path: props.path,
        blockIds: scopeIds.value,
        materialPaths: materialPaths.value,
        prompt: prompt.value.trim(),
        clickedDigest: preview.value.digest,
        newAgents: Array.from({ length: copies.value }, () => agentId.value as string),
        retryRunIds: [],
      }),
    );
    for (const run of runs) {
      await unwrap(commands.launchRun(props.rootId, run.id));
    }
    preview.value = null;
    phase.value = { kind: "dispatched" };
    notice.value =
      runs.length > 1
        ? `已发出 · 并行 ×${runs.length}`
        : `已发出 → ${runs[0]?.workspace ?? "runs/"}`;
    await refresh();
  } catch (error) {
    fail(error);
  } finally {
    busy.value = false;
  }
};

const newTask = (): void => {
  phase.value = { kind: "editing" };
  taskId.value = null;
  preview.value = null;
  selected.value = new Set();
  prompt.value = "";
  notice.value = null;
};

const collect = async (run: RunDto): Promise<void> => {
  if (busy.value) return;
  busy.value = true;
  notice.value = null;
  try {
    const outcome = await unwrap(commands.collectAttempt(props.rootId, run.id));
    if (outcome.kind === "waiting") {
      notice.value = "未回";
    } else if (outcome.kind === "completed") {
      const got = outcome.value;
      notice.value =
        got.drafts > 0
          ? `已收 · ${got.proposals} 提案 · ${got.drafts} 草稿`
          : `已收 · ${got.proposals} 提案`;
      emit("collected", got.proposals);
    } else {
      notice.value = `失败 · ${outcome.value.code}`;
    }
    await refresh();
  } catch (error) {
    fail(error);
  } finally {
    busy.value = false;
  }
};

const retry = async (run: RunDto): Promise<void> => {
  if (busy.value || !agentId.value) return;
  busy.value = true;
  notice.value = null;
  try {
    const queued = await unwrap(commands.retryRun(props.rootId, run.id));
    const again = await unwrap(
      commands.previewDispatch(
        props.rootId,
        props.path,
        scopeIds.value,
        materialPaths.value,
        prompt.value.trim(),
      ),
    );
    await unwrap(
      commands.authorizeDispatch({
        rootId: props.rootId,
        taskId: queued.taskId,
        path: props.path,
        blockIds: scopeIds.value,
        materialPaths: materialPaths.value,
        prompt: prompt.value.trim(),
        clickedDigest: again.digest,
        newAgents: [],
        retryRunIds: [queued.id],
      }),
    );
    await unwrap(commands.launchRun(props.rootId, queued.id));
    notice.value = "已重发";
    await refresh();
  } catch (error) {
    fail(error);
  } finally {
    busy.value = false;
  }
};

const cancel = async (run: RunDto): Promise<void> => {
  if (busy.value) return;
  busy.value = true;
  try {
    await unwrap(commands.cancelRun(props.rootId, run.id));
    await refresh();
  } catch (error) {
    fail(error);
  } finally {
    busy.value = false;
  }
};

// A draft becomes a Material only through these two clicks (SPEC 8.7): save
// (as written or after the author's own edit) or dismiss. Nothing else may.
const saveDraft = async (draft: MaterialDraftRow_Serialize): Promise<void> => {
  if (busy.value) return;
  busy.value = true;
  notice.value = null;
  try {
    const body = editingDraft.value === draft.id ? editedBody.value : null;
    const row = await unwrap(commands.commitMaterialAction(props.rootId, draft.id, body, false));
    if (row !== null) emit("materialSaved", row);
    editingDraft.value = null;
    notice.value = "已存";
    await refresh();
  } catch (error) {
    fail(error);
  } finally {
    busy.value = false;
  }
};

const dismissDraft = async (draft: MaterialDraftRow_Serialize): Promise<void> => {
  if (busy.value) return;
  busy.value = true;
  notice.value = null;
  try {
    await unwrap(commands.commitMaterialAction(props.rootId, draft.id, null, true));
    if (editingDraft.value === draft.id) editingDraft.value = null;
    notice.value = "已退";
    await refresh();
  } catch (error) {
    fail(error);
  } finally {
    busy.value = false;
  }
};

const startEdit = (draft: MaterialDraftRow_Serialize): void => {
  editingDraft.value = draft.id;
  editedBody.value = draft.body;
};

const tokenLabel = (tokens: { kind: string; value?: number }): string => {
  if (tokens.kind === "actual") return `token 实报 ${tokens.value}`;
  if (tokens.kind === "estimated") return `token 预估约 ${tokens.value}`;
  return "token 未知";
};

const runStatusLabel = (run: RunDto): string => {
  const labels: Record<string, string> = {
    queued: "排队",
    authorized: "已授权",
    launching: "启动",
    dispatched: "在途",
    completed: "完成",
    failed: `失败：${run.failure ?? ""}`,
    cancelled: "取消",
  };
  return labels[run.progress] ?? run.progress;
};

onMounted(async () => {
  try {
    const l0 = await commands.l0FileChannelAgent();
    agents.value = [{ id: l0, label: "L0 文件通道" }];
    for (const harness of await commands.listHarnesses()) {
      agents.value.push({
        id: harness.agentId,
        label: `${harness.label} · ${harness.version}`,
      });
    }
    agentId.value = l0;
  } catch (error) {
    fail(error);
  }
  await refresh();
  // In-flight runs settle off-thread; while any exist, poll the journal.
  poll = window.setInterval(() => {
    if (
      host.value?.runs.some((run) =>
        ["authorized", "launching", "dispatched"].includes(run.progress),
      )
    ) {
      void refresh();
    }
  }, 2_500);
});

onUnmounted(() => {
  if (poll !== null) window.clearInterval(poll);
});
</script>

<template>
  <section class="dispatch" aria-label="派发">
    <header class="ticket">
      <div class="cell"><span class="name">段落</span><span class="value">{{ cells.scope }}</span></div>
      <div class="cell"><span class="name">要求</span><span class="value">{{ cells.requirement }}</span></div>
      <div class="cell"><span class="name">委托</span><span class="value">{{ cells.agent }}</span></div>
      <div class="cell"><span class="name">范围</span><span class="value">{{ cells.range }}</span></div>
      <div class="cell send">
        <button
          class="dispatch-send"
          type="button"
          :disabled="!cells.ready || busy"
          @click="send"
        >
          送出
        </button>
      </div>
    </header>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <template v-if="phase.kind === 'editing'">
      <div class="blocks">
        <div class="blocks-head">
          <span>段落</span>
          <button type="button" class="dispatch-whole" @click="wholeChapter">整章</button>
        </div>
        <label v-for="(block, index) in blocks" :key="block.id" class="block-row">
          <input
            type="checkbox"
            :checked="selected.has(block.id)"
            @change="toggle(block.id)"
          />
          <span class="ordinal">b{{ index + 1 }}</span>
          <span class="peek">{{ block.text.slice(0, 20) }}</span>
          <span class="count">{{ block.text.length }} 字</span>
        </label>
      </div>
      <div class="blocks" v-if="materials.length > 0">
        <div class="blocks-head"><span>资料</span></div>
        <label v-for="material in materials" :key="material.path" class="material-row">
          <input
            type="checkbox"
            :checked="materialsSelected.has(material.path)"
            @change="toggleMaterial(material.path)"
          />
          <span class="peek">{{ material.label }}</span>
        </label>
      </div>
      <div class="agent-row" v-if="agents.length > 0">
        <select v-if="agents.length > 1" v-model="agentId" class="dispatch-agent">
          <option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.label }}</option>
        </select>
        <span class="copies">
          <select v-model.number="copies" class="dispatch-copies" aria-label="份数">
            <option :value="1">×1</option>
            <option :value="2">并行 ×2</option>
            <option :value="3">并行 ×3</option>
          </select>
        </span>
        <span v-if="reading" class="reading">
          {{ reading.rounds }} 轮 · {{ reading.stale ? "落后" : "同步" }}
        </span>
      </div>
      <textarea
        v-model="prompt"
        class="dispatch-prompt"
        rows="4"
        placeholder="要求"
      ></textarea>
    </template>

    <div class="blocks" v-if="drafts.length > 0">
      <div class="blocks-head"><span>草稿</span></div>
      <div v-for="draft in drafts" :key="draft.id" class="draft-row">
        <div class="draft-line">
          <span class="peek">{{ draft.title }}</span>
          <button type="button" class="draft-save" :disabled="busy" @click="saveDraft(draft)">
            保存
          </button>
          <button
            type="button"
            class="draft-edit"
            :disabled="busy"
            @click="editingDraft === draft.id ? (editingDraft = null) : startEdit(draft)"
          >
            改
          </button>
          <button type="button" class="draft-dismiss" :disabled="busy" @click="dismissDraft(draft)">
            退回
          </button>
        </div>
        <textarea
          v-if="editingDraft === draft.id"
          v-model="editedBody"
          class="draft-body"
          rows="6"
        ></textarea>
        <span v-else class="peek draft-peek">{{ draft.body.slice(0, 40) }}</span>
      </div>
    </div>

    <template v-else-if="phase.kind === 'previewing' && preview">
      <div class="manifest">
        <p class="manifest-title">清单 · {{ preview.digest.slice(0, 12) }}</p>
        <div v-for="entry in preview.manifest" :key="entry.section + entry.source" class="manifest-row">
          <span class="section">{{ entry.section }} · {{ entry.source }}</span>
          <span class="bytes">{{ entry.bytes }} B</span>
          <span class="tokens">{{ tokenLabel(entry.tokens) }}</span>
        </div>
        <button type="button" class="dispatch-expand" @click="showRequest = !showRequest">
          {{ showRequest ? "收" : "原文" }}
        </button>
        <pre v-if="showRequest" class="request-md">{{ preview.requestMd }}</pre>
        <div class="actions">
          <button class="dispatch-authorize" type="button" :disabled="busy" @click="authorize">
            授权
          </button>
          <button type="button" :disabled="busy" @click="phase = { kind: 'editing' }">返回</button>
        </div>
      </div>
    </template>

    <template v-if="runs.length > 0">
      <div class="runs">

        <div v-for="run in runs" :key="run.id" class="run-row">
          <span class="status">{{ runStatusLabel(run) }}</span>
          <code v-if="run.workspace" class="workspace">{{ run.workspace }}</code>
          <span class="run-actions">
            <button
              v-if="run.progress === 'dispatched'"
              class="dispatch-collect"
              type="button"
              :disabled="busy"
              @click="collect(run)"
            >
              收取
            </button>
            <button
              v-if="run.progress === 'failed' || run.progress === 'cancelled'"
              class="dispatch-retry"
              type="button"
              :disabled="busy"
              @click="retry(run)"
            >
              重试
            </button>
            <button
              v-if="run.progress !== 'completed' && run.progress !== 'failed' && run.progress !== 'cancelled'"
              type="button"
              :disabled="busy"
              @click="cancel(run)"
            >
              取消
            </button>
          </span>
        </div>
      </div>
    </template>

    <button type="button" class="dispatch-close" @click="emit('closed')">收起</button>
    <button v-if="phase.kind === 'dispatched'" type="button" class="dispatch-new" @click="newTask">
      再发
    </button>
  </section>
</template>

<style>
.dispatch {
  border-left: 1px solid color-mix(in oklab, currentColor 12%, transparent);
  padding: 12px 16px;
  font-size: 13px;
  max-width: 520px;
  min-width: 360px;
  overflow-y: auto;
}

.ticket {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 6px;
  margin-bottom: 8px;
}

.cell {
  border: 1px solid color-mix(in oklab, currentColor 16%, transparent);
  border-radius: 4px;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cell .name {
  opacity: 0.6;
  font-size: 11px;
}

.cell .value {
  font-variant-numeric: tabular-nums;
}

.cell.send {
  padding: 0;
  border: none;
}

.dispatch-send {
  all: unset;
  cursor: pointer;
  text-align: center;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  border-radius: 4px;
  background: color-mix(in oklab, currentColor 14%, transparent);
}

.dispatch-send:disabled {
  opacity: 0.35;
  cursor: default;
}

.blocker {
  color: #8a4b00;
}

.notice {
  color: #8a4b00;
}

.blocks {
  margin: 8px 0;
  max-height: 40vh;
  overflow-y: auto;
  border-top: 1px solid color-mix(in oklab, currentColor 10%, transparent);
}

.blocks-head {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  opacity: 0.7;
}

.block-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 3px 0;
  cursor: pointer;
}

.block-row .ordinal {
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
}

.block-row .peek {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.block-row .count {
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
}

.material-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 3px 0;
  cursor: pointer;
}

.material-row .peek {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.draft-row {
  padding: 3px 0;
}

.draft-line {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.draft-line .peek {
  flex: 1;
}

.draft-peek {
  display: block;
  opacity: 0.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.draft-body {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  padding: 8px;
  border: 1px solid color-mix(in oklab, currentColor 16%, transparent);
  border-radius: 4px;
  background: transparent;
  color: inherit;
  resize: vertical;
}

.dispatch-prompt {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  padding: 8px;
  border: 1px solid color-mix(in oklab, currentColor 16%, transparent);
  border-radius: 4px;
  background: transparent;
  color: inherit;
  resize: vertical;
}

.agent-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin: 8px 0;
}

.reading {
  margin-left: auto;
  opacity: 0.6;
  font-variant-numeric: tabular-nums;
}

.dispatch-agent {
  font: inherit;
  background: transparent;
  color: inherit;
  border: 1px solid color-mix(in oklab, currentColor 16%, transparent);
  border-radius: 4px;
  padding: 4px 8px;
}

.manifest {
  margin: 8px 0;
}

.manifest-title {
  font-size: 12px;
  opacity: 0.7;
}

.manifest-row {
  display: flex;
  gap: 12px;
  padding: 3px 0;
  font-variant-numeric: tabular-nums;
}

.manifest-row .section {
  flex: 1;
}

.request-md {
  max-height: 30vh;
  overflow: auto;
  font-size: 12px;
  padding: 8px;
  border: 1px solid color-mix(in oklab, currentColor 10%, transparent);
  white-space: pre-wrap;
}

.actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.runs {
  margin-top: 12px;
  border-top: 1px solid color-mix(in oklab, currentColor 10%, transparent);
}

.runs-title {
  font-size: 12px;
  opacity: 0.7;
}

.run-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 4px 0;
}

.run-row .status {
  flex: 1;
}

.run-row .workspace {
  font-size: 11px;
  opacity: 0.6;
}

.run-actions {
  display: flex;
  gap: 6px;
}

.dispatch-close {
  margin-top: 12px;
  opacity: 0.6;
}
</style>
