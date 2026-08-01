/**
 * The smallest reactive cell the shell needs, owned by us rather than a
 * framework.
 *
 * The domain modules (project catalog, document session, KARA projection) must
 * not import a UI framework — that is what lets them be tested without a DOM
 * and what made replacing the old shell a bounded job rather than a rewrite. They still
 * need to say "this changed"; that is all this file provides.
 *
 * `.value` is deliberately the same shape the old refs had, so migrating a
 * module is an import change rather than a rewrite of every read.
 */

export interface Cell<T> {
  value: T;
  /** Observe changes. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export function cell<T>(initial: T): Cell<T> {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get value() {
      return current;
    },
    set value(next: T) {
      if (Object.is(current, next)) return;
      current = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** A read-only cell derived from others. Recomputed on every read: these are
 * cheap projections of a handful of fields, and caching them would add an
 * invalidation problem for no measured gain. */
export function derived<T>(compute: () => T): { readonly value: T } {
  return {
    get value() {
      return compute();
    },
  };
}
