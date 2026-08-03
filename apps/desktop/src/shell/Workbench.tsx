import type {
  BlockPrefix,
  CodeTheme,
  EditorAnnotationProjection,
  EditorContext,
  EditorFormat,
  PunctuationFinding,
  SelectionMeasure,
} from "@refrain/editor";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { describe } from "../bridge";
import type {
  AnnotationDto,
  BlockHit,
  Disclosure,
  DocumentRow,
  OpenDocumentDto_Serialize,
  ProposalDto,
} from "../generated/bindings.gen";
import { AnnotationSurface } from "../ui/AnnotationSurface";
import { ConflictDialog } from "../ui/ConflictDialog";
import { ConnectionsSurface } from "../ui/ConnectionsSurface";
import { DispatchSurface, type DispatchSurfaceProps } from "../ui/DispatchSurface";
import { EditorContextMenu, type EditorContextMenuProps } from "../ui/EditorContextMenu";
import { EditorHost, type EditorHostHandle } from "../ui/EditorHost";
import { HistorySurface } from "../ui/HistorySurface";
import { KaraSurface, KaraVeil } from "../ui/KaraSurface";
import { MailboxSection } from "../ui/MailboxSection";
import { MailboxSurface } from "../ui/MailboxSurface";
import { RailPrompt } from "../ui/RailPrompt";
import { type RailCatalog, RailShelf } from "../ui/RailShelf";
import { ReviewSurface } from "../ui/ReviewSurface";
import { SearchHits } from "../ui/SearchHits";
import { SettingsSurface } from "../ui/SettingsSurface";
import { SourceSurface } from "../ui/SourceSurface";
import { StatusLine } from "../ui/StatusLine";
import { UniversalMenu } from "../ui/UniversalMenu";
import { VerdictBento } from "../ui/VerdictBento";
import { WindowChrome } from "../ui/WindowChrome";
import { noticeText, workingText } from "./activity-text";
import { AnnotationSelection } from "./annotation-selection";
import { CommandFocus } from "./command-focus";
import { browserGateway, DocumentSession } from "./document-session";
import { EditIntents } from "./edit-intents";
import { browserHistoryGateway, HistorySession } from "./history-session";
import { useKara } from "./kara-state";
import { canOpen, panelKey, settingsSection } from "./panel-reference";
import { type PanelLayout, panelLayout } from "./panel-spine";
import { PanelStack } from "./panel-stack";
import { ProjectSession } from "./project-session";
import { QuarterMemory, runQuarterKey } from "./quarter-navigation";
import { dispatchBesideManuscript, takesWholeStage } from "./quarters";
import { browserTimer, RailPresence } from "./rail-presence";
import { railScroll } from "./rail-scroll";
import { browserRunWatchGateway, RunWatch } from "./run-watch";
import { SelectionReadout } from "./selection-readout";
import { handleShortcut } from "./shortcuts";
import type { TicketMailbox } from "./ticket-mailbox";
import { anchorProposals, bentoLayout, type VerdictAnchor } from "./verdict-anchors";
import { Welcome } from "./Welcome";
import { commandCatalog, type WorkbenchCommandId } from "./workbench-commands";
import {
  initialWorkbenchState,
  reduceWorkbench,
  type WorkbenchEvent,
  type WorkbenchReference,
  type WorkbenchState,
} from "./workbench-state";

type WorkbenchProps = {
  onThemeChanged?: (slug: string) => void;
  /** The code palette in force, projected from Config by App. */
  codeTheme?: CodeTheme | undefined;
};

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

/**
 * 从搜索命中跳过来时，把光标放到命中的那一块。
 *
 * 用 `ordinal` 而不是 `startByte`：块在打开后是一个数组，序号直接是下标，而
 * 字节偏移还要再算一次边界。索引可能比磁盘旧——作者删掉过几段之后，序号会落
 * 在数组之外，那时什么都不做，文档照常打开在开头。
 *
 * 排在微任务里：调用方 `transition` 之后编辑器要按新文档重挂，此刻直接调用会
 * 落在正被替换掉的那个实例上，光标随即被重挂时的 `focus()` 收回文首。宿主句柄
 * 因此按需取，而不是当参数传——传进来的那个可能已经不是将要接管的那一个。
 */
function revealBlock(
  blocks: readonly { readonly id: string }[],
  ordinal: number | null,
  host: () => EditorHostHandle | null,
): void {
  if (ordinal === null) return;
  const block = blocks[ordinal];
  if (block === undefined) return;
  queueMicrotask(() => host()?.focusBlock(block.id, 0));
}

/** 栏脚的目的地按钮。每个全局快捷键在这里都有一颗看得见的入口（KARA = Ctrl+Enter）。 */
function RailFoot(props: {
  hasDocument: boolean;
  annotationsOpen: boolean;
  historyOpen: boolean;
  karaEngaged: boolean;
  connectionsOpen: boolean;
  settingsOpen: boolean;
  onOpenAnnotations: () => void;
  onOpenHistory: () => void;
  onToggleKara: () => void;
  onOpenConnections: () => void;
  onOpenSettings: () => void;
}): JSX.Element {
  return (
    <div class="rail-foot">
      {/*
        逐句裁决与发送台**不在这里**：它们只从信箱进入。

        两个入口通向同一个 stage 时，作者要去的其实是「有三单未读」而不是
        一个空的裁决台，而信箱本来就带着计数——底部这一排给不出它。实测
        这两个按钮打开的 stage 与信箱三格完全相同（待发送→dispatch，
        其余→review），且没有任何一个能告诉作者另一个也到这里。

        批注留下：它开的是 annotations 面板，与信箱三格不重合。
      */}
      <Show when={props.hasDocument}>
        <button
          type="button"
          classList={{ current: props.annotationsOpen }}
          onClick={props.onOpenAnnotations}
        >
          批注
        </button>
        <button
          type="button"
          classList={{ current: props.historyOpen }}
          onClick={props.onOpenHistory}
        >
          历史
        </button>
        <button
          type="button"
          classList={{ current: props.karaEngaged }}
          onClick={props.onToggleKara}
        >
          KARA
        </button>
      </Show>
      <button
        type="button"
        classList={{ current: props.connectionsOpen }}
        onClick={props.onOpenConnections}
      >
        连接
      </button>
      <button
        type="button"
        classList={{ current: props.settingsOpen }}
        onClick={props.onOpenSettings}
      >
        设置
      </button>
    </div>
  );
}

/** 侧栏：品牌、新建与导入、搜索、栏内表单、两架文档、栏脚目的地。 */
function RailNav(props: {
  receded: boolean;
  rail: ReturnType<typeof railScroll>;
  onBrandToggle: () => void;
  onCreateChapter: () => void;
  onCreateMaterial: () => void;
  onImport: () => void;
  importDisabled: boolean;
  query: string;
  onQuery: (value: string) => void;
  precision: "exact" | "loose";
  onTogglePrecision: () => void;
  searchRef: (element: HTMLInputElement) => void;
  prompt: { label: string } | null;
  onPromptSubmit: (answer: string) => void;
  onPromptCancel: () => void;
  mailboxRootId: string | null;
  mailboxPath: string | null;
  onMailboxReady: (instance: TicketMailbox) => void;
  runWatch: RunWatch;
  onOpenTicket: (box: "draft" | "unread" | "done") => void;
  onTicketNotice: (text: string) => void;
  /** 「全部 →」那一击的去处：管理页是一层 reference，开合归外壳。 */
  onOpenMailbox: () => void;
  chapters: readonly DocumentRow[];
  materials: readonly DocumentRow[];
  /** 资料行的右键：移入回收站与范围。范围只与资料有关——原稿不进派发清单。 */
  onRemoveMaterial: (path: string) => void;
  onMaterialDisclosure: (path: string, disclosure: Disclosure) => void;
  searchHits: readonly BlockHit[];
  currentPath: string | null;
  onSelect: (path: string, ordinal?: number) => void;
  catalog: RailCatalog;
  foot: Parameters<typeof RailFoot>[0];
}): JSX.Element {
  return (
    <nav
      class="rail"
      classList={{ receded: props.receded }}
      aria-label="文档"
      ref={props.rail.ref}
      onScroll={props.rail.onScroll}
    >
      {/*
        侧栏不再挂第二个印：窗口边框那一处已经在同一屏上，两个同形的标记并排出现
        只是重复。这个按钮保留下来做收起/展开的把手，标签给读屏器。
      */}
      <button
        type="button"
        class="brand"
        aria-label="收起或展开侧栏"
        title="收起或展开侧栏"
        onClick={props.onBrandToggle}
      />
      <div class="rail-actions">
        <button type="button" onClick={props.onCreateChapter}>
          新章
        </button>
        <button type="button" onClick={props.onCreateMaterial}>
          新资料
        </button>
        <button type="button" disabled={props.importDisabled} onClick={props.onImport}>
          导入
        </button>
      </div>
      <div class="rail-search">
        <input
          ref={props.searchRef}
          value={props.query}
          type="search"
          aria-label="搜索全部文档"
          placeholder="搜索全部文档（Ctrl+F）"
          onInput={(event) => props.onQuery(event.currentTarget.value)}
        />
        {/* 默认精确：词里的每一部分都要出现；找不到时再切模糊。 */}
        <button
          type="button"
          class="search-mode"
          aria-pressed={props.precision === "loose"}
          title={
            props.precision === "exact" ? "精确：词的每一部分都要出现" : "模糊：任一部分命中即可"
          }
          onClick={props.onTogglePrecision}
        >
          {props.precision === "exact" ? "精确" : "模糊"}
        </button>
      </div>
      <SearchHits
        query={props.query}
        hits={props.searchHits}
        onSelect={(path, ordinal) => props.onSelect(path, ordinal)}
      />
      <Show when={props.prompt}>
        {(request) => (
          <RailPrompt
            label={request().label}
            onSubmit={props.onPromptSubmit}
            onCancel={props.onPromptCancel}
          />
        )}
      </Show>
      <RailShelf
        label="原稿"
        shelf="manuscript"
        rows={props.chapters}
        scrollTop={props.rail.view().top}
        viewportHeight={props.rail.view().height}
        currentPath={props.currentPath}
        onSelect={props.onSelect}
        catalog={props.catalog}
      />
      <Show when={props.materials.length > 0}>
        <RailShelf
          label="资料"
          shelf="material"
          rows={props.materials}
          scrollTop={props.rail.view().top}
          viewportHeight={props.rail.view().height}
          currentPath={props.currentPath}
          onSelect={props.onSelect}
          catalog={props.catalog}
          rowMenu={{
            onRemove: (row) => props.onRemoveMaterial(row.path),
            onDisclosure: (row, disclosure) => props.onMaterialDisclosure(row.path, disclosure),
          }}
        />
      </Show>
      <MailboxSection
        rootId={props.mailboxRootId}
        path={props.mailboxPath}
        runWatch={props.runWatch}
        onOpenTicket={props.onOpenTicket}
        onNotice={props.onTicketNotice}
        onOpenMailbox={props.onOpenMailbox}
        onReady={props.onMailboxReady}
      />
      <RailFoot {...props.foot} />
    </nav>
  );
}

/** 关窗前的未保存确认：给出路（保存并关闭），不是一行字把作者堵死。 */
function CloseConfirmBar(props: { onSaveAndClose: () => void; onCancel: () => void }): JSX.Element {
  return (
    <div class="close-confirm" role="alert">
      <span>正文尚未保存。</span>
      <button type="button" onClick={props.onSaveAndClose}>
        保存并关闭
      </button>
      <button type="button" onClick={props.onCancel}>
        取消
      </button>
    </div>
  );
}

/**
 * 搜索行的响应式切片：命中、查询词、精度。ProjectSession 是 framework-free
 * 的（它不该认识渲染框架），变化靠 tick 信号转达。此前这里把
 * `projectSession.precision` 裸传给按钮——getter 不读信号，模式真的切了而
 * 按钮上的字永远不变。工厂放模块级，组件体里只剩一行装配。
 */
function trackSearch(session: ProjectSession, tick: () => number) {
  return createMemo(() => {
    tick();
    return {
      hits: session.searchHits,
      query: session.query,
      precision: session.precision,
    };
  });
}

/** Ctrl+Z 的装配：编辑器在壳里，撤销在会话里，这一处是它们唯一的接头。 */
function undoWith(session: DocumentSession, host: () => EditorHostHandle | null): () => void {
  return () => {
    const current = host();
    if (current !== null) void session.undo((transition) => current.acceptTransition(transition));
  };
}

/** 发送台在舞台行里的那一格。接线只有一处，散到调用点就会漂开。 */
function DispatchStage(props: {
  rootId: string;
  path: string;
  blocks: DispatchSurfaceProps["blocks"];
  materials: DispatchSurfaceProps["materials"];
  seed: string[];
  initialPrompt: string | undefined;
  runWatch: RunWatch;
  onCollected: (count: number) => void;
  onMaterialSaved: (row: DocumentRow) => void;
  onClosed: () => void;
}): JSX.Element {
  return (
    <DispatchSurface
      rootId={props.rootId}
      path={props.path}
      blocks={props.blocks}
      materials={props.materials}
      seed={props.seed}
      initialPrompt={props.initialPrompt}
      runWatch={props.runWatch}
      onCollected={props.onCollected}
      onMaterialSaved={props.onMaterialSaved}
      onClosed={props.onClosed}
    />
  );
}

/** 正文右键菜单的接线，一处。每个动作收掉菜单后的去向也在这里。 */
function EditorMenu(props: {
  menu: { context: EditorContextMenuProps["context"]; x: number; y: number };
  kara: boolean;
  relocating: boolean;
  editor: () => EditorHostHandle | null;
  intents: EditIntents;
  onHighlight: () => void;
  onComment: () => void;
  onRelocate: () => void;
  onDispatch: (accumulate: boolean) => void;
  onNotice: (text: string) => void;
  focusEditor: () => void;
}): JSX.Element {
  const release = (): void => props.intents.release();
  return (
    <EditorContextMenu
      context={props.menu.context}
      pointerX={props.menu.x}
      pointerY={props.menu.y}
      kara={props.kara}
      relocating={props.relocating}
      onFormat={(kind: EditorFormat) => {
        props.editor()?.formatSelection(kind);
        release();
      }}
      onDeleteEmpty={() => {
        props.editor()?.deleteEmptyBlock();
        release();
      }}
      onPunctuation={(finding: PunctuationFinding) => {
        props.editor()?.applyPunctuation(finding);
        release();
      }}
      onConvertEverywhere={() => {
        const converted = props.editor()?.convertPunctuationEverywhere() ?? 0;
        // 一处都没转时菜单不能装死：作者分不清「没有可转的」与「坏了」。
        if (converted === 0) props.onNotice("没有需要转换的标点。");
        release();
      }}
      onHighlight={props.onHighlight}
      onComment={props.onComment}
      onRelocate={props.onRelocate}
      onAccumulate={() => props.onDispatch(true)}
      onClose={() => {
        release();
        // 菜单拿走焦点开过键盘路，收掉时还回编辑器。
        props.focusEditor();
      }}
    />
  );
}

/**
 * 设置面板的接线，一处。
 *
 * 它出现在两个位置——有稿子时在 stage-row 内与正文并存，没稿子时在一条空
 * stage-row 里。两处的接线完全相同，抄两遍的代价是它们会漂开：改了一处的
 * `onThemePicked` 而忘了另一处，换主题在其中一种情形下静默失效。
 *
 * 设置与正文并存——作者改字号时要看得见自己的字。它在 stage-row 里而不是
 * stage 里，因此走的是与其他面板同一条 CSS 路径。
 */
function SettingsReference(props: {
  reference: WorkbenchReference | null;
  onClosed: () => void;
  onThemeChanged?: ((slug: string) => void) | undefined;
}): JSX.Element {
  return (
    <Show when={props.reference?.kind === "settings"}>
      <SettingsSurface
        initialSection={settingsSection(props.reference)}
        onClosed={props.onClosed}
        onThemePicked={(slug: string) => props.onThemeChanged?.(slug)}
      />
    </Show>
  );
}

/**
 * 原件面板的接线，一处。
 *
 * 与 `SettingsReference` 同构，理由也相同：它是一层面板的全部接线，写在
 * `StageRow` 体内会让那个组件继续长——而 `verify:component-depth` 的额度只
 * 允许下调，不允许为新功能抬高。模块级函数不计入组件体，这不是钻空子：一层
 * 面板的「什么时候出现、要哪些数据」本来就是它自己的性质，不是舞台的编排。
 */
function SourceReference(props: {
  open: boolean;
  document: { sourceDigest: string | null; sourceFormat: string | null };
  readBytes: (digest: string, format: string) => Promise<Uint8Array | null>;
  onClose: () => void;
}): JSX.Element {
  return (
    <Show when={props.open}>
      <SourceSurface
        sourceDigest={props.document.sourceDigest}
        sourceFormat={props.document.sourceFormat}
        readBytes={props.readBytes}
        onClose={props.onClose}
      />
    </Show>
  );
}

/**
 * 历史面板的全部状态：会话、tick 投影、以及与文档/项目会话的同步。
 *
 * 刷新挂在两个会话的广播上，而不是另设一条路：行动执行、保存落盘（「已撤回」
 * 标记此刻才翻写）、换稿、换项目都会经过这里——要求的三个刷新触发点与
 * 这两个 tick 是同一个集合。与 createBentoState 同构：模块级工厂持有信号，
 * 组件体里只剩一行装配。
 */
function createHistoryState(deps: {
  documentSession: DocumentSession;
  projectSession: ProjectSession;
  setNotice: (text: string) => void;
  /** 栈顶那一层：关窗期间 sync 只记状态，不发桥往返。 */
  reference: () => { kind: string } | null;
}) {
  const session = new HistorySession(
    browserHistoryGateway,
    { notice: deps.setNotice, failed: deps.setNotice },
    describe,
  );
  const [tick, setTick] = createSignal(0);
  const stop = session.onChanged(() => setTick((value) => value + 1));
  const [sourceTick, setSourceTick] = createSignal(0);
  const stopDocument = deps.documentSession.onChanged(() => setSourceTick((value) => value + 1));
  const stopProject = deps.projectSession.onChanged(() => setSourceTick((value) => value + 1));
  createEffect(() => {
    sourceTick();
    const active = deps.reference()?.kind === "history";
    const view = deps.documentSession.view();
    const doc = view.document;
    const rootId = deps.projectSession.project?.rootId;
    session.sync(
      doc !== null && rootId !== undefined ? { rootId, path: doc.document.path } : null,
      view.save.kind !== "clean",
      active,
    );
  });
  const view = createMemo(() => {
    tick();
    return session.view();
  });
  return {
    session,
    view,
    dispose: (): void => {
      stop();
      stopDocument();
      stopProject();
    },
  };
}

/**
 * 历史面板的接线，一处。
 *
 * 与 `SettingsReference` 同构，理由也相同：一层面板的「什么时候出现、要哪些
 * 数据」是它自己的性质，不是舞台的编排。回档的落点与 Ctrl+Z 是同一个——
 * 宿主回读确认头、换稿、标脏，面板不发明第二条落地路径。
 */
function HistoryReference(props: {
  open: boolean;
  state: ReturnType<typeof createHistoryState>;
  editor: () => EditorHostHandle | null;
  onClose: () => void;
}): JSX.Element {
  return (
    <Show when={props.open}>
      <HistorySurface
        view={props.state.view()}
        onAskRevert={(id) => props.state.session.askRevert(id)}
        onCancelRevert={() => props.state.session.cancelRevert()}
        onConfirmRevert={() => {
          const current = props.editor();
          if (current !== null) {
            void props.state.session.confirmRevert((transition) =>
              current.acceptTransition(transition),
            );
          }
        }}
        onClose={props.onClose}
      />
    </Show>
  );
}

/**
 * 信箱管理页的接线，一处。
 *
 * 与 `HistoryReference` 同构。实例向饭盒借：信箱只有一个——侧栏那格、段落旁的
 * 饭盒、这一页读的都是它，各持一份就会有三份各自漂开的「下一封」。撤回合并
 * 的文本落点与回档、Ctrl+Z 是同一个：宿主回读确认头、换稿、标脏，历史面板
 * 因此自己也看得见这次冲销。
 */
function MailboxReference(props: {
  open: boolean;
  mailbox: () => TicketMailbox | null;
  editor: () => EditorHostHandle | null;
  onOpenTicket: (box: "draft" | "unread" | "done") => void;
  onNotice: (text: string) => void;
  onClose: () => void;
}): JSX.Element {
  const instance = (): TicketMailbox | null => (props.open ? props.mailbox() : null);
  const countermand = (ids: readonly string[]): void => {
    const mailbox = props.mailbox();
    const host = props.editor();
    if (mailbox === null || host === null) return;
    void mailbox
      .countermand(ids, (transition) => host.acceptTransition(transition))
      .then((text) => {
        if (text !== null) props.onNotice(text);
      });
  };
  return (
    <Show when={instance()}>
      {(mailbox) => (
        <MailboxSurface
          mailbox={mailbox()}
          initialBox={null}
          onOpenTicket={props.onOpenTicket}
          onCountermand={countermand}
          onNotice={props.onNotice}
          onClose={props.onClose}
        />
      )}
    </Show>
  );
}

/** 信箱管理页那一层的元素：与 history/settings 同一形，外壳里只剩一行装配。 */
function mailboxElement(
  open: boolean,
  mailbox: () => TicketMailbox | null,
  editor: () => EditorHostHandle | null,
  onOpenTicket: (box: "draft" | "unread" | "done") => void,
  onNotice: (text: string) => void,
  onClose: () => void,
): JSX.Element {
  return (
    <MailboxReference
      open={open}
      mailbox={mailbox}
      editor={editor}
      onOpenTicket={onOpenTicket}
      onNotice={onNotice}
      onClose={onClose}
    />
  );
}

/** 设置面板那一层的元素：两处挂载点（有稿/无稿）共享同一份接线。 */
function settingsElement(
  reference: WorkbenchReference | null,
  onClosed: () => void,
  onThemeChanged: ((slug: string) => void) | undefined,
): JSX.Element {
  return (
    <SettingsReference reference={reference} onClosed={onClosed} onThemeChanged={onThemeChanged} />
  );
}

/** 历史面板那一层的元素：两处挂载点（有稿/无稿）共享同一份接线。 */
function historyElement(
  state: ReturnType<typeof createHistoryState>,
  open: boolean,
  editor: () => EditorHostHandle | null,
  onClose: () => void,
): JSX.Element {
  return <HistoryReference state={state} open={open} editor={editor} onClose={onClose} />;
}

/**
 * 命令面板每个 id 选了之后做什么。
 *
 * 命令目录（workbench-commands.ts）说「有什么」，这里说「做什么」。收在模块级
 * 工厂里：组件体不为每个 id 付一行，而 id 与去向的对应关系仍只有这一处。
 */
function createCommandExecutor(deps: {
  closeMenu: () => void;
  openStage: (stage: "writing" | "review" | "dispatch") => void;
  openReference: (next: WorkbenchReference) => void;
  editor: () => EditorHostHandle | null;
  openProject: () => Promise<void>;
  createProject: () => Promise<void>;
  openDocument: () => Promise<void>;
  createDocument: (role: "chapter" | "material") => Promise<void>;
  importMaterial: () => Promise<void>;
  save: () => void;
}): (id: WorkbenchCommandId) => void {
  return (id) => {
    deps.closeMenu();
    if (id === "return-writing") {
      deps.openStage("writing");
      queueMicrotask(() => deps.editor()?.focus());
      return;
    }
    const simple: Partial<Record<WorkbenchCommandId, () => void>> = {
      "open-review": () => deps.openStage("review"),
      "open-project": () => void deps.openProject(),
      "create-project": () => void deps.createProject(),
      "open-document": () => void deps.openDocument(),
      "new-chapter": () => void deps.createDocument("chapter"),
      "new-material": () => void deps.createDocument("material"),
      "import-material": () => void deps.importMaterial(),
      "save-document": deps.save,
      "open-dispatch": () => deps.openStage("dispatch"),
      "open-connections": () => deps.openReference({ kind: "connections" }),
      "open-source": () => deps.openReference({ kind: "source" }),
      "open-appearance": () => deps.openReference({ kind: "settings", section: "appearance" }),
      "open-typography": () => deps.openReference({ kind: "settings", section: "typography" }),
      "open-shortcuts": () => deps.openReference({ kind: "settings", section: "shortcuts" }),
    };
    const action = simple[id];
    if (action !== undefined) {
      action();
      return;
    }
    // 块级格式化命令是一次查表。表里没有的 id 落到这里什么也不做——这是刻意的：
    // 命令目录与执行分属两处，漏接一个不应当让整条命令路径崩掉。
    const prefix = BLOCK_PREFIX_OF[id];
    if (prefix !== undefined) deps.editor()?.applyBlockPrefix(prefix);
  };
}

/**
 * 饭盒的全部状态：印点投影、正在打开的那一只、以及裁决动作。
 * 信箱由 MailboxSection 交出（onMailboxReady），这里只认它，不认桥。
 */
function createBentoState(deps: {
  documentTick: () => number;
  active: () => OpenDocumentDto_Serialize | null;
  setNotice: (text: string) => void;
  /** 接受类裁决已合并：外壳把落地后的正文读回来。 */
  adoptCommitted: () => Promise<unknown>;
}) {
  let mailbox: TicketMailbox | null = null;
  let stopMailbox: (() => void) | null = null;
  const [mailTick, setMailTick] = createSignal(0);
  const unjudged = createMemo(() => {
    mailTick();
    return mailbox?.unjudgedProposals ?? [];
  });
  /** 提案 → 段落右缘印点的投影：锚不住的提案不出现，不钉到错的段落上。 */
  const anchors = createMemo<VerdictAnchor[]>(() => {
    mailTick();
    deps.documentTick();
    return anchorProposals(unjudged(), deps.active()?.blocks ?? []);
  });
  // 打开的饭盒：一次一只，判完即合。
  const [bentoId, setBentoId] = createSignal<string | null>(null);
  const [bentoBusy, setBentoBusy] = createSignal(false);
  const bento = createMemo(() => {
    const id = bentoId();
    if (id === null) return null;
    const proposal = unjudged().find((candidate) => candidate.id === id);
    const anchor = anchors().find((candidate) => candidate.id === id);
    const block = deps.active()?.blocks.find((candidate) => candidate.id === anchor?.blockId);
    if (proposal === undefined || anchor === undefined || block === undefined) return null;
    return { proposal, anchor, block };
  });
  const judge = async (
    kind: "accept" | "accept-modified" | "reject",
    finalText: string | null,
  ): Promise<void> => {
    const current = bento();
    if (mailbox === null || current === null) return;
    setBentoBusy(true);
    try {
      const notice = await mailbox.judge(current.proposal.id, kind, finalText);
      if (notice !== null) deps.setNotice(notice);
      // 接受类裁决此刻已落成正文；退回只是记录，不用重读。
      if (kind !== "reject") await deps.adoptCommitted();
      setBentoId(null);
    } catch (error) {
      // 失败要说话（过期提案、被拒绝的合并）——静默吞掉等于替作者装作判完了。
      deps.setNotice(describe(error));
    } finally {
      setBentoBusy(false);
    }
  };
  return {
    anchors,
    bentoId,
    setBentoId,
    bento,
    bentoBusy,
    judge,
    adoptCommitted: deps.adoptCommitted,
    /** 信箱实例本身：管理页（MailboxSurface）与饭盒读的是同一份事实。 */
    mailbox: (): TicketMailbox | null => mailbox,
    onMailboxReady: (instance: TicketMailbox): void => {
      mailbox = instance;
      stopMailbox?.();
      stopMailbox = instance.onChanged(() => setMailTick((value) => value + 1));
    },
    dispose: (): void => stopMailbox?.(),
  };
}

/** 打开的饭盒：一次一只，贴在锚点旁边，判完即合。 */
function BentoLayer(props: {
  bento: {
    proposal: ProposalDto;
    anchor: VerdictAnchor;
    block: { id: string; text: string };
  };
  editor: () => EditorHostHandle | null;
  busy: boolean;
  onJudge: (kind: "accept" | "accept-modified" | "reject", finalText: string | null) => void;
  onClose: () => void;
}): JSX.Element {
  const rect = (): DOMRect | null => props.editor()?.blockRect(props.bento.anchor.blockId) ?? null;
  const layout = (): "side" | "inline" =>
    bentoLayout(rect()?.right ?? window.innerWidth, window.innerWidth);
  const position = (): { top: number; left: number } => {
    const box = rect();
    if (box === null) return { top: 80, left: 80 };
    return layout() === "side"
      ? { top: box.top, left: box.right + 12 }
      : { top: box.bottom + 8, left: box.left };
  };
  return (
    <VerdictBento
      proposal={props.bento.proposal}
      original={{
        text: props.bento.block.text,
        start: props.bento.anchor.start,
        end: props.bento.anchor.end,
      }}
      layout={layout()}
      position={position()}
      busy={props.busy}
      onAccept={() => props.onJudge("accept", null)}
      onEditAccept={(text) => props.onJudge("accept-modified", text)}
      onReturn={() => props.onJudge("reject", null)}
      onClose={props.onClose}
    />
  );
}

/** 有稿子时的那条舞台行：编辑器、面板路径与光源，只有一条 CSS 路径。 */
function WritingStageRow(props: {
  rootId: string;
  openDocument: OpenDocumentDto_Serialize;
  layout: () => PanelLayout;
  annotations: readonly EditorAnnotationProjection[];
  proposalMarks: readonly VerdictAnchor[];
  onProposalMark: (id: string) => void;
  codeTheme: CodeTheme | undefined;
  onEditorReady: (handle: EditorHostHandle | null) => void;
  onConfirmed: () => void;
  onRejected: (reason: string) => void;
  onContext: (context: EditorContext, pointerX: number, pointerY: number) => void;
  annotationsOpen: boolean;
  annotationRows: readonly AnnotationDto[];
  selectedAnnotations: ReadonlySet<string>;
  onToggleAnnotation: (id: string) => void;
  onCloseReference: () => void;
  onDeleteAnnotation: (id: string) => void;
  onRelocate: (annotation: AnnotationDto) => void;
  onDispatchAnnotations: (blockIds: string[], prompt: string) => void;
  dispatchOpen: boolean;
  materials: { path: string; label: string }[];
  seed: string[];
  initialPrompt: string | undefined;
  runWatch: RunWatch;
  onCollected: (count: number) => void;
  onMaterialSaved: (row: DocumentRow) => void;
  onDispatchClosed: () => void;
  connectionsOpen: boolean;
  sourceOpen: boolean;
  readSourceBytes: (digest: string, format: string) => Promise<Uint8Array | null>;
  settings: JSX.Element;
  history: JSX.Element;
  /** 信箱管理页那一层：元素在外壳里装好，这里只挂。 */
  mailbox: JSX.Element;
}): JSX.Element {
  return (
    <div
      class="stage-row"
      attr:data-panels={props.layout()["data-panels"]}
      style={props.layout().style}
    >
      {/* 光源区。层级与理由见 shell/strata.ts。 */}
      <div class="lamp-layer" aria-hidden="true" />
      <EditorHost
        rootId={props.rootId}
        path={props.openDocument.document.path}
        document={props.openDocument}
        annotations={props.annotations}
        proposalMarks={props.proposalMarks}
        onProposalMark={props.onProposalMark}
        codeTheme={props.codeTheme}
        onReady={props.onEditorReady}
        onConfirmed={props.onConfirmed}
        onRejected={props.onRejected}
        onContext={props.onContext}
      />
      <Show when={props.annotationsOpen}>
        <AnnotationSurface
          annotations={props.annotationRows}
          selected={props.selectedAnnotations}
          onToggle={props.onToggleAnnotation}
          onClose={props.onCloseReference}
          onDelete={props.onDeleteAnnotation}
          onRelocate={props.onRelocate}
          onDispatch={props.onDispatchAnnotations}
        />
      </Show>
      <Show when={props.dispatchOpen}>
        <DispatchStage
          rootId={props.rootId}
          path={props.openDocument.document.path}
          blocks={props.openDocument.blocks}
          materials={props.materials}
          seed={props.seed}
          initialPrompt={props.initialPrompt}
          runWatch={props.runWatch}
          onCollected={props.onCollected}
          onMaterialSaved={props.onMaterialSaved}
          onClosed={props.onDispatchClosed}
        />
      </Show>
      <Show when={props.connectionsOpen}>
        <ConnectionsSurface rootId={props.rootId} onClosed={props.onCloseReference} />
      </Show>
      <SourceReference
        open={props.sourceOpen}
        document={props.openDocument.document}
        readBytes={props.readSourceBytes}
        onClose={props.onCloseReference}
      />
      {props.history}
      {props.settings}
      {props.mailbox}
    </div>
  );
}

/** 欢迎屏分支：没有项目时的全部去处，含就地问名字的表单。 */
function WelcomeBranch(props: {
  notice: string | null;
  prompt: { label: string } | null;
  onPromptSubmit: (answer: string) => void;
  onPromptCancel: () => void;
  onOpenFolder: () => void;
  onCreateProject: () => void;
  onOpenDocument: () => void;
}): JSX.Element {
  return (
    <>
      <Show when={props.prompt}>
        {(request) => (
          <div class="welcome-prompt">
            <RailPrompt
              label={request().label}
              onSubmit={props.onPromptSubmit}
              onCancel={props.onPromptCancel}
            />
          </div>
        )}
      </Show>
      <Welcome
        notice={props.notice}
        onOpenFolder={props.onOpenFolder}
        onCreateProject={props.onCreateProject}
        onOpenDocument={props.onOpenDocument}
      />
    </>
  );
}

/** 关窗守卫：未保存不堵死作者，给「保存并关闭」的出路。 */
function createCloseGuard(deps: {
  documentSession: DocumentSession;
  setNotice: (text: string) => void;
}) {
  const [closePending, setClosePending] = createSignal(false);
  const destroyWindow = (): Promise<void> =>
    getCurrentWindow()
      .destroy()
      .catch((error) => {
        deps.setNotice(describe(error));
      });
  return {
    closePending,
    requestClose: (): void => {
      if (deps.documentSession.hasUnsavedText()) {
        setClosePending(true);
        return;
      }
      void destroyWindow();
    },
    saveAndClose: async (): Promise<void> => {
      await deps.documentSession.save();
      if (deps.documentSession.hasUnsavedText()) {
        deps.setNotice("保存失败：请先解决状态行里的问题，再关闭窗口。");
        return;
      }
      setClosePending(false);
      await destroyWindow();
    },
    cancel: (): void => {
      setClosePending(false);
    },
  };
}

export function Workbench(props: WorkbenchProps) {
  const [notice, setNotice] = createSignal<string | null>(null);
  const [projectTick, setProjectTick] = createSignal(0);
  const [documentTick, setDocumentTick] = createSignal(0);
  const [state, setState] = createSignal<WorkbenchState>(initialWorkbenchState());
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
  // 一句话的询问（项目名、新章名、批注）在侧栏就地问，不跳 window.prompt。
  // 同一时间只问一句：新问句到来时旧的先收回，作者不会面对两张表单。
  const [promptRequest, setPromptRequest] = createSignal<{
    label: string;
    resolve: (answer: string | null) => void;
  } | null>(null);
  const askInline = (label: string): Promise<string | null> =>
    new Promise((resolve) => {
      promptRequest()?.resolve(null);
      setPromptRequest({ label, resolve });
    });
  const settlePrompt = (answer: string | null): void => {
    promptRequest()?.resolve(answer);
    setPromptRequest(null);
  };
  // 面板拿走焦点、还回焦点这件事完整地归 CommandFocus。这里只订它的广播。
  const commandFocus = new CommandFocus(setCommandMenuOpen, () => editor?.focus());
  const closeCommandMenu = (): void => commandFocus.hide();

  const [railReceded, setRailReceded] = createSignal(false);
  const rail = new RailPresence(browserTimer, setRailReceded);
  const kara = useKara();
  const [karaTick, setKaraTick] = createSignal(0);
  const stopKara = kara.subscribe(() => setKaraTick((value) => value + 1));
  // The global watcher for agents working elsewhere: in-flight and settled
  // states stay visible on the status line whether the panel is open or not.
  const runWatch = new RunWatch(browserRunWatchGateway, {
    allSettled: () => kara.quiet("agent-completed"),
  });
  const [runTick, setRunTick] = createSignal(0);
  const stopRuns = runWatch.onChanged(() => setRunTick((value) => value + 1));
  const runsInFlight = createMemo(() => {
    runTick();
    return runWatch.view().inFlight;
  });
  let editor: EditorHostHandle | null = null;
  let searchInput: HTMLInputElement | null = null;
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
      runWatch.retarget(opened.rootId);
      transition({ kind: "projectChanged" });
      setNotice(null);
    },
    describe,
  );
  const documentSession = new DocumentSession(
    browserGateway,
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
    const text = noticeText(projectSession.view());
    if (text !== null) setNotice(text);
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
  const bentoState = createBentoState({
    documentTick,
    active,
    setNotice,
    // 合并落地即回到写作现场——裁决面不替作者留着。
    adoptCommitted: async () => {
      await documentSession.adoptCommitted();
      openStage("writing");
    },
  });
  const { anchors, setBentoId, bento, bentoBusy, onMailboxReady, judge: judgeBento } = bentoState;

  const documents = createMemo(() => {
    projectTick();
    return projectSession.visibleDocuments;
  });
  // 搜索行的响应式切片：裸 getter 曾让精度按钮在模式切换后永不更新。
  const search = trackSearch(projectSession, projectTick);
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
  const history = createHistoryState({ documentSession, projectSession, setNotice, reference });
  const scene = createMemo(() => ({
    reference: reference()?.kind ?? null,
    stage: state().stage,
  }));
  const dispatchOpen = createMemo(() => dispatchBesideManuscript(scene()));
  /** 这条路径此刻在屏幕上的样子：让开多宽、算不算开着。 */
  const layout = createMemo(() => {
    panelTick();
    return panelLayout(panels.depth + (dispatchOpen() ? 1 : 0), takesWholeStage(scene()));
  });
  const annotationsOpen = createMemo(() => reference()?.kind === "annotations");
  const commandsForMenu = createMemo(() =>
    commandCatalog({
      hasProject: project() !== null,
      hasDocument: active() !== null,
      hasImportedSource: active()?.document.sourceDigest != null,
    }),
  );
  const karaEngaged = createMemo(() => {
    karaTick();
    return kara.engaged.value;
  });
  /**
   * The status line's "what is happening" sentence: the operation in hand
   * first (import, opening a project), then the agents running elsewhere.
   * One sentence, one authority — there used to be three copies.
   */
  const activityLine = createMemo(() => {
    projectTick();
    const working = workingText(projectSession.view());
    if (working !== null) return working;
    const inFlight = runsInFlight();
    return inFlight > 0 ? (inFlight > 1 ? `Agent 在途 ×${inFlight}` : "Agent 在途") : null;
  });
  /** An in-progress operation greys out its entry — a second click would be
      swallowed silently, and silent swallowing is what anger is made of. */
  const projectBusy = createMemo(() => {
    projectTick();
    return projectSession.view().kind === "working";
  });
  // Agent navigation remembers its last panel. It is read only when Cmd+4 runs.
  const quarterMemory = new QuarterMemory();
  const transition = (event: WorkbenchEvent): void => {
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
    panels.open({ key, content: next });
  };
  const closeReference = (): void => panels.clear();

  // 取得项目的四条路都归 ProjectSession；这里只负责问作者要一个名字。
  const openProjectFolder = (): Promise<void> => projectSession.openFolder();
  const openSingleDocument = (): Promise<void> => projectSession.openSingleDocument();
  const createProject = async (): Promise<void> => {
    const name = await askInline("项目名");
    if (name === null) return;
    await projectSession.createProject(name);
  };

  const selectDocument = async (path: string, ordinal: number | null = null): Promise<void> => {
    const opened = await documentSession.open(path);
    if (opened === null) return;
    kara.apply(opened.kara);
    // 换一份稿子是换场景：打开着的那条面板路径不再属于这里。
    panels.clear();
    transition({ kind: "documentSelected" });
    revealBlock(opened.blocks, ordinal, () => editor);
    if (opened.staleJournal.length > 0) {
      setNotice(`有 ${opened.staleJournal.length} 条未确认的行动无法恢复，已留作证据。`);
    } else if (opened.replayed > 0) {
      setNotice(`已恢复 ${opened.replayed} 条上次未确认的行动。`);
    }
  };

  const createDocument = async (role: "chapter" | "material"): Promise<void> => {
    const title = await askInline(role === "chapter" ? "新章名" : "新资料名");
    if (title === null) return;
    // 建好之后跳过去是外壳的编排；名录只管把它记下来。
    const created = await projectSession.createDocument(title, role);
    if (created !== null) await selectDocument(created);
  };

  const importMaterial = (): Promise<void> => projectSession.importMaterial();
  const readSourceBytes = projectSession.importedSourceBytes.bind(projectSession);

  const save = (): void => void documentSession.save();

  const undo = undoWith(documentSession, () => editor);

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
      kind === "comment" && existing === null ? await askInline("批注") : (existing?.body ?? null);
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

  // 右键「攒进发送」只记录：送出集中在发送台，不打断手上的句子。
  const dispatchBlock = (accumulate: boolean): void => {
    if (!intents.dispatchAimedBlock(accumulate)) return;
    setNotice(`已攒进发送（${dispatchSeed().blockIds.length} 段）。去「发送」一次送出。`);
  };

  const executeCommand = createCommandExecutor({
    closeMenu: closeCommandMenu,
    openStage,
    openReference,
    editor: () => editor,
    openProject: openProjectFolder,
    createProject,
    openDocument: openSingleDocument,
    createDocument,
    importMaterial,
    save,
  });

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
      undo,
      toggleCommandMenu: () => commandFocus.toggle(),
      toggleKara: () => void kara.toggle(),
      focusSearch: () => {
        searchInput?.focus();
        searchInput?.select();
      },
      menuOpen: () => menu() !== null,
      closeMenu: () => intents.release(),
      panelDepth: () => panels.depth,
      closePanel: () => panels.back(),
      goToQuarter,
    });
  };

  const onPointerMove = (event: PointerEvent): void => rail.pointerMoved(event.clientX);

  const closeGuard = createCloseGuard({ documentSession, setNotice });
  const { closePending, requestClose, saveAndClose } = closeGuard;

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
    history.dispose();
    stopKara();
    stopRuns();
    bentoState.dispose();
    runWatch.dispose();
  });

  return (
    <div class="workbench">
      <WindowChrome onCloseRequested={requestClose} onError={setNotice} />
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
          <WelcomeBranch
            notice={notice()}
            prompt={promptRequest()}
            onPromptSubmit={(answer) => settlePrompt(answer)}
            onPromptCancel={() => settlePrompt(null)}
            onOpenFolder={() => void openProjectFolder()}
            onCreateProject={() => void createProject()}
            onOpenDocument={() => void openSingleDocument()}
          />
        }
      >
        {(root) => (
          <>
            <RailNav
              receded={railReceded() || reference()?.kind === "settings"}
              rail={railView}
              onBrandToggle={() => setRailReceded((value) => !value)}
              onCreateChapter={() => void createDocument("chapter")}
              onCreateMaterial={() => void createDocument("material")}
              onImport={() => void importMaterial()}
              importDisabled={projectBusy()}
              query={search().query}
              onQuery={(value) => projectSession.setQuery(value)}
              precision={search().precision}
              onTogglePrecision={() => projectSession.togglePrecision()}
              searchRef={(element) => {
                searchInput = element;
              }}
              prompt={promptRequest()}
              onPromptSubmit={(answer) => settlePrompt(answer)}
              onPromptCancel={() => settlePrompt(null)}
              mailboxRootId={project()?.rootId ?? null}
              mailboxPath={active()?.document.path ?? null}
              onMailboxReady={onMailboxReady}
              runWatch={runWatch}
              onOpenTicket={(box) => openStage(box === "draft" ? "dispatch" : "review")}
              onTicketNotice={setNotice}
              onOpenMailbox={() => openReference({ kind: "mailbox" })}
              chapters={chapters()}
              materials={materials()}
              onRemoveMaterial={projectSession.removeDocument.bind(projectSession)}
              onMaterialDisclosure={projectSession.setDisclosure.bind(projectSession)}
              searchHits={search().hits}
              currentPath={active()?.document.path ?? null}
              onSelect={(path, ordinal) => void selectDocument(path, ordinal ?? null)}
              catalog={projectSession}
              foot={{
                hasDocument: active() !== null,
                annotationsOpen: annotationsOpen(),
                historyOpen: reference()?.kind === "history",
                karaEngaged: karaEngaged(),
                connectionsOpen: reference()?.kind === "connections",
                settingsOpen: reference()?.kind === "settings",
                onOpenAnnotations: () => openReference({ kind: "annotations" }),
                onOpenHistory: () => openReference({ kind: "history" }),
                onToggleKara: () => void kara.toggle(),
                onOpenConnections: () => openReference({ kind: "connections" }),
                onOpenSettings: () =>
                  openReference({ kind: "settings", section: settingsSection(reference()) }),
              }}
            />

            <main class="stage">
              {/* 滤镜属于稿纸这一区，所以它渲染在这里，而不是那层全窗外壳。 */}
              <KaraVeil />
              <Show when={notice()}>{(text) => <p class="notice">{text()}</p>}</Show>
              <Show when={closePending()}>
                <CloseConfirmBar
                  onSaveAndClose={() => void saveAndClose()}
                  onCancel={closeGuard.cancel}
                />
              </Show>
              <Show when={state().stage === "review" && active() !== null}>
                <ReviewSurface
                  rootId={root().rootId}
                  path={active()?.document.path ?? ""}
                  commitBatch={() => commitDecisions()}
                  onClosed={() => openStage("writing")}
                />
              </Show>
              <Show when={active()}>
                {(openDocument) => (
                  <WritingStageRow
                    rootId={root().rootId}
                    openDocument={openDocument()}
                    layout={layout}
                    annotations={editorAnnotations()}
                    proposalMarks={anchors()}
                    onProposalMark={(id) => setBentoId(id)}
                    codeTheme={props.codeTheme}
                    onEditorReady={(handle) => {
                      editor = handle;
                      selectionReadout.observe(handle);
                    }}
                    onConfirmed={() => markDirty()}
                    onRejected={setNotice}
                    onContext={(context, pointerX, pointerY) =>
                      intents.aim(context, pointerX, pointerY)
                    }
                    annotationsOpen={annotationsOpen()}
                    annotationRows={documentView().annotations}
                    selectedAnnotations={selectedAnnotations()}
                    onToggleAnnotation={(id) => annotationSelection.toggle(id)}
                    onCloseReference={closeReference}
                    onDeleteAnnotation={(id) => void documentSession.deleteAnnotation(id)}
                    onRelocate={beginRelocation}
                    onDispatchAnnotations={dispatchAnnotations}
                    dispatchOpen={dispatchOpen()}
                    materials={materials().map((row) => ({ path: row.path, label: row.path }))}
                    seed={[...dispatchSeed().blockIds]}
                    initialPrompt={dispatchSeed().prompt}
                    runWatch={runWatch}
                    onCollected={(count) =>
                      setNotice(`${count} 条提案已冻结，去「逐句裁决」一条条判。`)
                    }
                    onMaterialSaved={(row) => projectSession.add(row)}
                    onDispatchClosed={() => openStage("writing")}
                    connectionsOpen={reference()?.kind === "connections"}
                    sourceOpen={reference()?.kind === "source"}
                    readSourceBytes={readSourceBytes}
                    settings={settingsElement(reference(), closeReference, props.onThemeChanged)}
                    history={historyElement(
                      history,
                      reference()?.kind === "history",
                      () => editor,
                      closeReference,
                    )}
                    // 信箱管理页与饭盒借同一个实例（见 MailboxReference）。
                    mailbox={mailboxElement(
                      reference()?.kind === "mailbox",
                      bentoState.mailbox,
                      () => editor,
                      (box) => openStage(box === "draft" ? "dispatch" : "review"),
                      setNotice,
                      closeReference,
                    )}
                  />
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
                  {settingsElement(reference(), closeReference, props.onThemeChanged)}
                </div>
              </Show>
              <Show when={active() === null && reference() === null}>
                <p class="empty">从左侧选一个文档，或新建一章。</p>
              </Show>
            </main>

            <Show when={menu()}>
              {(current) => (
                <EditorMenu
                  menu={current()}
                  kara={karaEngaged()}
                  relocating={documentView().relocating !== null}
                  editor={() => editor}
                  intents={intents}
                  onHighlight={() => void persistAnnotation("highlight")}
                  onComment={() => void persistAnnotation("comment")}
                  onRelocate={() => {
                    const relocating = documentView().relocating;
                    if (relocating !== null) void persistAnnotation(relocating.kind, relocating);
                  }}
                  onDispatch={(accumulate) => dispatchBlock(accumulate)}
                  onNotice={setNotice}
                  focusEditor={() => queueMicrotask(() => editor?.focus())}
                />
              )}
            </Show>
            <Show when={bento()}>
              {(current) => (
                <BentoLayer
                  bento={current()}
                  editor={() => editor}
                  busy={bentoBusy()}
                  onJudge={(kind, finalText) => void judgeBento(kind, finalText)}
                  onClose={() => setBentoId(null)}
                />
              )}
            </Show>
            <StatusLine
              state={documentView().save}
              savedAt={documentView().savedAt ?? null}
              selection={selectionMeasure()}
              activity={activityLine()}
            />
            <KaraSurface />
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
