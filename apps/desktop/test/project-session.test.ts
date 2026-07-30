import { describe, expect, test } from "bun:test";
import type { DocumentPageDto, DocumentRow, ProjectOpenedDto } from "../src/generated/bindings.gen";
import {
  type DelayPort,
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
    expect(session.activity.value).toBe("waiting");

    delay.flush();
    await settle();
    expect(searches).toEqual(["新稿"]);
    expect(session.visibleDocuments.value).toEqual([row("新稿", "新稿.md")]);
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
    expect(session.visibleDocuments.value).toEqual([]);
    expect(session.activity.value).toBe("searching");

    session.install(opened("second", [row("second", "第二项目.md")], null));
    pending.get("新稿")?.resolve([row("new", "新稿.md")]);
    await settle();
    expect(session.project.value?.rootId).toBe("second");
    expect(session.visibleDocuments.value).toEqual([row("second", "第二项目.md")]);
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
    expect(session.documents.value.map((document) => document.path)).toEqual([
      "root-一.md",
      "root-二.md",
    ]);
    expect(session.hasMore.value).toBe(false);
  });
});
