/**
 * 历史面板的会话：当前文档的正文行动列表，与选择性回档（回到某一步之后）。
 *
 * 这个模块存在的原因与 DocumentSession 相同：列表状态、两步确认、回档后的
 * 本地补标，是同一件事的几个侧面，散在外壳里就会各写一遍。组件只读
 * `view()` 的投影，不认识领域措辞，也不过桥。
 *
 * 「已撤回」标记有两层真相：磁盘上的 `undone` 只在保存落盘时翻写（崩溃诚实——
 * 标记若先于文本落盘，重启后的历史链会整段跳过），所以一次刚发生的回档由
 * `#revertedUnsaved` 在视图里先如实标出，等保存把磁盘追平后本地补标退场。
 *
 * Framework-free by construction: no signal, no component. The shell
 * subscribes and re-reads; it never writes these fields.
 */

import { unwrap } from "../bridge";
import type {
  RevertOutcomeDto,
  TextActionSummaryDto,
  TextTransitionDto,
} from "../generated/bindings.gen";
import { commands } from "../generated/bindings.gen";
import type { SessionNotices } from "./document-session";
import { Broadcast, type DescribeError } from "./session";

/** The Tauri surface this module needs. Narrow on purpose: a test double is
 * two functions rather than the whole generated binding. */
export interface HistoryGateway {
  listTextActions(rootId: string, path: string): Promise<TextActionSummaryDto[]>;
  revertToAction(rootId: string, path: string, actionId: string): Promise<RevertOutcomeDto>;
}

/** The production gateway: the two generated commands this session needs. */
export const browserHistoryGateway: HistoryGateway = {
  async listTextActions(rootId, path) {
    return unwrap(commands.listTextActions(rootId, path));
  },
  async revertToAction(rootId, path, actionId) {
    return unwrap(commands.revertToAction(rootId, path, actionId));
  },
};

/**
 * 面板里的一行：展示文字已经全部投影好。
 *
 * `steps` 是「回到这一步之后」会撤回的步数——比它新、且尚未撤回的行动的个数。
 * 0 表示这一步就是当前位置，点它没有事情可做。
 */
export interface HistoryRow {
  readonly id: string;
  readonly cause: string;
  readonly time: string;
  readonly undone: boolean;
  readonly steps: number;
}

/** 列表的三态。没有打开的文档与「正在读」是两种不同的空，措辞各归各处。 */
export type HistoryRows =
  | { readonly kind: "absent" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly rows: readonly HistoryRow[] };

/** 一次待确认的回档：回到哪一步之后、要撤回几步。 */
export interface PendingRevert {
  readonly actionId: string;
  readonly cause: string;
  readonly steps: number;
}

/** Everything the surface renders. One read, one consistent picture. */
export interface HistoryView {
  readonly rows: HistoryRows;
  readonly confirming: PendingRevert | null;
  readonly reverting: boolean;
  /**
   * 有未落盘的改动。此时「已撤回」标记可能与磁盘不一致：它们只在保存时翻写，
   * 面板据此给出一行提示（不是警告——滞后是设计，不是故障）。
   */
  readonly dirty: boolean;
}

/**
 * 领域记在行动上的英文原因，译成作者读得出的一句。
 *
 * 已知的原因只有四种落点：open（会话重建）、author edit（编辑器确认）、
 * decision-batch（裁决合并）、undo: X（一次撤回）。未知原因原样示出——
 * 给一句编出来的措辞比给一句原文更糟。
 */
export function causeText(cause: string): string {
  if (cause === "open") return "打开文档";
  if (cause === "author edit") return "编辑";
  if (cause === "decision-batch") return "裁决合并";
  if (cause.startsWith("undo: ")) return `撤销：${causeText(cause.slice("undo: ".length))}`;
  return cause;
}

/**
 * 行动时刻的显示：今天的给时分，更早的补上日期。
 *
 * 完整时间戳留在领域里；面板要回答的是「这一步是什么时候」，而同日的一行
 * 历史里日期是重复噪音。
 */
export function actionTimeText(createdAtMs: string, now: Date): string {
  const at = new Date(Number(createdAtMs));
  const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  return sameDay ? hhmm : `${at.getMonth() + 1}月${at.getDate()}日 ${hhmm}`;
}

/**
 * 回档的两类拒绝与撤销共用同一个 `io` 桥码（`text_refusal` 把 TextRefusal 的
 * Display 原样装进 `detail`），区分它们只有读 detail 这一条路——与
 * document-session 的 undoRefusalText 同一个 precedent。桥上长出真正的
 * 错误码时，这个映射改读 `code`——措辞只有这里知道。
 */
export function revertRefusalText(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const detail = (error as { detail?: unknown }).detail;
  if (typeof detail !== "string") return null;
  if (detail.includes("is not in the undo history")) {
    return "那一步已不在可撤销的历史里——可能已被撤销，或太早了。";
  }
  if (detail.includes("is not invertible")) {
    return "那一步之后有改动带着裁决记录，不能越过它回档。";
  }
  return null;
}

/** The open document the panel lists, or null when none is open. */
export interface HistoryTarget {
  readonly rootId: string;
  readonly path: string;
}

export class HistorySession extends Broadcast {
  #document: HistoryTarget | null = null;
  #rows: HistoryRows = { kind: "absent" };
  #confirming: PendingRevert | null = null;
  #reverting = false;
  #dirty = false;
  /** 已撤回、保存尚未落盘的行动：视图先如实标出，磁盘在下次保存追平。 */
  #revertedUnsaved = new Set<string>();
  /** 请求代次：慢响应落到已换人的文档上时丢弃，与 ProjectSession 同一个理由。 */
  #epoch = 0;

  constructor(
    private readonly gateway: HistoryGateway,
    private readonly notices: SessionNotices,
    private readonly describe: DescribeError,
    private readonly now: () => Date = () => new Date(),
  ) {
    super();
  }

  view(): HistoryView {
    return {
      rows: this.#rows,
      confirming: this.#confirming,
      reverting: this.#reverting,
      dirty: this.#dirty,
    };
  }

  /**
   * 外壳在文档/项目 tick 上同步一次：换了文档就重置重来；没换就按最新事实
   * 重列——新行动在执行时写入，「已撤回」标记在保存时翻写，两者都落在
   * 这条刷新路上。保存完成（dirty → clean）时本地补标退场：磁盘已是真值。
   *
   * `active` = 面板开着。**面板关着时一次桥往返都不发**：击键也走 tick，
   * 没人在看的列表不值得一次 SQL 走查；开面板的那一下（active 翻真）总会
   * 补一次全量刷新，所以关窗期间错过多少都不欠账。
   */
  sync(document: HistoryTarget | null, dirty: boolean, active: boolean): void {
    const changed =
      document?.rootId !== this.#document?.rootId || document?.path !== this.#document?.path;
    if (changed) {
      this.#document = document;
      this.#confirming = null;
      this.#revertedUnsaved.clear();
      this.#rows = document === null ? { kind: "absent" } : { kind: "loading" };
      this.emit();
    }
    if (this.#dirty && !dirty) this.#revertedUnsaved.clear();
    this.#dirty = dirty;
    const opened = active && !this.#active;
    this.#active = active;
    if (this.#document !== null && (active || opened)) void this.#refresh();
  }

  /** 面板是否开着：关窗期间 sync 只记状态不发请求。 */
  #active = false;

  /**
   * 点一行的第一下：把它立为待确认。已撤回的行与当前位置不立（前者撤回
   * 不了——领域会拒；后者无事可做）。再点同一行是收回确认，不是叠一张。
   */
  askRevert(actionId: string): void {
    if (this.#reverting || this.#rows.kind !== "ready") return;
    const row = this.#rows.rows.find((candidate) => candidate.id === actionId);
    if (row === undefined || row.undone || row.steps === 0) return;
    this.#confirming =
      this.#confirming?.actionId === actionId
        ? null
        : { actionId, cause: row.cause, steps: row.steps };
    this.emit();
  }

  /** 收回待确认——取消按钮、面板关闭都走这里。 */
  cancelRevert(): void {
    if (this.#confirming === null) return;
    this.#confirming = null;
    this.emit();
  }

  /**
   * 第二下：真的回档。
   *
   * 文本落地（回读确认头、换稿、标脏）由调用方拿转移去做——与
   * DocumentSession.undo 同一个接缝，会话不认识编辑器。两类拒绝
   * （目标已不在历史、上方有带着裁决的一步）是预期内的答案，走公告；
   * 其余错误才走失败。
   */
  async confirmRevert(apply: (transition: TextTransitionDto) => Promise<void>): Promise<void> {
    const pending = this.#confirming;
    const doc = this.#document;
    if (pending === null || doc === null || this.#reverting) return;
    this.#reverting = true;
    this.emit();
    try {
      const outcome = await this.gateway.revertToAction(doc.rootId, doc.path, pending.actionId);
      // 桥带回了每一次撤销的真实转移：最后一棒的落点（修订与触块）交给宿主
      // 恢复光标；目标是链尖时没有转移——什么都没动，也就不需要落地。
      const last = outcome.transitions[outcome.transitions.length - 1];
      if (last !== undefined) await apply(last);
      this.#confirming = null;
      for (const id of outcome.undone) this.#revertedUnsaved.add(id);
    } catch (error) {
      const refusal = revertRefusalText(error);
      if (refusal !== null) this.notices.notice(refusal);
      else this.notices.failed(this.describe(error));
    } finally {
      this.#reverting = false;
      this.emit();
      void this.#refresh();
    }
  }

  async #refresh(): Promise<void> {
    const doc = this.#document;
    if (doc === null) return;
    const epoch = ++this.#epoch;
    try {
      const rows = await this.gateway.listTextActions(doc.rootId, doc.path);
      // 作者可能在请求在途时换了文档：那次响应不属于现在这份稿子。
      if (epoch !== this.#epoch || this.#document?.path !== doc.path) return;
      this.#rows = { kind: "ready", rows: this.#project(rows) };
      this.emit();
    } catch (error) {
      if (epoch !== this.#epoch) return;
      // 读不出来时留着上一份列表：旧事实加一句失败公告，比空面板诚实。
      this.notices.failed(this.describe(error));
    }
  }

  /** 领域行 → 面板行：措辞、时刻、以及每一步之上还有几步可撤回。 */
  #project(rows: readonly TextActionSummaryDto[]): HistoryRow[] {
    const now = this.now();
    // 列表新在前。steps 是比这一行新、且尚未撤回的行数——回档走不到已撤回的行。
    let newerActive = 0;
    return rows.map((row) => {
      const undone = row.undone || this.#revertedUnsaved.has(row.id);
      const steps = newerActive;
      if (!undone) newerActive += 1;
      return {
        id: row.id,
        cause: causeText(row.cause),
        time: actionTimeText(row.createdAt, now),
        undone,
        steps,
      };
    });
  }
}
