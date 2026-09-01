# Shuttle — runtime integration

Satellite of [`README.md`](README.md), grounding decision 9 (one
in-process connection, `cf` verbs through shared library seams, a `!cf`
subprocess escape). This records what the runtime and `packages/cli` offer
today, the discipline a long-lived process must add, and the seam work in
`cli` that is prerequisite to building anything.

## The connection

One persistent `PiecesController` serves a place. `PiecesController.initialize`
(`packages/piece/src/ops/pieces-controller.ts`) is the lean constructor: it
opens the session and its storage manager, builds the `remoteClient` runtime
over the deployment's experimental options, health-checks the server before
reading any of the space, and settles the space session. `loadPieces`
(`packages/cli/lib/piece.ts`) wraps that same sequence for the CLI, adding a
version check against the server's git sha, embedded-space validation, and the
error-log, navigate, and JSON-console wiring a one-shot verb wants. A shell
pays the sequence once at connect; `cf` pays it per invocation.

The ambient record maps onto the config shapes those functions already
take: `SpaceConfig` (`apiUrl`, `space`, `identity`, …) and `PieceConfig`
(adding `piece`, `pieceScope`, `piecePath`, `pieceInput`) in
`packages/cli/lib/piece.ts`. `cf` builds them from flags through
`parseSpaceOptions`, `parsePieceOptions`, and `readTargetPositionals`
(`packages/cli/commands/piece.ts`); shuttle constructs them from the
ambient record directly and skips the flag parsing.

The connection pushes. The `remoteClient` runtime preset opens a persistent
`WebSocketTransport` (`packages/runner/src/storage/v2-remote-session.ts`), so
a write landing on the server from anywhere reaches this process's cells and
re-fires their sinks. `watch` needs no polling.

Two existing long-lived holders show the lifecycle discipline:

- `packages/cf-harness`: `createHarnessFabricSessionFactory` builds one
  controller and `cacheHarnessFabricSessionFactory` memoizes it so every
  invocation of a run shares it. Its cache clears on a **rejected
  construction** and nothing else — the `session === attempt` test guards
  against evicting a newer attempt, and is not a health probe — so it
  covers the connection that never opened, not one that later drops.
- `packages/fuse`: `CellBridge` takes an injectable `PiecesLoader` plus a
  separate `reconnectPiecesLoader` for recovery.

`initialize` health-checks the server before it returns, so the first
connection is proven live on the way up. What a long-lived process gives up is
the repetition: `loadPieces` re-proves liveness on every verb, and a shell
asks once.

## Recovery already exists

An established connection heals below shuttle, in the memory client
(`packages/memory/v2/client.ts`) rather than the storage layer above it:

- `Client.#onClose` marks the client disconnected, calls
  `handleDisconnect()` on every `SpaceSession`, rejects in-flight requests
  as `ConnectionError`, and starts `Client.#reconnect()` — a
  single-flighted loop that re-runs `#hello()` and then `restore()`s each
  session, backing off through `reconnectDelayMs` (25 ms base, 30 s cap,
  jittered).
- Standing watches survive it. `SpaceSession` remembers its selectors in
  `#watchSpecs`; `restore()` applies the server's `sync` when the server
  resumed the session and re-arms through `watchSetSync(#watchSpecs, …)`
  when it did not. Both paths reuse the same `WatchView` instance, which is
  what keeps `SpaceReplica.#consumeWatchView`'s standing loop delivering.
  Outstanding commits replay through `#outstandingCommits`.
- `SpaceReplica` deliberately does nothing on a drop, and says so:
  `#consumeOwedSessionRemount` records that a transport drop is already
  healed by the client's own `reconnect()`/`restore()` and must be left
  alone.

One near-miss worth pinning: `Provider.#syncRequests` and `#replaySync`
(`packages/runner/src/storage/v2.ts`) look like this replay but fire only
on route replacement — the reconnect replay is `SpaceSession`'s, above.

Two gaps around it. **Initial** construction is not retried —
`SpaceReplica.sessionHandle()` clears its memo on failure and re-attempts
only when a caller next asks for a session, which is the case cf-harness's
cache exists for. And a **permanent** failure stops the loop rather than
retrying: `isPermanentConnectionFailure` (a protocol-flag mismatch) sets
`Client.#fatalError`, while `isPermanentAuthorizationError` routes a
non-retriable denial to `#terminateSession` for that one space, leaving the
client's other spaces alive.

Shuttle therefore adds no recovery of its own. The repo's rule against retry
loops applies with particular force here: the loop that belongs in this
system already exists one layer down, and a second one would fight it.

## Observing connection state

What shuttle does need is unavailable today. The prompt's live marker and
the views' reconnecting marker both want connection state, and nothing in
the storage layer reports it:

- `Client.isConnected()` exists but reaches no consumer — `SpaceReplica`
  holds the client in a private field and surfaces nothing from it.
- The notification channel carries no connection variant.
  `IStorageNotificationCapability.subscribe` delivers commit, revert, load,
  pull, integrate, and reset notifications only.
- `IStorageManager.authorizationError(space)` is the one connection-adjacent
  state a consumer can read, and it is a per-space poll for permanent
  denial. Its own documentation records a hole: a denial that arrives during
  reconnect is visible only as the session's `closeError`.
- Nothing exposes "reconnecting" at all. `Client.#reconnecting`,
  `#connected`, and `#fatalError` are private with no accessor, and
  `#onClose` swallows the reconnect promise, so a consumer cannot tell quiet
  because nothing changed from quiet because the socket is down and backoff
  has reached its thirty-second cap.

So the liveness work is an **observation seam**, added where the state
already lives, reporting live, reconnecting, and permanently failed. That is
what B1 owes, and the three states are what the prompt and the view markers
render.

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
  `PieceCallableDependencies`), `readWish`, `runExec`, all of
  `lib/bulk.ts` — and the write path: `stepPiece`, `setCellValue`,
  `removePiece`, `linkPieces`, `renderPiece`, `callPieceHandler`,
  `getPieceView`, and the `lib/acl.ts` loaders. `stepPiece` gained the seam
  with its write receipt (#6556), and its unit test is the template the
  rest of the list follows. A supplied connection is the caller's to close,
  so `withAcl` disposes only a runtime it opened itself.
- **Hardcode `loadPieces`:** `setPieceSlug`, `savePiecePattern`,
  `applyPieceInput`, `linkSqliteDiskSource`, `resetHomePattern`, and
  `commands/deps.ts`. Each opens a fresh runtime and WebSocket per call. No
  shuttle-v1 verb reaches one, so each is a conversion for the milestone
  that first calls it.

`call` has the family's shape too, in `callFromCommand`
(`commands/piece.ts`). Cliffy splits an invocation into the two arrays it
holds on the command object bound as an action's `this` — this command's
own arguments, the line past `cf call` (`getRawArgs`), which a grammar
refusal reprints after prepending that prefix itself, and the words past
`--` (`getLiteralArgs`), which the read step parses — so both are
parameters of the named export, beside the mount's spelling, and the action
is the two reads that hand them on. The constituents underneath are
exported and library-grade (`executePieceCallable`, `pieceCallRawArgs`,
`pieceCallInvocation`, `resolveInvocationIdentity`,
`pieceCallPhaseObserver`, `resolveWaitControl`, `parsePieceCallSelection`,
`boundedSettlement`, `renderPieceCallOutcome`). Its deps bag holds
collaborators only — the `render`/`hint` sinks and the dispatch itself —
so a caller holding a connection passes an `executePieceCallable` bound to
it rather than opening one per call.

## Prerequisite work in `packages/cli`

Each of these is small and lands on its own; together they are what decision
9's "factor the seam in `cli`, not reimplement in shuttle" means concretely.

1. **Export entries.** Done. `@commonfabric/cli` carries an entry for each
   lib module a sibling calls, beside `.` → `mod.ts`, whose import runs CLI
   startup.
2. **Thread `deps.loadPieces` through the functions that still hardcode
   it.** Everything a shuttle-v1 verb reaches takes it; what is left is the
   set the inventory above names, each converting for the milestone that
   first calls it.
3. **`callFromCommand`.** Done. `buildCallCommand`'s action reads the two
   argv arrays off the command bound to it and hands them on; everything
   below that line is the named export, which needs no binding.
4. **Exit discipline.** Done. `exitWithDataError` and `exitPieceCallFailure`
   default to `Deno.exit(1)` (typed `never`) and take a `deps` override in
   its place, which the seams a v1 verb reaches forward:
   `getCellValueFromCommand` on a data error, and `callFromCommand` at each
   of its three exits. Shuttle's shim therefore throws rather than returns —
   what an `exit` typed `never` requires — and shuttle catches it beside the
   `ValidationError` that `exitPieceCallFailure` rethrows for Cliffy's usage
   rendering. `callFromCommand` reports its payload rejection from inside
   the dispatch's promise chain, so it records that an exit ran and rethrows
   rather than describing the shim's own throw as a second failure.
5. **Output capture.** What a caller captures today is the seam's own
   output: for every seam a v1 verb reaches, the value or page goes to
   `render`, the next steps to `hint`, and a failure's report to
   `printError`. What the seam prints, the caller decides where.

   Three streams reach the process's stderr regardless, and a caller
   holding one of its own cannot redirect them. The **write receipt**,
   `noteWroteTo` (`lib/write-receipt.ts`), which `set`, `link` and `call`
   all reach: it wants a sink of its own rather than the hint stream,
   because `--quiet` deliberately does not silence it, and a memo per
   connection rather than per process, which is item 6's subject. The
   **invocation announcement** and the **`--verbose` span stream** from
   `callFromCommand`: each names a fact about this process — the pair to
   retry with, the wall clock — rather than the call's outcome, so
   neither is the failure report `printError` carries, and capturing them
   wants a sink named for what they are.

   The `console.error` calls in `lib/piece.ts` are outside a v1 verb's
   path or outside a seam's reach. The navigate wiring sits inside
   `loadPieces`, which takes a config and no deps; the pin-rewrite report
   belongs to `piece new` and to `setsrc` either side of `--check`, and
   the inspect warning to `piece map`. The phase trace wraps operations
   throughout the module, `linkPieces` among them, but writes nothing
   unless `CF_CLI_TRACE_TIMINGS=1` asks it to.

   Sweep each as views need it captured.
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
