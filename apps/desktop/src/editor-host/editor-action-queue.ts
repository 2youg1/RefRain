import type { EditorAction, EditorChange } from "@refrain/editor";

type ApplyAction = (action: EditorAction) => Promise<void>;
type Schedule = (task: () => void) => void;
type Reject = (error: unknown) => void;

const mergeIntoTail = (queue: EditorAction[], action: EditorAction): boolean => {
  const last = queue.at(-1);
  const only = action.changes.length === 1 ? action.changes[0] : undefined;
  const previous = last?.changes.length === 1 ? last.changes[0] : undefined;
  if (
    last === undefined ||
    only?.kind !== "replace" ||
    previous?.kind !== "replace" ||
    only.text === null ||
    previous.text === null ||
    only.blocks.length !== 1 ||
    previous.blocks.length !== 1 ||
    only.blocks[0] !== previous.blocks[0]
  ) {
    return false;
  }
  const merged: EditorChange = {
    kind: "replace",
    blocks: previous.blocks,
    text: only.text,
  };
  queue[queue.length - 1] = {
    baseRevision: last.baseRevision,
    changes: [merged],
  };
  return true;
};

/**
 * One frame-bound confirmation queue for one mounted editor.
 *
 * Input only updates the editor's local projection. The first bridge command
 * cannot start until the next animation frame; repeated replacements of one
 * block collapse before that frame. A running confirmation owns its action,
 * and later input waits for another frame rather than recursing from the
 * promise continuation.
 */
export class EditorActionQueue {
  readonly #apply: ApplyAction;
  readonly #scheduleTask: Schedule;
  readonly #reject: Reject;
  readonly #queue: EditorAction[] = [];
  readonly #waiters: Array<() => void> = [];
  #inFlight = false;
  #scheduled = false;
  #destroyed = false;

  constructor(apply: ApplyAction, scheduleTask: Schedule, reject: Reject = () => undefined) {
    this.#apply = apply;
    this.#scheduleTask = scheduleTask;
    this.#reject = reject;
  }

  submit(action: EditorAction): void {
    if (this.#destroyed) return;
    if (!mergeIntoTail(this.#queue, action)) this.#queue.push(action);
    this.#schedule();
  }

  settled(): Promise<void> {
    return this.#queue.length === 0 && !this.#inFlight && !this.#scheduled
      ? Promise.resolve()
      : new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  destroy(): void {
    this.#destroyed = true;
    this.#queue.length = 0;
    this.#settleIfIdle();
  }

  #schedule(): void {
    if (this.#destroyed || this.#scheduled || this.#inFlight || this.#queue.length === 0) {
      return;
    }
    this.#scheduled = true;
    this.#scheduleTask(() => {
      this.#scheduled = false;
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    if (this.#destroyed || this.#inFlight) return;
    const action = this.#queue.shift();
    if (action === undefined) {
      this.#settleIfIdle();
      return;
    }
    this.#inFlight = true;
    try {
      await this.#apply(action);
    } catch (error) {
      this.#reject(error);
    } finally {
      this.#inFlight = false;
      this.#schedule();
      this.#settleIfIdle();
    }
  }

  #settleIfIdle(): void {
    if (this.#queue.length > 0 || this.#inFlight || this.#scheduled) return;
    for (const resolve of this.#waiters.splice(0)) resolve();
  }
}
