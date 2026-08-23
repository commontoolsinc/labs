---
status: historical
created: 2026-08-22
archived: 2026-08-22
reason: "Fork memo for the owner (flag-don't-fill): the OW45 arm-B triage caught the whole-piece client read starvation live on an instrumented client (run b04) and root-caused it to the flag-ON client's navigate-deferred piece start dying terminally on a ConflictError — its basis read the piece's computed docs at seq 0 (pre-birth) while the serving side's derived commits were materializing them — with no retry arm (runner.ts's deferred-start commit error path cancels ownership and returns). The piece never starts client-side, its demand never registers, and every dependent read stays undefined for the session while the store is perfect. Three candidate dispositions with a recommendation; the sibling defects the same triage FIXED red-first (the walk's absent hop targets never re-fire on birth; the event drain's deferral arm letting later arrivals overtake) are recorded for scope."
---

# The OW45 arm-B client-start fork — who re-runs a client piece start that lost the first-hydration race?

## The charge

OW45 arm B (verification-coverage.md): at the true ON topology, the
default-app reload step's first-hydration create-then-read flow
starves — the client's `readCell` of freshly created served state
stays `undefined` through a 300 s event-driven wait while the store
holds every append (3/5 valid gate runs, two shapes: h01/h05 one
starved chain, h04 every read of the piece). Zero data loss; sticky
client-side unresolved reads. The candidate mechanism recorded in the
row — "a first read landing in the interim leaves the client cache
permanently undefined" — pointed at the read path. The instrumented
catch shows the sticky half is real but sits one layer up: not the
read, the piece START.

## The instrumented catch (run b04, 2026-08-22)

Bench: the gate harness re-run from the arm-B worktree with
`FORWARD_WORKER_CONSOLE=1 PIPE_CONSOLE=1` (the name-draft triage's
instrumented-client aid), fresh store per run, ON-built binary at
merged main (0c0261df3), port 9653. Run b04 red in the h04 whole-piece
shape: source diagnostics hold only the entity id; render diagnostics
`isNotebook: false, noteCount: -1, notesLength: 0` beside
`storedUiNoteChips: 98` — the piece ROOT doc is in the replica and
readable (the chip labels are literal strings in its value) while
every link hop off it reads `undefined`. The store: all 7 appends
durable, last commit one second after the last append, then a silent
300 s — server-side indistinguishable from a green run.

The forwarded worker console, notebook space, creation window:

- `22:39:09.954 [ERROR][runner] tx-commit-error Error committing
  deferred start transaction {"name":"ConflictError","message":"stale
  confirmed read: computed:fid1:1PlbDz… at seq 0 conflicted with seq
  10", …}` — the client's deferred piece-start transaction, whose
  confirmed reads name the piece's computed docs **at seq 0**: the
  start based on the PRE-BIRTH absence of the served piece's docs and
  raced the serving side's own materialization of them.
- `22:39:10.605 [WARN][runner.pattern-update] check-failed pattern
  update check failed` (same space).
- `22:39:22.788 [ERROR][runner] pattern-load-error Failed to load
  pattern keyless:fid1:6kLtQ…#default` — the notebook pattern's load
  failing downstream.
- Then nothing for the whole wait window. Zero `sync-load-failure`
  lines in the run — the swallowed-pull-error class (storage v2's
  deny/error/absent collapse) is EXCLUDED for this red.

## The code seat

`packages/runner/src/runner.ts`, the deferred-start commit's error
arm (~line 3453):

```text
startTx.commit().then(({ error }) => {
  if (error) {
    ownership.cancel();
    logger.error("tx-commit-error",
      "Error committing deferred start transaction", error);
    return;            // ← terminal: nothing re-runs the start
  }
  ...
```

A ConflictError here is the ordinary optimistic-concurrency outcome —
and at first hydration it is the EXPECTED outcome shape: the piece was
just born server-side, the serving loop's derived commits are always
in flight at that moment, so the client's start tx basis is stale by
construction whenever the interleaving is tight. The sequence is
install-then-rollback: `startWithTx` has already installed the
client-side piece inside the transaction when the commit's refusal
lands, and the error arm's `ownership.cancel()` tears that
just-installed context down — after which nothing re-attempts the
start, so the piece context is absent for the session and every read
that depends on it returns `undefined`. (The argument pre-sync at
runner.ts ~4072 is the separate RESUME path's; it is not what dies
here.) The load-coupled lottery (14 straight greens then 3/5 red at
equal nominal load) is the interleaving window widening under load.

The h01/h05 single-chain shape is the same die-off later in the start
walk (the start got far enough to register most demand before a
dependent load/commit died); rf2's old-shape stall (the
piece-structure read never resolving) is the same die-off at the
front. The pattern-load-error path (runner.ts ~2860) logs and stops
the same way.

Why this stays sticky: every client read of the missing docs is a
bare replica peek (CellGet → `cell.get()`), its sync kick is
selector-coalesced after the first pull, and the space goes QUIET
after the last append — the create-then-read flow ends with a write
followed by pure reads, so no later commit exists to wake anything.
Every heal path assumes a next input; first hydration has none.

## What the same triage already fixed (scope boundary, not this fork)

- **The walk's absent hop targets never re-fire on birth** (server):
  a graph walk that dead-ends on a link-hop target absent at
  evaluation recorded nothing for it, so the target's birth commit
  failed the wake pass's touched check and the watch never delivered
  it — while the client's selector tracker legitimately suppressed
  every re-pull. Fixed red-first as a MISS SET on the tracked graph
  state (wake-reactivity only, never delivered — the first cut rode
  the schema tracker and its wire markers broke the deliberate
  absence-confirmation flow, caught by list-resume-container-defer):
  `packages/runner/src/graph-query.ts`,
  `packages/memory/v2/query.ts`, `packages/memory/v2/server.ts` +
  `packages/memory/test/v2-watch-absent-arrival.test.ts`.
- **The event drain's deferral arm let later arrivals overtake**
  (server): a deferred sidecar's entries were skipped past, so a
  later-arrived event on a healthy sidecar consequenced first —
  run b01's store-verified inversion (`usedCreateAnotherNote` ending
  true after the final Create cleared it: a deferred Create-Another
  applied last), violating events.md §2's stated arrival order. Fixed
  red-first (global commit-seq order with deferral as a barrier):
  `packages/runner/src/executor/space-server.ts` +
  the arrival-order pin in
  `packages/runner/test/executor-events-down.test.ts`.

With those two landed, the client-start die-off is the REMAINING
member of the arm-B family, and the step's ON skip stays until it
closes (the 10/10 lift bar is unreachable while a per-run lottery can
kill the client's piece context).

## The fork — dispositions for the owner

The no-retry is entangled with a RULED design: the client's
navigate-deferred start under flag-ON deliberately LOSES the race to
the serving side's own deferred start (serving-loop.md §3d's
speculative-consequence stamp — "a client win would suppress the
served navigateTo"). Losing the RACE is designed; losing the WHOLE
client-side start is the defect. Candidates:

- **(a) Retry the deferred start on ConflictError.** On a
  stale-confirmed-read refusal specifically, re-mint the deferred
  start against fresh confirmed state (bounded retries; the ownership
  guard already dedupes installs). Smallest diff; keeps the client
  start authoritative for its client-side half. Risk: re-entrancy
  with navigation/disposal, and the §3d stamp's eventId context on a
  re-run needs care — the class this arc has burned on before
  (repairs that re-issue work).
- **(b) Adopt-not-start under ON.** A flag-ON client whose navigate
  lands on a piece the SERVER materialized does not run its own
  deferred start at all: it adopts the served instance (sync the
  root, register demand through the served closure) and starts
  nothing. Dissolves the race instead of retrying it — the
  serving-side start is the only starter, matching the ON execution
  model. The ground already exists in canon: runtime-mapping.md's N62
  row deleted the old observation-adoption feature precisely BECAUSE
  under the flag "clients no longer run committed derivations at all
  (reload is read-and-render, §3b)" — and serving-loop.md §3b states
  that posture ("committed, so client reload is read-and-render").
  (b) is that stated posture applied at the navigate/piece-open seam,
  where the client-side deferred start is a remnant still running
  against it — not a new mechanism.
  Larger change; touches the piece-open path for every ON navigate;
  the OFF arm keeps today's behavior.
- **(c) Heal-on-read.** Keep the start's failure terminal but make
  the READ side re-demand: a piece whose client context is absent
  re-attempts the start when a read reaches it (the S-C shape the
  OW45 root row SKIPPED by ruling for the home-profile half — that
  ruling's evidence was "the loss window is closed going forward",
  which this defect shows is not true for the notebook flow).

**Recommendation: (a) now, (b) as the model's destination.** (a) is
the honest bug fix at the seat that failed — a transient refusal must
not be terminal — and is shippable with a red-first pin (deterministic
conflict injection at the start tx). (b) is the shape the ON
execution model implies (one starter per piece, the server), belongs
with the Phase-7 flip work, and would retire (a)'s retry as dead code
— worth a row of its own rather than a rider here. (c) re-opens a
ruled disposition on evidence the ruling did not have; surface that
evidence to the owner rather than building against the ruling.

**RULED 2026-08-22 (owner Berni) — the recommendation is adopted as
stated.**

> ok, let's do (a) and record (b) as a post-flip task — owner,
> 2026-08-22

(a) is BUILT at the seat named above: a stale-confirmed-read refusal
of a commit-gated start earns a bounded re-attempt against fresh
confirmed state, every other refusal class stays terminal exactly as
it is today, and exhaustion keeps that terminal arm under a
distinctly-named log. (b) is RECORDED as a POST-FLIP task carrying
this memo as its design seed — verification-coverage.md **OW61**,
which also holds the pieces (b) needs before it can be built and its
duty to retire (a)'s retry when it lands. (c) stands as written: the
S-C ruling's closed-loss-window premise is disproven for the notebook
flow, recorded for the owner, and not built against.

## Residuals flagged beside the fork (recorded, not owed here)

- The scheduler-level event deferral (`outcome.kind === "deferred"`,
  post-queue) can still reorder consequences across streams — the
  drain barrier covers the drain's own arms only. Rare path
  (cold-piece loads); same contract sentence governs it.
- A failed consequence-notice seal re-drains its entry later with the
  same overtake window one seam down (seal-failure requeue).
- The emulated harness cannot represent asynchronous frame delivery
  (a sync that resolves while the view still lags), so the view-lag
  half of the drain barrier is pinned through its sync-failure
  sibling; the live ON gate is the view-lag half's bench (the OW47
  hydration fix set the precedent for this shape).
