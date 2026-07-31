import type {
  BlockPrefix,
  EditorAnnotationProjection,
  EditorFormat,
  PunctuationFinding,
  SelectionMeasure,
} from "@refrain/editor";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { describe, unwrap } from "../bridge";
import { type AnnotationDto, commands } from "../generated/bindings.gen";
import { AnnotationSurface } from "../ui/AnnotationSurface";
import { ConflictDialog } from "../ui/ConflictDialog";
import { ConnectionsSurface } from "../ui/ConnectionsSurface";
import { DispatchSurface } from "../ui/DispatchSurface";
import { EditorContextMenu } from "../ui/EditorContextMenu";
import { EditorHost, type EditorHostHandle } from "../ui/EditorHost";
import { KaraSurface } from "../ui/KaraSurface";
import { LogoMark } from "../ui/LogoMark";
import { RailShelf } from "../ui/RailShelf";
import { ReviewSurface } from "../ui/ReviewSurface";
import { SettingsSurface } from "../ui/SettingsSurface";
import { StatusLine } from "../ui/StatusLine";
import { UniversalButton } from "../ui/UniversalButton";
import { UniversalMenu } from "../ui/UniversalMenu";
import { WindowChrome } from "../ui/WindowChrome";
import { AnnotationSelection } from "./annotation-selection";
import { CommandFocus } from "./command-focus";
import { type DocumentGateway, DocumentSession } from "./document-session";
import { EditIntents } from "./edit-intents";
import { useKara } from "./kara-state";
import { canOpen, panelKey, settingsSection } from "./panel-reference";
import { panelLayout } from "./panel-spine";
import { PanelStack } from "./panel-stack";
import { ProjectSession } from "./project-session";
import { QuarterMemory, runQuarterKey } from "./quarter-navigation";
import { takesWholeStage } from "./quarters";
import { browserTimer, RailPresence } from "./rail-presence";
import { railScroll } from "./rail-scroll";
import { SelectionReadout } from "./selection-readout";
import { handleShortcut } from "./shortcuts";
import { Welcome } from "./Welcome";
import { commandCatalog, type WorkbenchCommandId } from "./workbench-commands";
import {
  initialWorkbenchState,
  reduceWorkbench,
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

type WorkbenchProps = { onThemeChanged?: (slug: string) => void };

/**
 * 命令 id 到块级前缀的映射。
 *
 * Record 而非 switch 里的 default：加一个前缀命令却忘了接线，会在这里编译失败，
 * 而不是在作者按下它时静默什么也不做。
 */
const BLOCK_PREFIX_OF: Partial<Record<WorkbenchCommandId, BlockPrefix>> = {
  "format-heading-1": "heading-1",
  "format-heading-2": "heading-2",
  "format-heading-3": "heading-3",
  "format-quote": "quote",
  "format-bullet-list": "bullet-list",
  "format-ordered-list": "ordered-list",
};

export function Workbench(props: WorkbenchProps) {
  const [notice, setNotice] = createSignal<string | null>(null);
  const [projectTick, setProjectTick] = createSignal(0);
  const [documentTick, setDocumentTick] = createSignal(0);
  const [state, setState] = createSignal<WorkbenchState<never>>(initialWorkbenchState());
  const [panelTick, setPanelTick] = createSignal(0);
  const panels = new PanelStack<WorkbenchReference>(() => setPanelTick((value) => value + 1));
  const [selectionTick, setSelectionTick] = createSignal(0);
  // 作者勾了哪些批注要交给 Agent。归外壳而不是面板：面板一关组件就没了，
  // 而他刚做的选择不该跟着没——那正是「重复按键」的来源。
  const annotationSelection = new AnnotationSelection(() => setSelectionTick((value) => value + 1));
  const selectedAnnotations = createMemo(() => {
    selectionTick();
    return annotationSelection.selected;
  });
  // 批注在别处被删掉时（作者删了那段正文，或另一处删了批注），选择要跟着放手：
  // 否则派发会带上一个取不到引文的 id，而失败发生在派发那一刻，离作者做这个
  // 选择已经很远。放在 effect 而不是上面那个 memo 里——在读取路径上做写入，
  // 省下的四行不值得让「读一个值」变成可能改变状态的操作。
  createEffect(() => {
    annotationSelection.retain(documentView().annotations.map((row) => row.id));
  });
  const [intentTick, setIntentTick] = createSignal(0);
  // 右键落点、批注锚点、派发种子是同一条链上的三段，归 EditIntents。
  const intents = new EditIntents(() => setIntentTick((value) => value + 1));
  const menu = createMemo(() => {
    intentTick();
    return intents.pointer;
  });
  const dispatchSeed = createMemo(() => {
    intentTick();
    return intents.seed;
  });
  const [commandMenuOpen, setCommandMenuOpen] = createSignal(false);
  // 面板拿走焦点、还回焦点这件事完整地归 CommandFocus——包括「热区会把作者
  // 关进开合循环」那条只有它知道的规矩。这里只订它的广播。
  const commandFocus = new CommandFocus(setCommandMenuOpen, () => editor?.focus());
  const openCommandMenu = (): void => commandFocus.show();
  const closeCommandMenu = (): void => commandFocus.hide();

  const [railReceded, setRailReceded] = createSignal(false);
  const rail = new RailPresence(browserTimer, setRailReceded);
  const kara = useKara();
  const [karaTick, setKaraTick] = createSignal(0);
  const stopKara = kara.subscribe(() => setKaraTick((value) => value + 1));
  let editor: EditorHostHandle | null = null;
  const [selectionMeasure, setSelectionMeasure] = createSignal<SelectionMeasure | null>(null);
  const selectionReadout = new SelectionReadout(setSelectionMeasure);

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

  // 名录可以有十万条。侧栏只挂看得见的那几十行，其余用两个 spacer 撑住滚动条；
  // 视野逼近末尾时顺手取下一页——「继续加载」按钮不该存在，作者要的是往下滚。
  const railView = railScroll();
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
  // 栈顶就是屏幕上那一层。没有第二处记录，所以不存在「谁对」的问题。
  const reference = createMemo(() => {
    panelTick();
    return panels.top?.content ?? null;
  });
  /** 这条路径此刻在屏幕上的样子：让开多宽、算不算开着。 */
  const layout = createMemo(() => {
    panelTick();
    return panelLayout(
      panels.depth,
      takesWholeStage({ reference: reference()?.kind ?? null, stage: state().stage }),
    );
  });
  const annotationsOpen = createMemo(() => reference()?.kind === "annotations");
  const commandsForMenu = createMemo(() =>
    commandCatalog({ hasProject: project() !== null, hasDocument: active() !== null }),
  );
  const karaEngaged = createMemo(() => {
    karaTick();
    return kara.engaged.value;
  });
  // Agent navigation remembers its last panel. It is read only when Cmd+4 runs.
  const quarterMemory = new QuarterMemory();
  const transition = (event: Parameters<typeof reduceWorkbench<never>>[1]): void => {
    setState((current) => reduceWorkbench(current, event));
  };
  const openStage = (stage: "writing" | "review" | "dispatch"): void => {
    panels.clear();
    // 记在这里而不是每个按钮上：所有打开派发的路都经过这一处，
    // 散到调用点则每加一个入口就要记得补一次，而没人会记得。
    if (stage === "dispatch") quarterMemory.rememberAgent("dispatch");
    transition({ kind: "openStage", stage });
  };
  const openReference = (next: WorkbenchReference): void => {
    if (!canOpen(next, active() !== null)) return;
    if (next.kind === "annotations" || next.kind === "connections") {
      quarterMemory.rememberAgent({ reference: next });
    }
    const key = panelKey(next);
    panels.open({ key, title: key, content: next });
  };
  const closeReference = (): void => panels.clear();

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
    // 换一份稿子是换场景：打开着的那条面板路径不再属于这里。
    panels.clear();
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
    const caret = editor?.caret();
    const blocks = active()?.blocks ?? [];
    const text = blocks.find((candidate) => candidate.id === caret?.blockId)?.text ?? "";
    kara.markPosition(caret, text);
  };

  const persistAnnotation = async (
    kind: "highlight" | "comment",
    existing: AnnotationDto | null = null,
  ): Promise<void> => {
    const target = intents.annotationTarget(existing);
    if (target === null) return;
    const body =
      kind === "comment" && existing === null
        ? window.prompt("批注")?.trim() || null
        : (existing?.body ?? null);
    if (kind === "comment" && body === null) return;
    const row = await documentSession.upsertAnnotation({ ...target, kind, body });
    intents.release();
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
    intents.dispatchAnnotations(blockIds, prompt);
    // 意图已经交出去了，清空。只有这一刻该清——关面板、切层都不该。
    annotationSelection.clear();
    openStage("dispatch");
  };

  const dispatchBlock = (accumulate: boolean): void => {
    if (intents.dispatchAimedBlock(accumulate)) openStage("dispatch");
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
        openReference({ kind: "settings", section: "appearance" });
        break;
      case "open-typography":
        openReference({ kind: "settings", section: "typography" });
        break;
      case "open-shortcuts":
        openReference({ kind: "settings", section: "shortcuts" });
        break;
      default: {
        // 块级格式化命令是一次查表，不是六条分支。表里没有的 id 落到这里
        // 什么也不做——这是刻意的：命令目录与执行分属两处，漏接一个不应当
        // 让整条命令路径崩掉。
        const prefix = BLOCK_PREFIX_OF[id];
        if (prefix !== undefined) editor?.applyBlockPrefix(prefix);
        break;
      }
    }
  };

  /** Cmd+1..4。返回 false 表示这一层此刻去不了，那一下不该被接管。 */
  /** Cmd+1..4。返回 false 表示这一层此刻去不了，那一下不该被接管。 */
  const goToQuarter = (key: string): boolean =>
    runQuarterKey(key, quarterMemory, active() !== null, {
      openSettings: () =>
        openReference({ kind: "settings", section: settingsSection(reference()) }),
      focusRail: () => railView.focus(),
      returnToManuscript: () => {
        panels.clear();
        editor?.focus();
      },
      openDispatch: () => openStage("dispatch"),
      openReference,
    });

  const onKeydown = (event: KeyboardEvent): void => {
    handleShortcut(event, {
      composing: () => editor?.isComposing() === true,
      save,
      toggleCommandMenu: () => commandFocus.toggle(),
      menuOpen: () => menu() !== null,
      closeMenu: () => intents.release(),
      panelDepth: () => panels.depth,
      closePanel: () => panels.back(),
      goToQuarter,
    });
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

  /**
   * 设置面板的接线，一处。
   *
   * 它出现在两个位置——有稿子时在 stage-row 内与正文并存，没稿子时在一条空
   * stage-row 里。两处的接线完全相同，抄两遍的代价是它们会漂开：改了一处的
   * `onThemePicked` 而忘了另一处，换主题在其中一种情形下静默失效。
   *
   * 设置是四区第 1 层，与正文并存——作者改字号时要看得见自己的字。它在
   * stage-row 里而不是 stage 里，因此走的是与其他面板同一条 CSS 路径：
   * 绝对定位、正文让位、书脊、动效、材质、灯光全部自动跟随。此前它是 stage
   * 的直接子元素，探针实测把正文挤到视口外 156px 处。
   */
  const settingsPanel = () => (
    <Show when={reference()?.kind === "settings"}>
      <SettingsSurface
        initialSection={settingsSection(reference())}
        returnLabel={active()?.document.path ?? "工作台"}
        onClosed={closeReference}
        onThemePicked={(slug: string) => props.onThemeChanged?.(slug)}
      />
    </Show>
  );

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
          <Welcome
            notice={notice()}
            onOpenFolder={() => void openProjectFolder()}
            onCreateProject={() => void createProject()}
            onOpenDocument={() => void openSingleDocument()}
          />
        }
      >
        {(root) => (
          <>
            <nav
              class="rail"
              classList={{ receded: railReceded() || reference()?.kind === "settings" }}
              aria-label="文档"
              ref={railView.ref}
              onScroll={railView.onScroll}
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
              <RailShelf
                label="原稿"
                shelf="manuscript"
                rows={chapters()}
                scrollTop={railView.view().top}
                viewportHeight={railView.view().height}
                currentPath={active()?.document.path ?? null}
                onSelect={(path) => void selectDocument(path)}
                catalog={projectSession}
              />
              <Show when={materials().length > 0}>
                <RailShelf
                  label="资料"
                  shelf="material"
                  rows={materials()}
                  scrollTop={railView.view().top}
                  viewportHeight={railView.view().height}
                  currentPath={active()?.document.path ?? null}
                  onSelect={(path) => void selectDocument(path)}
                  catalog={projectSession}
                />
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
              <Show when={state().stage === "review" && active() !== null}>
                <ReviewSurface
                  rootId={root().rootId}
                  path={active()?.document.path ?? ""}
                  onCommitted={() => void documentSession.adoptCommitted()}
                  onClosed={() => openStage("writing")}
                />
              </Show>
              <Show when={active()}>
                {(openDocument) => (
                  <div
                    class="stage-row"
                    attr:data-panels={layout()["data-panels"]}
                    style={layout().style}
                  >
                    {/* 光源区。层级与理由见 shell/strata.ts。 */}
                    <div class="lamp-layer" aria-hidden="true" />
                    <EditorHost
                      rootId={root().rootId}
                      path={openDocument().document.path}
                      document={openDocument()}
                      annotations={editorAnnotations()}
                      onReady={(handle) => {
                        editor = handle;
                        selectionReadout.observe(handle);
                      }}
                      onConfirmed={() => markDirty()}
                      onRejected={setNotice}
                      onContext={(context, pointerX, pointerY) =>
                        intents.aim(context, pointerX, pointerY)
                      }
                    />
                    <Show when={annotationsOpen()}>
                      <AnnotationSurface
                        annotations={documentView().annotations}
                        selected={selectedAnnotations()}
                        onToggle={(id) => annotationSelection.toggle(id)}
                        onClose={closeReference}
                        onDelete={(id) => void documentSession.deleteAnnotation(id)}
                        onRelocate={beginRelocation}
                        onDispatch={dispatchAnnotations}
                      />
                    </Show>
                    <Show when={state().stage === "dispatch" && !annotationsOpen()}>
                      <DispatchSurface
                        rootId={root().rootId}
                        path={openDocument().document.path}
                        blocks={openDocument().blocks}
                        materials={materials().map((row) => ({ path: row.path, label: row.path }))}
                        seed={[...dispatchSeed().blockIds]}
                        initialPrompt={dispatchSeed().prompt}
                        onCollected={(count) =>
                          setNotice(`${count} 条提案已冻结，点 Review 逐句裁决。`)
                        }
                        onMaterialSaved={(row) => projectSession.add(row)}
                        onClosed={() => openStage("writing")}
                      />
                    </Show>
                    <Show when={reference()?.kind === "connections"}>
                      <ConnectionsSurface rootId={root().rootId} onClosed={closeReference} />
                    </Show>
                    {settingsPanel()}
                  </div>
                )}
              </Show>
              {/*
                还没打开稿子时，面板没有正文可以并存，自己占着一条空舞台行即可。
                走同一个 stage-row，是为了让面板的定位、动效、材质、灯光只有一条
                CSS 路径——分成两套写法，其中一套迟早会在某个主题下看起来不对。
              */}
              <Show when={active() === null && reference() !== null}>
                <div class="stage-row">
                  <Show when={reference()?.kind === "connections"}>
                    <ConnectionsSurface rootId={root().rootId} onClosed={closeReference} />
                  </Show>
                  {settingsPanel()}
                </div>
              </Show>
              <Show when={active() === null && reference() === null}>
                <p class="empty">从左侧选一个文档，或新建一章。</p>
              </Show>
            </main>

            <Show when={menu()}>
              {(current) => (
                <EditorContextMenu
                  context={current().context}
                  pointerX={current().x}
                  pointerY={current().y}
                  kara={karaEngaged()}
                  relocating={documentView().relocating !== null}
                  onFormat={(kind: EditorFormat) => {
                    editor?.formatSelection(kind);
                    intents.release();
                  }}
                  onDeleteEmpty={() => {
                    editor?.deleteEmptyBlock();
                    intents.release();
                  }}
                  onPunctuation={(finding: PunctuationFinding) => {
                    editor?.applyPunctuation(finding);
                    intents.release();
                  }}
                  onHighlight={() => void persistAnnotation("highlight")}
                  onComment={() => void persistAnnotation("comment")}
                  onRelocate={() => {
                    const relocating = documentView().relocating;
                    if (relocating !== null) void persistAnnotation(relocating.kind, relocating);
                  }}
                  onDispatch={() => dispatchBlock(false)}
                  onAccumulate={() => dispatchBlock(true)}
                  onClose={() => intents.release()}
                />
              )}
            </Show>
            <StatusLine
              state={documentView().save}
              path={active()?.document.path ?? null}
              selection={selectionMeasure()}
            />
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
