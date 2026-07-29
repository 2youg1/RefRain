<script setup lang="ts">
// biome-ignore-all lint/style/useVueMultiWordComponentNames: SPEC 9.10 names this surface Workbench.
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used only in
// the template are real usage; biome does not parse Vue templates.
// The writing slice (C5): Open/Create Project → Open/New Document → edit →
// Rust confirms → save → close/reopen → conflict → recovery. State the Rust
// side already owns is projected here; nothing is re-derived (INV-10).

import { getCurrentWindow } from "@tauri-apps/api/window";
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
import LogoMark from "./LogoMark.vue";
import { pickDocumentFile, pickProjectFolder, pickProjectParent } from "./pick";
import ReviewSurface from "./ReviewSurface.vue";
import SettingsSurface from "./SettingsSurface.vue";
import StatusLine from "./StatusLine.vue";
import WindowChrome from "./WindowChrome.vue";
import { reduceSurface, type SurfaceTarget, type WorkbenchSurface } from "./workbench-surface";

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
const surface = ref<WorkbenchSurface>({ kind: "writing" });
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
let lastPointerX = 0;

const wake = (event: PointerEvent): void => {
  if (chromePinned() || kara.engaged.value) return;
  lastPointerX = event.clientX;
  if (event.clientX < 28) railReceded.value = false;
  if (!railReceded.value) {
    if (idleTimer !== null) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      // The rail never vanishes under the pointer it belongs to.
      if (lastPointerX >= 270) railReceded.value = true;
    }, 2000);
  }
};

onMounted(() => {
  window.addEventListener("pointermove", wake, { passive: true });
  // Armed from the start: a reader who never touches the mouse still gets
  // the quiet room.
  idleTimer = window.setTimeout(() => {
    if (!chromePinned() && !kara.engaged.value) railReceded.value = true;
  }, 2400);
  void (async () => {
    const factor = await getCurrentWindow().scaleFactor();
    unlistenDrop = await getCurrentWindow().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter" || payload.type === "over") {
        const { x, y } = payload.position;
        dropTarget.value = shelfAt(x / factor, y / factor) ?? "stage";
      } else if (payload.type === "drop") {
        const { x, y } = payload.position;
        void onDropped(event.payload.paths, shelfAt(x / factor, y / factor));
        dropTarget.value = null;
      } else {
        dropTarget.value = null;
      }
    });
  })();
});
onUnmounted(() => {
  window.removeEventListener("pointermove", wake);
  unlistenDrop?.();
  if (idleTimer !== null) window.clearTimeout(idleTimer);
});

/** Writing is the signal to clear the desk: any contact with the stage
 * sends the drawer home. The rail never moves the manuscript — it is an
 * overlay, so the column holds its centre in the window at all times. */
const recedeRail = (): void => {
  if (surface.value.kind !== "writing") return;
  if (!chromePinned()) railReceded.value = true;
};

const openSurface = (target: SurfaceTarget): void => {
  surface.value = reduceSurface(surface.value, { kind: "open", target }, active.value !== null);
};

const returnToWriting = (): void => {
  surface.value = reduceSurface(surface.value, { kind: "return" }, active.value !== null);
};

// ── Drag-drop import (C12.6) ─────────────────────────────────────────────
// Text (.md/.txt) becomes a chapter; every other format becomes a Material
// (the manuscript editor is Markdown-only anyway). Dropping on a shelf pins
// the intent: 原稿 = 修改稿, 资料 = 解析链接.
const MANUSCRIPT_EXT = /\.(md|markdown|mdown|txt)$/i;
const dropTarget = ref<"manuscript" | "material" | "stage" | null>(null);
let unlistenDrop: (() => void) | null = null;

const shelfAt = (x: number, y: number): "manuscript" | "material" | null => {
  const shelf = document.elementFromPoint(x, y)?.closest("[data-shelf]");
  const zone = shelf?.getAttribute("data-shelf");
  return zone === "manuscript" || zone === "material" ? zone : null;
};

const onDropped = async (
  paths: string[],
  zone: "manuscript" | "material" | null,
): Promise<void> => {
  if (!project.value) return;
  for (const source of paths) {
    const asManuscript =
      zone === "manuscript" || (zone !== "material" && MANUSCRIPT_EXT.test(source));
    try {
      const row = asManuscript
        ? await unwrap(commands.importManuscript(project.value.rootId, source))
        : await unwrap(commands.importMaterial(project.value.rootId, source));
      onMaterialSaved(row);
      notice.value = asManuscript ? "已收入原稿" : "已收入资料";
    } catch (error) {
      fail(error);
    }
  }
};

// ── 编辑器右键菜单（C12.6）：Markdown 格式 + 句段级派发 ──────────────────
// 块是协议的最小 scope；菜单按所点段落精确派发，可多次攒进同一张票。
const contextMenu = ref<{ x: number; y: number; blockId: string } | null>(null);
const dispatchSeed = ref<string[]>([]);

const onContextMenu = (event: MouseEvent): void => {
  const paragraph = (event.target as HTMLElement).closest?.("p[data-block-id]");
  const blockId = paragraph?.getAttribute("data-block-id");
  if (!blockId) return;
  event.preventDefault();
  contextMenu.value = { x: event.clientX, y: event.clientY, blockId };
};

/** Wrap the current selection with a Markdown marker, then let the editor's
 * own input path settle the change (no second write path). */
const wrapSelection = (marker: string): void => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const paragraph = (range.commonAncestorContainer as Node).parentElement?.closest?.(
    "p[data-block-id]",
  );
  if (!paragraph) return;
  const text = selection.toString();
  if (text === "") return;
  range.deleteContents();
  range.insertNode(document.createTextNode(`${marker}${text}${marker}`));
  paragraph.dispatchEvent(new Event("input", { bubbles: true }));
  contextMenu.value = null;
};

const dispatchBlock = (accumulate: boolean): void => {
  const menu = contextMenu.value;
  if (!menu) return;
  dispatchSeed.value = accumulate ? [...dispatchSeed.value, menu.blockId] : [menu.blockId];
  surface.value = { kind: "dispatch" };
  contextMenu.value = null;
};

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
    surface.value = reduceSurface(surface.value, { kind: "documentSelected" }, true);
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
      // The author's side is the confirmed session text, not the blocks the
      // document was opened with — confirmed edits since then are theirs too.
      const session = await unwrap(
        commands.currentDocument(project.value.rootId, active.value.document.path),
      );
      conflict.value = {
        mine: session.blocks.map((block) => block.text).join("\n\n"),
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
  returnToWriting();
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

const canClose = (): boolean => {
  if (saveState.value.kind === "clean" || !active.value) return true;
  notice.value = "正文尚未保存。请先保存，再关闭窗口。";
  return false;
};

const requestClose = (): void => {
  if (!canClose()) return;
  void getCurrentWindow()
    .destroy()
    .catch((error: unknown) => {
      notice.value = describe(error);
    });
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
    <WindowChrome
      :title="active?.document.path ?? 'RefRain'"
      @close-requested="requestClose"
      @error="(message) => (notice = message)"
    />
    <template v-if="!project">
      <section class="welcome">
        <LogoMark class="welcome-mark" :size="64" />
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
        v-show="railReceded && !kara.engaged.value && surface.kind !== 'settings'"
        class="rail-strip"
        aria-hidden="true"
      ></div>
      <nav
        class="rail"
        :class="{ receded: railReceded || kara.engaged.value || surface.kind === 'settings' }"
        aria-label="文档"
      >
        <div
          class="brand"
          role="button"
          tabindex="0"
          title="收起 / 展开"
          aria-label="收起或展开文档栏"
          @click="railReceded = !railReceded"
          @keydown.enter="railReceded = !railReceded"
        >
          <LogoMark :size="28" label="RefRain" />
        </div>
        <div class="rail-actions">
          <button type="button" @click="newDocument('chapter')">新章</button>
          <button type="button" @click="newDocument('material')">新资料</button>
          <button type="button" @click="importMaterial">导入</button>
        </div>
        <div class="shelf" data-shelf="manuscript">
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
          <div v-if="dropTarget" class="drop-hint" :class="{ hot: dropTarget === 'manuscript' }">
            修改稿
          </div>
        </div>
        <div v-if="materialRows.length > 0 || dropTarget" class="shelf" data-shelf="material">
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
          <div v-if="dropTarget" class="drop-hint" :class="{ hot: dropTarget === 'material' }">
            资料
          </div>
        </div>
        <div class="rail-foot">
          <button
            v-if="active"
            type="button"
            :class="{ current: surface.kind === 'review' }"
            @click="openSurface('review')"
          >
            Review
          </button>
          <button
            v-if="active"
            type="button"
            :class="{ current: surface.kind === 'dispatch' }"
            @click="openSurface('dispatch')"
          >
            派发
          </button>
          <button
            type="button"
            :class="{ current: surface.kind === 'connections' }"
            @click="openSurface('connections')"
          >
            连接
          </button>
          <button
            type="button"
            :class="{ current: surface.kind === 'settings' }"
            @click="openSurface('settings')"
          >
            设置
          </button>
        </div>
      </nav>

      <main class="stage" @pointerdown="recedeRail">
        <p v-if="notice" class="notice">{{ notice }}</p>
        <SettingsSurface
          v-if="surface.kind === 'settings'"
          :return-label="active?.document.path ?? '工作台'"
          @closed="returnToWriting"
          @theme-picked="(slug: string) => $emit('theme-changed', slug)"
        />
        <ReviewSurface
          v-else-if="surface.kind === 'review' && active"
          :root-id="project.rootId"
          :path="active.document.path"
          @committed="afterCommit"
          @closed="returnToWriting"
        />
        <div v-else-if="active" class="stage-row" @contextmenu="onContextMenu">
          <EditorHost
            ref="editor"
            :key="active.document.path"
            :root-id="project.rootId"
            :path="active.document.path"
            :document="active"
            @confirmed="markDirty"
            @rejected="fail"
          />
          <DispatchSurface
            v-if="surface.kind === 'dispatch'"
            :key="active.document.path"
            :root-id="project.rootId"
            :path="active.document.path"
            :blocks="active.blocks"
            :materials="materialDocs"
            :seed="dispatchSeed"
            @collected="(count: number) => (notice = `${count} 条提案已冻结，点 Review 逐句裁决。`)"
            @material-saved="onMaterialSaved"
            @closed="returnToWriting"
          />
          <ConnectionsSurface
            v-if="surface.kind === 'connections'"
            :root-id="project.rootId"
            @closed="returnToWriting"
          />
        </div>
        <div v-else-if="surface.kind === 'connections'" class="stage-row">
          <ConnectionsSurface :root-id="project.rootId" @closed="returnToWriting" />
        </div>
        <p v-else class="empty">从左侧选一个文档，或新建一章。</p>
      </main>

      <div
        v-if="contextMenu"
        class="context-menu"
        :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      >
        <button type="button" @click="wrapSelection('**')">加粗</button>
        <button type="button" @click="wrapSelection('*')">斜体</button>
        <button type="button" @click="dispatchBlock(false)">派发此段</button>
        <button type="button" @click="dispatchBlock(true)">加入派发</button>
        <button type="button" @click="contextMenu = null">取消</button>
      </div>
      <div v-if="contextMenu" class="context-backdrop" @click="contextMenu = null"></div>

      <StatusLine
        :class="{ dimmed: kara.engaged.value }"
        :state="saveState"
        :path="active?.document.path ?? null"
      />
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
  --chrome-height: 38px;
  --status-height: 26px;
  min-height: 100vh;
  padding-top: var(--chrome-height);
}

/* ── 欢迎屏 ── */
.welcome {
  min-height: calc(100vh - var(--chrome-height));
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}

.welcome-mark {
  margin-bottom: 18px;
  color: var(--ink);
}

.welcome-brand {
  font-family: var(--display);
  font-size: 64px;
  font-weight: 400;
  letter-spacing: 0.2em;
  margin: 0 0 14px;
}


.welcome-tag {
  font-family: var(--serif);
  font-size: 15px;
  color: var(--ink-soft);
  margin: 0 0 42px;
}

.welcome-open {
  font-size: 15px;
  padding: 10px 36px;
  letter-spacing: 0.12em;
}

.secondary {
  margin-top: 22px;
  display: flex;
  gap: 28px;
  justify-content: center;
}

.secondary button {
  border: none;
  padding: 4px 2px;
  color: var(--ink-soft);
  text-decoration: underline;
  text-underline-offset: 5px;
  text-decoration-color: color-mix(in oklab, var(--ink) 30%, transparent);
}

.secondary button:hover:not(:disabled) {
  background: none;
  color: var(--ink);
  text-decoration-color: var(--seal);
}

/* ── Rail：抽屉。覆盖于桌面之上，版心永远居中、永不横移。 ── */
.rail {
  position: fixed;
  left: 0;
  top: var(--chrome-height);
  bottom: var(--status-height);
  z-index: 20;
  width: 264px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 18px 12px 40px;
  background: var(--rail);
  color: var(--rail-ink);
  border-right: 1px solid var(--rail-rule);
  box-shadow: 24px 0 48px color-mix(in oklab, var(--ink) 14%, transparent);
  font-size: 13px;
  visibility: visible;
  transition:
    transform 240ms var(--ease),
    opacity 240ms var(--ease),
    visibility 0s;
}

.rail.receded {
  transform: translateX(-102%);
  opacity: 0;
  pointer-events: none;
  visibility: hidden;
  transition:
    transform 240ms var(--ease),
    opacity 240ms var(--ease),
    visibility 0s 240ms;
}

.rail-strip {
  position: fixed;
  left: 0;
  top: var(--chrome-height);
  bottom: var(--status-height);
  width: 6px;
  background: color-mix(in oklab, var(--rail) 55%, transparent);
  z-index: 5;
}

.brand {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 2px 10px 18px;
  cursor: pointer;
  user-select: none;
}


.rail-actions {
  display: flex;
  flex-direction: column;
  padding: 0 0 8px;
  border-bottom: 1px solid var(--rail-rule);
}

.rail button {
  color: var(--rail-ink);
  border-color: color-mix(in oklab, var(--rail-ink) 26%, transparent);
  padding: 4px 8px;
  font-size: 12.5px;
}

/* Rail 内的动作不作盒：整行文字条目，hover 只给洗底（1.6 展开式）。 */
.rail-actions button,
.rail-foot button {
  border: none;
  border-radius: 0;
  text-align: left;
  padding: 6px 10px;
  color: var(--rail-ink);
}

.rail button:hover:not(:disabled) {
  border-color: color-mix(in oklab, var(--rail-ink) 48%, transparent);
  background: color-mix(in oklab, var(--rail-ink) 9%, transparent);
}

.rail-actions button:hover:not(:disabled),
.rail-foot button:hover:not(:disabled) {
  background: color-mix(in oklab, var(--rail-ink) 9%, transparent);
}

.rail-foot button.current {
  color: var(--rail-ink);
  background: color-mix(in oklab, var(--rail-ink) 12%, transparent);
  box-shadow: inset 2px 0 var(--seal);
}

.rail ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

.rail-group {
  font-size: 10px;
  letter-spacing: 0.24em;
  color: var(--rail-faint);
  padding: 10px 10px 4px;
}

.drop-hint {
  margin: 6px 4px;
  border: 1px dashed color-mix(in oklab, var(--rail-ink) 45%, transparent);
  border-radius: 3px;
  padding: 10px;
  text-align: center;
  font-size: 12px;
  color: var(--rail-faint);
}

.drop-hint.hot {
  border-color: var(--seal);
  color: var(--seal);
  background: color-mix(in oklab, var(--seal) 12%, transparent);
}

/* 文档条目是标题，不是文件行：明朝体 + 印色竖线。 */
.rail li button {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  border-left: 2px solid transparent;
  border-radius: 0;
  padding: 7px 10px 7px 12px;
  font-family: var(--serif);
  font-size: 14px;
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
  padding-top: 8px;
  border-top: 1px solid var(--rail-rule);
  display: flex;
  flex-direction: column;
}

/* ── Stage：桌面。平纸，占满窗口；面板浮于其上。 ── */
.stage {
  position: relative;
  display: flow-root;
  min-width: 0;
  height: calc(100vh - var(--chrome-height) - var(--status-height));
  min-height: 0;
  overflow: hidden;
  background: var(--paper);
}

.stage-row {
  display: flow-root;
  min-height: calc(100vh - var(--chrome-height) - var(--status-height));
}

/* 写作中的临时工作面：右侧滑入，不挤压版心。Settings 单独拥有整个 Stage。 */
.stage-row > :is(.dispatch, .connections) {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  z-index: 10;
  width: 400px;
  max-width: 48vw;
  box-shadow: -20px 0 44px color-mix(in oklab, var(--ink) 10%, transparent);
  animation: panel-in 240ms var(--ease);
}

@keyframes panel-in {
  from {
    transform: translateX(32px);
    opacity: 0;
  }
}

.notice {
  color: var(--pending);
  font-size: 13px;
  padding: 0 24px;
}

.empty {
  max-width: 720px;
  margin: 0 auto;
  padding: 20vh 24px 0;
  text-align: center;
  font-family: var(--serif);
  font-size: 15px;
  color: var(--ink-faint);
}

/* 编辑器右键菜单：句段级工具，点到即走。 */
.context-menu {
  position: fixed;
  z-index: 40;
  display: flex;
  flex-direction: column;
  min-width: 120px;
  background: var(--paper-raised);
  border: 1px solid var(--rule-strong);
  border-radius: 4px;
  box-shadow: 0 12px 32px color-mix(in oklab, var(--ink) 14%, transparent);
  padding: 4px;
}

.context-menu button {
  border: none;
  text-align: left;
  padding: 6px 12px;
  border-radius: 2px;
}

.context-backdrop {
  position: fixed;
  inset: 0;
  z-index: 39;
}
</style>
