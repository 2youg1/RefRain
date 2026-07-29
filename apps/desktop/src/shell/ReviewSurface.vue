<script setup lang="ts">
// The review surface (SPEC 9.7): original fixed left, current unit right;
// every judgment writes through on the keypress, not at commit; progress is
// a count, never a percentage. Keyboard is the primary path; the mouse path
// is always visible, never hover-only.
import { computed, onMounted, ref } from "vue";
import { describe, unwrap } from "../bridge";
import {
  commands,
  type ProposalDto,
  type ReviewSliceDto,
  type ReviewStateDto,
  type VerdictRecord,
} from "../generated/bindings.gen";

const props = defineProps<{
  rootId: string;
  path: string;
}>();

const emit = defineEmits<{
  committed: [];
  closed: [];
}>();

interface Unit {
  proposalId: string;
  proposalRun: string;
  before: string;
  after: string;
  kind: "replace" | "delete" | "insert";
  slices: ReviewSliceDto[];
  competing: boolean;
}

const state = ref<ReviewStateDto | null>(null);
const cursor = ref(0);
const batch = ref<Set<string>>(new Set());
const verdictBySlice = ref<Map<string, VerdictRecord>>(new Map());
const error = ref<string | null>(null);
const editingFinal = ref<string | null>(null);
const reasonDraft = ref<string | null>(null);
const competingPeer = ref(false);

const units = computed<Unit[]>(() => {
  const proposals = state.value?.proposals ?? [];
  const out: Unit[] = [];
  for (const proposal of proposals) {
    const changed = proposal.slices.filter((slice) => slice.kind !== "same");
    for (let i = 0; i < changed.length; i += 1) {
      const slice = changed[i];
      if (slice === undefined) continue;
      const next = changed[i + 1];
      if (slice.kind === "delete" && next?.kind === "insert") {
        out.push({
          proposalId: proposal.id,
          proposalRun: proposal.run,
          before: slice.text,
          after: next.text,
          kind: "replace",
          slices: [slice, next],
          competing: proposals.some(
            (other) => other.id !== proposal.id && other.baseline === proposal.baseline,
          ),
        });
        i += 1;
      } else {
        out.push({
          proposalId: proposal.id,
          proposalRun: proposal.run,
          before: slice.kind === "insert" ? "" : slice.text,
          after: slice.kind === "delete" ? "" : slice.text,
          kind: slice.kind === "delete" ? "delete" : slice.kind === "insert" ? "insert" : "replace",
          slices: [slice],
          competing: proposals.some(
            (other) => other.id !== proposal.id && other.baseline === proposal.baseline,
          ),
        });
      }
    }
  }
  return out;
});

const current = computed<Unit | null>(() => units.value[cursor.value] ?? null);
const total = computed(() => units.value.length);
// Counts are per Unit: a unit is decided when every slice in it has a row
// (SPEC 9.7: the ledger is slice-granular, the progress is unit-granular).
const decided = computed(
  () =>
    units.value.filter((unit) => unit.slices.every((slice) => verdictBySlice.value.has(slice.id)))
      .length,
);
const staged = computed(() => batch.value.size);

const verdictOf = (unit: Unit | null): VerdictRecord | undefined => {
  if (!unit) return undefined;
  for (const slice of unit.slices) {
    const found = verdictBySlice.value.get(slice.id);
    if (found) return found;
  }
  return undefined;
};

const isStaged = (unit: Unit | null): boolean => {
  if (!unit) return false;
  const ids = unit.slices
    .map((slice) => verdictBySlice.value.get(slice.id)?.id)
    .filter((id): id is string => id !== undefined);
  return ids.length > 0 && ids.every((id) => batch.value.has(id));
};

const persistSession = async (): Promise<void> => {
  try {
    await unwrap(commands.setReviewBatch(props.rootId, props.path, cursor.value, [...batch.value]));
  } catch (cause) {
    error.value = describe(cause);
  }
};

const move = async (delta: number): Promise<void> => {
  const next = Math.min(Math.max(cursor.value + delta, 0), total.value - 1);
  if (next === cursor.value) return;
  cursor.value = next;
  await persistSession();
};

// A merged Unit is ONE judgment for the author, but the ledger keeps the
// original granularity (SPEC 9.7): every slice in the unit gets a row.
// accept-modified's final text belongs to the insertion slice; its partner
// gets the plain accept that completes the pair.
const judge = async (
  kind: "accept" | "accept-modified" | "reject" | "comment-only",
  finalText?: string,
): Promise<void> => {
  const unit = current.value;
  if (!unit) return;
  try {
    for (const slice of unit.slices) {
      const isLast = slice === unit.slices.at(-1);
      const sliceKind = kind === "accept-modified" && !isLast ? "accept" : kind;
      const sliceFinal = kind === "accept-modified" && isLast ? (finalText ?? null) : null;
      const record = await unwrap(
        commands.recordVerdict(
          props.rootId,
          unit.proposalId,
          slice.id,
          sliceKind,
          reasonDraft.value ?? null,
          sliceFinal,
        ),
      );
      verdictBySlice.value.set(slice.id, record);
    }
    verdictBySlice.value = new Map(verdictBySlice.value);
    reasonDraft.value = null;
    editingFinal.value = null;
    await persistSession();
    window.setTimeout(() => void move(1), 120);
  } catch (cause) {
    error.value = describe(cause);
  }
};

const toggleStage = async (): Promise<void> => {
  const unit = current.value;
  if (!unit) return;
  const verdictIds = unit.slices
    .map((slice) => verdictBySlice.value.get(slice.id)?.id)
    .filter((id): id is string => id !== undefined);
  if (verdictIds.length < unit.slices.length) {
    error.value = "先裁决，再入批。";
    return;
  }
  const next = new Set(batch.value);
  const stagedHere = verdictIds.every((id) => next.has(id));
  if (stagedHere) {
    for (const id of verdictIds) next.delete(id);
  } else {
    for (const id of verdictIds) next.add(id);
  }
  batch.value = next;
  await persistSession();
};

const commit = async (): Promise<void> => {
  if (staged.value === 0) {
    error.value = "没有入批的裁决。";
    return;
  }
  try {
    await unwrap(commands.commitDecisionBatch(props.rootId, props.path));
    emit("committed");
  } catch (cause) {
    error.value = describe(cause);
  }
};

const onKeydown = (event: KeyboardEvent): void => {
  if (editingFinal.value !== null) {
    if (event.key === "Enter" && event.altKey) {
      event.preventDefault();
      void judge("accept-modified", editingFinal.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      editingFinal.value = null;
    }
    return;
  }
  if (!event.altKey) return;
  event.preventDefault();
  switch (event.key.toLowerCase()) {
    case "j":
      void move(1);
      break;
    case "k":
      void move(-1);
      break;
    case "a":
      void judge("accept");
      break;
    case "x":
      void judge("reject");
      break;
    case "e":
      editingFinal.value = current.value?.after ?? "";
      break;
    case "r":
      reasonDraft.value = window.prompt("理由（可留空）") ?? "";
      break;
    case "s":
      void toggleStage();
      break;
    case "p":
      competingPeer.value = !competingPeer.value;
      break;
    case "enter":
      void commit();
      break;
  }
};

onMounted(async () => {
  try {
    state.value = await unwrap(commands.reviewState(props.rootId, props.path));
    cursor.value = Math.min(state.value.cursor, Math.max(total.value - 1, 0));
    batch.value = new Set(state.value.batch);
    for (const verdict of state.value.verdicts) {
      verdictBySlice.value.set(verdict.sliceId, verdict);
    }
  } catch (cause) {
    error.value = describe(cause);
  }
});

const actionLabel = (unit: Unit | null): string => {
  if (!unit) return "";
  switch (unit.kind) {
    case "replace":
      return "采用改写";
    case "delete":
      return "删除此句";
    case "insert":
      return "写入此句";
  }
};
</script>

<template>
  <section class="review-surface" tabindex="0" @keydown="onKeydown">
    <header class="review-head">
      <span>{{ decided }}/{{ total }} 已判 · {{ staged }} 待合并</span>
      <span class="path">{{ path }}</span>
      <button type="button" @click="emit('closed')">返回 (Esc)</button>
    </header>

    <p v-if="error" class="notice">{{ error }}</p>

    <div v-if="total === 0" class="empty">这份文档没有待判的提案。</div>

    <div v-else-if="current" class="review-body">
      <div class="original">
        <h3>原段</h3>
        <p class="text">{{ current.before || "（无）" }}</p>
      </div>
      <div class="unit">
        <h3>
          {{ actionLabel(current) }}
          <span v-if="current.competing" class="competing" title="同题竞争">
            竞争 {{ competingPeer ? "B" : "A" }}
          </span>
        </h3>
        <p v-if="editingFinal === null" class="text proposed">{{ current.after || "（删除）" }}</p>
        <textarea
          v-else
          v-model="editingFinal"
          class="final-editor"
          rows="4"
          aria-label="改后接受的最终文本"
        />
        <p class="hint">
          Alt+J/K 移动 · Alt+A {{ actionLabel(current) }} · Alt+X 拒绝 · Alt+E 改后接受 ·
          Alt+R 理由 · Alt+S 入批 · Alt+P 换看竞争稿 · Alt+Enter 合并
        </p>
        <p v-if="verdictOf(current)" class="verdict-mark">
          已判:{{ verdictOf(current)?.kind }}<span v-if="isStaged(current)"> · 已入批</span>
        </p>
      </div>
    </div>

    <div class="mouse-row">
      <button type="button" :disabled="!current" @click="judge('accept')">
        {{ actionLabel(current) }} (Alt+A)
      </button>
      <button type="button" :disabled="!current" @click="judge('reject')">拒绝 (Alt+X)</button>
      <button type="button" :disabled="!current" @click="editingFinal = current?.after ?? ''">
        改后接受 (Alt+E)
      </button>
      <button type="button" :disabled="!current" @click="toggleStage">
        {{ isStaged(current) ? "出批" : "入批" }} (Alt+S)
      </button>
      <button type="button" :disabled="staged === 0" @click="commit">
        合并 {{ staged }} 条 (Alt+Enter)
      </button>
    </div>
  </section>
</template>

<style>
.review-surface {
  outline: none;
  display: flex;
  flex-direction: column;
  min-height: 60vh;
}

.review-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  font-size: 13px;
  border-bottom: 1px solid color-mix(in oklab, currentColor 12%, transparent);
}

.review-body {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  padding: 16px;
  flex: 1;
}

.original h3,
.unit h3 {
  font-size: 12px;
  opacity: 0.6;
  margin: 0 0 8px;
}

.text {
  white-space: pre-wrap;
  line-height: 1.8;
}

.proposed {
  border-left: 2px solid var(--role-agent, #888);
  padding-left: 8px;
}

.hint {
  font-size: 12px;
  opacity: 0.55;
  margin-top: 12px;
}

.verdict-mark {
  font-size: 12px;
  color: var(--role-agent, #888);
}

.final-editor {
  width: 100%;
  font: inherit;
  line-height: 1.8;
}

.mouse-row {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid color-mix(in oklab, currentColor 12%, transparent);
}

.competing {
  font-size: 11px;
  border: 1px solid currentColor;
  border-radius: 3px;
  padding: 1px 6px;
  margin-left: 8px;
}

.empty {
  padding: 48px 16px;
  opacity: 0.6;
}

.notice {
  color: #8a4b00;
  font-size: 13px;
  padding: 4px 16px;
}
</style>
