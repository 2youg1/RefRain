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
  type BlockDto,
  commands,
  type DispatchPreviewDto,
  type HostStateDto,
  type RunDto,
} from "../generated/bindings.gen";

const props = defineProps<{
  rootId: string;
  path: string;
  blocks: BlockDto[];
}>();

const emit = defineEmits<{ collected: [count: number]; closed: [] }>();

type Phase = { kind: "editing" } | { kind: "previewing" } | { kind: "dispatched" };

const selected = ref<Set<string>>(new Set());
const prompt = ref("");
const agentId = ref<string | null>(null);
const agents = ref<{ id: string; label: string }[]>([]);
const taskId = ref<string | null>(null);
const phase = ref<Phase>({ kind: "editing" });
const preview = ref<DispatchPreviewDto | null>(null);
const host = ref<HostStateDto | null>(null);
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
    blocker:
      scope === 0
        ? "先勾选要交出去的段落。"
        : requirement === 0
          ? "写下这次要 Agent 做什么。"
          : agent
            ? null
            : "通道尚未就绪。",
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
  } catch (error) {
    fail(error);
  }
};

const toggle = (id: string): void => {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
};

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
      commands.previewDispatch(props.rootId, props.path, scopeIds.value, prompt.value.trim()),
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
        prompt: prompt.value.trim(),
        clickedDigest: preview.value.digest,
        newAgents: [agentId.value],
        retryRunIds: [],
      }),
    );
    for (const run of runs) {
      await unwrap(commands.launchRun(props.rootId, run.id));
    }
    preview.value = null;
    phase.value = { kind: "dispatched" };
    notice.value = `请求已落到 ${runs[0]?.workspace ?? "runs/"}。把结果写进其中的 attempts 目录后回来收取。`;
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
      notice.value = "还没有结果：等 Agent 把 <agent-result> 写进 result.md 再收。";
    } else if (outcome.kind === "completed") {
      notice.value = `Run 完成：${outcome.value.proposals} 条提案已冻结，去 Review 裁决。`;
      emit("collected", outcome.value.proposals);
    } else {
      notice.value = `Run 失败（${outcome.value.code}）：${outcome.value.detail}。可重试——新 Run、新授权。`;
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
      commands.previewDispatch(props.rootId, props.path, scopeIds.value, prompt.value.trim()),
    );
    await unwrap(
      commands.authorizeDispatch({
        rootId: props.rootId,
        taskId: queued.taskId,
        path: props.path,
        blockIds: scopeIds.value,
        prompt: prompt.value.trim(),
        clickedDigest: again.digest,
        newAgents: [],
        retryRunIds: [queued.id],
      }),
    );
    await unwrap(commands.launchRun(props.rootId, queued.id));
    notice.value = "已用新 Run 重发；旧 Run 留档不动。";
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

const tokenLabel = (tokens: { kind: string; value?: number }): string => {
  if (tokens.kind === "actual") return `token 实报 ${tokens.value}`;
  if (tokens.kind === "estimated") return `token 预估约 ${tokens.value}`;
  return "token 未知";
};

const runStatusLabel = (run: RunDto): string => {
  const labels: Record<string, string> = {
    queued: "排队中",
    authorized: "已授权未启动",
    launching: "启动中",
    dispatched: "已发出，等结果",
    completed: "已完成",
    failed: `失败：${run.failure ?? ""}`,
    cancelled: "已取消",
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
  <section class="dispatch" aria-label="発送票">
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
    <p v-if="cells.blocker && phase.kind === 'editing'" class="blocker">{{ cells.blocker }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <template v-if="phase.kind === 'editing'">
      <div class="blocks">
        <div class="blocks-head">
          <span>选入 scope 的块</span>
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
      <div class="agent-row" v-if="agents.length > 1">
        <span>委托给</span>
        <select v-model="agentId" class="dispatch-agent">
          <option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.label }}</option>
        </select>
      </div>
      <textarea
        v-model="prompt"
        class="dispatch-prompt"
        rows="4"
        placeholder="这次要 Agent 做什么——逐字进入请求文件。"
      ></textarea>
    </template>

    <template v-else-if="phase.kind === 'previewing' && preview">
      <div class="manifest">
        <p class="manifest-title">发送清单 · digest {{ preview.digest.slice(0, 12) }}…</p>
        <div v-for="entry in preview.manifest" :key="entry.section + entry.source" class="manifest-row">
          <span class="section">{{ entry.section }} · {{ entry.source }}</span>
          <span class="bytes">{{ entry.bytes }} B</span>
          <span class="tokens">{{ tokenLabel(entry.tokens) }}</span>
        </div>
        <button type="button" class="dispatch-expand" @click="showRequest = !showRequest">
          {{ showRequest ? "收起请求原文" : "展开请求原文" }}
        </button>
        <pre v-if="showRequest" class="request-md">{{ preview.requestMd }}</pre>
        <div class="actions">
          <button class="dispatch-authorize" type="button" :disabled="busy" @click="authorize">
            确认授权
          </button>
          <button type="button" :disabled="busy" @click="phase = { kind: 'editing' }">返回</button>
        </div>
      </div>
    </template>

    <template v-if="runs.length > 0">
      <div class="runs">
        <p class="runs-title">Run 列表</p>
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
              重试（新 Run）
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

    <button type="button" class="dispatch-close" @click="emit('closed')">收起発送票</button>
    <button v-if="phase.kind === 'dispatched'" type="button" class="dispatch-new" @click="newTask">
      新 Task
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
