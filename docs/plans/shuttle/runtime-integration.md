# Shuttle — runtime integration

Satellite of [`../shuttle.md`](../shuttle.md), grounding decision 9 (one
in-process connection, `cf` verbs through shared library seams, a `!cf`
subprocess escape). This records what the runtime and `packages/cli` offer
today, the discipline a long-lived process must add, and the seam work in
`cli` that is prerequisite to building anything.

## The connection

One persistent `PiecesController` serves a place. `PiecesController.initialize`
(`packages/piece/src/ops/pieces-controller.ts`) is the lean constructor;
`loadPieces` (`packages/cli/lib/piece.ts`) is the CLI's wrapper, adding a
version check, an experimental-options fetch, and a health check per call —
preamble a shell pays once, not per verb.

The connection pushes. The `remoteClient` runtime preset opens a persistent
`WebSocketTransport` (`packages/runner/src/storage/v2-remote-session.ts`), so
a write landing on the server from anywhere reaches this process's cells and
re-fires their sinks. `watch` needs no polling.

Two existing long-lived holders show the lifecycle discipline:

- `packages/cf-harness`: `createHarnessFabricSessionFactory` builds one
  controller, `cacheHarnessFabricSessionFactory` memoizes it so every
  invocation of a run shares it, and a rejected construction clears the cache
  so a transient failure is not replayed forever. That
  reconnect-on-failure policy is the model to copy.
- `packages/fuse`: `CellBridge` takes an injectable `PiecesLoader` plus a
  separate `reconnectPiecesLoader` for recovery.

Skipping `loadPieces`'s per-call preamble also skips its health check, so
shuttle owns its own liveness story; the cf-harness policy is the leaner fit.

## Watch mechanics

`Cell.sink(callback, options)` (`IAnyCell.sink`,
`packages/runner/src/cell.ts`) is the substrate: it fires immediately with
the current value and re-fires on every committed change, and it works
outside a browser — `packages/fuse/cell-bridge.ts`,
`packages/cli/lib/callable.ts`, and the agents connector all sink from Deno
processes. (`packages/runtime-client` is not a candidate: its only transport
is browser-main-thread-to-Web-Worker.)

Two disciplines every existing sink consumer rediscovered:

- **Settling.** One logical change fires several sink callbacks before the
  reactive graph quiets. FUSE debounces on a timer; `renderVDomToHtml`
  (`packages/cli/lib/piece-render.ts`) uses a reentrancy guard plus
  `runtime.idle()` so several batches produce exactly one report per quiet
  runtime. The guard-plus-`idle()` form is the one to adopt — no timer.
- **Freshness requires running.** A piece that is not started serves stored
  state; computed values are only fresh when the pattern runs in this
  process. That is what `cf get --step` does per invocation
  (`getCellValue` in `packages/cli/lib/piece.ts`: get with `runIt`, then
  pull, `idle`, `synced`). In a persistent shell that dance collapses to a
  one-time start per piece. When shuttle starts a piece is a policy question
  the main document carries.

`renderPiece(config, { watch, onUpdate })` in
`packages/cli/lib/piece-render.ts` is the closest prior art: it returns a
cancel function and drives `onUpdate` per settled change. Its command action
keeps the process alive with a SIGINT listener and a never-resolving promise
— the shape a shell must not copy.

## Seam inventory in `packages/cli`

The CLI already factors many command actions as named exports with
dependency seams — the `*FromCommand` family in
`packages/cli/commands/piece.ts` (`getCellValueFromCommand`,
`setCellValueFromCommand`, `listPiecesFromCommand`,
`describePieceFromCommand`, the survey/repair/retarget/rollback/restore set,
and more), each shaped `(options, ...positionals, deps)`. `cf wish` goes
further: `wishAction` over `readWish` (`packages/cli/lib/wish.ts`), which
abstracts its connection behind `WishRuntimeHost` — the cleanest seam and
the model to generalize.

Connection injection is uneven. `PieceResolutionDeps.loadPieces` is the
injection point that lets a lib function reuse a held controller:

- **Accept it:** `getCellValue`, `listPieces`, `listSpaceSlugs`,
  `searchPieces`, `inspectPiece`, `executePieceCallable` (via
  `PieceCallableDependencies`), `readWish`, `runExec`, all of `lib/bulk.ts`.
- **Hardcode `loadPieces` instead:** `setCellValue`, `callPieceHandler`,
  `stepPiece`, `removePiece`, `getPieceView`, `renderPiece`, the
  `lib/acl.ts` loaders. Each opens a fresh runtime and WebSocket per call.

`call` is the one verb with no seam at all: `buildCallCommand`'s action is
inline and bound to Cliffy's `this` (`getLiteralArgs`). Its constituents are
already exported and library-grade (`executePieceCallable`,
`pieceCallRawArgs`, `pieceCallInvocation`, `resolveInvocationIdentity`,
`pieceCallPhaseObserver`, `resolveWaitControl`, `parsePieceCallSelection`,
`boundedSettlement`, `renderPieceCallOutcome`), so extraction is mechanical:
the literal-args array becomes a parameter.

## Prerequisite work in `packages/cli`

Each of these is small and lands on its own; together they are what decision
9's "factor the seam in `cli`, not reimplement in shuttle" means concretely.

1. **Export entries.** `@commonfabric/cli` exports only `.` → `mod.ts`. A
   sibling package needs real entries for the lib modules it calls.
2. **Thread `deps.loadPieces` through the hardcoded functions** —
   `setCellValue` first; `set` is a v1 verb and today cannot share a
   connection.
3. **Extract `callFromCommand`** from `buildCallCommand`'s inline action.
4. **Exit discipline.** `exitWithDataError` and `exitPieceCallFailure` call
   `Deno.exit(1)` (typed `never`); `getCellValueFromCommand` reaches the
   former on a data error, which would kill the shell. Both take a `deps`
   override — shuttle threads an exit shim through every seam it calls, and
   catches the `ValidationError` that `exitPieceCallFailure` rethrows for
   Cliffy's usage rendering.
5. **Output capture.** The `FromCommand` seams accept `render`/`hint` deps;
   stray `console.error` calls in `lib/piece.ts` do not. Sweep as views
   need them captured.
6. **Module-global state.** `quietMode` is a file-level `let` set on every
   `FromCommand` entry; `setLLMUrl` is a global written by both `loadPieces`
   and `PiecesController.initialize`, so two connections on different API
   URLs would fight. Scope them, or accept one-connection-per-process for
   v1 and record the limit.
7. **Disposal.** `withRuntimeCleanupOnFailure` disposes only on throw; the
   success path relies on process exit. In a long-lived shell every
   un-injected call leaks a runtime, a storage manager, and a WebSocket —
   injection is correctness, not merely speed. `groupSessions` in
   `lib/bulk.ts` (open, `synced`, `dispose` per group) names the cost.
8. **Invocation session.** `newSessionId`'s contract is one per agent run,
   shared by every call of the run. A shuttle instance is a run: mint one at
   startup and pass it explicitly into every `call` (decision 6 forbids
   env-var mutation; `resolveInvocationIdentity` throws on `--invocation`
   without a session). Replay via `--invocation` then works within a
   shuttle session for free.
