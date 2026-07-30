import type {
  EditorAnnotationProjection,
  EditorContext,
  EditorFormat,
  PunctuationFinding,
} from "@refrain/editor";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { describe, unwrap } from "../bridge";
import { debugCommands } from "../e2e/debug-bridge";
import {
  type AnnotationDto,
  commands,
  type DocumentRow,
  type ProjectOpenedDto,
} from "../generated/bindings.gen";
import { AnnotationSurface } from "../ui/AnnotationSurface";
import { ConflictDialog } from "../ui/ConflictDialog";
import { ConnectionsSurface } from "../ui/ConnectionsSurface";
import { DispatchSurface } from "../ui/DispatchSurface";
import { EditorContextMenu } from "../ui/EditorContextMenu";
import { EditorHost, type EditorHostHandle } from "../ui/EditorHost";
import { KaraSurface } from "../ui/KaraSurface";
import { LogoMark } from "../ui/LogoMark";
import { ReviewSurface } from "../ui/ReviewSurface";
import { SettingsSurface } from "../ui/SettingsSurface";
import { StatusLine } from "../ui/StatusLine";
import { UniversalButton } from "../ui/UniversalButton";
import { UniversalMenu } from "../ui/UniversalMenu";
import { WindowChrome } from "../ui/WindowChrome";
import { type DocumentGateway, DocumentSession } from "./document-session";
import { useKara } from "./kara-state";
import { e2ePickedPath } from "./pick";
import { ProjectSession } from "./project-session";
import { browserTimer, RailPresence } from "./rail-presence";
import { commandCatalog, type WorkbenchCommandId } from "./workbench-commands";
import {
  initialWorkbenchState,
  reduceWorkbench,
  type SettingsSection,
  type WorkbenchReference,
  type WorkbenchState,
} from "./workbench-state";

const gateway: DocumentGateway = {
  openDocument: async (rootId, path) => unwrap(commands.openDocument(rootId, path)),
  currentDocument: async (rootId, path) => unwrap(commands.currentDocument(rootId, path)),
  async persistRevision(rootId, path, stamp) {
    const outcome = await unwrap(commands.persistRevision(rootId, path, stamp));
    return outcome.kind === "saved"
      ? { kind: "saved", value: outcome.value }
      : { kind: "conflict", value: outcome.value };
  },
  listAnnotations: async (rootId, document) => unwrap(commands.listAnnotations(rootId, document)),
  upsertAnnotation: async (request) => unwrap(commands.upsertAnnotation(request)),
  deleteAnnotation: async (rootId, id) => unwrap(commands.deleteAnnotation(rootId, id)),
};

type MenuState = {
  context: EditorContext;
  pointerX: number;
  pointerY: number;
};

type WorkbenchProps = { onThemeChanged?: (slug: string) => void };

export function Workbench(props: WorkbenchProps) {
  const [notice, setNotice] = createSignal<string | null>(null);
  const [projectTick, setProjectTick] = createSignal(0);
  const [documentTick, setDocumentTick] = createSignal(0);
  const [state, setState] = createSignal<WorkbenchState<never>>(initialWorkbenchState());
  const [menu, setMenu] = createSignal<MenuState | null>(null);
  const [commandMenuOpen, setCommandMenuOpen] = createSignal(false);
  // Opening the command menu takes focus away from wherever the author was.
  // Closing it must give that focus back, or a keyboard user is dropped at the
  // top of the document with no way back to the sentence they were writing.
  // The entry point is remembered here because only the opener knows it.
  let commandReturnFocus: HTMLElement | null = null;

  const openCommandMenu = (): void => {
    if (commandMenuOpen()) return;
    commandReturnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCommandMenuOpen(true);
  };

  const closeCommandMenu = (): void => {
    if (!commandMenuOpen()) return;
    setCommandMenuOpen(false);
    const target = commandReturnFocus;
    commandReturnFocus = null;
    queueMicrotask(() => {
      // The hot zone re-opens the menu on focus, so returning focus there would
      // trap the author in a loop; fall through to the manuscript instead.
      if (target?.isConnected && !target.closest(".universal-button-zone")) target.focus();
      else editor?.focus();
    });
  };

  const [railReceded, setRailReceded] = createSignal(false);
  const rail = new RailPresence(browserTimer, setRailReceded);
  const [dispatchSeed, setDispatchSeed] = createSignal<string[]>([]);
  const [dispatchPrompt, setDispatchPrompt] = createSignal("");
  const kara = useKara();
  const [karaTick, setKaraTick] = createSignal(0);
  const stopKara = kara.subscribe(() => setKaraTick((value) => value + 1));
  let editor: EditorHostHandle | null = null;

  const projectSession = new ProjectSession(
    undefined,
    undefined,
    (error) => setNotice(describe(error)),
    undefined,
    // 装上一个项目，等于换了一份稿子的世界：打开的文档不再属于这里。
    (opened) => {
      documentSession.useProject(opened.rootId);
      setNotice(null);
    },
    describe,
  );
  const documentSession = new DocumentSession(
    gateway,
    () => editor,
    {
      notice: setNotice,
      failed: setNotice,
    },
    describe,
  );
  const stopProject = projectSession.onChanged(() => {
    setProjectTick((value) => value + 1);
    // 名录自己会说话了（「已导入」、取得项目时的失败）。外壳照搬，不改写措辞。
    const activity = projectSession.view();
    if (activity.kind === "reported" || activity.kind === "failed") setNotice(activity.text);
  });
  const stopDocument = documentSession.onChanged(() => setDocumentTick((value) => value + 1));

  const project = createMemo(() => {
    projectTick();
    return projectSession.project;
  });
  const documentView = createMemo(() => {
    documentTick();
    return documentSession.view();
  });
  const active = createMemo(() => documentView().document);
  const documents = createMemo(() => {
    projectTick();
    return projectSession.visibleDocuments;
  });
  const chapters = createMemo(() => documents().filter((row) => row.role === "chapter"));
  const materials = createMemo(() => documents().filter((row) => row.role === "material"));
  const editorAnnotations = createMemo<EditorAnnotationProjection[]>(() =>
    documentView().annotations.map((row) => ({
      id: row.id,
      blockId: row.blockId,
      start: row.start,
      end: row.end,
      kind: row.kind,
      anchorState: row.anchorState,
    })),
  );
  const reference = createMemo(() => state().reference);
  const annotationsOpen = createMemo(() => reference()?.kind === "annotations");
  const settingsSection = createMemo<SettingsSection>(() => {
    const current = reference();
    return current?.kind === "settings" ? current.section : "appearance";
  });
  const commandsForMenu = createMemo(() =>
    commandCatalog({ hasProject: project() !== null, hasDocument: active() !== null }),
  );
  const karaEngaged = (): boolean => {
    karaTick();
    return kara.engaged.value;
  };

  const transition = (event: Parameters<typeof reduceWorkbench<never>>[1]): void => {
    setState((current) => reduceWorkbench(current, event));
  };
  const openStage = (stage: "writing" | "review" | "dispatch"): void => {
    transition({ kind: "openStage", stage });
  };
  const openReference = (next: WorkbenchReference): void => {
    transition({ kind: "openReference", reference: next });
  };
  const closeReference = (): void => transition({ kind: "closeReference" });

  // 取得项目的四条路都归 ProjectSession；这里只负责问作者要一个名字。
  const openProjectFolder = (): Promise<void> => projectSession.openFolder();
  const openSingleDocument = (): Promise<void> => projectSession.openSingleDocument();
  const createProject = async (): Promise<void> => {
    const name = window.prompt("项目名");
    if (name === null) return;
    await projectSession.createProject(name);
  };

  const selectDocument = async (path: string): Promise<void> => {
    const opened = await documentSession.open(path);
    if (opened === null) return;
    kara.apply(opened.kara);
    transition({ kind: "documentSelected" });
    if (opened.staleJournal.length > 0) {
      setNotice(`有 ${opened.staleJournal.length} 条未确认的行动无法恢复，已留作证据。`);
    } else if (opened.replayed > 0) {
      setNotice(`已恢复 ${opened.replayed} 条上次未确认的行动。`);
    }
  };

  const createDocument = async (role: "chapter" | "material"): Promise<void> => {
    const title = window.prompt(role === "chapter" ? "新章名" : "新资料名");
    if (title === null) return;
    // 建好之后跳过去是外壳的编排；名录只管把它记下来。
    const created = await projectSession.createDocument(title, role);
    if (created !== null) await selectDocument(created);
  };

  const importMaterial = (): Promise<void> => projectSession.importMaterial();

  const save = (): void => void documentSession.save();
  const markDirty = (): void => {
    documentSession.markDirty();
    if (!kara.engaged.value) return;
    const caret = editor?.caret();
    const current = active();
    if (caret === null || caret === undefined || current === null) return;
    const block = current.blocks.find((candidate) => candidate.id === caret.blockId);
    void kara.setReturnPoint({
      blockId: caret.blockId,
      offset: caret.offset,
      sentenceTail: (block?.text ?? "").slice(0, caret.offset).slice(-18),
    });
  };

  const persistAnnotation = async (
    kind: "highlight" | "comment",
    existing: AnnotationDto | null = null,
  ): Promise<void> => {
    const current = menu();
    const selection = current?.context.selection;
    if (current === null || selection === null || selection === undefined) return;
    const body =
      kind === "comment" && existing === null
        ? window.prompt("批注")?.trim() || null
        : (existing?.body ?? null);
    if (kind === "comment" && body === null) return;
    const row = await documentSession.upsertAnnotation({
      id: existing?.id ?? null,
      blockId: current.context.blockId,
      start: selection.start,
      end: selection.end,
      quote: selection.quote,
      kind,
      body,
    });
    setMenu(null);
    if (row !== null) openReference({ kind: "annotations" });
  };

  const beginRelocation = (annotation: AnnotationDto): void => {
    documentSession.beginRelocation(annotation);
    closeReference();
    openStage("writing");
    setNotice("请选择准确原文，右键后选择“将批注迁到这里”。");
    queueMicrotask(() => editor?.focus());
  };

  const dispatchAnnotations = (blockIds: string[], prompt: string): void => {
    setDispatchSeed([...new Set(blockIds)]);
    setDispatchPrompt(prompt);
    openStage("dispatch");
  };

  const dispatchBlock = (accumulate: boolean): void => {
    const current = menu();
    if (current === null) return;
    setDispatchSeed((seed) =>
      accumulate ? [...seed, current.context.blockId] : [current.context.blockId],
    );
    openStage("dispatch");
    setMenu(null);
  };

  const executeCommand = (id: WorkbenchCommandId): void => {
    closeCommandMenu();
    switch (id) {
      case "return-writing":
        openStage("writing");
        queueMicrotask(() => editor?.focus());
        break;
      case "open-review":
        openStage("review");
        break;
      case "open-project":
        void openProjectFolder();
        break;
      case "create-project":
        void createProject();
        break;
      case "open-document":
        void openSingleDocument();
        break;
      case "new-chapter":
        void createDocument("chapter");
        break;
      case "new-material":
        void createDocument("material");
        break;
      case "import-material":
        void importMaterial();
        break;
      case "save-document":
        save();
        break;
      case "open-dispatch":
        openStage("dispatch");
        break;
      case "open-connections":
        openReference({ kind: "connections" });
        break;
      case "open-appearance":
      case "open-typography":
      case "open-shortcuts":
        openReference({
          kind: "settings",
          section:
            id === "open-appearance"
              ? "appearance"
              : id === "open-typography"
                ? "typography"
                : "shortcuts",
        });
        break;
    }
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.isComposing || editor?.isComposing()) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
    } else if (modifier && event.key.toLocaleLowerCase() === "k") {
      event.preventDefault();
      if (commandMenuOpen()) closeCommandMenu();
      else openCommandMenu();
    } else if (event.key === "Escape" && menu() !== null) {
      event.preventDefault();
      setMenu(null);
    }
  };

  const onPointerMove = (event: PointerEvent): void => rail.pointerMoved(event.clientX);

  const requestClose = (): void => {
    if (documentSession.hasUnsavedText()) {
      setNotice("正文尚未保存。请先保存，再关闭窗口。");
      return;
    }
    void getCurrentWindow()
      .destroy()
      .catch((error) => setNotice(describe(error)));
  };

  onMount(() => {
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    rail.begin();
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKeydown);
    window.removeEventListener("pointermove", onPointerMove);
    rail.dispose();
    projectSession.dispose();
    stopProject();
    stopDocument();
    stopKara();
  });

  return (
    <div class="workbench">
      <WindowChrome
        title={active()?.document.path ?? "RefRain"}
        onCloseRequested={requestClose}
        onError={setNotice}
      />
      <Show
        when={
          project() !== null &&
          active() !== null &&
          state().stage === "writing" &&
          reference() === null
        }
      >
        <UniversalButton onActivate={openCommandMenu} />
      </Show>
      <Show when={commandMenuOpen()}>
        <UniversalMenu
          entries={commandsForMenu()}
          onChoose={executeCommand}
          onClose={closeCommandMenu}
        />
      </Show>

      <Show
        when={project()}
        fallback={
          <section class="welcome">
            <LogoMark size={64} label="RefRain" />
            <h1 class="welcome-brand">RefRain</h1>
            <p class="welcome-tag">一个本地写作工作台。你写的每一个字都在磁盘上。</p>
            <button
              class="primary welcome-open"
              type="button"
              onClick={() => void openProjectFolder()}
            >
              打开文件夹
            </button>
            <div class="secondary">
              <button type="button" onClick={() => void createProject()}>
                新建项目
              </button>
              <button type="button" onClick={() => void openSingleDocument()}>
                打开文档
              </button>
            </div>
            <Show when={notice()}>{(text) => <p class="notice">{text()}</p>}</Show>
          </section>
        }
      >
        {(root) => (
          <>
            <nav
              class="rail"
              classList={{ receded: railReceded() || reference()?.kind === "settings" }}
              aria-label="文档"
            >
              <button type="button" class="brand" onClick={() => setRailReceded((value) => !value)}>
                <LogoMark size={28} label="RefRain" />
              </button>
              <div class="rail-actions">
                <button type="button" onClick={() => void createDocument("chapter")}>
                  新章
                </button>
                <button type="button" onClick={() => void createDocument("material")}>
                  新资料
                </button>
                <button type="button" onClick={() => void importMaterial()}>
                  导入
                </button>
              </div>
              <div class="rail-search">
                <input
                  value={projectSession.query}
                  type="search"
                  aria-label="搜索全部文档"
                  placeholder="搜索全部文档"
                  onInput={(event) => projectSession.setQuery(event.currentTarget.value)}
                />
              </div>
              <div class="shelf" data-shelf="manuscript">
                <div class="rail-group">原稿</div>
                <ul>
                  <For each={chapters()}>
                    {(row) => (
                      <li>
                        <button
                          type="button"
                          classList={{ current: active()?.document.path === row.path }}
                          onClick={() => void selectDocument(row.path)}
                        >
                          {row.path}
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
              <Show when={materials().length > 0}>
                <div class="shelf" data-shelf="material">
                  <div class="rail-group">资料</div>
                  <ul>
                    <For each={materials()}>
                      {(row) => (
                        <li>
                          <button type="button" onClick={() => void selectDocument(row.path)}>
                            {row.path}
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>
              <div class="rail-foot">
                <Show when={active()}>
                  <button
                    type="button"
                    classList={{ current: state().stage === "review" }}
                    onClick={() => openStage("review")}
                  >
                    Review
                  </button>
                  <button
                    type="button"
                    classList={{ current: state().stage === "dispatch" }}
                    onClick={() => openStage("dispatch")}
                  >
                    派发
                  </button>
                  <button
                    type="button"
                    classList={{ current: annotationsOpen() }}
                    onClick={() => openReference({ kind: "annotations" })}
                  >
                    批注
                  </button>
                </Show>
                <button
                  type="button"
                  classList={{ current: reference()?.kind === "connections" }}
                  onClick={() => openReference({ kind: "connections" })}
                >
                  连接
                </button>
                <button
                  type="button"
                  classList={{ current: reference()?.kind === "settings" }}
                  onClick={() => openReference({ kind: "settings", section: "appearance" })}
                >
                  设置
                </button>
              </div>
            </nav>

            <main class="stage">
              <Show when={notice()}>{(text) => <p class="notice">{text()}</p>}</Show>
              <Show when={reference()?.kind === "settings"}>
                <SettingsSurface
                  initialSection={settingsSection()}
                  returnLabel={active()?.document.path ?? "工作台"}
                  onClosed={closeReference}
                  onThemePicked={(slug: string) => props.onThemeChanged?.(slug)}
                />
              </Show>
              <Show when={state().stage === "review" && active() !== null}>
                <ReviewSurface
                  rootId={root().rootId}
                  path={active()?.document.path ?? ""}
                  onCommitted={() => void documentSession.adoptCommitted()}
                  onClosed={() => openStage("writing")}
                />
              </Show>
              <Show when={active()}>
                {(open) => (
                  <div
                    class="stage-row"
                    style={{
                      display:
                        reference()?.kind === "settings" || state().stage === "review"
                          ? "none"
                          : undefined,
                    }}
                  >
                    <EditorHost
                      rootId={root().rootId}
                      path={open().document.path}
                      document={open()}
                      annotations={editorAnnotations()}
                      onReady={(handle) => {
                        editor = handle;
                      }}
                      onConfirmed={() => markDirty()}
                      onRejected={setNotice}
                      onContext={(context, pointerX, pointerY) =>
                        setMenu({ context, pointerX, pointerY })
                      }
                    />
                    <Show when={annotationsOpen()}>
                      <AnnotationSurface
                        annotations={documentView().annotations}
                        onClose={closeReference}
                        onDelete={(id) => void documentSession.deleteAnnotation(id)}
                        onRelocate={beginRelocation}
                        onDispatch={dispatchAnnotations}
                      />
                    </Show>
                    <Show when={state().stage === "dispatch" && !annotationsOpen()}>
                      <DispatchSurface
                        rootId={root().rootId}
                        path={open().document.path}
                        blocks={open().blocks}
                        materials={materials().map((row) => ({ path: row.path, label: row.path }))}
                        seed={dispatchSeed()}
                        initialPrompt={dispatchPrompt()}
                        onCollected={(count) =>
                          setNotice(`${count} 条提案已冻结，点 Review 逐句裁决。`)
                        }
                        onMaterialSaved={(row: DocumentRow) => projectSession.add(row)}
                        onClosed={() => openStage("writing")}
                      />
                    </Show>
                    <Show when={reference()?.kind === "connections"}>
                      <ConnectionsSurface rootId={root().rootId} onClosed={closeReference} />
                    </Show>
                  </div>
                )}
              </Show>
              <Show when={active() === null && reference()?.kind === "connections"}>
                <div class="stage-row">
                  <ConnectionsSurface rootId={root().rootId} onClosed={closeReference} />
                </div>
              </Show>
              <Show
                when={
                  active() === null &&
                  reference()?.kind !== "settings" &&
                  reference()?.kind !== "connections"
                }
              >
                <p class="empty">从左侧选一个文档，或新建一章。</p>
              </Show>
            </main>

            <Show when={menu()}>
              {(current) => (
                <EditorContextMenu
                  context={current().context}
                  pointerX={current().pointerX}
                  pointerY={current().pointerY}
                  kara={karaEngaged()}
                  relocating={documentView().relocating !== null}
                  onFormat={(kind: EditorFormat) => {
                    editor?.formatSelection(kind);
                    setMenu(null);
                  }}
                  onDeleteEmpty={() => {
                    editor?.deleteEmptyBlock();
                    setMenu(null);
                  }}
                  onPunctuation={(finding: PunctuationFinding) => {
                    editor?.applyPunctuation(finding);
                    setMenu(null);
                  }}
                  onHighlight={() => void persistAnnotation("highlight")}
                  onComment={() => void persistAnnotation("comment")}
                  onRelocate={() => {
                    const relocating = documentView().relocating;
                    if (relocating !== null) void persistAnnotation(relocating.kind, relocating);
                  }}
                  onDispatch={() => dispatchBlock(false)}
                  onAccumulate={() => dispatchBlock(true)}
                  onClose={() => setMenu(null)}
                />
              )}
            </Show>
            <StatusLine state={documentView().save} path={active()?.document.path ?? null} />
            <Show when={karaEngaged()}>
              <KaraSurface />
            </Show>
            <Show when={documentView().conflict}>
              {(conflict) => (
                <ConflictDialog
                  mine={conflict().mine}
                  theirs={conflict().theirs}
                  onResolve={(choice) => void documentSession.resolveConflict(choice)}
                />
              )}
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
