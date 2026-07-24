---
status: historical
created: 2026-07-22
archived: 2026-07-22
reason: "Investigation of the three CLI piece-library timeouts; records why the tool-result poll was replaced event-driven and why the piece-start and sync bounds could not be removed at the CLI layer."
---

# CLI piece-library timeouts: which are removable, and why

The CLI's piece library carried three wall-clock waits that the repository's
engineering principles single out for removal — a poll, and two timeouts that
bound success:

1. `packages/cli/lib/callable.ts` — the tool-result wait polled the result cell
   every 25 milliseconds until a 15-second deadline, then threw a generic
   "timed out waiting for tool result".
2. `packages/cli/lib/piece.ts` `newPiece` — a 60-second bound races
   `pieces.create(...)` and rejects with "Piece created but failed to start
   within 60s".
3. `packages/cli/lib/utils.ts` `awaitSyncWithTimeout` — a 30-second bound wraps
   `storageManager.synced()` (used by `loadManager`, `acl.ts`, and `wish.ts`).

This document records what the runtime actually offers as an event-driven
completion or failure signal for each, so the choice of what to change is
traceable. The tool-result poll was replaced with an event-driven wait. The
other two bounds were left in place because the runtime surfaces no signal that
would let the CLI replace them without reintroducing a silent, diagnostic-free
hang.

## 1. Tool-result poll — replaced with an event-driven wait

The runtime does offer an authoritative completion signal for a tool run, so
the poll was removed.

- `runtime.run(tx, pattern, input, resultCell)` returns the result `Cell`
  (`packages/runner/src/runtime.ts` `run`). The existing code already subscribed
  to that cell's `sink`, which fires on the value's arrival, including a
  server-pushed writeback (`sinkHelper` re-subscribes the callback as a
  scheduler effect, `packages/runner/src/cell.ts`).
- `runtime.settled()` (`packages/runner/src/runtime.ts`) drains the runtime to
  full quiescence: scheduler idle, storage synced, and every in-flight async
  builtin — an LLM call, a fetch — awaited to completion. It is bounded by
  convergence rounds, not by a wall clock, and it awaits the async work rather
  than polling for it. It normalizes a failed builtin to "settled", so a broken
  tool converges rather than hanging.

The wait now commits the run, awaits `settled()`, and takes the sink-captured
value; if the sink reported nothing it reads the result cell once, and if that
is still empty it fails loudly — surfacing the pattern's own recorded runtime
error when there is one, and otherwise reporting that the tool produced no
result. This also fixes a real defect the 15-second ceiling caused: a
legitimate but slow tool (an LLM call longer than 15 seconds) was failed even
though it would have completed.

One residual dependency comes with this. `settled()` awaits every in-flight
async builtin, so a tool whose network builtin opens a connection that is
accepted but never answered — no response, no reset — leaves `settled()` waiting
with no wall-clock ceiling, where the old 15-second poll would have given up.
This is a liveness gap in the builtins — an LLM or fetch request carries no
request deadline of its own — not in the callable path, and it is shared by
every caller of `settled()` in the codebase: the runtime builtins and the CLI
test runner all trust it to complete. Bounding it belongs with the builtins'
request handling rather than a wall-clock guard re-added in the CLI, which would
once again bound success for a legitimately slow tool.

## 2. Piece-start bound — kept; no failure signal exists

`newPiece` → `pieces.create` → `runPersistent` → `startPiece`, which awaits
`runtime.start(piece)`, then `getResult(piece).pull()`, then `synced()`.

- The hang is in `getResult(piece).pull()`. `Cell.pull()` resolves inside
  `scheduler.idle().then(...)` (`packages/runner/src/cell.ts`), and `idle()` /
  `waitForQuiescence` parks the waiter without resolving while a lineage-head or
  load-parked-head event is outstanding
  (`packages/runner/src/scheduler/facade.ts`). A piece whose pattern never
  settles — a node stuck on an input or a load that never lands — leaves `idle()`
  parked, so `pull()` never resolves. `runtime.start` itself does not hang.
- A piece whose pattern *throws* does **not** hang: the scheduler catches the
  throw, marks the action run, `idle()` resolves, and `pull()` returns
  `undefined` while the error goes only to the error channel
  (`packages/runner/src/scheduler/run.ts`). That is the "silent error swallowing"
  half of the bug the bound originally addressed.
- A dispatched pattern error is not a reliable "start failed" signal. The
  reactive run path dispatches every non-`RetryImmediately` throw to the error
  handlers with no transient-versus-terminal classification
  (`packages/runner/src/scheduler/run.ts`); a transient throw — reading an input
  that is momentarily `undefined` — is dispatched to the same handlers yet
  recovers on a later pass. Rejecting the wait on "the first error for this
  piece" would reject runs that were going to succeed.

So the authoritative signal is success (the result cell's sink firing a defined
value); there is no authoritative per-piece failure event. On the success path
the wait is already event-driven — `pull()` resolves when the scheduler
quiesces. The 60-second bound is the only thing that converts the never-settle
hang into a message in an interactive CLI. It was kept, and its message now
carries the runtime error the pattern recorded while starting rather than only
pointing at the server logs.

## 3. Sync bound — kept; the failure is swallowed or retried forever

`storageManager.synced()` (`packages/runner/src/storage/v2.ts`) awaits its pull
and commit promises but never inspects their `Result.error`. On an
authorization failure — for example a client/server EXPERIMENTAL-option
mismatch — one of two things happens, and neither surfaces a usable signal:

- **Swallowed.** The pull path resolves its promise with an error that
  `toConnectionError` (`packages/runner/src/storage/v2.ts`) has already flattened
  from `AuthorizationError` to a generic `ConnectionError`, and `synced()` then
  discards the `Result.error` entirely. `synced()` resolves and the auth failure
  vanishes.
- **Retried forever.** If the failure manifests as a transport close or an auth
  failure during a reconnect, the memory client enters an unbounded
  `while (!this.#closed)` reconnect loop that retries on any error with no
  auth classification (`packages/memory/v2/client.ts` `reconnect`).
  `ensureConnected()` blocks every request on that loop, so `session.watchAddSync`
  never returns, the sync promise never settles, and `synced()` hangs.

There is no event-driven signal a `StorageManager` holder can subscribe to for
this failure: the storage notification union has no error variant, no telemetry
marker is emitted on the read/connect path, the inspector `PushState`/`PullState`
auth variants are not fed by the v2 storage manager, and the runtime
`errorHandlers` are the pattern-execution channel, not the session channel.
`healthCheck()` only probes `/_health` unauthenticated, so it does not pre-empt
the mismatch either. The 30-second bound is the only thing that converts the
hang into the actionable AuthorizationError message it prints today.

### Recommended follow-up (not done here)

Removing the sync bound honestly requires new plumbing in the foundation layer,
which also removes the retry loop the engineering principles call out:

1. Preserve the `AuthorizationError` name through `toConnectionError` instead of
   flattening it to `ConnectionError`.
2. Surface the pull `Result.error` from `synced()` (or a companion status API) so
   a caller can observe the failure.
3. Replace the unbounded `reconnect()` retry loop with an auth-classified break
   (or a session-error callback) so the hang path produces a settled, typed
   failure.

That change alters reconnection semantics for every memory client — shell,
toolshed, and the background piece service, not only the CLI — so it belongs in
its own reviewed change rather than bundled with the CLI cleanup.
