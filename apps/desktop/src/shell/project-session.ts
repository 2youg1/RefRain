import { readArtifactBytes, unwrap } from "../bridge";
import { debugCommands } from "../e2e/debug-bridge";
import {
  type BlockHit,
  commands,
  type Disclosure,
  type DocumentRow,
  type ProjectInput,
  type ProjectOpened,
  type ProjectOutput,
  type ProjectPage,
  type SearchPrecision,
} from "../generated/bindings.gen";
import { e2ePickedPath } from "./pick";
import { type Activity, type DescribeError, Session } from "./session";

/** 这个 session 会忙的几件事。 */
export type ProjectOperation =
  | "open-folder"
  | "open-file"
  | "create-project"
  | "create-document"
  | "import-manuscript"
  | "import-material"
  | "delete-document"
  | "set-disclosure";

export interface ProjectCatalogPort {
  page(rootId: string, after: string): Promise<ProjectPage>;
  search(
    rootId: string,
    query: string,
    precision: SearchPrecision,
  ): Promise<readonly DocumentRow[]>;
  searchBlocks(
    rootId: string,
    query: string,
    precision: SearchPrecision,
  ): Promise<readonly BlockHit[]>;
  /**
   * 移入回收站（INV-6：文件只有一个去处）。返回被删的那一行，
   * 好让名录按行摘而不是按路径猜。
   */
  remove(rootId: string, path: string): Promise<DocumentRow>;
  /** 写下一份资料下次派发时的可见范围；返回改写后的行。 */
  setDisclosure(rootId: string, path: string, disclosure: Disclosure): Promise<DocumentRow>;
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
  adoptFolder(): Promise<ProjectOpened | null>;
  adoptFile(): Promise<ProjectOpened | null>;
  createProject(name: string): Promise<ProjectOpened | null>;
  createDocument(rootId: string, title: string, role: "chapter" | "material"): Promise<DocumentRow>;
  /** 把一份认可格式的文本按原字节复制进 Root，角色是 Chapter。 */
  importManuscript(rootId: string): Promise<DocumentRow | null>;
  importMaterial(rootId: string): Promise<DocumentRow | null>;
  /**
   * 一份导入来源的原始字节，供只读地看它的原件。
   *
   * `null` 是一个值：早于 schema v10 导入的 Material，或克隆件已被移走。
   * 调用方显示手上已有的文本，不当作错误。
   */
  importedSourceBytes(rootId: string, digest: string, format: string): Promise<Uint8Array | null>;
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
  | {
      readonly kind: "ready";
      readonly query: string;
      readonly documents: readonly DocumentRow[];
      /**
       * 命中的块，带着它们的文本。
       *
       * `DocumentRow` 只说「哪份文档匹配」，界面因此只能显示一列路径——而查询
       * 词不在路径里。要在结果上高亮查询词，得先有一段包含它的文字。
       */
      readonly hits: readonly BlockHit[];
    }
  | { readonly kind: "failed"; readonly query: string };

type ProjectState =
  | { readonly kind: "closed" }
  | {
      readonly kind: "open";
      readonly project: ProjectOpened;
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
type ProjectOutputOf<K extends ProjectOutput["kind"]> = Extract<ProjectOutput, { kind: K }>;

async function callProject(input: ProjectInput): Promise<ProjectOutput> {
  return unwrap(commands.project(input));
}

function expectProjectOutput<K extends ProjectOutput["kind"]>(
  output: ProjectOutput,
  kind: K,
): ProjectOutputOf<K> {
  if (output.kind !== kind) {
    throw new Error(`Project use case returned ${output.kind}; expected ${kind}`);
  }
  return output as ProjectOutputOf<K>;
}

async function acquireProject(input: ProjectInput): Promise<ProjectOpened | null> {
  const output = await callProject(input);
  return output.kind === "cancelled" ? null : expectProjectOutput(output, "opened").value;
}

const productionAcquisition: ProjectAcquisitionPort = {
  async adoptFolder() {
    const picked = e2ePickedPath();
    return picked === null
      ? acquireProject({ kind: "chooseAndAdoptRoot", value: { kind: "folder" } })
      : debugCommands.adoptRoot(picked, "folder");
  },
  async adoptFile() {
    const picked = e2ePickedPath();
    return picked === null
      ? acquireProject({ kind: "chooseAndAdoptRoot", value: { kind: "file" } })
      : debugCommands.adoptRoot(picked, "file");
  },
  async createProject(name) {
    const picked = e2ePickedPath();
    return picked === null
      ? acquireProject({ kind: "chooseAndCreateProject", value: { name } })
      : debugCommands.createProject(picked, name);
  },
  async createDocument(rootId, title, role) {
    const output = await callProject({
      kind: "createDocument",
      value: { rootId, title, role },
    });
    return expectProjectOutput(output, "documentOpened").value.document;
  },
  async importManuscript(rootId) {
    const picked = e2ePickedPath();
    if (picked !== null) return debugCommands.importManuscript(rootId, picked);
    const output = await callProject({
      kind: "chooseAndImportManuscript",
      value: { rootId },
    });
    return output.kind === "cancelled" ? null : expectProjectOutput(output, "imported").value;
  },
  async importMaterial(rootId) {
    const picked = e2ePickedPath();
    if (picked !== null) return debugCommands.importMaterial(rootId, picked);
    const output = await callProject({
      kind: "chooseAndImportMaterial",
      value: { rootId },
    });
    return output.kind === "cancelled" ? null : expectProjectOutput(output, "imported").value;
  },
  async importedSourceBytes(rootId, digest, format) {
    // 字节怎么过桥归 bridge.ts：那是前端唯一允许触碰请求原语的地方。
    return readArtifactBytes(rootId, digest, format);
  },
};

const productionCatalog: ProjectCatalogPort = {
  async page(rootId, after) {
    const output = await callProject({
      kind: "documentPage",
      value: { rootId: rootId, after },
    });
    return expectProjectOutput(output, "page").value;
  },
  async search(rootId, query, precision) {
    const output = await callProject({
      kind: "documentSearch",
      value: { rootId: rootId, query, precision },
    });
    return expectProjectOutput(output, "documents").value.documents;
  },
  async searchBlocks(rootId, query, precision) {
    const output = await callProject({
      kind: "blockSearch",
      value: { rootId: rootId, query, precision },
    });
    return expectProjectOutput(output, "blocks").value.blocks;
  },
  async remove(rootId, path) {
    const output = await callProject({
      kind: "deleteDocument",
      value: { rootId: rootId, path },
    });
    return expectProjectOutput(output, "deleted").value;
  },
  async setDisclosure(rootId, path, disclosure) {
    const output = await callProject({
      kind: "setDisclosure",
      value: { rootId: rootId, path, disclosure },
    });
    return expectProjectOutput(output, "disclosureSet").value;
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

  get project(): ProjectOpened | null {
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
  /**
   * 本次搜索命中的块，带着它们的文本。
   *
   * 只在 `ready` 时非空：搜索进行中给出上一次的命中会让作者读到与查询框里
   * 不相符的文字。
   */
  get searchHits(): readonly BlockHit[] {
    const state = this.#state;
    if (state.kind !== "open" || state.catalog.kind !== "ready") return [];
    return state.catalog.hits;
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

  /** 精度是个二态：取另一态。翻转规则归这里，按钮不该自己知道有两态。 */
  togglePrecision(): void {
    this.setPrecision(this.#precision === "exact" ? "loose" : "exact");
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
  readonly #onInstalled: (project: ProjectOpened) => void;

  constructor(
    catalog: ProjectCatalogPort = productionCatalog,
    delay: DelayPort = browserDelay,
    report: (error: unknown) => void = () => undefined,
    acquire: ProjectAcquisitionPort = productionAcquisition,
    onInstalled: (project: ProjectOpened) => void = () => undefined,
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

  install(project: ProjectOpened): void {
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
  /**
   * 一份导入来源的原始字节。
   *
   * 不走 `exclusive`：这是只读的，也不改任何会话状态，而排他会让「看原件」
   * 在保存或导入正忙时干等。
   */
  async importedSourceBytes(digest: string, format: string): Promise<Uint8Array | null> {
    const open = this.#state;
    if (open.kind !== "open") return null;
    return await this.#acquire.importedSourceBytes(open.project.rootId, digest, format);
  }

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

  /**
   * 导入一份原稿：字节原样进 Root，角色是 Chapter。
   *
   * 返回新条目的路径，由外壳决定接着打开它——「导入之后跳过去」是外壳的编排，
   * 和「新建之后跳过去」是同一件事，不在名录里各写一遍。
   */
  async importManuscript(): Promise<string | null> {
    const open = this.#state;
    if (open.kind !== "open") return null;
    let imported: string | null = null;
    await this.exclusive("import-manuscript", async () => {
      const row = await this.#acquire.importManuscript(open.project.rootId);
      if (row === null) return null;
      this.add(row);
      imported = row.path;
      return `已导入为原稿：${row.path}`;
    });
    return imported;
  }

  importMaterial(): Promise<void> {
    const open = this.#state;
    if (open.kind !== "open") return Promise.resolve();
    return this.exclusive("import-material", async () => {
      const row = await this.#acquire.importMaterial(open.project.rootId);
      if (row === null) return null;
      this.add(row);
      // 公告要说出角色与项目内路径，否则作者只知道「有事发生了」。
      return `已导入为 ARTIFACT：${row.path}`;
    });
  }

  /** 四条取得路径共用的那一段：拿到非空就安装，取消什么都不做。 */
  #acquireInto(op: ProjectOperation, acquire: () => Promise<ProjectOpened | null>): Promise<void> {
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

  /**
   * 移入回收站：桥那侧把文件送进系统回收站（INV-6），这里把行从名录摘掉。
   * 正在搜索时重跑当前查询——与 add() 同一条刷新路，不各写一份。
   */
  removeDocument(path: string): Promise<void> {
    const open = this.#state;
    if (open.kind !== "open") return Promise.resolve();
    return this.exclusive("delete-document", async () => {
      const row = await this.#catalog.remove(open.project.rootId, path);
      this.#removeRow(row.id);
      return `已移入回收站：${path}`;
    });
  }

  /** 一份资料下次派发时的可见范围（范围）。行就地换，下一次派发自然读到。 */
  setDisclosure(path: string, disclosure: Disclosure): Promise<void> {
    const open = this.#state;
    if (open.kind !== "open") return Promise.resolve();
    return this.exclusive("set-disclosure", async () => {
      const row = await this.#catalog.setDisclosure(open.project.rootId, path, disclosure);
      this.#replaceRow(row);
      return null;
    });
  }

  #removeRow(id: string): void {
    const state = this.#state;
    if (state.kind !== "open") return;
    this.#set({
      ...state,
      project: {
        ...state.project,
        documents: state.project.documents.filter((row) => row.id !== id),
        documentTotal: Math.max(0, state.project.documentTotal - 1),
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

  #replaceRow(row: DocumentRow): void {
    const state = this.#state;
    if (state.kind !== "open") return;
    const swap = (rows: readonly DocumentRow[]): DocumentRow[] =>
      rows.map((candidate) => (candidate.id === row.id ? row : candidate));
    this.#set({
      ...state,
      project: { ...state.project, documents: swap(state.project.documents) },
      catalog:
        state.catalog.kind === "ready"
          ? { ...state.catalog, documents: swap(state.catalog.documents) }
          : state.catalog,
    });
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
      // 两个查询互不依赖：文档列表管导航与分页合并，块命中管「显示哪一段」。
      // 串行会让结果面板多等一个往返，而后者恰是作者最先看的东西。
      const [documents, hits] = await Promise.all([
        this.#catalog.search(rootId, query, this.#precision),
        this.#catalog.searchBlocks(rootId, query, this.#precision),
      ]);
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
        catalog: { kind: "ready", query, documents: [...documents], hits: [...hits] },
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
