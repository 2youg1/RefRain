# Effect conventions

Effect (`effect@beta`, pinned exact) is the concurrency and error runtime for
the TypeScript session layer. This document is the authority for where Effect
runs, which patterns are canonical, and which are forbidden. Read
[AGENTS.md](AGENTS.md) first; every rule there still applies.

## Territory

| Area | Effect | Reason |
|---|---|---|
| `apps/desktop/src/shell/` sessions, watchers, dispatch orchestration | **Required** for new async or concurrent state | This layer hand-writes epochs, cancel flags, and exclusive locks. Effect owns these invariants in the runtime. |
| `apps/desktop/src/ui/` components | Forbidden, except the one adapter module | Components read views and call session methods. They do not compose effects. |
| `packages/typeset/`, `packages/editor/` | **Forbidden** | Pure synchronous computation on the mount hot path. The performance gate budgets 50 ms; a runtime adds cost and no capability. |
| `scripts/`, `e2e/` | **Forbidden** | Build scripts compile with ScriptC as fully static (roadmap D15). Effect demotes them to the dynamic tier. |
| `src-tauri/` generated bindings | Untouched | Generated code stays generated. Wrap it once at the bridge. |

## The five load-bearing patterns

### 1. Errors: one tagged family at the bridge

`RefrainError` crosses the bridge as data. Convert it to a tagged error once,
in `bridge.ts`; after that boundary every failure is typed and every handler
matches on `_tag`.

```ts
import { Data, Effect } from "effect";

export class BridgeError extends Data.TaggedError("BridgeError")<{
  readonly code: RefrainError["code"];
  readonly action: string;
  readonly subject: string;
}> {}

export const call = <T>(envelope: Promise<Envelope<T>>): Effect.Effect<T, BridgeError> =>
  Effect.promise(() => envelope).pipe(
    Effect.flatMap((result) =>
      result.status === "ok"
        ? Effect.succeed(result.data)
        : Effect.fail(new BridgeError(result.error)),
    ),
  );
```

- Do not throw. Do not return `null` for failure.
- Recover with `Effect.catchTag`. A catch-all `Effect.catchAll` that swallows
  the error and returns a default is forbidden; if a branch truly ignores a
  failure, write the reason on that line.
- Interface code renders `code`; it never parses prose (INV-15 unchanged).

### 2. Lifecycle: Scope replaces manual teardown

Every long-lived object (watcher, poller, event subscription) is created with
`Effect.Effect<X, E, Scope.Scope>` and forks its fibers into that scope.
Closing the scope interrupts every fiber and runs every finalizer, in reverse
order, exactly once.

- Do not store `(() => void) | null` unsubscribe fields.
- Do not write epoch counters to invalidate stale async answers. Interrupt the
  fiber instead; interruption cancels the in-flight request and the sleep with
  it. `shell/run-watch.ts` is the reference conversion.
- One `ManagedRuntime` exists, created in `main.tsx` next to the Solid root.
  Components never call `Effect.runPromise`; the adapter does.

### 3. State: SubscriptionRef, views stay data

Observable session state lives in `SubscriptionRef`. Derived facts (for
example "everything just settled") are derived from `changes` with `Stream`,
not stored in a second mutable field that can disagree with the first.

The single Solid adapter module converts `SubscriptionRef<A>` to a Solid
signal. It is the only file that imports both `solid-js` and `effect`.

### 4. Operations: Effect.fn, exclusivity as a combinator

Reusable session operations are `Effect.fn` functions. The `Session.exclusive`
discipline (one operation at a time, re-entry refused not queued) stays, as a
combinator that wraps an operation with a `Ref`-held lock; refusal is a typed
`Refused` value, not a silent return.

### 5. Time and tests: TestClock, scripted layers

Any code that sleeps, polls, or debounces is tested under
`TestClock.layer()` from `effect/testing`. Real-time waits in tests are
forbidden. Gateways are interfaces; tests provide scripted implementations
that log calls into a `Ref`. A test drives virtual time with
`TestClock.adjust` and asserts on the log — polling cadence, backoff, and
stale-answer refusal become exact assertions, not sleeps and hopes.

## TypeScript rules carried over

- `any`, `as` casts, and non-null assertions stay forbidden inside Effect code.
- Discriminated unions stay the state representation. `Option`/`Either` are
  welcome; a `{ kind: ... }` union you already have does not need conversion.
- Imports stay static and top-level.
- Do not use `Effect.fnUntraced` without a measured hot-path reason on the
  same line.

## Dependency discipline

- `effect` is pinned exact in `package.json`; upgrades are one commit that
  also runs the full gate.
- No other `@effect/*` package enters without a consumer in the same commit.
- The bundle cost of the runtime was measured at 54 KB gzip once
  (probe, 2026-08-03); a change that imports Effect into `packages/*` fails
  `verify:typeset-purity` and is a regression, not a trade-off.

## Migration order

Convert a module when you touch it for a milestone, not in a sweep. A module
converts completely in one commit: its manual cancel flags, epochs, and
unsubscribe fields are deleted in the same change that introduces the scope.
A half-converted module (Effect inside, promise-with-flags outside) is a
review rejection.

First consumers, in dependency order: `run-watch.ts` (M2), the M2 run
lifecycle state machines, the M5 CONTEXT compiler, M6 relay and speculative
prefetch (interruption is the prefetch-invalidation primitive).
