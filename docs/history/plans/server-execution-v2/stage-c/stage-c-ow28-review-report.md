---
status: historical
created: 2026-08-17
archived: 2026-08-18
reason: "Stage-C evidence: the adversarial review of #5968 (compile-and-run served as an outbox effect, OW28) with the author's resolutions; the coordinator-round independent review is the PR's ledger comment."
---

# Adversarial review — stage C / OW28: `compile-and-run` served as an outbox effect

Scope: `git diff --cached` in `/Users/berni/labs-worktrees/stage-c-ow28`.
Files reviewed in depth: `packages/runner/src/builtins/compile-and-run.ts`,
`packages/runner/src/pattern-manager.ts`, both test files, and the supporting
machinery they lean on (`executor/outbox.ts`, `executor/effect-completion.ts`,
`executor/space-server.ts`, `builtins/fetch.ts` as the proven sibling, `cell.ts`
`send/set`, `create-ref.ts`).

Both source files and both test files pass `deno check --no-lock`.

Severity legend: BLOCKER / MAJOR / MINOR / NIT.

---

## MAJOR-1 — A same-hash request stuck in `pending=true` has no re-issue path on the current runtime; it recompiles only after the space re-activates on a fresh runtime

**Files:** `packages/runner/src/builtins/compile-and-run.ts:329` (hit rule),
`:439-442` (needIssue), `:581-590` (success re-arm), `performServedCompile`
`:544-556` (throw on completion-commit failure); `executor/outbox.ts:411-446`
(a rejected completion counts `outbox.failed`, no retry);
`executor/space-server.ts:1298-1303` (a completion arriving while parked is
REFUSED as `StorageTransactionAborted`).

**Defect.** The two gates that govern progress are:

- hit: `if (stored === hash && currentlyPending === false)` — requires `pending===false`.
- (re)issue: `const needIssue = reissue || (currentlyPending !== true && errorT===undefined && resultT===undefined)` — with `reissue = stored !== hash`.

So a request in the state `stored === hash && pending === true && compile-cache
cold` satisfies neither: the hit rule is blocked by `pending===true`, and
`needIssue` is `false || (true !== true && …) === false` → the action returns at
`:442` and does nothing. Nothing re-enqueues the compile effect.

That state is reachable WITHOUT a crash. `performServedCompile` throws whenever
the completion commit returns `written.error` (`:550`, `:569`, `:586`). The most
ordinary cause is a park during a slow compile: `#commitEffectCompletion` refuses
the completion with `StorageTransactionAborted` (`space-server.ts:1298`), the
throw makes the tracked work reject, the outbox counts `outbox.failed`
(`outbox.ts:432`) and — by design — never retries (no timers). The derivation is
never re-armed (the `compiledHash` write never lands), so on the current runtime
the node is not dirtied and never re-runs; `pending=true` stands. Even if some
unrelated tracked read later dirties the node, it re-runs against a WARM
`internal` (already synced, `stored===hash`) with `pending===true` and a cold
compile cache → `needIssue` is still false → still stuck.

The design's own escape hatch is the "fresh runtime re-miss" documented at
`:210-214` and `:31-33`: a fresh runtime reads the unlinked `internal` memo cell
UNSYNCED on its first evaluation, so `stored` reads `undefined`, `reissue=true`,
and the compile re-issues. That genuinely covers park→re-activate (the fresh
loopback replica is cold). But it does NOT cover the current runtime: once
`internal` is synced (`stored===hash`) and `pending===true`, there is no
re-issue. A piece therefore hangs "loading" from any transient completion-commit
failure until the space next re-activates on a fresh runtime — which, if the
space stays warm (live demand, periodic activity), may not happen for a long
time, or at all.

Contrast the proven sibling, `fetch.ts:507-509,640`: fetch gates re-issue on an
IN-MEMORY claim id, `alreadyFetching = inputsMatch && currentPending &&
myRequestId !== undefined`. `myRequestId` is a closure variable, so on ANY
runtime that does not itself hold the in-memory claim (warm or cold) fetch
re-issues even when `pending===true`. `compile-and-run` dropped that guard and
trusts the durable `pending` + `internal` alone, which is exactly what wedges it.

**Why the invariant claim is actually false.** The comment at `:326-328` asserts
"every path that ends a request writes `pending=false` in the SAME transaction
that (re-)asserts `requestHash`." The init `pending.send(false)` at
`compile-and-run.ts:172` violates it: on a fresh runtime it stages `pending=false`
WITHOUT touching `internal`, so a persisted in-flight `internal={requestHash:H}`
plus the init false-write is a `pending=false` state carrying a `requestHash`
that names an UNRESOLVED request. Today that is masked only because `internal` is
unlinked and thus reads unsynced on the fresh-runtime first eval (so `stored`
reads `undefined` and the false-hit is dodged in favor of a re-miss). The
correctness of recovery rests on that implicit, undocumented ordering — see
NIT-8.

**Suggested fix.** Give the served arm an explicit in-memory in-flight guard
analogous to fetch's `myRequestId`: track "this closure has an effect in flight
for hash H" in a closure variable, and make `needIssue` true when `pending===true
&& stored===hash && cache-miss && !inFlightInThisClosure`. That re-issues a
stuck-pending same-hash request on the current runtime (the effect having failed
or been dropped) without waiting for a park, matching the outbox's stated
"memo re-miss re-fires" contract. Clear the guard when the completion re-arms or
when inputs change.

**Test gap.** No test drives a failed/park-refused completion. The E2E recovery
leg (`executor-compile-and-run.test.ts:320-353`) parks only AFTER a successful
landing (answer=7, `pending=false`, durable child pointer), so it exercises
memo-hit resume, never the stuck-pending path. A regression here passes CI.

---

## MINOR-2 — The flag-ON CLIENT writes `pending`/`error`/`errors`/`internal` for the synchronous invalid-inputs and main-not-found cases, contradicting "writes nothing speculatively / pure read-through"

**File:** `packages/runner/src/builtins/compile-and-run.ts:355-384` (both branches
run BEFORE the `if (!runtime.servingPosture) return;` read-through gate at `:396`).

**Defect.** The design context and the doc (`builtins.md` §3 add; the review
prompt's item 3) state the client "never compiles and writes NOTHING
speculatively — pure read-through." That holds for a VALID program (the client
falls through to the servingPosture gate at `:396` and returns without writing).
But for invalid inputs (`:360-367`) and main-not-found (`:374-382`) the client
executes `runtime.runner.stop(result)`, `ctx.abort()`, and writes
`result/error/errors/pending` + `internal.set({requestHash: hash})`. The
`internal` cell is created and synced for the client too (`:209` gate is `on ===
serverExecution === true`, which the client satisfies). So the client DOES touch
the memo cell and the output cells for these synchronous outcomes.

Under real client speculation these seal into the process-only overlay and match
the server's deterministic outcome, so it is not a correctness hazard. But (a) the
"writes nothing speculatively" claim is overstated, and (b) a flag-ON client
whose derivation tx is NOT overlay-intercepted (e.g. a non-stamped run, as in the
bare-runtime tests) would durably commit these. The client can instead read
through the hit rule once the server lands the same deterministic outcome, so the
write is unnecessary.

**Suggested fix.** Gate the WRITES in the invalid-inputs and main-not-found
branches on `runtime.servingPosture` (leave the reads/early-returns), so the
client truly reads through for every case, not only the valid-program case. Add a
client-posture unit assertion with an invalid program and a main-not-found
program (currently only PROGRAM_A is tested for the client, which returns before
any write).

---

## MINOR-3 — Compile-cache eviction between the effect and the re-arm run wedges the request (same mechanism as MAJOR-1, eviction-triggered)

**Files:** `compile-and-run.ts:404-408` (sync lookup), `:439-442` (needIssue);
`pattern-manager.ts:70,2135` (`MAX_EVALUATED_MODULE_CACHE_SIZE = 1000`, FIFO evict).

**Defect.** The re-arm run reaches the instantiate branch only if
`getCompiledPatternForProgramSync(plainProgram)` still hits `compiledByContent`.
If ≥1000 distinct programs are compiled between the effect's compile
(`:521`) and the re-arm run, the FIFO cache evicts this entry; the re-arm run then
sees `compiled === undefined`, and with `pending===true` + `reissue===false`,
`needIssue===false` → return → wedge. Rare (needs >1000 distinct programs in the
window), but it is the same "no re-issue for a stuck-pending same-hash request"
hole as MAJOR-1 and would be closed by the same fix.

---

## MINOR-4 — The gate moved from `waveRunContextOf(tx)` to `runtime.servingPosture`; confirm the served action only ever runs inside a wave-stamped tx on the serving runtime

**File:** `packages/runner/src/builtins/compile-and-run.ts:396` (was, at HEAD
`:221-224`, `experimental.serverExecution === true && waveRunContextOf(tx) ===
undefined`).

**Observation.** The old gate keyed on the tx being a wave run; the new one keys
on the runtime being the SpaceServer. These are not equivalent. If the serving
runtime ever evaluates this action inside a NON-wave tx (a bookkeeping/teardown
run, or an `ensurePieceRunning` setup tx), the served path would run
`enqueuePostCommitEffect` / `runtime.run(tx, …)` / cell writes against a tx that
is not sealed into a wave, where the outbox admit + completion-routing
assumptions (`outbox.ts:333`, `space-server.ts:866`) do not hold. In the wave
loop this is presumably always a wave tx, so this is likely fine — but it is a
real broadening of the precondition and worth an assertion or a comment pinning
it. Low confidence; flag for author confirmation.

---

## NIT-5 — `stampWaveRunContext` in the unit test is vestigial scaffolding

**File:** `packages/runner/test/compile-and-run.test.ts` (`run`/`rerun` stamp the
tx via `stampWaveRunContext` when `served`).

The ON arm no longer reads `waveRunContextOf(tx)` (MINOR-4); it gates on
`runtime.servingPosture`, set at runtime construction (`newOnRuntime`). So the
`served` option and its wave-stamping do not influence which path runs in these
bare-runtime pins — `servingPosture: true` alone does. Harmless, but the naming
("served" via stamping) implies wave-stamping is the gate, which it is not.
Consider dropping the stamp or renaming to avoid implying a contract that no
longer exists.

---

## NIT-6 — Recovery/failure coverage gap (restates the untested surface behind MAJOR-1)

The E2E asserts the strong contracts well (client never compiles —
`executor-compile-and-run.test.ts:239,262,416`; `unstampedSealRefusals === 0` —
`:287,418`; child VALUE updates on a program change, answer 42→7→99). What is
NOT exercised anywhere: a completion that fails/refuses to commit (park during
compile), and a mid-compile park→re-activate. Those are precisely the paths
MAJOR-1 lives in. Add a pin that parks the space WHILE a compile is in flight
(before the completion lands) and asserts the request eventually resolves after
re-activation.

---

## NIT-7 — `internal` memo cell is not linked to the parent/pattern cell (diverges from fetch), and recovery silently depends on that

**Files:** `compile-and-run.ts:209-223` vs `fetch.ts:405-417`
(`setResultCell(internal, parentCell)` + `setPatternCell(internal, …)`).

fetch links its `internal` cell into the piece's result/pattern graph;
`compile-and-run` only `internal.sync()`s it. Reads still work (it is addressed by
a deterministic cause id), so this is not itself a defect. But the recovery
re-issue in MAJOR-1's "fresh-runtime re-miss" relies on `internal` NOT being
preloaded by `ensurePieceRunning` (so the first eval reads it unsynced and
re-misses). That dependency is undocumented. If a future change links `internal`
(to match fetch) and it becomes preloaded on activation, the fresh-runtime read
would return `stored===hash` and recovery would flip from "re-miss/recompile" to
"stuck" (or false-hit). Please add a comment stating that `internal` MUST remain
unlinked for the recovery re-miss to hold — or, better, implement the explicit
in-memory guard from MAJOR-1 so recovery no longer rides an implicit sync-ordering
accident.

---

## Things checked and found SOUND (for the record)

- **OFF-arm neutrality.** `compileAndRunOff` is behaviorally identical to the HEAD
  builtin. The one removed line — the Phase-2 gate `if (serverExecution === true
  && waveRunContextOf(tx) === undefined) return;` — was flag-ON-only, so it never
  fired in the OFF arm; its removal is inert for flag-off runtimes. Operation
  order (abort→new controller→requestId→`runner.stop`→clear→pending), the
  `previousCallHash` dedupe, `thisRequestId` supersession checks,
  `runSynced`+`isHidden`+`pieceCreatedCallback` timing all match. The `internal`
  cell and `internal.sync()` are correctly gated on `on`, so the OFF arm touches
  no new cell. `hasValidInputs` gained a `!!` (boolean coercion) — behaviorally
  identical in the boolean contexts it is used in.
- **Completion marking.** Every writeback in `performServedCompile` calls
  `markEffectCompletion(tx, effectKey)` FIRST inside the `editWithRetry` callback
  (`:530,546? ,564,582`), including before the `stillCurrent` early-returns, so a
  superseded completion still stamps the tx (no unstamped seal refusal). No
  writeback path is unmarked. `effectKey = effectTargetKey('compileAndRun:'+hash,
  result)` is captured once and used identically at enqueue (`:450,455`) and in
  every completion, and the outbox dedupe key is `idempotencyKey ?? id` = the same
  scoped key.
- **Supersession.** `stillCurrent` re-reads the current inputs through the
  completion tx and compares `hashOf(proxy)` to `hash`; combined with the captured
  `signal` (aborted by any later `ctx.abort()`), a superseded request writes
  nothing but the marker. The `needIssue` guard correctly does NOT abort or
  re-enqueue a same-hash in-flight re-run (the "re-compile-forever" bug the comment
  at `:430-438` warns about): such a run returns at `:442` before `ctx.abort()`.
- **Hit-rule / client hook.** The client fires `pieceCreatedCallback` once per
  landed successful hash (`reportCreated` dedupe), gated off for error/errors
  results (`:336-341`) and for the server (no callback installed). Every terminal
  DERIVATION path (invalid, main-not-found, instantiate) and every terminal
  COMPLETION path (compile failure, no-pattern) co-writes `pending=false` with
  `internal.requestHash` in one tx — the success re-arm is deliberately non-terminal
  (`pending` stays true until the instantiate run), which is consistent. (The one
  exception to the co-write invariant is the init `pending.send(false)`; see
  MAJOR-1.)
- **`plainProgramOf`.** The `compile-and-run` builtin only ever sees `{files, main}`
  (its `asSchema` schema exposes nothing else), so dropping `RuntimeProgram`'s
  `mainExport`/`sourceRoots` is moot here; `Source` is exactly `{name, contents}`,
  which `plainProgramOf` preserves. The normalization rationale is correct:
  `createRef` dereferences a query-result proxy to the underlying (shared input)
  cell's id — insensitive to nested `contents` — whereas on the plain object it
  descends into the actual `contents` strings (`create-ref.ts:156-160,181-185`).
  The compile (`requestProgram = plainProgram`) and the sync lookup
  (`getCompiledPatternForProgramSync(plainProgram)`) both key on the same plain
  form, so the cache keys agree; request IDENTITY (`hash`) stays proxy-based and
  consistent on both sides (`:230`, `stillCurrent :515`).
- **Async tracking / leaks.** `trackAsyncWork(work, parentCell)` runs in the
  flush's synchronous prefix, so the outbox captures it (`outbox.ts:408-424`); no
  abort controller accumulates (single closure var, replaced on each `ctx.abort`).
  The `waveRunContextOf` import is fully removed and unreferenced; no unused import
  remains.

---

# Author resolutions (2026-08-17)

Context: the review ran against the diff as STAGED at launch time; the
`resolvedHash` refactor (which closes MAJOR-1's "the invariant is false —
init `pending.send(false)`" observation) landed in the working tree after
staging. Every finding below is addressed in the final tree; the pins named
are mutation-verified where stated (mutant → red).

- **MAJOR-1 — stuck-pending same-hash request.** RESOLVED in three parts.
  (a) The false-hit hazard is closed at the root: the §4 hit keys on a
  `resolvedHash` RESOLUTION marker (set on every terminal outcome), never
  on `pending` — so the init clobber cannot manufacture a landed request.
  (b) The park / crash / dropped-or-refused-completion cases (the review's
  "most ordinary cause") all END the serving runtime; the fresh runtime's
  first evaluation re-fires (init clobbers `pending=false` → `needIssue`).
  Pinned: `compile-and-run.test.ts` "recovery mid-flight" (seeded durable
  issued state, fresh closure re-fires; mutant pending-based hit → red) and
  LIVE in `executor-compile-and-run.test.ts` "MID-COMPILE park" (the first
  serving runtime's compile is held, the space parks mid-compile, the fresh
  runtime resolves it; the mutant produces exactly the wedge signature
  `pending=false, answer=undefined` → red). (c) The residual — a completion
  commit that FAILS on a LIVE runtime that did NOT park — is the
  request-hash builtins' identical posture (fetch's in-memory `myRequestId`
  claim also blocks re-issue until re-activation or an input change:
  "recovery is §6's re-miss on the next activation, or an input change").
  NOT filled with a dirtiness-driven retry (an unstated semantic; a
  re-issue loop on deterministic failures); stated in code + docs + Flags.
- **MINOR-2 — client writes for sync outcomes.** FIXED: the client
  read-through gate now sits directly after the hit rule, so the client
  writes NOTHING for any outcome (invalid inputs / main-not-found included
  — the server decides them identically and lands committed cells the hit
  rule reads through). Pinned in the client read-through unit test (both
  sync outcomes: no error/memo/pending write, 0 compiles; mutant gate moved
  back → red).
- **MINOR-3 — cache eviction between re-arm and instantiate.** FIXED:
  `needIssue` re-fires when `compiledHash === hash` but the process cache
  misses (the re-arm landed, the entry was evicted) — recompile → re-arm →
  instantiate, never a wedge. Pinned (white-box cache clear; mutant → red).
- **MINOR-4 — `waveRunContextOf` → `servingPosture`.** Documented at the
  gate: every scheduler run on the serving runtime is wave-stamped by the
  SpaceServer's stamper; an unstamped serving-runtime run refuses LOUDLY at
  the seal (§3d, `unstampedSealRefusals`), never silently mis-routes — and
  the E2E pins that counter at ZERO across every served leg (both steps).
  No silent gate added (a silent no-op would hide what the loud refusal
  surfaces).
- **NIT-5 — vestigial wave stamping in the unit tests.** REMOVED; the
  posture is the runtime's (`servingPosture`), stated in the helper's doc.
- **NIT-6 — recovery/failure coverage.** ADDED: the live mid-compile-park
  step (above) plus the unit recovery-mid-flight and eviction pins.
- **NIT-7 — `internal` unlinked; recovery rode the unsynced first read.**
  No longer true: with `resolvedHash` the recovery re-issue rides the init
  `pending` clobber, and the hit rule cannot false-fire on a synced-but-
  unresolved memo. `internal` staying unlinked (unlike fetch) is now only a
  first-eval at-least-once cost (T10.Q4), not a correctness dependency —
  recorded as an observation in the PR's Flags.
