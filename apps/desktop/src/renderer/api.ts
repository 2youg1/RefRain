/**
 * The renderer's whole capability surface. Everything else — file access,
 * process launch, the ledger — lives in the main process behind these channels.
 */
export interface ChapterView {
  title: string;
  text: string;
  root: string;
  path: string;
}

export interface EditView {
  id: string;
  kind: "replace" | "insert" | "remove";
  blockId: string;
  before?: string;
  after?: string;
  at: string;
  note?: string;
}

export interface SliceView {
  id: string;
  kind: "same" | "del" | "ins";
  text: string;
}

export interface ProposalView {
  id: string;
  runId: string;
  baseline: string;
  scope: { id: string; blockIds: string[] };
  before: string;
  after: string | null;
  slices: SliceView[];
}

export interface ManifestEntryView {
  agentName: string;
  harness: string;
  model: string;
  reasoningEffort: string;
  runCount: number;
  scopes: string[];
  prompts: string[];
  drifted: string[];
}

export interface RunView {
  id: string;
  state: string;
  resultPath: string;
  agentId: string;
  /**
   * Why it failed, verbatim from the harness or the artifact parser.
   *
   * Present only on a failed run. Shown rather than summarised: a
   * misconfigured command or a malformed reply is diagnosed by its own words,
   * and "the run failed" tells an author nothing they can act on.
   */
  failure?: string;
}

export interface VerdictView {
  id: string;
  proposalId: string;
  sliceId?: string;
  kind: "accept" | "accept-modified" | "reject" | "comment-only";
  finalText?: string;
  reason?: string;
  baseline: string;
  decidedAt: string;
}

export interface AgentView {
  id: string;
  name: string;
  binding: { harness: string; model: string; reasoningEffort: string };
}

interface RefRainApi {
  openProject(): Promise<string | null>;
  openFile(): Promise<string | null>;
  createProject(): Promise<string | null>;
  loadWorkspace(roots: string[]): Promise<ChapterView[]>;
  systemFonts(): Promise<string[]>;
  probeAgent(root: string, id: string): Promise<{ ok: boolean; detail?: string }>;
  removeAgent(root: string, id: string): Promise<boolean>;
  editsBetween(before: string, after: string): Promise<EditView[]>;
  revertEdit(text: string, edit: EditView): Promise<string>;
  revertAll(text: string, edits: EditView[]): Promise<string>;
  describeEdits(edits: EditView[]): Promise<string>;
  pathFor(file: File): string;
  resolveDrop(path: string): Promise<string | null>;
  fullscreen(on: boolean): Promise<boolean>;
  /** Opens one of this project's own pages in the system browser. */
  openProjectUrl(url: string): Promise<boolean>;
  loadProject(root: string): Promise<ChapterView[]>;
  /**
   * Saves, unless the file changed underneath.
   *
   * A refusal carries the disk's text, because the author has to choose between
   * two versions and cannot do that without seeing the other one.
   */
  saveChapter(
    root: string,
    title: string,
    text: string,
  ): Promise<
    { ok: true } | { ok: false; reason: "changed-underneath"; path: string; onDisk: string }
  >;
  /** Resolves only the two versions the conflict dialog displayed. */
  resolveConflict(
    root: string,
    title: string,
    choice: "mine" | "disk",
  ): Promise<
    { ok: true; text: string } | { ok: false; reason: string; path?: string; onDisk?: string }
  >;
  listAgents(root: string): Promise<AgentView[]>;
  addAgent(root: string, name: string, command: string): Promise<AgentView>;
  enqueue(root: string, task: unknown): Promise<boolean>;
  manifest(root: string): Promise<ManifestEntryView[]>;
  send(root: string): Promise<{ id: string; requestPath: string; resultPath: string }[]>;
  collect(
    root: string,
    runId: string,
  ): Promise<{ proposals: ProposalView[]; comments: { target: string; text: string }[] }>;
  runs(root: string): Promise<RunView[]>;
  commit(
    root: string,
    payload: { chapter: string; verdicts: VerdictView[] },
  ): Promise<{ ok: true; text: string } | { ok: false; reason: string; detail: string[] }>;
  ledger(root: string): Promise<VerdictView[]>;
  /** Search the ledger over stated reasoning, to inform a persona revision. */
  searchLedger(root: string, fragment: string): Promise<VerdictView[]>;
  reply(root: string, proposalId: string): Promise<string>;

  /**
   * The native file layer. Every call returns a tagged result rather than
   * throwing, because a machine without the platform binary keeps its editor
   * and loses only the browser — and the renderer has to tell those apart.
   */
  files: {
    scan(root: string, options?: Record<string, unknown>): Promise<FileResult<{ count: number }>>;
    page(
      root: string,
      offset: number,
      limit: number,
    ): Promise<FileResult<{ entries: FileEntryView[]; total: number }>>;
    search(
      root: string,
      query: string,
      limit?: number,
    ): Promise<FileResult<{ hits: FileHitView[] }>>;
    searchDirectories(
      root: string,
      query: string,
      limit?: number,
    ): Promise<FileResult<{ hits: FileHitView[] }>>;
    sort(root: string, order: string, descending: boolean): Promise<FileResult<object>>;
    move(
      root: string,
      from: string,
      to: string,
      replace?: boolean,
    ): Promise<FileResult<{ path: string }>>;
    copy(
      root: string,
      from: string,
      to: string,
      replace?: boolean,
    ): Promise<FileResult<{ path: string }>>;
    /** Deletes to the system trash. There is deliberately no permanent variant. */
    trash(root: string, targets: string[]): Promise<FileResult<{ outcomes: TrashOutcomeView[] }>>;
    /**
     * For a volume with no trash of its own (SPEC Q8).
     *
     * Offered only after `trash` reported `NO_TRASH_HERE`, so the author
     * chooses to send the file to the trash on another volume rather than
     * having it moved somewhere they did not pick. Still recoverable from the
     * operating system; still not a permanent delete.
     */
    trashViaHome(root: string, target: string): Promise<FileResult<{ path: string }>>;
    link(root: string, target: string, linkPath: string): Promise<FileResult<{ path: string }>>;
    createDirectory(root: string, path: string): Promise<FileResult<{ path: string }>>;
    uniqueName(root: string, desired: string): Promise<FileResult<{ path: string }>>;
    admits(root: string, path: string): Promise<FileResult<{ admitted: boolean }>>;
  };

  displayProfile?(): Promise<DisplayProfileView>;
  onDisplayChange?(listener: (profile: DisplayProfileView) => void): () => void;
}

/** Success carries the payload; failure carries a reason a person can read. */
export type FileResult<T> = ({ ok: true } & T) | { ok: false; reason: string; detail: string };

export interface FileEntryView {
  path: string;
  name: string;
  kind: "file" | "directory" | "symlink";
  size: number;
  modifiedMs: number;
  depth: number;
  manuscript: boolean;
}

export interface FileHitView {
  entry: FileEntryView;
  score: number;
  /** Character offsets into `entry.name`, for highlighting. */
  positions: number[];
}

export interface TrashOutcomeView {
  path: string;
  trashed: boolean;
  /** A stable code to branch on, e.g. `NO_TRASH_HERE`. Never a sentence. */
  code?: string;
  error?: string;
}

export interface DisplayProfileView {
  refreshHz: number;
  frameBudgetMs: number;
  scaleFactor: number;
  hairlineCss: number;
  width: number;
  height: number;
  highDensity: boolean;
  highRefresh: boolean;
  css: Record<string, string>;
}

declare global {
  interface Window {
    refrain: RefRainApi;
  }
}

export const api = (): RefRainApi => window.refrain;
