/**
 * The single watcher for "an agent is working somewhere in this project".
 *
 * Run progress used to live only inside the dispatch panel: unmount the
 * panel and the polling died with it, so the author heard nothing about a
 * run that finished while they were writing. This module owns the whole
 * concern behind a small interface: it listens to the bridge's run-settled
 * event, polls only while something is actually in flight, and broadcasts
 * one number (how many runs are in flight) plus one transition (the last
 * one just settled).
 *
 * The framework-free part is the state and the polling discipline; the
 * bridge and the event subscription arrive through the gateway, so a test
 * can drive every state without Tauri.
 */

import { listen } from "@tauri-apps/api/event";
import { unwrap } from "../bridge";
import { commands, type HostStateDto } from "../generated/bindings.gen";
import { inFlight } from "./dispatch-wording";
import { browserDelay, type DelayPort } from "./project-session";
import { Broadcast } from "./session";

export interface RunWatchGateway {
  hostState(rootId: string): Promise<HostStateDto>;
  /** Subscribe to the bridge's run-settled event; resolves to an unsubscribe. */
  onRunSettled(listener: (rootId: string) => void): Promise<() => void>;
}

export const browserRunWatchGateway: RunWatchGateway = {
  hostState: async (rootId) => unwrap(commands.hostState(rootId)),
  onRunSettled: (listener) =>
    listen<{ rootId: string }>("run-settled", (event) => listener(event.payload.rootId)),
};

/** "All settled" means one thing: a moment ago something was in flight, now nothing is. */
export interface RunWatchHooks {
  allSettled(): void;
}

/** How often in-flight runs are re-read. Same cadence as the dispatch panel, same reason. */
const POLL_MS = 2_500;

export class RunWatch extends Broadcast {
  readonly #gateway: RunWatchGateway;
  readonly #hooks: RunWatchHooks;
  readonly #delay: DelayPort;
  #rootId: string | null = null;
  #inFlight = 0;
  /** Epoch: after retarget/dispose, every in-flight answer is stale. */
  #epoch = 0;
  #cancelPoll: (() => void) | null = null;
  #stopEvent: (() => void) | null = null;
  #disposed = false;

  constructor(gateway: RunWatchGateway, hooks: RunWatchHooks, delay: DelayPort = browserDelay) {
    super();
    this.#gateway = gateway;
    this.#hooks = hooks;
    this.#delay = delay;
    void gateway
      .onRunSettled((rootId) => {
        if (rootId === this.#rootId) this.poke();
      })
      .then((stop) => {
        // The listener may resolve after disposal: unsubscribe immediately
        // rather than holding a dead object.
        if (this.#disposed) stop();
        else this.#stopEvent = stop;
      });
  }

  /** A different project is a different world: stop watching the old one, look at the new. */
  retarget(rootId: string | null): void {
    this.#rootId = rootId;
    this.#epoch += 1;
    this.#cancelPoll?.();
    this.#cancelPoll = null;
    if (this.#inFlight !== 0) {
      this.#inFlight = 0;
      this.emit();
    }
    if (rootId !== null) this.poke();
  }

  /** "Look now" — right after a dispatch, or when a settled event arrives. */
  poke(): void {
    void this.#refresh();
  }

  view(): { readonly inFlight: number } {
    return { inFlight: this.#inFlight };
  }

  dispose(): void {
    this.#disposed = true;
    this.#epoch += 1;
    this.#cancelPoll?.();
    this.#cancelPoll = null;
    this.#stopEvent?.();
    this.#stopEvent = null;
  }

  async #refresh(): Promise<void> {
    const rootId = this.#rootId;
    if (rootId === null || this.#disposed) return;
    const epoch = this.#epoch;
    try {
      const host = await this.#gateway.hostState(rootId);
      if (this.#disposed || epoch !== this.#epoch || rootId !== this.#rootId) return;
      const count = host.runs.filter((run) => inFlight(run)).length;
      const was = this.#inFlight;
      this.#inFlight = count;
      // Every tick while in flight broadcasts: the dispatch panel refreshes
      // its run list from this watcher instead of running a second poller.
      this.emit();
      if (was > 0 && count === 0) this.#hooks.allSettled();
    } catch {
      // A failed poll says nothing about the runs; the next tick still comes.
    }
    if (!this.#disposed && epoch === this.#epoch && this.#inFlight > 0) {
      this.#cancelPoll = this.#delay.after(POLL_MS, () => void this.#refresh());
    }
  }
}
