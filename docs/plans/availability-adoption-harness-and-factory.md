# Availability adoption: cf-harness and pattern-factory

Working notes, owner @gideonwald. Written 2026-07-14 against labs PR
[#4677](https://github.com/commontoolsinc/labs/pull/4677) (explicit unavailable
data flow) and review
[#4688008874](https://github.com/commontoolsinc/labs/pull/4677#pullrequestreview-4688008874).
Model reference: `docs/specs/data-unavailability.md` (on the PR branch until
merge).

## Background

PR #4677 replaces the `.result` / `.pending` / `.error` triple on the
single-result async built-ins with `AsyncResult<T> = T | DataUnavailable`
(four reasons: `pending`, `error`, `syncing`, `schema-mismatch`). The runner
skips a computation whose inputs carry an unaccepted marker and propagates the
marker to its output; guards (`isPending` / `hasError` / `isSyncing` /
`hasSchemaMismatch`) compile into serialized exact-path policy; `resultOf()`
is a pure static projection; handler events with unavailable captured inputs
park at the head of the event queue until the inputs change.

Two of my projects sit directly on top of this model and need deliberate
adaptation rather than incidental fixes. This doc records the implications and
the work items so they survive the review cycle.

## Part 1 — cf-harness

**The contract shift: "settled" and "usable" have come apart.** Pre-#4677,
awaiting quiescence and then reading outputs was a complete test protocol —
if the scheduler was idle, absence looked like `undefined` and data was as
good as it was going to get. Now there are three distinct quiescent states:

1. usable data;
2. *settled-at-marker* — a pending/error marker persisted in an output cell
   with no local work scheduled (legal and common: awaiting external HTTP, a
   terminal producer error);
3. *parked-head* — the event queue blocked on a handler whose captured inputs
   are unavailable.

Work items, in dependency order:

- **H1. Click-while-pending regression pin (e2e).** Pattern with `fetchJson`
  plus a handler capturing `resultOf(request)`; transport mock that resolves
  after a delay; dispatch the handler's event during pending; assert with a
  deadline that (a) the result cell transitions to the value and (b) the
  event eventually dispatches. History: the original review flagged a
  structural deadlock here (parked head held `idle()` open while producer
  writebacks awaited `idle()`); the scheduler-v2 restructure resolved it —
  the idle-holding set in `scheduler/continuation.ts` now excludes
  input-parked heads. The liveness property is currently protected only by
  that structure; nothing pins it end-to-end. This test is the pin, and it
  hangs rather than fails on regression — hence H2.
- **H2. `dumpAvailabilityState(runtime)` diagnostic.** On-demand dump of:
  event queue depth, the head's parked-wait deps (which cell, which reason),
  in-flight producer state, and the missing-doc load table. Wire it into the
  harness's on-timeout path so every future hang in CI is a one-glance
  diagnosis. This doubles as the prototype for the long-park telemetry
  requested in the review (pull-events comment).
- **H3. Status-bearing reads + assertion vocabulary.** Markers make read-path
  divergence concrete: `Cell.get()` on a marker returns `undefined`
  (masking — a test asserting "no value yet" passes for the wrong reason,
  including when the true state is a terminal *error*); `getRaw()` returns
  the opaque instance; the honest read (`getCellWithStatus`) is deliberately
  runner-internal. The harness needs a sanctioned status-bearing accessor
  (blessed runner export for tests, or helpers over `getRaw` + the data-model
  guards), and on top of it: `awaitUsable(cell, {timeout})` (the new "await
  the result"), `expectUnavailable(cell, reason?)`, and eventually-style
  matchers that tolerate legal multi-hop transitions — the runner's own
  parking test exercises pending → syncing → value, so single-transition
  assertions are flake generators. This is the CT-1811 lesson (harness must
  read the way the runtime reads) with a third read path added.
- **H4. Mock at the transport, never the builtin.** The fetch/LLM state
  machines are now genuinely stateful: pending published under a mutex claim,
  `requestId` ownership CAS on writes, lease-expiry reclaim on resume,
  legacy-state reconciliation on load, same-transaction stale-result
  replacement. A mock that impersonates the builtin must re-implement all of
  that or it *is* the next harness/runtime divergence. Mock the HTTP/provider
  layer and let the real builtin run (H1 requires this anyway).
- **H5. Fixture regeneration pass.** Persisted old-style triples are upgraded
  in place by the legacy reconcilers on first load; snapshot-based tests will
  see rewrites on contact. Plan one regeneration pass rather than chasing
  per-test diffs.
- **H6. Timeout hygiene as default posture.** Hangs-not-failures become the
  dominant failure mode for this bug class. Per-test deadlines with the H2
  dump on expiry should be harness defaults, not opt-in.

## Part 2 — pattern-factory

The factory is the widest distribution channel for this programming model —
and for its footguns. Four threads:

- **F1. Teach the two-API world as a table, not prose.**
  `fetchBinary/fetchText/fetchJson/fetchJsonUnchecked/fetchProgram`,
  `generateText`, `generateObject` → `AsyncResult<T>` direct.
  `compileAndRun`, `sqliteQuery`, `streamData`, `llmDialog`, `wish`, and
  `generateTextStream`/`generateObjectStream` → state objects (stream
  `.result` fields are themselves `AsyncResult`). Mixed idioms in one file
  are now *correct*; an LLM will "helpfully" normalize them in the wrong
  direction unless the per-builtin contract is explicit in the system prompt.
  Regenerate the few-shot corpus from the migrated repo patterns
  (`packages/patterns/examples/llm.tsx`, `examples/fetch-json.tsx`,
  `test-generateobject-error-handling.tsx` are the canonical exemplars).
  Cautionary tale: a reviewer agent running stale guidance flagged the PR's
  own canonical idiom (`resultOf` at pattern top level) as a bug during
  #4677's review.
- **F2. Idiom rules *with reasons* — the reasons are invisible in the code.**
  (a) Pair every request with a `resultOf` projection; use the house JSX
  chain `isPending(x) ? … : hasError(x) ? … : content`.
  (b) **Guard captured requests in handlers** — an unguarded unavailable
  capture defers the event and everything queued behind it; nothing in the
  visible code hints at this.
  (c) Never falsy-guard a projected result — the computation waits instead of
  falling back, so the guard is dead code; a fallback-while-loading must
  guard the *request*.
  (d) Structural marker lookalikes are inert — a generated
  `{reason: "pending"}` object never matches a guard; it fails silently.
- **F3. Compile-gate with the new diagnostics; lint the non-diagnostic
  hazards.** Run the CTS transform in the generation loop and feed the
  availability diagnostics (`availability:observation-inside-compute`,
  `availability:unobserved-compute-guard`,
  `availability:unsupported-guard-operand`) back for a self-repair round —
  they are precisely worded and actionable. Add factory-side lints for:
  falsy-guards on projections (F2c), hand-rolled `{pending, result, error}`
  shims (prefer exposing the request itself until a blessed boundary-status
  helper exists), and local names shadowing the guard imports
  (`isPending`/`hasError` collisions forced renames during the repo
  migration).
- **F4. Sequencing is a hard gate, not a preference.** Patterns compiled with
  the new transformer serialize `javascript-availability` modules, which fail
  closed on any runtime predating #4677 (by design). Deployment order is
  therefore fixed: upgrade every target runtime — toolshed, shell, the
  Loom-vendored labs snapshot (which lags by design), and the estuary homes —
  *before* the factory adopts the new compiler. Get the order wrong and every
  freshly generated pattern is dead on arrival at load. Hold the factory
  *release* (branch work can start now) until the review's open parking
  questions (terminal-error parking, schema-mismatch carve-out) have a
  resolution, since generated patterns lean handler-heavy.

New eval classes to add alongside: fallback-while-loading (generated pattern
needing a default-while-pending must use request guards, not falsy checks);
handler capture guarding; a both-status-and-value pattern (exercises
`resultOf` alias canonicalization); error rendering present (no
blank-marker UI).

## Sequencing across both

1. H1 + H2 while the review discussion is hot (H1 is the regression pin for
   the resolved deadlock; H2 leaves permanent infrastructure).
2. H3 read-path helpers and assertion vocabulary — everything else builds on
   them.
3. H5 opportunistically; H4/H6 as policy from now on.
4. F1–F3 in a factory branch now; F4 gates the release on runtime upgrades
   and the parking-policy resolution.

## Open review questions that feed back into this plan

- Terminal-`error` parking and the schema-mismatch carve-out (review comments
  on `runner.ts` / `pull-events.ts`): the outcome changes H3's assertion
  semantics and F2b's wording.
- Renderer story for propagated markers (review body item 3): the outcome
  changes F1's UI templates and the error-rendering eval.
- `latestComplete()` timing: until it lands, neither harness helpers nor
  factory templates have a sanctioned stale-while-revalidate idiom; expect
  hand-rolled "keep last" cells and lint for them later.
