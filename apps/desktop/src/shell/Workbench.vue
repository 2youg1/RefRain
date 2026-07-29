<script setup lang="ts">
// biome-ignore-all lint/style/useVueMultiWordComponentNames: SPEC 9.10 names this surface Workbench.
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used only in
// the template are real usage; biome does not parse Vue templates.
// The writing slice (C5): Open/Create Project → Open/New Document → edit →
// Rust confirms → save → close/reopen → conflict → recovery. State the Rust
// side already owns is projected here; nothing is re-derived (INV-10).

import { computed, onMounted, onUnmounted, ref } from "vue";
import { describe, unwrap } from "../bridge";
// biome-ignore lint/style/useImportType: the component renders — a type-only import unmounts it.
import EditorHost from "../editor-host/EditorHost.vue";
import {
  commands,
  type DocumentRow,
  type FileStamp_Serialize,
  type OpenDocumentDto_Serialize,
  type ProjectOpenedDto,
} from "../generated/bindings.gen";
import ConflictDialog from "./ConflictDialog.vue";
import ConnectionsSurface from "./ConnectionsSurface.vue";
import DispatchSurface from "./DispatchSurface.vue";
import KaraSurface from "./KaraSurface.vue";
import { useKara } from "./kara-state";
import { pickDocumentFile, pickProjectFolder, pickProjectParent } from "./pick";
import ReviewSurface from "./ReviewSurface.vue";
import SettingsSurface from "./SettingsSurface.vue";
import StatusLine from "./StatusLine.vue";

type SaveState =
  | { kind: "clean" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "failed"; reason: string };

defineEmits<{ "theme-changed": [slug: string] }>();

const project = ref<ProjectOpenedDto | null>(null);
const active = ref<OpenDocumentDto_Serialize | null>(null);
const stamp = ref<FileStamp_Serialize | null>(null);
const saveState = ref<SaveState>({ kind: "clean" });
const notice = ref<string | null>(null);
const conflict = ref<{ mine: string; theirs: string; stamp: FileStamp_Serialize } | null>(null);
const editor = ref<InstanceType<typeof EditorHost> | null>(null);
const reviewing = ref(false);
const dispatching = ref(false);
const connecting = ref(false);
const settings = ref(false);
const kara = useKara();

// Chrome recede (C12.6): the rail is visible on entry — the author should
// know what tools exist before KARA takes them away. It steps back only
// after the pointer has been still, and returns the instant the pointer
// reaches the left edge. The transform-only hide keeps the column's width,
// so the manuscript never shifts sideways (SPEC 9.3: 正文零横移). The e2e
// harness pins chrome through the same global seam family as pick.
const chromePinned = (): boolean =>
  (window as unknown as Record<string, unknown>)["refrain.e2e.pin"] === true;
const railReceded = ref(false);
let idleTimer: number | null = null;

const wake = (event: PointerEvent): void => {
  if (chromePinned() || kara.engaged.value) return;
  if (event.clientX < 28) railReceded.value = false;
  if (!railReceded.value) {
    if (idleTimer !== null) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      railReceded.value = true;
    }, 2000);
  }
};

onMounted(() => window.addEventListener("pointermove", wake, { passive: true }));
onUnmounted(() => {
  window.removeEventListener("pointermove", wake);
  if (idleTimer !== null) window.clearTimeout(idleTimer);
});

/** The caret as a ReturnPoint: block id, offset, and the sentence tail the
 * return card shows (SPEC 9.3 "你停在这里"). */
const trackReturnPoint = (): void => {
  if (!kara.engaged.value) return;
  const caret = editor.value?.caret?.();
  if (!caret || !active.value) return;
  const block = active.value.blocks.find((candidate) => candidate.id === caret.blockId);
  const tail = (block?.text ?? "").slice(0, caret.offset).slice(-18);
  void kara.setReturnPoint({ blockId: caret.blockId, offset: caret.offset, sentenceTail: tail });
};

const documents = computed<DocumentRow[]>(() => project.value?.documents ?? []);
const chapterDocs = computed<DocumentRow[]>(() =>
  documents.value.filter((row) => row.role === "chapter"),
);
const materialRows = computed<DocumentRow[]>(() =>
  documents.value.filter((row) => row.role === "material"),
);
const materialDocs = computed<{ path: string; label: string }[]>(() =>
  documents.value
    .filter((row) => row.role === "material")
    .map((row) => ({ path: row.path, label: row.path })),
);

const fail = (error: unknown): void => {
  notice.value = describe(error);
};

const openProjectFolder = async (): Promise<void> => {
  const path = await pickProjectFolder("请选择项目文件夹");
  if (typeof path !== "string") return;
  try {
    project.value = await unwrap(commands.adoptRoot(path, "folder"));
    notice.value = null;
  } catch (error) {
    fail(error);
  }
};

const openSingleDocument = async (): Promise<void> => {
  const path = await pickDocumentFile();
  if (typeof path !== "string") return;
  try {
    project.value = await unwrap(commands.adoptRoot(path, "file"));
    notice.value = null;
    const first = project.value.documents[0];
    if (first) await select(first.path);
  } catch (error) {
    fail(error);
  }
};

const newProject = async (): Promise<void> => {
  const parent = await pickProjectParent();
  if (typeof parent !== "string") return;
  const name = window.prompt("项目名");
  if (!name) return;
  try {
    project.value = await unwrap(commands.createProject(parent, name));
    notice.value = null;
  } catch (error) {
    fail(error);
  }
};

const select = async (path: string): Promise<void> => {
  if (!project.value) return;
  // A failed save never switches the document (SPEC: text still only here).
  if (saveState.value.kind === "dirty" || saveState.value.kind === "failed") {
    notice.value = "先保存：未落盘的文字还只在这个窗口里。";
    return;
  }
  try {
    const opened = await unwrap(commands.openDocument(project.value.rootId, path));
    kara.apply(opened.kara);
    active.value = opened;
    stamp.value = opened.stamp;
    saveState.value = { kind: "clean" };
    conflict.value = null;
    if (opened.staleJournal.length > 0) {
      notice.value = `有 ${opened.staleJournal.length} 条未确认的行动无法恢复，已留作证据。`;
    } else if (opened.replayed > 0) {
      notice.value = `已恢复 ${opened.replayed} 条上次未确认的行动。`;
    }
  } catch (error) {
    fail(error);
  }
};

const newDocument = async (role: "chapter" | "material"): Promise<void> => {
  if (!project.value) return;
  const title = window.prompt(role === "chapter" ? "新章名" : "新资料名");
  if (!title) return;
  try {
    const created = await unwrap(commands.createDocument(project.value.rootId, title, role));
    kara.apply(created.kara);
    project.value = {
      ...project.value,
      documents: [...project.value.documents, created.document],
    };
    await select(created.document.path);
  } catch (error) {
    fail(error);
  }
};

// A saved material draft joins the bookshelf; the ticket's materials list
// derives from it.
const onMaterialSaved = (row: DocumentRow): void => {
  if (!project.value) return;
  project.value = {
    ...project.value,
    documents: [...project.value.documents, row],
  };
};

// Import a source file (C12.3): extraction is local, the Material opens with
// its provenance header. The button is a thin prompt over the command.
const importMaterial = async (): Promise<void> => {
  if (!project.value) return;
  const source = window.prompt("资料文件路径（PDF / EPUB / HTML / DOCX / PPTX / XLSX）");
  if (!source) return;
  try {
    const row = await unwrap(commands.importMaterial(project.value.rootId, source));
    onMaterialSaved(row);
    notice.value = "已导入";
  } catch (error) {
    fail(error);
  }
};

const save = async (): Promise<void> => {
  if (!project.value || !active.value) return;
  // A save mid-composition is deferred, not refused (INV-7).
  if (editor.value?.isComposing()) {
    window.setTimeout(() => void save(), 250);
    return;
  }
  saveState.value = { kind: "saving" };
  try {
    // Unconfirmed actions in the queue hold up the save (SPEC 7.2-5): the
    // file only ever stores confirmed revisions.
    await editor.value?.settled?.();
    const outcome = await unwrap(
      commands.persistRevision(project.value.rootId, active.value.document.path, stamp.value),
    );
    if (outcome.kind === "saved") {
      stamp.value = outcome.value.stamp;
      saveState.value = { kind: "clean" };
      if (outcome.value.recoveryEvidence) {
        notice.value = `恢复了一份中断的写入:${outcome.value.recoveryEvidence}`;
      }
    } else {
      saveState.value = { kind: "failed", reason: "磁盘上的版本已经变了" };
      conflict.value = {
        mine: active.value.blocks.map((block) => block.text).join("\n\n"),
        theirs: outcome.value.onDisk,
        stamp: outcome.value.stamp,
      };
    }
  } catch (error) {
    saveState.value = { kind: "failed", reason: describe(error) };
  }
};

const resolveConflict = async (choice: "mine" | "theirs"): Promise<void> => {
  if (!conflict.value) return;
  if (choice === "mine") {
    // CAS against the stamp we just saw: only the exact disk version we were
    // shown may be overwritten (SPEC 7.2).
    stamp.value = conflict.value.stamp;
    conflict.value = null;
    await save();
  } else {
    conflict.value = null;
    if (active.value) await select(active.value.document.path);
    saveState.value = { kind: "clean" };
  }
};

const afterCommit = async (): Promise<void> => {
  reviewing.value = false;
  if (!project.value || !active.value) return;
  // Never reopen from disk here: the committed head lives in the session,
  // and reopening would replace it with the pre-commit bytes (losing the
  // batch and any unsaved edits with it).
  const session = await unwrap(
    commands.currentDocument(project.value.rootId, active.value.document.path),
  );
  active.value = { ...active.value, revision: session.revision, blocks: session.blocks };
  saveState.value = { kind: "dirty" };
};

const markDirty = (): void => {
  if (saveState.value.kind === "clean") saveState.value = { kind: "dirty" };
  trackReturnPoint();
};

const onKeydown = (event: KeyboardEvent): void => {
  if ((event.ctrlKey || event.metaKey) && event.key === "s") {
    event.preventDefault();
    void save();
    return;
  }
  // D10: Ctrl+Enter is the only KARA toggle. Escape never exits — it belongs
  // to the IME, then to registers, then to nothing.
  if (event.ctrlKey && event.key === "Enter") {
    event.preventDefault();
    if (editor.value?.isComposing()) {
      window.setTimeout(() => void kara.toggle(), 250);
    } else {
      trackReturnPoint();
      void kara.toggle();
    }
  }
};
</script>

<template>
  <div class="workbench" @keydown="onKeydown">
    <template v-if="!project">
      <section class="welcome">
        <h1 class="welcome-brand">RefRain</h1>
        <p class="welcome-tag">一个本地写作工作台。你写的每一个字都在磁盘上。</p>
        <button class="primary welcome-open" type="button" @click="openProjectFolder">打开文件夹</button>
        <div class="secondary">
          <button type="button" @click="newProject">新建项目</button>
          <button type="button" @click="openSingleDocument">打开文档</button>
        </div>
        <p v-if="notice" class="notice">{{ notice }}</p>
      </section>
    </template>

    <template v-else>
      <div
        v-show="railReceded && !kara.engaged.value"
        class="rail-strip"
        aria-hidden="true"
      ></div>
      <nav
        v-show="!kara.engaged.value"
        class="rail"
        :class="{ receded: railReceded }"
        aria-label="文档"
      >
        <div class="brand"><span class="brand-mark"></span><span class="brand-word">RefRain</span></div>
        <div class="rail-actions">
          <button type="button" @click="newDocument('chapter')">新章</button>
          <button type="button" @click="newDocument('material')">新资料</button>
          <button type="button" @click="importMaterial">导入</button>
        </div>
        <div class="rail-group">原稿</div>
        <ul>
          <li v-for="row in chapterDocs" :key="row.id">
            <button
              type="button"
              :class="{ current: active?.document.path === row.path }"
              @click="select(row.path)"
            >
              {{ row.path }}
            </button>
          </li>
        </ul>
        <template v-if="materialRows.length > 0">
          <div class="rail-group">资料</div>
          <ul>
            <li v-for="row in materialRows" :key="row.id">
              <button
                type="button"
                :class="{ current: active?.document.path === row.path }"
                @click="select(row.path)"
              >
                {{ row.path }}
              </button>
            </li>
          </ul>
        </template>
        <div class="rail-foot">
          <button v-if="active" type="button" @click="reviewing = !reviewing">
            {{ reviewing ? "返回编辑" : "Review" }}
          </button>
          <button v-if="active && !reviewing" type="button" @click="dispatching = !dispatching">
            {{ dispatching ? "收起" : "派发" }}
          </button>
          <button type="button" @click="connecting = !connecting">
            {{ connecting ? "收起" : "连接" }}
          </button>
          <button type="button" @click="settings = !settings">
            {{ settings ? "收起" : "设置" }}
          </button>
        </div>
      </nav>

      <main class="stage">
        <p v-if="notice" class="notice">{{ notice }}</p>
        <ReviewSurface
          v-if="reviewing && active"
          :root-id="project.rootId"
          :path="active.document.path"
          @committed="afterCommit"
          @closed="reviewing = false"
        />
        <div v-else-if="active" class="stage-row">
          <EditorHost
            v-if="!reviewing"
            ref="editor"
            :root-id="project.rootId"
            :path="active.document.path"
            :document="active"
            @confirmed="markDirty"
            @rejected="fail"
          />
          <DispatchSurface
            v-if="dispatching"
            :key="active.document.path"
            :root-id="project.rootId"
            :path="active.document.path"
            :blocks="active.blocks"
            :materials="materialDocs"
            @collected="(count: number) => (notice = `${count} 条提案已冻结，点 Review 逐句裁决。`)"
            @material-saved="onMaterialSaved"
            @closed="dispatching = false"
          />
          <ConnectionsSurface v-if="connecting" @closed="connecting = false" />
          <SettingsSurface
            v-if="settings"
            @closed="settings = false"
            @theme-picked="(slug: string) => $emit('theme-changed', slug)"
          />
        </div>
        <div v-else-if="connecting || settings" class="stage-row">
          <ConnectionsSurface v-if="connecting" @closed="connecting = false" />
          <SettingsSurface
            v-if="settings"
            @closed="settings = false"
            @theme-picked="(slug: string) => $emit('theme-changed', slug)"
          />
        </div>
        <p v-else class="empty">从左侧选一个文档，或新建一章。</p>
      </main>

      <StatusLine v-show="!kara.engaged.value" :state="saveState" :path="active?.document.path ?? null" />
      <KaraSurface v-if="kara.engaged.value" />
      <ConflictDialog
        v-if="conflict"
        :mine="conflict.mine"
        :theirs="conflict.theirs"
        @resolve="resolveConflict"
      />
    </template>
  </div>
</template>

<style>
.workbench {
  display: grid;
  grid-template-columns: auto 1fr;
  min-height: 100vh;
}

/* ── 欢迎屏 ── */
.welcome {
  grid-column: 1 / -1;
  align-self: center;
  justify-self: center;
  text-align: center;
}

.welcome-brand {
  font-family: var(--display);
  font-size: 44px;
  font-weight: 400;
  letter-spacing: 0.18em;
  margin: 0 0 10px;
}

.welcome-tag {
  font-family: var(--serif);
  color: var(--ink-soft);
  margin: 0 0 30px;
}

.welcome-open {
  font-size: 15px;
  padding: 9px 34px;
}

.secondary {
  margin-top: 14px;
  display: flex;
  gap: 12px;
  justify-content: center;
}

/* ── Rail：房间。深配重，工具先可见，静止后分层退场。 ── */
.rail {
  width: 232px;
  max-height: 100vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 14px 10px 40px; /* the fixed status line owns the bottom 26px */
  background: var(--rail);
  color: var(--rail-ink);
  border-right: 1px solid var(--rail-rule);
  font-size: 13px;
  transition:
    transform 200ms ease,
    opacity 200ms ease;
}

.rail.receded {
  transform: translateX(-104%);
  opacity: 0;
  pointer-events: none;
}

.rail-strip {
  position: fixed;
  left: 0;
  top: 0;
  bottom: 0;
  width: 6px;
  background: color-mix(in oklab, var(--rail) 55%, transparent);
  z-index: 5;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 8px 14px;
}

.brand-mark {
  width: 10px;
  height: 10px;
  border-radius: 2.5px;
  background: var(--seal);
  flex: none;
}

.brand-word {
  font-family: var(--display);
  font-size: 15px;
  letter-spacing: 0.14em;
}

.rail-actions {
  display: flex;
  gap: 6px;
  padding: 0 2px 10px;
}

.rail button {
  color: var(--rail-ink);
  border-color: color-mix(in oklab, var(--rail-ink) 26%, transparent);
  padding: 4px 8px;
  font-size: 12.5px;
}

.rail button:hover:not(:disabled) {
  border-color: color-mix(in oklab, var(--rail-ink) 48%, transparent);
  background: color-mix(in oklab, var(--rail-ink) 9%, transparent);
}

.rail-actions button {
  flex: 1;
}

.rail ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

.rail-group {
  font-size: 10px;
  letter-spacing: 0.2em;
  color: var(--rail-faint);
  padding: 4px 10px 4px;
}

.rail li button {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  border-left: 2px solid transparent;
  border-radius: 0;
  padding: 5px 8px 5px 10px;
  color: var(--rail-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rail li button:hover:not(:disabled) {
  color: var(--rail-ink);
  background: color-mix(in oklab, var(--rail-ink) 6%, transparent);
}

.rail li button.current {
  color: var(--rail-ink);
  background: color-mix(in oklab, var(--rail-ink) 9%, transparent);
  border-left-color: var(--seal);
}

.rail-foot {
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px solid var(--rail-rule);
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* ── Stage：桌面。平纸，无光效；版心由 EditorHost 的纸面档绘制。 ── */
.stage {
  min-width: 0;
  background: var(--paper);
}

.stage-row {
  display: flex;
  align-items: stretch;
}

.stage-row > :first-child {
  flex: 1;
  min-width: 0;
}

.notice {
  color: var(--pending);
  font-size: 13px;
  padding: 0 24px;
}

.empty {
  padding: 48px 24px;
  color: var(--ink-faint);
}
</style>
