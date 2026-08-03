import { describe, expect, test } from "bun:test";
import type {
  BlockHit,
  DocumentRow,
  ProjectOpened,
  ProjectPage,
} from "../src/generated/bindings.gen";
import {
  type DelayPort,
  type ProjectAcquisitionPort,
  type ProjectCatalogPort,
  ProjectSession,
} from "../src/shell/project-session";

const hit = (query: string): BlockHit => ({
  path: `${query}.md`,
  ordinal: 0,
  kind: "paragraph",
  startByte: 0,
  bytes: 12,
  text: `前文${query}后文`,
  relevance: 1,
});

const row = (id: string, path: string): DocumentRow => ({
  id,
  path,
  role: "chapter",
  digest: null,
  currentHead: null,
  headBlockIds: null,
});

const opened = (
  rootId: string,
  documents: DocumentRow[] = [row(`${rootId}-1`, `${rootId}-一.md`)],
  cursor: string | null = "next",
  openedPath: string | null = documents[0]?.path ?? null,
): ProjectOpened => ({
  rootId,
  backup: { kind: "nothingToCopy" },
  documents,
  documentTotal: documents.length + (cursor === null ? 0 : 1),
  documentCursor: cursor,
  openedPath,
});

class ManualDelay implements DelayPort {
  readonly tasks: Array<{ active: boolean; task: () => void }> = [];

  after(_milliseconds: number, task: () => void): () => void {
    const scheduled = { active: true, task };
    this.tasks.push(scheduled);
    return () => {
      scheduled.active = false;
    };
  }

  flush(): void {
    for (const scheduled of this.tasks.splice(0)) {
      if (scheduled.active) scheduled.task();
    }
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("project session", () => {
  test("typing is debounced and only the latest query reaches Rust", async () => {
    const delay = new ManualDelay();
    const searches: string[] = [];
    const catalog: ProjectCatalogPort = {
      async page(): Promise<ProjectPage> {
        throw new Error("not used");
      },
      async search(_rootId, query) {
        searches.push(query);
        return [row(query, `${query}.md`)];
      },
      async searchBlocks(_rootId, query) {
        return [hit(query)];
      },
      async remove(): Promise<DocumentRow> {
        throw new Error("not used");
      },
      async setDisclosure(): Promise<DocumentRow> {
        throw new Error("not used");
      },
    };
    const session = new ProjectSession(catalog, delay);
    session.install(opened("root"));

    session.setQuery("旧稿");
    session.setQuery("新稿");
    expect(searches).toEqual([]);
    expect(session.catalogActivity).toBe("waiting");

    delay.flush();
    await settle();
    expect(searches).toEqual(["新稿"]);
    expect(session.visibleDocuments).toEqual([row("新稿", "新稿.md")]);
  });

  test("an old response cannot replace a new query or a new project", async () => {
    const delay = new ManualDelay();
    const pending = new Map<string, Deferred<readonly DocumentRow[]>>();
    const pendingHits = new Map<string, Deferred<readonly BlockHit[]>>();
    const catalog: ProjectCatalogPort = {
      async page(): Promise<ProjectPage> {
        throw new Error("not used");
      },
      search(_rootId, query) {
        const result = deferred<readonly DocumentRow[]>();
        pending.set(query, result);
        return result.promise;
      },
      // 块查询与文档查询并行发出，因此它也必须能停在半路：只延迟其中一个，
      // 陈旧响应就永远被另一个的完成时刻掩盖，这条测试会测不到新增的那条路。
      searchBlocks(_rootId, query) {
        const result = deferred<readonly BlockHit[]>();
        pendingHits.set(query, result);
        return result.promise;
      },
      async remove(): Promise<DocumentRow> {
        throw new Error("not used");
      },
      async setDisclosure(): Promise<DocumentRow> {
        throw new Error("not used");
      },
    };
    const session = new ProjectSession(catalog, delay);
    session.install(opened("first"));
    session.setQuery("旧稿");
    delay.flush();
    session.setQuery("新稿");
    delay.flush();

    pending.get("旧稿")?.resolve([row("old", "旧稿.md")]);
    await settle();
    expect(session.visibleDocuments).toEqual([]);
    expect(session.catalogActivity).toBe("searching");

    session.install(opened("second", [row("second", "第二项目.md")], null));
    pending.get("新稿")?.resolve([row("new", "新稿.md")]);
    await settle();
    expect(session.project?.rootId).toBe("second");
    expect(session.visibleDocuments).toEqual([row("second", "第二项目.md")]);
  });

  test("the next page merges once without exposing a page control", async () => {
    const delay = new ManualDelay();
    let calls = 0;
    const catalog: ProjectCatalogPort = {
      async page(rootId, after) {
        calls += 1;
        expect([rootId, after]).toEqual(["root", "next"]);
        return {
          documents: [row("root-2", "root-二.md")],
          total: 2,
          next: null,
        };
      },
      async searchBlocks() {
        return [];
      },
      async search() {
        return [];
      },
      async remove(): Promise<DocumentRow> {
        throw new Error("not used");
      },
      async setDisclosure(): Promise<DocumentRow> {
        throw new Error("not used");
      },
    };
    const session = new ProjectSession(catalog, delay);
    session.install(opened("root"));

    await Promise.all([session.loadNext(), session.loadNext()]);
    expect(calls).toBe(1);
    expect(session.documents.map((document) => document.path)).toEqual([
      "root-一.md",
      "root-二.md",
    ]);
    expect(session.hasMore).toBe(false);
  });
});

describe("ProjectSession 取得一个项目", () => {
  const acquisition = (
    overrides: Partial<ProjectAcquisitionPort> = {},
  ): ProjectAcquisitionPort => ({
    adoptFolder: async () => opened("folder-root"),
    adoptFile: async () => opened("file-root"),
    createProject: async (name) => opened(`created-${name}`),
    createDocument: async (_rootId, title) => row("new-1", `${title}.md`),
    importManuscript: async () => row("man-1", "拖入.md"),
    importMaterial: async () => row("mat-1", "资料.md"),
    ...overrides,
  });

  const build = (port: ProjectAcquisitionPort, installed: ProjectOpened[] = []): ProjectSession =>
    new ProjectSession(
      { page: async () => ({}) as ProjectPage, search: async () => [] },
      new ManualDelay(),
      () => undefined,
      port,
      (project) => installed.push(project),
      (error) => `失败:${String(error)}`,
    );

  test("选中一个文件夹就装上那个项目", async () => {
    const installed: ProjectOpened[] = [];
    const session = build(acquisition(), installed);
    await session.openFolder();
    expect(session.project?.rootId).toBe("folder-root");
    expect(installed).toHaveLength(1);
  });

  test("作者取消选择，什么都不发生", async () => {
    const installed: ProjectOpened[] = [];
    const session = build(acquisition({ adoptFolder: async () => null }), installed);
    await session.openFolder();
    expect(session.project).toBeNull();
    expect(installed).toHaveLength(0);
    // 取消不是失败：界面上不该出现红字。
    expect(session.view().kind).toBe("idle");
  });

  test("空白项目名不会建出一个项目", async () => {
    const session = build(acquisition());
    await session.createProject("   ");
    expect(session.project).toBeNull();
  });

  test("项目名两端的空白会被去掉", async () => {
    const session = build(acquisition());
    await session.createProject("  夜航  ");
    expect(session.project?.rootId).toBe("created-夜航");
  });

  test("桥拒绝时说得出原因，而不是静静地什么都没发生", async () => {
    const session = build(
      acquisition({
        adoptFolder: async () => {
          throw new Error("没有权限");
        },
      }),
    );
    await session.openFolder();
    expect(session.view()).toEqual({ kind: "failed", text: "失败:Error: 没有权限" });
  });

  test("新建的章节进名录，并把路径交回去给外壳打开", async () => {
    const session = build(acquisition());
    await session.openFolder();
    const created = await session.createDocument("第二章", "chapter");
    expect(created).toBe("第二章.md");
    expect(session.documents.some((entry) => entry.path === "第二章.md")).toBe(true);
  });

  test("还没有项目的时候建不出文档", async () => {
    const session = build(acquisition());
    expect(await session.createDocument("孤章", "chapter")).toBeNull();
  });

  test("导入 ARTIFACT 的公告说出角色与项目内路径，而不是只说「已导入」", async () => {
    const session = build(acquisition());
    await session.openFolder();
    await session.importMaterial();
    // F-27：作者要能从公告本身分辨这一次导入的是资料还是原稿。
    expect(session.view()).toEqual({ kind: "reported", text: "已导入为 ARTIFACT：资料.md" });
    expect(session.documents.some((entry) => entry.path === "资料.md")).toBe(true);
  });

  test("导入原稿是另一条路：角色是原稿，并把路径交回去给外壳打开", async () => {
    const session = build(acquisition());
    await session.openFolder();
    const imported = await session.importManuscript();
    expect(imported).toBe("拖入.md");
    expect(session.view()).toEqual({ kind: "reported", text: "已导入为原稿：拖入.md" });
    expect(session.documents.some((entry) => entry.path === "拖入.md")).toBe(true);
  });

  test("导入被取消时不出现公告", async () => {
    const session = build(acquisition({ importMaterial: async () => null }));
    await session.openFolder();
    await session.importMaterial();
    expect(session.view().kind).toBe("idle");
  });

  test("原稿导入被取消时交回 null，外壳因此不会去打开一份不存在的文档", async () => {
    const session = build(acquisition({ importManuscript: async () => null }));
    await session.openFolder();
    expect(await session.importManuscript()).toBeNull();
    expect(session.view().kind).toBe("idle");
  });

  test("还没有项目的时候导不进原稿", async () => {
    const session = build(acquisition());
    expect(await session.importManuscript()).toBeNull();
  });

  test("取得项目时交回落点，外壳据此打开正文而不是自己猜第一行", async () => {
    const installed: ProjectOpened[] = [];
    const session = build(acquisition(), installed);
    await session.openFolder();
    // D10：落点由 Rust 判定，装上项目的那一刻它就在 DTO 里。
    expect(installed[0]?.openedPath).toBe("folder-root-一.md");
  });

  test("空项目的落点是 null——只有这一种情形允许停在空工作区", async () => {
    const installed: ProjectOpened[] = [];
    const session = build(
      acquisition({ adoptFolder: async () => opened("empty-root", [], null, null) }),
      installed,
    );
    await session.openFolder();
    expect(installed[0]?.openedPath).toBeNull();
  });
});

describe("资料行：回收站、范围与精度", () => {
  const catalog = (overrides: Partial<ProjectCatalogPort> = {}): ProjectCatalogPort => ({
    page: async () => {
      throw new Error("not used");
    },
    search: async () => [],
    searchBlocks: async () => [],
    remove: async (_rootId, path) => row("root-1", path),
    setDisclosure: async (_rootId, path, disclosure) => ({ ...row("root-1", path), disclosure }),
    ...overrides,
  });

  test("移入回收站后这一行从名录消失，并说了一声", async () => {
    const session = new ProjectSession(catalog(), new ManualDelay());
    session.install(opened("root"));
    expect(session.documents).toHaveLength(1);
    await session.removeDocument("root-一.md");
    expect(session.documents).toEqual([]);
    expect(session.view()).toEqual({ kind: "reported", text: "已移入回收站：root-一.md" });
  });

  test("范围写回到那一行上——下一次派发读到的就是新值", async () => {
    const session = new ProjectSession(catalog(), new ManualDelay());
    session.install(opened("root"));
    await session.setDisclosure("root-一.md", "full");
    expect(session.documents[0]?.disclosure).toBe("full");
  });

  test("精度是个二态：toggle 换到另一态，手里有查询时立刻按新态重搜", async () => {
    const delay = new ManualDelay();
    const precisions: string[] = [];
    const session = new ProjectSession(
      catalog({
        search: async (_rootId, _query, precision) => {
          precisions.push(precision);
          return [];
        },
      }),
      delay,
    );
    session.install(opened("root"));
    session.setQuery("概念");
    delay.flush();
    await settle();
    expect(session.precision).toBe("exact");
    session.togglePrecision();
    expect(session.precision).toBe("loose");
    delay.flush();
    await settle();
    expect(precisions).toEqual(["exact", "loose"]);
  });
});
