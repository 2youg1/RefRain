import { unwrap } from "../bridge";
import { debugCommands } from "../e2e/debug-bridge";
import {
  commands,
  type DocumentPageDto,
  type DocumentRow,
  type ProjectOpenedDto,
  type SearchPrecision,
} from "../generated/bindings.gen";
import { e2ePickedPath } from "./pick";
import { type Activity, type DescribeError, Session } from "./session";

/** 这个 session 会忙的五件事。 */
export type ProjectOperation =
  | "open-folder"
  | "open-file"
  | "create-project"
  | "create-document"
  | "import-material";

export interface ProjectCatalogPort {
  page(rootId: string, after: string): Promise<DocumentPageDto>;
  search(
    rootId: string,
    query: string,
    precision: SearchPrecision,
  ): Promise<readonly DocumentRow[]>;
}

/**
 * 取得一个项目的四条路。
 *
 * 外壳里原本有五段几乎逐字相同的代码：问一次 e2e 路径、在真选择器与调试入口之间
 * 二选一、拿到非空就安装、出错就写公告。同一段写五遍，是「取得一个项目」这个概念
 * 没有落到任何地方的样子。它属于这里——项目的名录本来就归这个 session。
 *
 * 返回 null 表示作者取消了选择：那不是失败，界面上什么都不该发生。
 */
export interface ProjectAcquisitionPort {
  adoptFolder(): Promise<ProjectOpenedDto | null>;
  adoptFile(): Promise<ProjectOpenedDto | null>;
  createProject(name: string): Promise<ProjectOpenedDto | null>;
  createDocument(rootId: string, title: string, role: "chapter" | "material"): Promise<DocumentRow>;
  importMaterial(rootId: string): Promise<DocumentRow | null>;
}

export interface DelayPort {
  after(milliseconds: number, task: () => void): () => void;
}

export type CatalogActivity = "idle" | "waiting" | "searching" | "paging" | "failed";

type CatalogState =
  | { readonly kind: "idle" }
  | { readonly kind: "paging" }
  | { readonly kind: "waiting"; readonly query: string }
  | { readonly kind: "searching"; readonly query: string }
  | { readonly kind: "ready"; readonly query: string; readonly documents: readonly DocumentRow[] }
  | { readonly kind: "failed"; readonly query: string };

type ProjectState =
  | { readonly kind: "closed" }
  | {
      readonly kind: "open";
      readonly project: ProjectOpenedDto;
      readonly catalog: CatalogState;
    };

/** 一只挂在墙上的钟。run-watch 与这里共用同一个实现，别各写一份。 */
export const browserDelay: DelayPort = {
  after(milliseconds, task) {
    const handle = window.setTimeout(task, milliseconds);
    return () => window.clearTimeout(handle);
  },
};

/**
 * 真实的取得路径。
 *
 * e2e 那一支不是「测试代码混进产品」——桌面选择器在无人值守的窗口里打不开，
 * 而这五条路径本身就是要在真窗口里验证的东西。两支都走同一个 install。
 */
const productionAcquisition: ProjectAcquisitionPort = {
  async adoptFolder() {
    const picked = e2ePickedPath();
    return picked === null
      ? unwrap(commands.chooseAndAdoptRoot("folder"))
      : debugCommands.adoptRoot(picked, "folder");
  },
  async adoptFile() {
    const picked = e2ePickedPath();
    return picked === null
      ? unwrap(commands.chooseAndAdoptRoot("file"))
      : debugCommands.adoptRoot(picked, "file");
  },
  async createProject(name) {
    const picked = e2ePickedPath();
    return picked === null
      ? unwrap(commands.chooseAndCreateProject(name))
      : debugCommands.createProject(picked, name);
  },
  async createDocument(rootId, title, role) {
    return (await unwrap(commands.createDocument(rootId, title, role))).document;
  },
  async importMaterial(rootId) {
    const picked = e2ePickedPath();
    return picked === null
      ? unwrap(commands.chooseAndImportMaterial(rootId))
      : debugCommands.importMaterial(rootId, picked);
  },
};

const productionCatalog: ProjectCatalogPort = {
  async page(rootId, after) {
    return unwrap(commands.documentPage(rootId, after));
  },
  async search(rootId, query, precision) {
    return unwrap(commands.documentSearch(rootId, query, precision));
  },
};

function mergeRows(
  current: readonly DocumentRow[],
  incoming: readonly DocumentRow[],
): DocumentRow[] {
  const byId = new Map(current.map((row) => [row.id, row]));
  for (const row of incoming) byId.set(row.id, row);
  return [...byId.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

/**
 * Own the renderer's complete project catalog session.
 *
 * Pagination, debounce, stale-response rejection, and catalog projection stay
 * behind this interface. Workbench renders the refs and sends user intents; it
 * never sends its internal request epoch across the bridge or edits project DTO fields itself.
 */
export class ProjectSession extends Session<ProjectOperation> {
  #state: ProjectState = { kind: "closed" };

  #set(next: ProjectState): void {
    this.#state = next;
    this.emit();
  }
  readonly #catalog: ProjectCatalogPort;
  readonly #delay: DelayPort;
  readonly #report: (error: unknown) => void;
  // 默认精确：词里的每一部分都要出现。模糊是作者主动要的宽松。
  #precision: SearchPrecision = "exact";
  #request = 0;
  #cancelDelay: (() => void) | null = null;

  get project(): ProjectOpenedDto | null {
    return this.#state.kind === "open" ? this.#state.project : null;
  }
  get documents(): readonly DocumentRow[] {
    return this.project?.documents ?? [];
  }
  get visibleDocuments(): readonly DocumentRow[] {
    const state = this.#state;
    if (state.kind !== "open") return [];
    return state.catalog.kind === "ready"
      ? state.catalog.documents
      : state.catalog.kind === "idle" || state.catalog.kind === "paging"
        ? state.project.documents
        : [];
  }
  get precision(): SearchPrecision {
    return this.#precision;
  }

  /** 切换精确/模糊。当前有搜索词时立即用它重搜。 */
  setPrecision(next: SearchPrecision): void {
    if (next === this.#precision) return;
    this.#precision = next;
    const current = this.query;
    if (current !== "") this.setQuery(current);
    this.emit();
  }

  get query(): string {
    const state = this.#state;
    if (state.kind !== "open") return "";
    switch (state.catalog.kind) {
      case "idle":
      case "paging":
        return "";
      case "waiting":
      case "searching":
      case "ready":
      case "failed":
        return state.catalog.query;
    }
    return "";
  }
  get catalogActivity(): CatalogActivity {
    const state = this.#state;
    if (state.kind !== "open") return "idle";
    switch (state.catalog.kind) {
      case "idle":
      case "ready":
        return "idle";
      case "paging":
        return "paging";
      case "waiting":
        return "waiting";
      case "searching":
        return "searching";
      case "failed":
        return "failed";
    }
    return "idle";
  }
  get hasMore(): boolean {
    const state = this.#state;
    return (
      state.kind === "open" &&
      state.catalog.kind === "idle" &&
      state.project.documentCursor !== null
    );
  }

  readonly #acquire: ProjectAcquisitionPort;
  readonly #onInstalled: (project: ProjectOpenedDto) => void;

  constructor(
    catalog: ProjectCatalogPort = productionCatalog,
    delay: DelayPort = browserDelay,
    report: (error: unknown) => void = () => undefined,
    acquire: ProjectAcquisitionPort = productionAcquisition,
    onInstalled: (project: ProjectOpenedDto) => void = () => undefined,
    describe: DescribeError = (error) => String(error),
  ) {
    super();
    this.#catalog = catalog;
    this.#delay = delay;
    this.#report = report;
    this.#acquire = acquire;
    this.#onInstalled = onInstalled;
    this.#describe = describe;
  }

  readonly #describe: DescribeError;

  protected describeError(error: unknown): string {
    return this.#describe(error);
  }

  /** 当前这一步在做什么、说了什么。外壳据此显示公告。 */
  view(): Activity<ProjectOperation> {
    return this.activity;
  }

  install(project: ProjectOpenedDto): void {
    this.#invalidateRequests();
    this.#set({ kind: "open", project, catalog: { kind: "idle" } });
    this.#onInstalled(project);
  }

  // —— 取得一个项目：四条路，同一个形状 ——

  openFolder(): Promise<void> {
    return this.#acquireInto("open-folder", () => this.#acquire.adoptFolder());
  }

  openSingleDocument(): Promise<void> {
    return this.#acquireInto("open-file", () => this.#acquire.adoptFile());
  }

  createProject(name: string): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === "") return Promise.resolve();
    return this.#acquireInto("create-project", () => this.#acquire.createProject(trimmed));
  }

  /**
   * 新建一章或一份资料，并把它放进名录。
   *
   * 返回新条目的路径，好让外壳接着把它打开——由调用者决定打不打开，因为「建好
   * 之后要不要跳过去」是外壳的编排，不是名录的事。
   */
  async createDocument(title: string, role: "chapter" | "material"): Promise<string | null> {
    const open = this.#state;
    const trimmed = title.trim();
    if (open.kind !== "open" || trimmed === "") return null;
    let created: string | null = null;
    await this.exclusive("create-document", async () => {
      const row = await this.#acquire.createDocument(open.project.rootId, trimmed, role);
      this.add(row);
      created = row.path;
      return null;
    });
    return created;
  }

  importMaterial(): Promise<void> {
    const open = this.#state;
    if (open.kind !== "open") return Promise.resolve();
    return this.exclusive("import-material", async () => {
      const row = await this.#acquire.importMaterial(open.project.rootId);
      if (row === null) return null;
      this.add(row);
      return "已导入";
    });
  }

  /** 四条取得路径共用的那一段：拿到非空就安装，取消什么都不做。 */
  #acquireInto(
    op: ProjectOperation,
    acquire: () => Promise<ProjectOpenedDto | null>,
  ): Promise<void> {
    return this.exclusive(op, async () => {
      const opened = await acquire();
      if (opened !== null) this.install(opened);
      return null;
    });
  }

  add(row: DocumentRow): void {
    const state = this.#state;
    if (state.kind !== "open") return;
    const exists = state.project.documents.some((candidate) => candidate.id === row.id);
    if (exists) return;
    this.#set({
      ...state,
      project: {
        ...state.project,
        documents: mergeRows(state.project.documents, [row]),
        documentTotal: state.project.documentTotal + 1,
      },
    });
    switch (state.catalog.kind) {
      case "waiting":
      case "searching":
      case "ready":
      case "failed":
        this.setQuery(state.catalog.query);
        break;
      case "idle":
      case "paging":
        break;
    }
  }

  setQuery(rawQuery: string): void {
    const state = this.#state;
    if (state.kind !== "open") return;
    this.#invalidateRequests();
    const query = rawQuery.trim();
    if (query === "") {
      this.#set({ ...state, catalog: { kind: "idle" } });
      return;
    }
    const request = this.#request;
    const rootId = state.project.rootId;
    this.#set({ ...state, catalog: { kind: "waiting", query } });
    this.#cancelDelay = this.#delay.after(120, () => {
      this.#cancelDelay = null;
      void this.#search(rootId, query, request);
    });
  }

  async loadNext(): Promise<void> {
    const state = this.#state;
    if (
      state.kind !== "open" ||
      state.catalog.kind !== "idle" ||
      state.project.documentCursor === null
    ) {
      return;
    }
    const rootId = state.project.rootId;
    const cursor = state.project.documentCursor;
    this.#invalidateRequests();
    const request = this.#request;
    this.#set({ ...state, catalog: { kind: "paging" } });
    try {
      const page = await this.#catalog.page(rootId, cursor);
      const live = this.#state;
      if (
        live.kind !== "open" ||
        live.project.rootId !== rootId ||
        live.project.documentCursor !== cursor ||
        live.catalog.kind !== "paging" ||
        request !== this.#request
      ) {
        return;
      }
      this.#set({
        ...live,
        catalog: { kind: "idle" },
        project: {
          ...live.project,
          documents: mergeRows(live.project.documents, page.documents),
          documentTotal: page.total,
          documentCursor: page.next,
        },
      });
    } catch (error) {
      const live = this.#state;
      if (
        live.kind === "open" &&
        live.project.rootId === rootId &&
        live.catalog.kind === "paging" &&
        request === this.#request
      ) {
        this.#set({ ...live, catalog: { kind: "idle" } });
        this.#report(error);
      }
    }
  }

  dispose(): void {
    this.#invalidateRequests();
    this.#set({ kind: "closed" });
  }

  async #search(rootId: string, query: string, request: number): Promise<void> {
    const state = this.#state;
    if (
      state.kind !== "open" ||
      state.project.rootId !== rootId ||
      state.catalog.kind !== "waiting" ||
      state.catalog.query !== query ||
      request !== this.#request
    ) {
      return;
    }
    this.#set({ ...state, catalog: { kind: "searching", query } });
    try {
      const documents = await this.#catalog.search(rootId, query, this.#precision);
      const live = this.#state;
      if (
        live.kind !== "open" ||
        live.project.rootId !== rootId ||
        live.catalog.kind !== "searching" ||
        live.catalog.query !== query ||
        request !== this.#request
      ) {
        return;
      }
      this.#set({
        ...live,
        project: {
          ...live.project,
          documents: mergeRows(live.project.documents, documents),
        },
        catalog: { kind: "ready", query, documents: [...documents] },
      });
    } catch (error) {
      const live = this.#state;
      if (
        live.kind === "open" &&
        live.project.rootId === rootId &&
        live.catalog.kind === "searching" &&
        live.catalog.query === query &&
        request === this.#request
      ) {
        this.#set({ ...live, catalog: { kind: "failed", query } });
        this.#report(error);
      }
    }
  }

  #invalidateRequests(): void {
    this.#request += 1;
    this.#cancelDelay?.();
    this.#cancelDelay = null;
  }
}
