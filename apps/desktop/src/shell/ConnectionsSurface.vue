<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used only in the template.
import { computed, onMounted, ref } from "vue";
import { describe, unwrap } from "../bridge";
import {
  type AgentDto,
  type AgentReadingDto,
  commands,
  type HarnessDto,
} from "../generated/bindings.gen";

const props = defineProps<{
  rootId?: string;
}>();

const emit = defineEmits<{ closed: [] }>();

const harnesses = ref<HarnessDto[]>([]);
const agents = ref<AgentDto[]>([]);
const ledger = ref<AgentReadingDto[]>([]);
const checkedVersions = ref<Record<string, string>>({});
const agentName = ref("");
const agentChannel = ref("");
const agentPersona = ref("");
const notice = ref<string | null>(null);
const busy = ref(false);

const connectedHarnesses = computed(() =>
  harnesses.value.filter(
    (harness): harness is HarnessDto & { connectionId: string } =>
      harness.status === "connected" && harness.connectionId !== null,
  ),
);

const fail = (error: unknown): void => {
  notice.value = describe(error);
};

const refresh = async (): Promise<void> => {
  try {
    const [nextHarnesses, nextAgents] = await Promise.all([
      unwrap(commands.listHarnesses()),
      commands.listAgents(),
    ]);
    harnesses.value = nextHarnesses;
    agents.value = nextAgents;
    if (agentChannel.value === "" && connectedHarnesses.value[0] !== undefined) {
      agentChannel.value = connectedHarnesses.value[0].connectionId;
    }
    if (props.rootId) {
      ledger.value = await unwrap(commands.agentReadingLedger(props.rootId));
    }
  } catch (error) {
    fail(error);
  }
};

const connect = async (candidateId: string): Promise<void> => {
  if (busy.value) return;
  busy.value = true;
  notice.value = null;
  try {
    await unwrap(commands.upsertHarnessConnection(candidateId));
    notice.value = "已连接。现在可以把写作伙伴交给它运行。";
    await refresh();
  } catch (error) {
    fail(error);
  } finally {
    busy.value = false;
  }
};

const check = async (connectionId: string): Promise<void> => {
  if (busy.value) return;
  busy.value = true;
  notice.value = null;
  try {
    const version = await unwrap(commands.probeConnection(connectionId));
    checkedVersions.value = { ...checkedVersions.value, [connectionId]: version };
    notice.value = "连接可用。检查没有调用模型。";
  } catch (error) {
    fail(error);
  } finally {
    busy.value = false;
  }
};

const removeConnection = async (connectionId: string): Promise<void> => {
  if (busy.value) return;
  busy.value = true;
  notice.value = null;
  try {
    await unwrap(commands.removeHarnessConnection(connectionId));
    if (agentChannel.value === connectionId) agentChannel.value = "";
    notice.value = "已断开。";
    await refresh();
  } catch (error) {
    fail(error);
  } finally {
    busy.value = false;
  }
};

const createAgent = async (): Promise<void> => {
  if (busy.value || agentName.value.trim().length === 0) return;
  busy.value = true;
  notice.value = null;
  try {
    await unwrap(
      commands.upsertAgent(
        agentName.value.trim(),
        agentChannel.value === "" ? null : agentChannel.value,
        agentPersona.value.trim() === "" ? null : agentPersona.value,
      ),
    );
    agentName.value = "";
    agentPersona.value = "";
    notice.value = "写作伙伴已就绪。派发时可以直接选择它。";
    await refresh();
  } catch (error) {
    fail(error);
  } finally {
    busy.value = false;
  }
};

const removeAgent = async (id: string): Promise<void> => {
  if (busy.value) return;
  busy.value = true;
  notice.value = null;
  try {
    await unwrap(commands.removeAgent(id));
    notice.value = "已移除写作伙伴。";
    await refresh();
  } catch (error) {
    fail(error);
  } finally {
    busy.value = false;
  }
};

const readingOf = (agentId: string): AgentReadingDto | null =>
  ledger.value.find((row) => row.agentId === agentId) ?? null;

const statusLabel = (harness: HarnessDto): string => {
  switch (harness.status) {
    case "connected":
      return "已连接";
    case "available":
      return "已找到";
    case "missing":
      return "这台电脑上未找到";
    case "needs-attention":
      return "需要重新连接";
  }
};

onMounted(refresh);
</script>

<template>
  <section class="connections" aria-label="Agent 连接">
    <header class="connections-head">
      <div>
        <h2 class="conn-title">Agent 连接</h2>
        <p class="conn-hint">
          RefRain 只调用你已在电脑上安装并登录的 Agent 工具，不保存账号或密钥。
        </p>
      </div>
      <button type="button" class="scan" :disabled="busy" @click="refresh">重新扫描</button>
    </header>

    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <div class="steps" aria-label="连接步骤">
      <span class="step"><b>1</b> 找到本机工具</span>
      <span class="step"><b>2</b> 连接</span>
      <span class="step"><b>3</b> 添加写作伙伴</span>
    </div>

    <div class="tool-list">
      <article v-for="harness in harnesses" :key="harness.connectionId ?? harness.candidateId" class="tool-card">
        <div class="tool-copy">
          <strong>{{ harness.label }}</strong>
          <span class="tool-state" :data-status="harness.status">{{ statusLabel(harness) }}</span>
          <small>
            {{ checkedVersions[harness.connectionId ?? ""] ?? harness.version ?? harness.tier }}
          </small>
        </div>
        <div class="tool-actions">
          <button
            v-if="harness.status === 'available' || harness.status === 'needs-attention'"
            type="button"
            class="primary"
            :disabled="busy"
            @click="connect(harness.candidateId)"
          >
            {{ harness.status === "needs-attention" ? "重新连接" : "连接" }}
          </button>
          <button
            v-if="harness.status === 'connected' && harness.connectionId"
            type="button"
            :disabled="busy"
            @click="check(harness.connectionId)"
          >
            检查
          </button>
          <button
            v-if="harness.connectionId"
            type="button"
            class="quiet"
            :disabled="busy"
            @click="removeConnection(harness.connectionId)"
          >
            断开
          </button>
        </div>
      </article>
    </div>

    <section class="partners" aria-labelledby="partners-title">
      <div class="partners-head">
        <div>
          <h3 id="partners-title">写作伙伴</h3>
          <p>名称与工作方式属于这个伙伴；模型账号仍由本机 Agent 工具管理。</p>
        </div>
      </div>

      <article v-for="agent in agents" :key="agent.id" class="partner-card">
        <div class="partner-copy">
          <strong>{{ agent.name }}</strong>
          <span>{{ agent.channel }} · {{ agent.version }}</span>
          <small v-if="readingOf(agent.id)">
            已参与 {{ readingOf(agent.id)?.rounds }} 轮 ·
            {{ readingOf(agent.id)?.stale ? "手稿后来改过" : "读到当前版本" }}
          </small>
        </div>
        <span v-if="agent.hasPersona" class="has-brief">有工作说明</span>
        <button type="button" class="quiet" :disabled="busy" @click="removeAgent(agent.id)">
          移除
        </button>
      </article>

      <form class="partner-form" @submit.prevent="createAgent">
        <label>
          <span>伙伴名称</span>
          <input v-model="agentName" class="conn-input" placeholder="例如：史料校对" maxlength="40" />
        </label>
        <label>
          <span>怎样往返</span>
          <select v-model="agentChannel" class="conn-input">
            <option value="">手动往返（也可用于网页聊天）</option>
            <option
              v-for="harness in connectedHarnesses"
              :key="harness.connectionId"
              :value="harness.connectionId"
            >
              由 {{ harness.label }} 直接运行
            </option>
          </select>
        </label>
        <label>
          <span>工作说明 <i>可留空</i></span>
          <textarea
            v-model="agentPersona"
            class="partner-brief"
            rows="3"
            placeholder="例如：只校对史实，不改段落结构。"
          ></textarea>
        </label>
        <button type="submit" class="primary add-partner" :disabled="busy || agentName.trim().length === 0">
          添加写作伙伴
        </button>
      </form>
    </section>

    <button type="button" class="conn-close" @click="emit('closed')">返回手稿</button>
  </section>
</template>

<style scoped>
.connections {
  border-left: 1px solid var(--rule);
  background: var(--paper-raised);
  padding: 22px 26px;
  font-size: 13px;
  width: min(620px, 68vw);
  overflow-y: auto;
}

.connections-head,
.partners-head,
.tool-card,
.partner-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.conn-title {
  font-size: 19px;
  font-weight: 450;
  letter-spacing: 0.18em;
  margin: 0;
}

.conn-hint,
.partners-head p {
  color: var(--ink-ghost);
  font-size: 12px;
  line-height: 1.6;
  margin: 6px 0 0;
}

.scan,
.quiet,
.conn-close {
  color: var(--ink-faint);
}

.notice {
  color: var(--pending);
  background: color-mix(in oklab, var(--pending) 8%, transparent);
  border-left: 2px solid var(--pending);
  padding: 7px 10px;
  margin: 12px 0;
}

.steps {
  display: flex;
  gap: 8px;
  margin: 18px 0 10px;
  color: var(--ink-faint);
}

.step {
  flex: 1;
  border-top: 1px solid var(--rule);
  padding-top: 7px;
  font-size: 11px;
}

.step b {
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  margin-right: 4px;
  border: 1px solid var(--rule);
  border-radius: 50%;
  font-weight: 500;
}

.tool-list {
  display: grid;
  gap: 8px;
}

.tool-card,
.partner-card {
  padding: 11px 12px;
  border: 1px solid var(--rule);
  border-radius: 5px;
  background: color-mix(in oklab, var(--paper-raised) 94%, var(--ink) 6%);
}

.tool-copy,
.partner-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.tool-copy strong,
.partner-copy strong {
  font-weight: 520;
}

.tool-copy small,
.partner-copy span,
.partner-copy small {
  color: var(--ink-ghost);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-state {
  color: var(--ink-faint);
  font-size: 12px;
}

.tool-state[data-status="connected"],
.tool-state[data-status="available"] {
  color: var(--accepted);
}

.tool-state[data-status="needs-attention"] {
  color: var(--pending);
}

.tool-actions {
  display: flex;
  gap: 7px;
  flex: none;
}

.primary {
  border-color: color-mix(in oklab, var(--seal) 45%, transparent);
  color: var(--seal);
  background: var(--seal-wash);
}

.partners {
  margin-top: 24px;
  padding-top: 18px;
  border-top: 1px solid var(--rule);
}

.partners-head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 500;
  letter-spacing: 0.12em;
}

.partner-card {
  margin-top: 8px;
}

.has-brief {
  flex: none;
  color: var(--accepted);
  font-size: 11px;
}

.partner-form {
  display: grid;
  grid-template-columns: minmax(140px, 0.8fr) minmax(220px, 1.2fr);
  gap: 10px 12px;
  margin-top: 14px;
  padding: 14px;
  border: 1px solid var(--rule);
  border-radius: 5px;
}

.partner-form label {
  display: grid;
  gap: 5px;
  color: var(--ink-faint);
  font-size: 12px;
}

.partner-form label:nth-child(3) {
  grid-column: 1 / -1;
}

.partner-form i {
  color: var(--ink-ghost);
  font-style: normal;
}

.conn-input,
.partner-brief {
  box-sizing: border-box;
  width: 100%;
  font: inherit;
  padding: 7px 9px;
  border: 1px solid var(--rule);
  border-radius: 3px;
  background: transparent;
  color: var(--ink);
}

.partner-brief {
  resize: vertical;
}

.add-partner {
  grid-column: 2;
  justify-self: end;
}

.conn-close {
  margin-top: 16px;
}

@media (max-width: 880px) {
  .connections {
    width: min(100%, 600px);
    max-width: 100%;
    padding: 18px;
  }

  .steps,
  .tool-card,
  .partner-card {
    align-items: flex-start;
  }

  .partner-form {
    grid-template-columns: 1fr;
  }

  .partner-form label:nth-child(3),
  .add-partner {
    grid-column: 1;
  }
}
</style>
