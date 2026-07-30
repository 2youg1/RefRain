import { type ComputedRef, computed, type Ref, ref } from "vue";
import { unwrap } from "../bridge";
import {
  commands,
  type DocumentPageDto,
  type DocumentRow,
  type ProjectOpenedDto,
} from "../generated/bindings.gen";

export interface ProjectCatalogPort {
  page(rootId: string, after: string): Promise<DocumentPageDto>;
  search(rootId: string, query: string): Promise<readonly DocumentRow[]>;
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

const browserDelay: DelayPort = {
  after(milliseconds, task) {
    const handle = window.setTimeout(task, milliseconds);
    return () => window.clearTimeout(handle);
  },
};

const productionCatalog: ProjectCatalogPort = {
  async page(rootId, after) {
    return unwrap(commands.documentPage(rootId, after));
  },
  async search(rootId, query) {
    return unwrap(commands.documentSearch(rootId, query));
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
export class ProjectSession {
  readonly #state: Ref<ProjectState> = ref({ kind: "closed" });
  readonly #catalog: ProjectCatalogPort;
  readonly #delay: DelayPort;
  readonly #report: (error: unknown) => void;
  #request = 0;
  #cancelDelay: (() => void) | null = null;

  readonly project: ComputedRef<ProjectOpenedDto | null> = computed(() =>
    this.#state.value.kind === "open" ? this.#state.value.project : null,
  );
  readonly documents: ComputedRef<readonly DocumentRow[]> = computed(
    () => this.project.value?.documents ?? [],
  );
  readonly visibleDocuments: ComputedRef<readonly DocumentRow[]> = computed(() => {
    const state = this.#state.value;
    if (state.kind !== "open") return [];
    return state.catalog.kind === "ready"
      ? state.catalog.documents
      : state.catalog.kind === "idle" || state.catalog.kind === "paging"
        ? state.project.documents
        : [];
  });
  readonly query: ComputedRef<string> = computed(() => {
    const state = this.#state.value;
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
  });
  readonly activity: ComputedRef<CatalogActivity> = computed(() => {
    const state = this.#state.value;
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
  });
  readonly hasMore: ComputedRef<boolean> = computed(() => {
    const state = this.#state.value;
    return (
      state.kind === "open" &&
      state.catalog.kind === "idle" &&
      state.project.documentCursor !== null
    );
  });

  constructor(
    catalog: ProjectCatalogPort = productionCatalog,
    delay: DelayPort = browserDelay,
    report: (error: unknown) => void = () => undefined,
  ) {
    this.#catalog = catalog;
    this.#delay = delay;
    this.#report = report;
  }

  install(project: ProjectOpenedDto): void {
    this.#invalidateRequests();
    this.#state.value = { kind: "open", project, catalog: { kind: "idle" } };
  }

  add(row: DocumentRow): void {
    const state = this.#state.value;
    if (state.kind !== "open") return;
    const exists = state.project.documents.some((candidate) => candidate.id === row.id);
    if (exists) return;
    this.#state.value = {
      ...state,
      project: {
        ...state.project,
        documents: mergeRows(state.project.documents, [row]),
        documentTotal: state.project.documentTotal + 1,
      },
    };
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
    const state = this.#state.value;
    if (state.kind !== "open") return;
    this.#invalidateRequests();
    const query = rawQuery.trim();
    if (query === "") {
      this.#state.value = { ...state, catalog: { kind: "idle" } };
      return;
    }
    const request = this.#request;
    const rootId = state.project.rootId;
    this.#state.value = { ...state, catalog: { kind: "waiting", query } };
    this.#cancelDelay = this.#delay.after(120, () => {
      this.#cancelDelay = null;
      void this.#search(rootId, query, request);
    });
  }

  async loadNext(): Promise<void> {
    const state = this.#state.value;
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
    this.#state.value = { ...state, catalog: { kind: "paging" } };
    try {
      const page = await this.#catalog.page(rootId, cursor);
      const live = this.#state.value;
      if (
        live.kind !== "open" ||
        live.project.rootId !== rootId ||
        live.project.documentCursor !== cursor ||
        live.catalog.kind !== "paging" ||
        request !== this.#request
      ) {
        return;
      }
      this.#state.value = {
        ...live,
        catalog: { kind: "idle" },
        project: {
          ...live.project,
          documents: mergeRows(live.project.documents, page.documents),
          documentTotal: page.total,
          documentCursor: page.next,
        },
      };
    } catch (error) {
      const live = this.#state.value;
      if (
        live.kind === "open" &&
        live.project.rootId === rootId &&
        live.catalog.kind === "paging" &&
        request === this.#request
      ) {
        this.#state.value = { ...live, catalog: { kind: "idle" } };
        this.#report(error);
      }
    }
  }

  dispose(): void {
    this.#invalidateRequests();
    this.#state.value = { kind: "closed" };
  }

  async #search(rootId: string, query: string, request: number): Promise<void> {
    const state = this.#state.value;
    if (
      state.kind !== "open" ||
      state.project.rootId !== rootId ||
      state.catalog.kind !== "waiting" ||
      state.catalog.query !== query ||
      request !== this.#request
    ) {
      return;
    }
    this.#state.value = { ...state, catalog: { kind: "searching", query } };
    try {
      const documents = await this.#catalog.search(rootId, query);
      const live = this.#state.value;
      if (
        live.kind !== "open" ||
        live.project.rootId !== rootId ||
        live.catalog.kind !== "searching" ||
        live.catalog.query !== query ||
        request !== this.#request
      ) {
        return;
      }
      this.#state.value = {
        ...live,
        project: {
          ...live.project,
          documents: mergeRows(live.project.documents, documents),
        },
        catalog: { kind: "ready", query, documents: [...documents] },
      };
    } catch (error) {
      const live = this.#state.value;
      if (
        live.kind === "open" &&
        live.project.rootId === rootId &&
        live.catalog.kind === "searching" &&
        live.catalog.query === query &&
        request === this.#request
      ) {
        this.#state.value = { ...live, catalog: { kind: "failed", query } };
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
