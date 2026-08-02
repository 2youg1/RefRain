import { describe, expect, test } from "bun:test";
import type {
  AnnotationDto,
  FileStamp_Serialize,
  OpenDocumentDto_Serialize,
} from "../src/generated/bindings.gen";
import {
  type DocumentGateway,
  DocumentSession,
  type PersistOutcome,
} from "../src/shell/document-session";

const stamp = (tag: string): FileStamp_Serialize =>
  ({ digest: tag, len: 1, mtime: 1 }) as unknown as FileStamp_Serialize;

const opened = (path: string, text: string): OpenDocumentDto_Serialize =>
  ({
    document: { path, role: "chapter", title: path },
    revision: "r1",
    blocks: [{ id: "b1", text }],
    stamp: stamp("disk-1"),
    kara: null,
    staleJournal: [],
    replayed: 0,
  }) as unknown as OpenDocumentDto_Serialize;

const annotation = (id: string): AnnotationDto =>
  ({
    id,
    document: "a.md",
    blockId: "b1",
    start: 0,
    end: 2,
    quote: "Al",
    kind: "highlight",
    body: null,
    anchorState: "anchored",
  }) as unknown as AnnotationDto;

interface Harness {
  session: DocumentSession;
  notices: string[];
  failures: string[];
  calls: string[];
  setOutcome(outcome: PersistOutcome): void;
  setAnnotations(rows: AnnotationDto[]): void;
  failUndo(error: unknown): void;
  settle(): void;
}

function harness(): Harness {
  const notices: string[] = [];
  const failures: string[] = [];
  const calls: string[] = [];
  let outcome: PersistOutcome = { kind: "saved", value: { stamp: stamp("disk-2") } };
  let rows: AnnotationDto[] = [];
  let undoFailure: unknown = null;
  let releaseComposition: (() => void) | null = null;

  const gateway: DocumentGateway = {
    async openDocument(_root, path) {
      calls.push(`open:${path}`);
      return opened(path, "Alpha");
    },
    async currentDocument() {
      calls.push("current");
      return { revision: "r2", blocks: [{ id: "b1", text: "Alpha edited" }] };
    },
    async undoEditorAction() {
      calls.push("undo");
      const failure = undoFailure;
      undoFailure = null;
      if (failure !== null) throw failure;
      return { revision: "r0", actionId: "a0", touchedBlocks: ["b1"] };
    },
    async persistRevision() {
      calls.push("persist");
      return outcome;
    },
    async listAnnotations() {
      calls.push("list");
      return [...rows];
    },
    async upsertAnnotation(request) {
      calls.push("upsert");
      return { ...annotation(request.id ?? "new-1"), kind: request.kind };
    },
    async deleteAnnotation() {
      calls.push("delete");
      return true;
    },
  };

  const session = new DocumentSession(
    gateway,
    () => ({
      whenSettled: () =>
        releaseComposition === null
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              const previous = releaseComposition;
              releaseComposition = () => {
                previous?.();
                resolve();
              };
            }),
      settled: () => Promise.resolve(),
    }),
    {
      notice: (text) => {
        if (text !== null) notices.push(text);
      },
      failed: (reason) => failures.push(reason),
    },
    (error) => String(error),
  );

  return {
    session,
    notices,
    failures,
    calls,
    setOutcome: (next) => {
      outcome = next;
    },
    setAnnotations: (next) => {
      rows = next;
    },
    failUndo: (error) => {
      undoFailure = error;
    },
    settle: () => {
      const release = releaseComposition;
      releaseComposition = null;
      release?.();
    },
  };
}

describe("DocumentSession", () => {
  test("opening loads the document and its annotations together", async () => {
    const h = harness();
    h.setAnnotations([annotation("a1")]);
    h.session.useProject("root");
    await h.session.open("a.md");
    const view = h.session.view();
    expect(view.document?.document.path).toBe("a.md");
    expect(view.annotations).toHaveLength(1);
    expect(view.save.kind).toBe("clean");
  });

  test("a dirty document refuses to switch away and says why", async () => {
    const h = harness();
    h.session.useProject("root");
    await h.session.open("a.md");
    h.session.markDirty();
    h.calls.length = 0;
    const result = await h.session.open("b.md");
    expect(result).toBeNull();
    expect(h.calls).not.toContain("open:b.md");
    expect(h.notices.at(-1)).toContain("先保存");
  });

  test("a failed save also blocks the switch", async () => {
    const h = harness();
    h.session.useProject("root");
    await h.session.open("a.md");
    h.setOutcome({ kind: "conflict", value: { onDisk: "theirs", stamp: stamp("disk-9") } });
    await h.session.save();
    expect(h.session.view().save.kind).toBe("failed");
    h.calls.length = 0;
    await h.session.open("b.md");
    expect(h.calls).not.toContain("open:b.md");
  });

  test("save waits for composition to end rather than a timer", async () => {
    const h = harness();
    h.session.useProject("root");
    await h.session.open("a.md");
    h.session.markDirty();
    h.settle(); // arm: the next whenSettled() stays pending until released
    let done = false;
    // Start a composition by making whenSettled pend, then request a save.
    const pending = (async () => {
      await h.session.save();
      done = true;
    })();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await pending;
    expect(done).toBe(true);
  });

  test("a conflict keeps the session text as the author's side", async () => {
    const h = harness();
    h.session.useProject("root");
    await h.session.open("a.md");
    h.setOutcome({ kind: "conflict", value: { onDisk: "theirs", stamp: stamp("disk-9") } });
    await h.session.save();
    const conflict = h.session.view().conflict;
    expect(conflict?.mine).toBe("Alpha edited");
    expect(conflict?.theirs).toBe("theirs");
  });

  test("keeping mine saves against the stamp the author was shown", async () => {
    const h = harness();
    h.session.useProject("root");
    await h.session.open("a.md");
    h.setOutcome({ kind: "conflict", value: { onDisk: "theirs", stamp: stamp("disk-9") } });
    await h.session.save();
    h.setOutcome({ kind: "saved", value: { stamp: stamp("disk-10") } });
    await h.session.resolveConflict("mine");
    expect(h.session.view().save.kind).toBe("clean");
    expect(h.session.view().conflict).toBeNull();
  });

  test("taking theirs reopens and clears the conflict", async () => {
    const h = harness();
    h.session.useProject("root");
    await h.session.open("a.md");
    h.setOutcome({ kind: "conflict", value: { onDisk: "theirs", stamp: stamp("disk-9") } });
    await h.session.save();
    await h.session.resolveConflict("theirs");
    const view = h.session.view();
    expect(view.conflict).toBeNull();
    expect(view.save.kind).toBe("clean");
    expect(h.calls.filter((call) => call === "open:a.md")).toHaveLength(2);
  });

  test("a commit adopts the session head instead of re-reading disk", async () => {
    const h = harness();
    h.session.useProject("root");
    await h.session.open("a.md");
    h.calls.length = 0;
    await h.session.adoptCommitted();
    expect(h.calls).toContain("current");
    expect(h.calls).not.toContain("open:a.md");
    expect(h.session.view().document?.blocks[0]?.text).toBe("Alpha edited");
    expect(h.session.view().save.kind).toBe("dirty");
  });

  test("switching projects drops the open document", async () => {
    const h = harness();
    h.session.useProject("root");
    await h.session.open("a.md");
    h.session.useProject("other");
    const view = h.session.view();
    expect(view.document).toBeNull();
    expect(view.annotations).toHaveLength(0);
    expect(view.save.kind).toBe("clean");
  });

  test("deleting the annotation being relocated clears the relocation", async () => {
    const h = harness();
    h.setAnnotations([annotation("a1")]);
    h.session.useProject("root");
    await h.session.open("a.md");
    const row = h.session.view().annotations[0];
    if (row === undefined) throw new Error("annotation missing");
    h.session.beginRelocation(row);
    expect(h.session.view().relocating?.id).toBe("a1");
    await h.session.deleteAnnotation("a1");
    expect(h.session.view().relocating).toBeNull();
    expect(h.session.view().annotations).toHaveLength(0);
  });

  test("unsaved text is reported so the window can refuse to close", async () => {
    const h = harness();
    h.session.useProject("root");
    await h.session.open("a.md");
    expect(h.session.hasUnsavedText()).toBe(false);
    h.session.markDirty();
    expect(h.session.hasUnsavedText()).toBe(true);
  });

  test("undo hands the transition to the caller's apply", async () => {
    const h = harness();
    h.session.useProject("root");
    await h.session.open("a.md");
    const applied: string[] = [];
    await h.session.undo(async (transition) => {
      applied.push(transition.revision);
    });
    expect(h.calls).toContain("undo");
    expect(applied).toEqual(["r0"]);
    expect(h.failures).toEqual([]);
  });

  test("undo on an empty history is a notice, not a failure", async () => {
    const h = harness();
    h.session.useProject("root");
    await h.session.open("a.md");
    h.failUndo({
      code: "io",
      action: "undo the last action",
      subject: "a.md",
      detail: "there is no Text Action to undo",
      recovery: [],
    });
    let applied = false;
    await h.session.undo(async () => {
      applied = true;
    });
    expect(applied).toBe(false);
    expect(h.notices.at(-1)).toBe("没有可撤销的一步。");
    expect(h.failures).toEqual([]);
  });

  test("undo a step that carried verdicts is refused honestly", async () => {
    const h = harness();
    h.session.useProject("root");
    await h.session.open("a.md");
    h.failUndo({
      code: "io",
      action: "undo the last action",
      subject: "a.md",
      detail: "Text Action abc is not invertible: its verdicts are already ledger facts",
      recovery: [],
    });
    await h.session.undo(async () => undefined);
    expect(h.notices.at(-1)).toBe("那一步带着裁决记录，不能撤销。");
    expect(h.failures).toEqual([]);
  });

  test("an unexpected undo error goes to the failure channel", async () => {
    const h = harness();
    h.session.useProject("root");
    await h.session.open("a.md");
    h.failUndo(new Error("disk gone"));
    await h.session.undo(async () => undefined);
    expect(h.failures.at(-1)).toContain("disk gone");
  });
});
