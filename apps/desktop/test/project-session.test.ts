import { describe, expect, test } from "bun:test";
import type { DocumentPageDto, DocumentRow, ProjectOpenedDto } from "../src/generated/bindings.gen";
import {
  type DelayPort,
  type ProjectAcquisitionPort,
  type ProjectCatalogPort,
  ProjectSession,
} from "../src/shell/project-session";

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
): ProjectOpenedDto => ({
  rootId,
  backup: { kind: "nothingToCopy" },
  documents,
  documentTotal: documents.length + (cursor === null ? 0 : 1),
  documentCursor: cursor,
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
      async page(): Promise<DocumentPageDto> {
        throw new Error("not used");
      },
      async search(_rootId, query) {
        searches.push(query);
        return [row(query, `${query}.md`)];
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
    const catalog: ProjectCatalogPort = {
      async page(): Promise<DocumentPageDto> {
        throw new Error("not used");
      },
      search(_rootId, query) {
        const result = deferred<readonly DocumentRow[]>();
        pending.set(query, result);
        return result.promise;
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
      async search() {
        return [];
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
    importMaterial: async () => row("mat-1", "资料.md"),
    ...overrides,
  });

  const build = (
    port: ProjectAcquisitionPort,
    installed: ProjectOpenedDto[] = [],
  ): ProjectSession =>
    new ProjectSession(
      { page: async () => ({}) as DocumentPageDto, search: async () => [] },
      new ManualDelay(),
      () => undefined,
      port,
      (project) => installed.push(project),
      (error) => `失败:${String(error)}`,
    );

  test("选中一个文件夹就装上那个项目", async () => {
    const installed: ProjectOpenedDto[] = [];
    const session = build(acquisition(), installed);
    await session.openFolder();
    expect(session.project?.rootId).toBe("folder-root");
    expect(installed).toHaveLength(1);
  });

  test("作者取消选择，什么都不发生", async () => {
    const installed: ProjectOpenedDto[] = [];
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

  test("导入资料会说一声，好让作者知道它进来了", async () => {
    const session = build(acquisition());
    await session.openFolder();
    await session.importMaterial();
    expect(session.view()).toEqual({ kind: "reported", text: "已导入" });
    expect(session.documents.some((entry) => entry.path === "资料.md")).toBe(true);
  });

  test("导入被取消时不出现「已导入」这句话", async () => {
    const session = build(acquisition({ importMaterial: async () => null }));
    await session.openFolder();
    await session.importMaterial();
    expect(session.view().kind).toBe("idle");
  });
});
