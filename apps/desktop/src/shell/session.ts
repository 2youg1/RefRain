/**
 * What every session in this application is: a piece of state that outlives a
 * component, tells its watchers when it changed, and runs one exclusive
 * operation at a time against a remote catalogue.
 *
 * Three sessions had independently grown the same `#listeners` set, the same
 * `add`/`delete` subscribe pair, and the same loop over listeners; one of them
 * had also grown an exclusive-operation wrapper the other two will need as they
 * take work away from their components. A sequence repeated three times is not
 * a coincidence, it is a concept with no home. This file is the home.
 *
 * Framework-free by construction: no solid-js import, no DOM reference. A
 * session is testable by calling it and reading `view()`.
 */

/**
 * The state of an operation that talks to the other side of the bridge.
 *
 * This is a discriminated union rather than `busy: boolean` plus
 * `notice: string | null` because independent fields admit combinations no
 * screen can render — "working and also reporting a failure" is representable
 * with two booleans and meaningless to an author. Making it unrepresentable is
 * cheaper than remembering not to write it.
 */
export type Activity<Operation extends string = string> =
  | { readonly kind: "idle" }
  /**
   * `op` names which operation holds the lock. A surface with one button can
   * ignore it; a surface with seven needs it to grey out the right control and
   * to say "正在派发" rather than a generic "请稍候".
   */
  | { readonly kind: "working"; readonly op: Operation }
  | { readonly kind: "reported"; readonly text: string }
  | { readonly kind: "failed"; readonly text: string };

/** The resting state. Typed by its own arm so it fits any operation set. */
export const idle: { readonly kind: "idle" } = { kind: "idle" };

/** Renders an unknown thrown value as something an author can read. */
export type DescribeError = (error: unknown) => string;

/**
 * A source of change that watchers can subscribe to.
 *
 * Sessions expose this and nothing else about their notification mechanism, so
 * a caller cannot reach in and emit on their behalf.
 */
export interface Observable {
  onChanged(listener: () => void): () => void;
}

/**
 * State that outlives a component and tells watchers when it changed.
 *
 * Separate from `Session` because not every observable owns remote operations:
 * the project catalogue broadcasts but never locks, and inheriting a lock it
 * cannot use would force it to implement an error renderer nothing calls. A
 * base class that makes its subclass write dead code is the wrong base class.
 */
export abstract class Broadcast implements Observable {
  readonly #listeners = new Set<() => void>();

  /**
   * Watch for change. The returned function unsubscribes; a component calls it
   * from its cleanup so a torn-down surface stops holding this alive.
   */
  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Tell every watcher that the readable state would now answer differently. */
  protected emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

/** A broadcast that also owns one exclusive operation against a remote store. */
export abstract class Session<Operation extends string = string> extends Broadcast {
  #activity: Activity<Operation> = idle;

  /** Current operation state. Subclasses expose it through their own `view()`. */
  protected get activity(): Activity<Operation> {
    return this.#activity;
  }

  /**
   * Run one operation with this session locked, then publish the result.
   *
   * The lock is the reason this method exists rather than each caller setting a
   * flag: two operations interleaving their writes would leave the surface
   * describing a state that never existed on disk. A returned string becomes
   * the notice an author reads; `null` finishes silently.
   *
   * Re-entry is refused rather than queued. A queue would let an author's
   * second click land after a refresh they can no longer see the reason for;
   * refusing keeps the button's meaning honest.
   */
  protected async exclusive(op: Operation, operation: () => Promise<string | null>): Promise<void> {
    if (this.#activity.kind === "working") return;
    this.#setActivity({ kind: "working", op });
    try {
      const reported = await operation();
      this.#setActivity(reported === null ? idle : { kind: "reported", text: reported });
    } catch (error) {
      this.#setActivity({ kind: "failed", text: this.describeError(error) });
    }
  }

  /**
   * Show a complaint that never crossed the bridge — a refusal this session
   * decided on its own, such as an empty name. It is a notice, not a failure of
   * an operation, so it does not pretend to have run one.
   */
  protected report(text: string): void {
    if (this.#activity.kind === "working") return;
    this.#setActivity({ kind: "failed", text });
  }

  /**
   * Clear a notice without running anything — for a surface that dismisses the
   * last message when the author starts typing again.
   */
  dismissNotice(): void {
    if (this.#activity.kind === "idle" || this.#activity.kind === "working") return;
    this.#setActivity(idle);
  }

  /** How this session renders a thrown value. Subclasses supply it. */
  protected abstract describeError(error: unknown): string;

  #setActivity(next: Activity<Operation>): void {
    this.#activity = next;
    this.emit();
  }
}
