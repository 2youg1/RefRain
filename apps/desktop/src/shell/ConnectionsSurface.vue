<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used only in
// the template are real usage; biome does not parse Vue templates.
// The Connections surface (SPEC 8.3a 引导式接入): every channel is declared
// in the one Config, PATH detection only offers candidates, and a probe is a
// version check — never a model call. Trust evidence lives in app.db (Q24),
// not on this page.

import { onMounted, ref } from "vue";
import { describe, unwrap } from "../bridge";
import {
  type ConfigSnapshot,
  commands,
  type HarnessConnection,
  type HarnessDto,
} from "../generated/bindings.gen";

const emit = defineEmits<{ closed: [] }>();

const connections = ref<HarnessConnection[]>([]);
const detected = ref<HarnessDto[]>([]);
const versions = ref<Record<string, string>>({});
const executable = ref("");
const notice = ref<string | null>(null);
const busy = ref(false);

const fail = (error: unknown): void => {
  notice.value = describe(error);
};

const refresh = async (): Promise<void> => {
  try {
    const snapshot = await unwrap(commands.readConfig());
    connections.value = snapshot.config.harness_connections ?? [];
    detected.value = await unwrap(commands.listHarnesses());
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

onMounted(refresh);
</script>

<template>
  <section class="connections" aria-label="连接">
    <div class="blocks-head"><span>连接</span></div>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <div v-for="connection in connections" :key="connection.id" class="conn-row">
      <span class="peek">{{ connection.executable }}</span>
      <span v-if="versions[connection.executable]" class="version">
        {{ versions[connection.executable] }}
      </span>
      <button type="button" :disabled="busy" @click="probe(connection.executable)">探测</button>
      <button type="button" class="conn-remove" :disabled="busy" @click="remove(connection.id)">
        删除
      </button>
    </div>

    <div v-if="connections.length === 0">
      <div v-for="harness in detected" :key="harness.agentId" class="conn-row">
        <span class="peek">检测到 {{ harness.label }} · {{ harness.version }}</span>
        <button type="button" :disabled="busy" @click="register(harness.probe.program)">登记</button>
      </div>
      <p v-if="detected.length === 0" class="dim">PATH 上没有候选。</p>
    </div>

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
  padding: 12px 16px;
  font-size: 13px;
  max-width: 520px;
  min-width: 360px;
  overflow-y: auto;
}

.blocks-head {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  color: var(--ink-faint);
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
  padding: 3px 0;
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

.conn-add {
  display: flex;
  gap: 8px;
  margin-top: 8px;
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
  margin-top: 8px;
}
</style>
