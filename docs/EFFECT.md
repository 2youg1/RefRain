# Effect conventions

Effect (`effect@beta`, pinned exact) is the concurrency and error runtime for
the TypeScript session layer. This document is the authority for where Effect
runs, which patterns are canonical, and which are forbidden. Read
[AGENTS.md](AGENTS.md) first; every rule there still applies.

## Type discipline

These hold for every TypeScript file in this repository, Effect or not. AGENTS.md
points here rather than repeating them.

- Keep `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, and `noFallthroughCasesInSwitch` enabled.
- Do not use `any`. Accept `unknown` at a boundary and narrow it there.
- Use a discriminated union instead of several independent Booleans. Two Booleans
  can both be true; one tag cannot be two values at once.
- Keep imports static and at the top level.
- Model an exhaustive set so that a missing member fails to compile.

## Territory

| Area | Effect | Reason |
|---|---|---|
| `scripts/`, `e2e/` | **Forbidden** | Build scripts compile with ScriptC as fully static. Effect demotes them to the dynamic tier. |
| `apps/native/src/` | **Forbidden** | The Native core is a synchronous `update` compiled through a restricted subset (`native check --strict`). A runtime cannot enter it, and effects are the SDK's `Cmd`. |
| A future TypeScript session layer | **Required** when it appears | Nothing occupies this row today. |

**Effect currently has no consumer in this repository.** The session layer it
governed lived in `apps/desktop/src/shell/` and was deleted with the Solid
surface in step 10; the orchestration it managed (epochs, cancel flags,
exclusive locks) now lives in Rust — `AgentHost` owns Run lifecycles, and
`DocumentSurface` owns the document state machine. The dependency stays pinned
and this document stays authoritative because the *next* TypeScript layer that
needs concurrency must adopt these patterns rather than hand-write a second
epoch scheme, which is exactly what the deleted one did.

**The gate is coupled to these paths.** `scripts/verify-effect-territory.ts`
fails when a scan matches no files at all — that self-check is deliberate,
because a gate over an empty set proves nothing. Step 10 moved its scan set
from `apps/desktop/**` to `apps/native/src/**` and `scripts/**`, and its
run-time edge set is now empty (no file may start an Effect runtime). If a
session layer returns, add its directory here, remove it from the forbidden
globs, and name its entry point as a run edge — **do not** relax the empty-set
check to make the gate quiet.

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
- One `ManagedRuntime` exists, created at the session layer's entry point.
  Components never call `Effect.runPromise`; the adapter does.

### 3. State: SubscriptionRef, views stay data

Observable session state lives in `SubscriptionRef`. Derived facts (for
example "everything just settled") are derived from `changes` with `Stream`,
not stored in a second mutable field that can disagree with the first.

An adapter module converts `SubscriptionRef<A>` to whatever the view layer
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

First consumers are named by the current plan's integer steps, not by the
retired letter numbering: the Run lifecycle state machines (step 7), the
CONTEXT compiler (step 8), and relay with speculative prefetch (step 8, where
interruption is the prefetch-invalidation primitive).
