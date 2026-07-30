/**
 * The one owner of an open manuscript: which document, its disk stamp, whether
 * it is saved, any conflict, and its annotations.
 *
 * These five facts change together and were previously five refs beside each
 * other in the shell, where every caller had to remember the order to touch
 * them in — a failed save had to block a document switch, a switch had to clear
 * the relocation target, a commit had to re-read the session rather than the
 * disk. Holding them behind one interface makes those orderings the module's
 * business instead of the caller's.
 *
 * Framework-free by construction: no signal, no ref, no component. The shell
 * subscribes and re-reads; it never writes these fields.
 */

import { unwrap } from "../bridge";
import type {
  AnnotationDto,
  AnnotationKind,
  DocumentRow,
  FileStamp_Serialize,
  OpenDocumentDto_Serialize,
  RecoveryStep,
  SessionDocumentDto,
} from "../generated/bindings.gen";
import { commands } from "../generated/bindings.gen";
import { type DescribeError, Session } from "./session";

export type SaveState =
  | { readonly kind: "clean" }
  | { readonly kind: "dirty" }
  | { readonly kind: "saving" }
  | {
      readonly kind: "failed";
      readonly reason: string;
      readonly recovery: readonly RecoveryStep[];
    };

export interface Conflict {
  readonly mine: string;
  readonly theirs: string;
  readonly stamp: FileStamp_Serialize;
}

/** Everything the shell renders. One read, one consistent picture. */
export interface DocumentSessionView {
  readonly document: OpenDocumentDto_Serialize | null;
  readonly save: SaveState;
  readonly conflict: Conflict | null;
  readonly annotations: readonly AnnotationDto[];
  readonly relocating: AnnotationDto | null;
}

/** The Tauri surface this module needs. Narrow on purpose: it names exactly
 * the six calls the session makes, so a test double is six functions rather
 * than the whole generated binding. */
export interface DocumentGateway {
  openDocument(rootId: string, path: string): Promise<OpenDocumentDto_Serialize>;
  // The generated DTO, not a hand-written shape of it: spelling out
  // `{ id, text }` here made this a second authority for what a block is, and
  // it drifted the moment blocks began carrying their byte shape.
  currentDocument(rootId: string, path: string): Promise<SessionDocumentDto>;
  persistRevision(
    rootId: string,
    path: string,
    stamp: FileStamp_Serialize | null,
  ): Promise<PersistOutcome>;
  listAnnotations(rootId: string, document: string): Promise<AnnotationDto[]>;
  upsertAnnotation(request: UpsertAnnotation): Promise<AnnotationDto>;
  deleteAnnotation(rootId: string, id: string): Promise<boolean>;
}

export type PersistOutcome =
  | { kind: "saved"; value: { stamp: FileStamp_Serialize; recoveryEvidence?: string | null } }
  | { kind: "conflict"; value: { onDisk: string; stamp: FileStamp_Serialize } };

export interface UpsertAnnotation {
  readonly rootId: string;
  readonly id: string | null;
  readonly document: string;
  readonly blockId: string;
  readonly start: number;
  readonly end: number;
  readonly quote: string;
  readonly kind: AnnotationKind;
  readonly body: string | null;
}

/** What the editor must supply. `whenSettled` is why a save no longer guesses
 * at IME timing with a 250ms timer. */
export interface EditorAccess {
  whenSettled(): Promise<void>;
  settled(): Promise<void>;
}

export interface SessionNotices {
  /** A message for the author; null clears the line. */
  notice(text: string | null): void;
  /** An error that reached the boundary, already described. */
  failed(reason: string): void;
}

/** The production gateway: the six generated commands this session needs. */
export const browserGateway: DocumentGateway = {
  async openDocument(rootId, path) {
    return unwrap(commands.openDocument(rootId, path));
  },
  async currentDocument(rootId, path) {
    return unwrap(commands.currentDocument(rootId, path));
  },
  async persistRevision(rootId, path, stamp) {
    return (await unwrap(commands.persistRevision(rootId, path, stamp))) as PersistOutcome;
  },
  async listAnnotations(rootId, document) {
    return unwrap(commands.listAnnotations(rootId, document));
  },
  async upsertAnnotation(request) {
    return unwrap(commands.upsertAnnotation(request));
  },
  async deleteAnnotation(rootId, id) {
    return unwrap(commands.deleteAnnotation(rootId, id));
  },
};

/**
 * Recovery steps a typed error carries, when it carries any.
 *
 * The step stays typed. Widening it to `string[]` here would throw away the
 * fact that this is a closed set of six, and the interface could then only
 * print it back at the author — which is what it did. Keeping the union lets
 * the surface answer each one with a sentence in the author's language, and
 * lets a compiler point at the gap when a seventh is added.
 */
function recoveryOf(error: unknown): readonly RecoveryStep[] {
  if (typeof error !== "object" || error === null) return [];
  const recovery = (error as { recovery?: unknown }).recovery;
  if (!Array.isArray(recovery)) return [];
  return recovery.filter((step): step is RecoveryStep =>
    RECOVERY_STEPS.includes(step as RecoveryStep),
  );
}

/**
 * Every RecoveryStep the bridge can send.
 *
 * Listed here so the filter above rejects anything unknown rather than passing
 * it through as a step nobody can render. `satisfies` makes the compiler check
 * this against the generated union instead of trusting that it was kept in
 * step by hand.
 */
const RECOVERY_STEPS = [
  "retry",
  "choose-another-location",
  "choose-another-name",
  "grant-permission",
  "open-settings",
  "report-defect",
] as const satisfies readonly RecoveryStep[];

export class DocumentSession extends Session {
  #document: OpenDocumentDto_Serialize | null = null;
  #stamp: FileStamp_Serialize | null = null;
  #save: SaveState = { kind: "clean" };
  #conflict: Conflict | null = null;
  #annotations: readonly AnnotationDto[] = [];
  #relocating: AnnotationDto | null = null;
  #rootId: string | null = null;

  constructor(
    private readonly gateway: DocumentGateway,
    private readonly editor: () => EditorAccess | null,
    private readonly notices: SessionNotices,
    private readonly describe: DescribeError,
  ) {
    super();
  }

  protected describeError(error: unknown): string {
    return this.describe(error);
  }

  view(): DocumentSessionView {
    return {
      document: this.#document,
      save: this.#save,
      conflict: this.#conflict,
      annotations: this.#annotations,
      relocating: this.#relocating,
    };
  }

  /** The project changed underneath us; forget the open document. */
  useProject(rootId: string | null): void {
    this.#rootId = rootId;
    this.#document = null;
    this.#stamp = null;
    this.#save = { kind: "clean" };
    this.#conflict = null;
    this.#annotations = [];
    this.#relocating = null;
    this.emit();
  }

  /** True when the author would lose text by leaving. */
  hasUnsavedText(): boolean {
    return this.#document !== null && this.#save.kind !== "clean";
  }

  async open(path: string): Promise<OpenDocumentDto_Serialize | null> {
    const rootId = this.#rootId;
    if (rootId === null) return null;
    // Unsaved text lives only in this window, so a switch must not discard it.
    if (this.#save.kind === "dirty" || this.#save.kind === "failed") {
      this.notices.notice("先保存：未落盘的文字还只在这个窗口里。");
      return null;
    }
    try {
      const opened = await this.gateway.openDocument(rootId, path);
      this.#document = opened;
      this.#stamp = opened.stamp;
      this.#save = { kind: "clean" };
      this.#conflict = null;
      this.#relocating = null;
      this.#annotations = await this.gateway.listAnnotations(rootId, path);
      this.emit();
      return opened;
    } catch (error) {
      this.#fail(error);
      return null;
    }
  }

  async save(): Promise<void> {
    const rootId = this.#rootId;
    const open = this.#document;
    if (rootId === null || open === null) return;
    const editor = this.editor();
    // Wait for the composition to end, not for a guessed number of ms.
    await editor?.whenSettled();
    this.#save = { kind: "saving" };
    this.emit();
    try {
      // The file only ever stores confirmed revisions (SPEC 7.2-5).
      await editor?.settled();
      const outcome = await this.gateway.persistRevision(rootId, open.document.path, this.#stamp);
      if (outcome.kind === "saved") {
        this.#stamp = outcome.value.stamp;
        this.#save = { kind: "clean" };
        if (outcome.value.recoveryEvidence) {
          this.notices.notice(`恢复了一份中断的写入:${outcome.value.recoveryEvidence}`);
        }
      } else {
        // The author's side is the confirmed session text, not the bytes the
        // document was opened with: edits confirmed since then are theirs too.
        const session = await this.gateway.currentDocument(rootId, open.document.path);
        this.#save = { kind: "failed", reason: "磁盘上的版本已经变了", recovery: [] };
        this.#conflict = {
          mine: session.blocks.map((block) => block.text).join("\n\n"),
          theirs: outcome.value.onDisk,
          stamp: outcome.value.stamp,
        };
      }
    } catch (error) {
      this.#save = { kind: "failed", reason: this.describe(error), recovery: recoveryOf(error) };
    }
    this.emit();
  }

  async resolveConflict(choice: "mine" | "theirs"): Promise<void> {
    const conflict = this.#conflict;
    if (conflict === null) return;
    this.#conflict = null;
    if (choice === "mine") {
      // Compare-and-swap against the stamp the author was actually shown.
      this.#stamp = conflict.stamp;
      this.#save = { kind: "dirty" };
      this.emit();
      await this.save();
      return;
    }
    const path = this.#document?.document.path;
    this.#save = { kind: "clean" };
    this.emit();
    if (path !== undefined) await this.open(path);
  }

  /** After a Review commit: read the session head, never the pre-commit disk. */
  async adoptCommitted(): Promise<void> {
    const rootId = this.#rootId;
    const open = this.#document;
    if (rootId === null || open === null) return;
    try {
      const session = await this.gateway.currentDocument(rootId, open.document.path);
      this.#document = { ...open, revision: session.revision, blocks: [...session.blocks] };
      this.#save = { kind: "dirty" };
      this.emit();
    } catch (error) {
      this.#fail(error);
    }
  }

  /** The editor confirmed an action: the document now differs from disk. */
  markDirty(): void {
    if (this.#save.kind === "clean") this.#save = { kind: "dirty" };
    this.emit();
    void this.#refreshAnnotations();
  }

  async upsertAnnotation(
    input: Omit<UpsertAnnotation, "rootId" | "document">,
  ): Promise<AnnotationDto | null> {
    const rootId = this.#rootId;
    const open = this.#document;
    if (rootId === null || open === null) return null;
    try {
      const row = await this.gateway.upsertAnnotation({
        ...input,
        rootId,
        document: open.document.path,
      });
      const index = this.#annotations.findIndex((candidate) => candidate.id === row.id);
      this.#annotations =
        index < 0
          ? [...this.#annotations, row]
          : this.#annotations.map((candidate) => (candidate.id === row.id ? row : candidate));
      this.#relocating = null;
      this.emit();
      return row;
    } catch (error) {
      this.#fail(error);
      return null;
    }
  }

  async deleteAnnotation(id: string): Promise<void> {
    const rootId = this.#rootId;
    if (rootId === null) return;
    try {
      await this.gateway.deleteAnnotation(rootId, id);
      this.#annotations = this.#annotations.filter((row) => row.id !== id);
      if (this.#relocating?.id === id) this.#relocating = null;
      this.emit();
    } catch (error) {
      this.#fail(error);
    }
  }

  beginRelocation(annotation: AnnotationDto): void {
    this.#relocating = annotation;
    this.emit();
  }

  cancelRelocation(): void {
    this.#relocating = null;
    this.emit();
  }

  /** A newly saved material joins the shelf without reopening the document. */
  noteDocumentAdded(_row: DocumentRow): void {
    this.emit();
  }

  async #refreshAnnotations(): Promise<void> {
    const rootId = this.#rootId;
    const path = this.#document?.document.path;
    if (rootId === null || path === undefined) return;
    try {
      const rows = await this.gateway.listAnnotations(rootId, path);
      // The author may have switched documents while this was in flight.
      if (this.#document?.document.path !== path) return;
      this.#annotations = rows;
      this.emit();
    } catch (error) {
      this.#fail(error);
    }
  }

  #fail(error: unknown): void {
    this.notices.failed(this.describe(error));
  }
}
