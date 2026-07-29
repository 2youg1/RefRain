<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used only in the template.
// The Connections surface (SPEC 8.3a 引导式接入): every channel is declared
// in the one Config, PATH detection only offers candidates, and a probe is a
// version check — never a model call. Each row shows what the author needs
// to judge the channel: state (已登记/候选), version after probe, and what
// the agent has read (阅读账本).
import { onMounted, ref } from "vue";
import { describe, unwrap } from "../bridge";
import {
  type AgentReadingDto,
  type ConfigSnapshot,
  commands,
  type HarnessConnection,
  type HarnessDto,
} from "../generated/bindings.gen";

const props = defineProps<{
  rootId?: string;
}>();

const emit = defineEmits<{ closed: [] }>();

const connections = ref<HarnessConnection[]>([]);
const detected = ref<HarnessDto[]>([]);
const versions = ref<Record<string, string>>({});
const ledger = ref<AgentReadingDto[]>([]);
const executable = ref("");
const notice = ref<string | null>(null);
const busy = ref(false);

const fail = (error: unknown): void => {
  notice.value = describe(error);
};

const refresh = async (): Promise<void> => {
  try {
    const snapshot: ConfigSnapshot = await unwrap(commands.readConfig());
    connections.value = snapshot.config.harness_connections ?? [];
    detected.value = await unwrap(commands.listHarnesses());
    if (props.rootId) {
      ledger.value = await unwrap(commands.agentReadingLedger(props.rootId));
    }
  } catch (error) {
    fail(error);
  }
};

const probe = async (target: string): Promise<void> => {
  if (busy.value) return;
  busy.value = true;
  notice.value = null;
  try {
    const version = await unwrap(commands.probeConnection(target));
    versions.value = { ...versions.value, [target]: version };
  } catch (error) {
    fail(error);
  } finally {
    busy.value = false;
  }
};

const register = async (target: string): Promise<void> => {
  if (busy.value || target.trim().length === 0) return;
  busy.value = true;
  notice.value = null;
  try {
    const snapshot: ConfigSnapshot = await unwrap(commands.upsertHarnessConnection(target.trim()));
    connections.value = snapshot.config.harness_connections ?? [];
    executable.value = "";
    notice.value = "已登记";
    detected.value = await unwrap(commands.listHarnesses());
  } catch (error) {
    fail(error);
  } finally {
    busy.value = false;
  }
};

const remove = async (id: string): Promise<void> => {
  if (busy.value) return;
  busy.value = true;
  notice.value = null;
  try {
    const snapshot = await unwrap(commands.removeHarnessConnection(id));
    connections.value = snapshot.config.harness_connections ?? [];
    notice.value = "已删";
    detected.value = await unwrap(commands.listHarnesses());
  } catch (error) {
    fail(error);
  } finally {
    busy.value = false;
  }
};

const readingOf = (agentId: string): AgentReadingDto | null =>
  ledger.value.find((row) => row.agentId === agentId) ?? null;

const isRegistered = (harness: HarnessDto): boolean =>
  connections.value.some((connection) => connection.executable === harness.probe.program);

onMounted(refresh);
</script>

<template>
  <section class="connections" aria-label="连接">
    <h2 class="conn-title">连接</h2>
    <p class="conn-hint">登记即接入 harness；探测只查版本，不触模型。</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <div v-for="connection in connections" :key="connection.id" class="conn-row">
      <span class="state on">已登记</span>
      <span class="peek">{{ connection.executable }}</span>
      <span class="version">{{ versions[connection.executable] ?? "未探测" }}</span>
      <span v-if="readingOf(connection.id)" class="reading">
        {{ readingOf(connection.id)?.rounds }} 轮 ·
        {{ readingOf(connection.id)?.stale ? "落后" : "同步" }}
      </span>
      <button type="button" :disabled="busy" @click="probe(connection.executable)">探测</button>
      <button type="button" class="conn-remove" :disabled="busy" @click="remove(connection.id)">
        删除
      </button>
    </div>

    <div v-for="harness in detected" :key="harness.agentId" class="conn-row">
      <template v-if="!isRegistered(harness)">
        <span class="state">候选</span>
        <span class="peek">{{ harness.label }} · {{ harness.version }}</span>
        <span v-if="readingOf(harness.agentId)" class="reading">
          {{ readingOf(harness.agentId)?.rounds }} 轮 ·
          {{ readingOf(harness.agentId)?.stale ? "落后" : "同步" }}
        </span>
        <button type="button" :disabled="busy" @click="register(harness.probe.program)">登记</button>
      </template>
    </div>
    <p v-if="connections.length === 0 && detected.length === 0" class="dim">
      PATH 上没有候选；把可执行文件的完整路径贴进来。
    </p>

    <div class="conn-add">
      <input
        v-model="executable"
        class="conn-input"
        placeholder="可执行文件路径"
        @keydown.enter="register(executable)"
      />
      <button type="button" :disabled="busy" @click="register(executable)">添加</button>
    </div>

    <button type="button" class="conn-close" @click="emit('closed')">收起</button>
  </section>
</template>

<style scoped>
.connections {
  border-left: 1px solid var(--rule);
  background: var(--paper-raised);
  padding: 20px 24px;
  font-size: 13px;
  width: 480px;
  max-width: 56vw;
  overflow-y: auto;
}

.conn-title {
  font-size: 18px;
  font-weight: 400;
  letter-spacing: 0.3em;
  margin: 0 0 6px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--rule);
}

.conn-hint {
  color: var(--ink-ghost);
  font-size: 12px;
  margin: 8px 0;
}

.notice {
  color: var(--pending);
}

.dim {
  color: var(--ink-ghost);
}

.conn-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 5px 0;
  border-bottom: 1px solid color-mix(in oklab, var(--ink) 6%, transparent);
}

.state {
  flex: none;
  font-size: 11px;
  color: var(--ink-ghost);
  border: 1px solid var(--rule);
  border-radius: 3px;
  padding: 1px 6px;
}

.state.on {
  color: var(--accepted);
  border-color: color-mix(in oklab, var(--accepted) 40%, transparent);
  background: var(--accepted-wash);
}

.conn-row .peek {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.version {
  color: var(--ink-faint);
  font-variant-numeric: tabular-nums;
}

.reading {
  color: var(--ink-faint);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}

.conn-add {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.conn-input {
  flex: 1;
  font: inherit;
  padding: 6px 8px;
  border: 1px solid var(--rule);
  border-radius: 3px;
  background: transparent;
  color: inherit;
}

.conn-close {
  margin-top: 12px;
  color: var(--ink-faint);
}
</style>
