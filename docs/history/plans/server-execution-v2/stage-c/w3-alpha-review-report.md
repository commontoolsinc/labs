---
status: historical
created: 2026-08-19
reason: "Stage-C W3 (α) independent adversarial review of PR #6043 (server-execution v2): LANDABLE-WITH-FIXES, 1 BLOCKER / 2 MAJOR / 3 MINOR / 4 NIT. The BLOCKER (B1) is a LOST delivery in the same-eventId-sibling corner — a regression vs the W1 base introduced by the α1b/marking interaction — with a validated two-hunk fix. Verbatim reviewer deliverable; the fixes landed on-branch are recorded in w3-alpha-fix-report.md beside it."
---

# Independent adversarial review — PR #6043 (LABS), stage C build W3 (α)

Reviewer: independent (read-only — nothing pushed, nothing commented, no branch checked out, no stash).
Head `claude/server-exec-v2-w3-alpha` @ `4f2bda2d7` (the tip named in the brief; nothing newer). Base `claude/server-exec-v2-w1-dprime` @ `19c6448ab`.
Worktree `/Users/berni/labs-worktrees/review-w3` (detached). Every deno invocation `--no-lock`; suites foreground, ≤600 s per call; runner via the package task's flags (preload on; `executor-events-down` is in `realClockFiles`). Tree clean at the end (`git status --short` empty after every probe revert).

All file:line references are at `4f2bda2d7`. Every claim below that came from the PR body / build report / register was re-derived (code read, mutation run, or artifact inspected) before being relied on; the ones I could not re-derive are marked as such.

---

## 1. Verdict

**LANDABLE-WITH-FIXES — with one REQUIRED fix.** One finding meets the brief's BLOCKER definition (a refusal that LOSES a delivery, and it is a regression against the W1 base), but its trigger is narrow, its fix is two local hunks in `wave.ts` that I validated against the full file (18/18 steps green with two new probe pins), and nothing else in the diff is in that class. If the coordinator reads "BLOCKER present" as "NOT LANDABLE until fixed", then: NOT LANDABLE as-is; landable once F1+F2 (below) plus a sibling-shape pin land and OW35's wording carries the residual.

What the (α) seats get RIGHT (re-derived, mutation-killed, artifact-verified): the queued-leftover purge (α1), the late-seal refusal (α1b), the drain-self guard as (α2), the orphan refusal for derivation-superseded emitters (α3), the per-event run-count pins that count the NON-IDEMPOTENT effect (α4) — including the defense-in-depth claim (refusal off alone → effect still once); the lunch gate's vote-toggle class is closed and the W0 l1/l3 stores say exactly what the builder says they say. The l3 root cause (client cascade-echo stranding) is consistent with the store, the step timings, and the code at every link; I could not falsify it.

What is WRONG: the α1b refusal and the α3 orphan drop both assume the LT1 copy's handler tx is the ONLY same-eventId contribution of the event. It is not — the served `navigateTo` intent tx (`navigate-to.ts:213`) is a second event-handler-stamped tx carrying the same `eventId`, committed mid-run. When it seals into the appending wave and the handler tx does not, the existing batch-build marking (`survivedEventIds`, `wave.ts:2288–2296`) marks the entry consequenced on the strength of the sibling alone, the late handler tx is refused, and the drain never re-delivers — **zero completed runs of the handler's consequences** (probe P1: `counterC 0`, entry consequenced, `processed 1`; same probe on the W1 base: `counterC 1`). The α3 arm has the mirror gap: the sibling is not folded into the orphan drop, so the intent half of an orphan LANDS (probe P2: `side 1`, `seen ["rival"]`).

---

## 2. Findings by severity

### BLOCKER

**B1 — α1b + a same-eventId sibling tx = a LOST delivery (regression vs base).**
Seat: `space-server.ts:1077–1096` (the refusal) interacting with `wave.ts:2288–2296` (`survivedEventIds` admits ANY surviving event-handler contribution whose `eventId` matches; the seq-less LT1 entry is then marked `consequenced` in the batch clone, `wave.ts:2383–2391`).
Failing schedule: an LT1 cascade child with an ASYNC handler runs in its appending wave N; before its first await it commits a separate event-handler-stamped tx carrying its own `eventId` — in production exactly the served `navigateTo` intent tx (`navigate-to.ts:213` stamps `{kind: "event-handler", eventId: context.eventId, acting, scopeKeyIdentity}` on `intentTx` and `:304` commits it inline) — which seals into wave N; the handler then awaits past the 100 ms flush deadline (`DEFAULT_FLUSH_DEADLINE_MS`, `space-server.ts:203`). Wave N commits: the intent contribution survives → `survivedEventIds` has the child's id → the child's seq-less entry is marked consequenced. The handler tx seals later → `appending !== #currentWave` → refused (`lt1LateSealsRefused` 1). The drain scans: the entry is consequenced → never queued. The handler's writes never land.
Evidence: probe P1 (N4 below) on the tip: `{"counterC":0,"side":1,"childRuns":1,"entryConsequenced":true,"refused":1,"purged":0,"processed":1,"appended":1,"consequenceCommits":1}`; on the W1 base sources: `{"counterC":1,…,"consequenceCommits":2}` (the late copy committed unmarked in N+1 — delivered). A store-side per-event consequence count reads "1" in both worlds — it cannot see this loss; only the effect can.
Note: with the refusal OFF, α3's absent-emitter clause drops the late copy in N+1 (M2b) — so BOTH new seats convert this shape from "late but delivered" to "lost"; the root cause is the marking, not the refusal per se.
Fix shape (validated, F1): in the batch build, only the LT1 copy's OWN run may mark its seq-less entry — `survivedEventIds.add` only when `contribution.context.lt1 === true` (`wave.ts:2290–2294`). Auxiliary same-eventId txs never mark. Then the entry stays unmarked, the drain re-delivers, the re-run re-issues the intent (navigateTo's engine-side nonce dedupe absorbs the re-append — `navigate-to.ts:272–282`), and the effect lands once. Verified 18/18 with the probes. Add the P1 shape as a pin (the navigateTo-intent sibling is the production instance; a test can stamp a sibling tx directly as P1 does).
Realism: needs an async LT1 child handler that navigates BEFORE an await spanning 100 ms. Rare, but the invariant is RULED absolute and this is a regression the design's own pins cannot see.

### MAJOR

**M1 — α3 leaves the same-eventId sibling standing: the intent half of an orphan LANDS.**
Seat: `wave.ts:1659–1684` — the orphan arm adds the copy to `droppedWhole`, not `requeued`; the per-event fold `eventRequeued` (`wave.ts:1624–1627`) keys on `requeued` only, so a sibling intent tx (no `lt1`, same `eventId`) survives while the handler contribution is refused. Probe P2: `{"seen":["rival"],"side":1,"orphans":1}` — a navigation intent enacted for an event with zero durable entries (events.md §4's FORBIDDEN "a handler delivery with no durable stream entry behind it", half of it). Pre-W3 BOTH halves landed (the base's orphan double), so W3 fixes the handler half and leaves this half — not a regression, but the LANDED note's "readers of the refused run and its own cascade grandchildren fold through the same closure" is true of readers and grandchildren only; siblings do not fold.
Fix shape (validated, F2): an `eventOrphaned` fold beside `eventRequeued` — same-eventId siblings of an orphan-refused contribution are dropped whole with it. 18/18 with P2 → `side 0`. Count `orphanDeliveriesRefused` per EVENT, not per contribution, once siblings fold (with F2 as probed the counter read 2 for one event).

**M2 — Register/spec: OW35 "CLOSED" and events.md §4's LANDED note overstate the code.**
`verification-coverage.md` OW35 CLOSED + the W3 block's row "One durable stream entry … exactly once … COVERED by the run-count pins": true for the pinned shapes, false for the sibling shape (B1/M1). The RULED sentence's letter ("does not complete within its appending wave is dispatched by the drain alone") is STRONGER than the code in that corner — the entry is dispatched by nobody. Fix: land F1/F2 + the sibling pin with the row, or mark OW35 CLOSED-WITH-RESIDUAL naming the sibling-tx shape. The RULED sentence itself is byte-intact (the diff is pure additions) — no issue there.

### MINOR

**m1 — α4 pins are blind to an over-reaching purge.** Mutation M4 (predicate widened to `event.served !== undefined`, i.e. the purge also drops the DRAIN's queued copies → dropped notice → lost delivery) leaves all THREE α pins GREEN (the drain copies never sit across a deadline in the pins' timing); only the trio's pins catch it ("exactly-once under an HONEST flush deadline" RED `Expected 0 ≥ 1`). Acceptable because the suite catches it, but the α4 row claims the pins guard the discriminator. Fix shape: in pin 1 hold the gate across ≥2 deadlines after the drain queued `c1'`/`c2'` and assert `lt1LeftoversPurged` stays 1 and no `status: "dropped"` lands.

**m2 — OW37 re-read wording is wrong-direction.** Register W3 block: "wavesBudgetExhausted 38 / 26 / 25 — … fewer than the W0 tip's 21 on a 46-wave run in ratio terms only by noise". The artifacts: W3 ratios 0.62 / 0.50 / 0.48 (61/38, 52/26, 52/25); W0 l1–l3 0.46 / 0.39 / 0.26 (46/21, 44/17, 38/10). W3's exhausted ratio is HIGHER, not fewer; load differed (W3 ran at load 4.5–8.8). The conclusion (ratio metric owed to W4's quiet run) stands; the sentence should say "higher; confounded by load; owed to W4".

**m3 — the purge cannot see shaper-HELD LT1 copies (observation, not a bug).** An LT1 copy forwarding a renderer-trusted event object is `shouldShapeDelivery` → held in the wake shaper, NOT in `eventQueue` (`facade.ts:1257–1275`); the purge scans `eventQueue` only. α1b covers it (released later → refused at the seal → drain delivers), so exactly-once holds, but for that class every cascade costs a refused run + one extra cycle and `lt1LateSealsRefused` grows routinely. The builder's "shaper-held pin follow-on" should cover the HELD LT1 copy too, not only the drain-held copy; the counter doc's "a count that grows … names a handler whose in-process copy keeps missing its wave" will fire for this benign class.

### NIT

**n1 — pin 1's title mutation clause is imprecise.** "purge AND refusal skipped → the effect applied four times": with the orphan arm intact (M8), the late copies are orphan-dropped in N+1 — the effect stays 2 and the pin fails earlier on the counters (0≠1 at test:1830 / :1948). The "four times" needs the absent-emitter clause off as well; the report's §5 table (3×/2× with refusal + absent-emitter clause off) is the accurate one.

**n2 — `handleCommitResult`'s sentinel path skips the `scheduler.event.commit` telemetry submit** for the refused copy (`events.ts:1413–1430` returns before it). Fine, but say so in the comment.

**n3 — `seal()`'s refusal skips `#feedArrived?.resolve()`** — correct today (the drain copy follows and wakes the loop), but if a future caller relies on a seal waking the loop it will not.

**n4 — pre-existing, not W3's (flag only):** `cell.ts:1730` keys the LT1 branch on the CELL's space (`resolvedToValueLink.space === this.space`), not on the serving runtime's space; a served run sending on a cell held for a FOREIGN space would take the LT1 path on the wrong server. With W3, α3 orphan-refuses that copy (the emitter ops are foreign, `emitterOf` misses) and the target space's drain delivers — conservative and exactly-once, an accidental improvement.

---

## 3. Mutation-probe table

| # | mutation (file) | expected if pins are load-bearing | observed | verdict |
|---|---|---|---|---|
| M1 (builder) | both `#purgeLt1Leftovers` calls commented (`space-server.ts:3063,3069`) | pin 1 RED on `lt1LeftoversPurged` | RED: 0≠1 at test:1830 (exactly-once itself survives — α1b refuses the queued copy at its seal) | reproduced |
| M2 (builder) | refusal `false &&` (`:1078`) + absent-emitter clause removed (`wave.ts:1660`) | effect 3×/2× | RED: `counterC` 3≠2 (test:1853), 2≠1 (test:1946) — the lunch double | reproduced |
| M2b (builder) | refusal skipped ALONE | refusals 0, effect still once | RED at `lt1LateSealsRefused` 0≠1 (test:1856/1948) AFTER `counterC` passed → effect once; defense-in-depth verified | reproduced |
| M3 (builder) | orphan arm removed (`emitterWithdrawn = false && …`) | pin 3 RED "ping" delivered | RED: `["ping","rival"]` (test:2055) | reproduced |
| M4 (mine) | purge predicate `event.served !== undefined` (drops DRAIN copies too) | some pin RED (lost delivery) | α pins ALL GREEN; trio pins RED (`Expected 0 ≥ 1`; SEAL→OUTCOME timeout) | caught by the suite, NOT by the α pins (m1) |
| M5 (mine) | refusal inverted (`appending === #currentWave`) | in-wave pins RED | 4 RED: C8d timeout; pin 1/2 at `lt1LateSealsRefused` 0≠1 (late copies were orphan-dropped, `counterC` stayed right); pin 3 timeout | caught |
| M7 (mine) | only `droppedDocs[emitter.index].has(emitter.docKey)` removed | pin 3 RED | RED `["ping","rival"]` | caught — the per-doc clause is load-bearing |
| M8 (mine) | purge + refusal skipped, orphan arm intact (the pin-1 title's claim) | "four times" per the title | pin 1 RED at purge counter (early); pin 2 RED at refusal counter after `counterC` 1 — effect NOT 4 | n1 |
| P1 (mine, new test) | α1b + same-eventId sibling tx before the deadline-spanning await | `counterC` 1 | **`counterC` 0, entry consequenced, `processed` 1** (base: 1) | **B1** |
| P2 (mine, new test) | α3 + same-eventId sibling tx | sibling refused (`side` 0) | **`side` 1, `seen ["rival"]`, orphans 1** | **M1** |
| F1+F2 (mine, fix probe) | `lt1 === true` gate on `survivedEventIds` + `eventOrphaned` fold | all green | **18/18 green** (16 originals + P1 `counterC` 1 + P2 `side` 0) | fix validated |

Baseline at the tip: `executor-events-down.test.ts` 1 passed (16 steps), 14 s. All mutations reverted by `git checkout -- <file>`; tree clean.

---

## 4. Axes — held / finding

1. **Exactly-once, both directions.** (i) TWICE: held — the in-wave copy marks via its own survival; the drain scans the committed store (so `X'` only exists after wave N commits with X unmarked); a late LT1 copy is refused; a purged copy is never re-queued (no `originTx`, `retries: false`, `finalOutcomeNotified`); shaper-held LT1 copies are refused at the seal; depth-2: a grandchild copy resolves its appending wave from its (refused) emitter's tx → `null` → refused, and the drain's re-run of the parent re-emits a fresh id; an LT1 copy whose parent is a drain delivery: C8d `parentRequeued` folds it on a parent requeue. The emitter's commit reaches `seal()` synchronously (`extended-storage-transaction.ts:2159`, no awaits before it; `events.ts:1571`/`run.ts:119` call it inside the action's `.then`) before the scheduler's next pass, so `#waveByTx` is set before the copy can dispatch — verified. (ii) ZERO: **FINDING B1** (the sibling-marked entry). Otherwise held: the purge touches no durable entry; a refused copy's writes never reach the overlay (refused before `#openWave`/`wave.seal`; post-commit outbox cleared on error; cross-space appends ride only with a sealed contribution, `wave.ts:705–710`); a purged copy writes no notice (no `onFailure`/`onCommit`).
2. **α1b.** The rule is NOT "first to seal wins": it is "the LT1 copy completes in its appending wave or not at all; the drain copy is never refused by this seat." The drain copy cannot arrive in the same wave as an in-wave LT1 completion (it exists only once the entry is committed unmarked). No `dropped` notice is written (verified: pins assert `status`/`error` undefined; `handleCommitResult` takes the sentinel path, `onFailure` is never called). events.md §4's LANDED note is DATED, the RULED sentence untouched — and α1b IS within the ruling's letter ("does not complete within its appending wave → dispatched by the drain alone"): a clarification, not an extension. BUT the code is weaker than the letter in the sibling corner (B1) — the note should not say "enforces the sentence" until F1 lands.
3. **α3 seat.** Held against misclassification: `emitterOf` is per wave, built from THIS wave's seq-less entries (`#lt1EmittersByEventId`, `wave.ts:2067–2087`, the same detection the batch build uses — `seqLessStreamEntryEventIds` mirrors `wave.ts:2308–2360`); a legitimate re-emission across waves mints a fresh id with its own entry; §3b's overwrite unit replaces basis ROWS, not ops. "Derivation-kind" is not determined by the arm at all — it keys on the emitter's withdrawal (`requeued`/`droppedWhole`/per-doc `droppedDocs` of the SIDECAR key) — robust. Gap: the sibling fold (M1).
4. **Pin vacuity.** The pins count the non-idempotent effect + one consequence commit per entry — they do catch the lunch double (M2) and the inverted seat (M5). Weaknesses: m1 (purge over-reach invisible to the α pins), and the sibling shape is unpinned (B1/M1). `consequenceCommitsOf` alone would pass in a same-wave double — the builder said so; confirmed on W0 l1's store (max 1 per event while the toggle is in one commit).
5. **OFF byte-identity.** Held by reading: cell.ts's addition is inside the `serverExecution && servingPosture` branch; `events.ts` spreads `lt1` only from `served`, the sentinel path is `served !== undefined`-gated, `notifyEventDropped`/`dropQueuedEvent`/`dropEvent` gained a defaulted `options` argument (warn path unchanged); `purgeQueuedEvents` is called only by the SpaceServer; wave/stats/types are serving-only. The builder's "pass/fail set equals W1's + 3" is weak evidence by itself (a pass set cannot see silent behavior change); the reading is the evidence.
6. **Lunch gate evidence.** 3/3 VERIFIED from artifacts (N6). The (α) witness is the vote class: votes add-unique 3 / remove-by-value 0 in all three W3 stores vs W0 l1's add 2 / remove 1 in one commit; swatches step 504–506 ms vs W0 l1's 60 035 ms. The join step passes at the first probe (7–16 ms) in every green run — consistent with the host page already showing spec-Alice + confirmed-Alice; it is NOT evidence for (α). "~1-in-8" is an estimate (observed 1 of 6). **Skip decision: agree** — lifting re-exposes a known client-side flake W2 owns; the alternative (re-point the step at the CONFIRMED count) is a test-side one-liner a follow-up could do.
7. **l3 root cause.** Store clean (8 ids × 1; `users` spliced exactly at commits 42 and 52; nothing else touches `/value/users`); every link of the client-echo chain verified in code (per-tx random `mintEventId` key; exact-id `retireIntent`; late-echo rule only at seal; `$event: tx.dispatchedEventId` frame cause). Not falsified; I found no competing explanation for "3 joined · Alice · Alice · Bob" over a 2-user store.
8. **Counters / register honesty.** `events.lt1LeftoversPurged / lt1LateSealsRefused / orphanDeliveriesRefused` land where claimed and read 1/0/0 on the lunch runs, 0/0/0 on chat — verified. OW35 CLOSED is overstated (M2); OW37 re-read wording wrong-direction (m2); the skip-row rewrite is consistent with the record (#5969 refuted the `nowTick` story earlier, register :3499); the W3 block's coverage rows match pins that exist except for the sibling shape; "Plan coordination block not touched" — fine.
9. **Ordinary correctness/perf.** Purge: `eventQueue.filter` + per-hit `indexOf/splice`, O(queue) per cut cycle — fine. `#lt1EmittersByEventId`: O(home ops) per commit; the LT1 append is a mergeable tail-only `append` patch so the entry walk is O(1) per emission. `#lt1AppendingWave`/`#waveByTx`: WeakMaps keyed by tx — no cross-wave leak; `emitterOf` is per-`resolveConflicts` call. Exceptions in the seal path: the refusal returns a resolved `{error}`; `commit()` clears the outbox and runs callbacks; the scheduler's sentinel path settles quietly. Marker propagation: `lt1: true` is stamped only from `served.lt1` (cell.ts's serving arm), never inherited by the child's own sends (each grandchild carries its own `emitterTx`). Held.

---

## 5. Suites / probes run, tree-clean confirmation

- runner (tip, clean tree): A 25 passed (265 steps) 1m35s + B 1187 passed (6463 steps) 8m40s = **1212 passed / 6728 steps, 0 failed** (= the builder's count). toolshed **142 passed (428 steps)**. `server-execution-on-skips.test.ts` **17 passed**. fmt clean (11 files); lint 1 pre-existing `require-await`.
- `executor-events-down.test.ts`: baseline 16/16; 8 mutation runs (M1, M2, M2b, M3, M4, M5, M7, M8) + 2 probe runs (P1, P2 on the tip; P1 on the W1 base sources) + 1 fix-probe run (F1+F2, 18/18). Logs under the scratchpad `w3/` (`M*.log`, `P1.log`, `P1-base.log`, `P2.log`, `FIX.log`, `suite-a.log`, `suite-b.log`, `toolshed.log`); the probe test file copy at `…/scratchpad/w3/executor-events-down.with-probes.test.ts`.
- Artifacts read: `…/scratchpad/w0bench/runs/{l1,l2,l3}-lunch-on`, `…/scratchpad/w3bench/runs/{l1,l2,l3}-lunch-on,c1-chat-on` (driver.log, test.log, the sqlite stores) — with `/usr/bin/grep -a` and sqlite3.
- **Tree clean**: `git status --short` empty at the end; no branch checkout (`git checkout -- <path>` / `git checkout 19c6448ab -- <paths>` then `git checkout HEAD -- packages/runner/src/` only); no stash.

---

## Working notes (chronological)


### N1. Setup + baseline (tip `4f2bda2d7`)
- Worktree created detached at `origin/claude/server-exec-v2-w3-alpha` = `4f2bda2d7` (matches the brief; nothing newer).
- `git diff --stat 19c6448ab..HEAD`: 17 files, +1460/−60 (runner src: cell.ts, executor/{space-server,stats,wave}.ts, runtime.ts, scheduler/{events,facade,types}.ts; test: executor-events-down.test.ts +451; tasks/server-execution-on-skips{,.test}.ts; docs: events.md +40, serving-loop.md +23/−2, verification-coverage.md +162, stage-c-design.md +18/−2, build report, INDEX).
- Governing docs read: stage-c-design §4 (verbatim ruling; α1–α4; "(β) for the drain's own copies is already covered"), §5 (R-B), §6 W3 block; events.md §4 — the RULED sentence is byte-intact (the diff is pure additions after the enforcement paragraph); the LANDED note is DATED; serving-loop.md §7 counters; verification-coverage.md OW35 CLOSED + the W3 block; the build report; the PR body.
- Baseline: `packages/runner` `test/executor-events-down.test.ts` via the package task flags (`ENV=test deno test --no-lock --no-check --preload=test/clock-preload.ts …`; `executor-events-down` IS in `realClockFiles`): **1 passed (16 steps), 0 failed, 14 s** — the three α pins green (773 / 834 / 684 ms).

### N2. Mutation reproductions (builder's) — all observed RED as claimed
- M1 purge skipped (both `#purgeLt1Leftovers` calls commented): pin "(α1)+(α1b)+(α4)" RED at `lt1LeftoversPurged` 0≠1 (test:1830). Exactly-once itself still holds without the purge (α1b refuses the queued copy at its seal instead) — the purge is the RULED seat, α1b is the load-bearing one.
- M2 seal refusal (`false &&`) + absent-emitter clause (`emitter === undefined ||` removed): pin 1 RED `counterC` 3≠2 (test:1853), pin 2 RED `counterC` 2≠1 (test:1946) — the lunch double reproduced via the NON-IDEMPOTENT effect count.
- M2b seal refusal skipped ALONE: both pins RED at `lt1LateSealsRefused` 0≠1 (test:1856/1948) AFTER the `counterC` assertions passed — the effect is still once (the orphan arm's absent-emitter clause drops the late copy in the next wave). Defense-in-depth claim VERIFIED.
- M3 orphan arm removed (`emitterWithdrawn = false && …`): pin "(α3)" RED — `seen` = ["ping","rival"] (test:2055): "ping" delivered with no entry behind it.

### N3. My mutations
- M4 purge predicate widened to `event.served !== undefined` (the purge also drops the DRAIN's queued copies → dropped notice → lost delivery): the THREE α pins stay GREEN (timing: the drain copies never sit across a deadline in the pins); the trio's pins catch it ("exactly-once under an HONEST flush deadline" RED `Expected 0 ≥ 1` — a LOST delivery; "the guard holds through SEAL→OUTCOME" timeout). Vacuity note: the α4 pins alone do not guard the purge's discriminator against over-reach; the suite does.
- M5 refusal inverted (`appending === this.#currentWave`): 4 RED — C8d (timeout), pin 1/2 at `lt1LateSealsRefused` 0≠1 (the accepted late copies were then orphan-dropped by the absent-emitter clause, so `counterC` stayed right — caught by the counter), pin 3 timeout.
- M7 only the per-doc clause `droppedDocs[emitter.index].has(emitter.docKey)` removed: pin "(α3)" RED (`["ping","rival"]`) — the per-doc clause is load-bearing for the derivation-supersede case.

### N4. PROBES (new tests appended to the file, then reverted) — the main finding
- **P1 — α1b + a same-eventId SIBLING tx**: an LT1 child handler (async) commits a SEPARATE event-handler-stamped tx carrying its own `eventId` (exactly `navigate-to.ts:213`'s served intent tx: `runtime.stampServerRun(intentTx, {kind: "event-handler", eventId: context.eventId, …}); intentTx.commit()`) BEFORE an await that spans the 150 ms deadline, then writes its consequence. Tip `4f2bda2d7`: `{"counterC":0,"side":1,"childRuns":1,"entryConsequenced":true,"refused":1,"purged":0,"processed":1,"appended":1,"consequenceCommits":1}` — the sibling survived in wave N and MARKED the entry (`survivedEventIds` admits any surviving event-handler contribution with that eventId, wave.ts:2288–2296), the handler's own tx was refused at the late seal, the drain never re-delivered (processed 1 = the root), the handler's consequence never landed: **a LOST delivery.** Same probe on the W1 BASE sources (`git checkout 19c6448ab -- packages/runner/src/…`, HEAD test file): `{"counterC":1,…,"consequenceCommits":2}` — the base delivered it (the late copy committed unmarked in N+1). **Regression introduced by W3**; α3's absent-emitter clause would independently drop the late copy too (M2b shows the late copy is orphan-dropped in N+1), so BOTH new seats convert this shape from "late but delivered" to "lost".
- **P2 — α3 + the same sibling shape** in the orphan pin: `{"seen":["rival"],"side":1,"orphans":1}` — the handler contribution is orphan-refused (droppedWhole) but the sibling is NOT folded (the per-event fold `eventRequeued` keys on `requeued` only): the intent half LANDS with zero durable entries behind it (a half-applied orphan; on the base BOTH halves landed, so this half is pre-existing, W3 fixes only the handler half).
- **Fix-probe F1+F2** (wave.ts only): F1 — seq-less-entry marking requires `contribution.context.lt1 === true` (only the LT1 copy's OWN run marks its entry; auxiliary same-eventId txs cannot); F2 — an `eventOrphaned` fold beside `eventRequeued` (same-eventId siblings of an orphan-refused contribution are dropped whole with it). Result: **18/18 steps green** — the 16 originals + P1 (`counterC` 1, processed 2 — the drain re-delivered) + P2 (`side` 0). Reverted.

### N5. Suites run at the tip (clean tree; every deno invocation `--no-lock`; foreground, ≤600 s per call)
- runner, split in two invocations to stay under the per-call cap (same flags as the package task, preload on): **A** `test/executor-*.test.ts test/speculation-*.test.ts test/event-append-client.test.ts test/space-host-late-hint.test.ts test/scheduler/*.test.ts` → **25 passed (265 steps), 0 failed, 1m35s**; **B** the remaining 576 files → **1187 passed (6463 steps), 0 failed, 8m40s**. Total **1212 passed / 6728 steps** — matches the builder's count exactly.
- toolshed (`ENV=test deno test --no-lock --no-check -A --env-file=.env.test`): **142 passed (428 steps), 0 failed, 27 s**.
- `tasks/server-execution-on-skips.test.ts`: **17 passed**.
- `deno fmt --check` on the 11 touched TS files: clean. `deno lint` on the 9 touched runner files: 1 finding, the pre-existing `require-await` in `wave.ts` `#foreignGrantFor` (fan-out F1) — as the builder said.
- `git status --short` after every probe/mutation revert: clean (the probe test file was copied to the scratchpad and restored via `git checkout -- <file>`; no branch checkout, no stash).

### N6. Evidence re-derivation (W0 / W3 artifacts under the scratchpad `w0bench/` and `w3bench/`)
- **W0 l3 store** (`did:key:z6MkrtnN…`): 54 commits; 6 derived commits carry `consequence_of` (33, 35, 38, 42 [2 ids], 45, 52 [2 ids]) = 8 eventIds, each exactly once; `/value/users` `splice` ops appear ONLY in commits 42 (`index 0`, `NYEME…`) and 52 (`index 1`, `IV6lU…`) — one per join, nothing else touches the path; `appended 6 / processed 6`, `drainInFlightSkips 0`. Store clean — VERIFIED. The host page's last probe: "3 joined · Alice · Alice · Bob". `mintEventId(link, originTx)` = `evt:${originKey}:${seq}:${link.id}` (per-tx random key) — the client cascade id cannot equal the server LT1 id (`evt:395542e7…:0:…lalq…`); `retireIntent` retires by exact `entry.eventId`; the late-echo rule fires only at SEAL when the parent is already terminal; the handler frame cause is `$event: tx.dispatchedEventId` (runner.ts:5976). Every link of the builder's chain checks out against the code; I found no alternative explanation consistent with the clean store.
- **W0 l1 store**: commit 63 = the click (`evt:5b126ac8…`) marked + the seq-less `append` of castVote's entry (`evt:bd00b09f…:0:…`); commit 64 = `add-unique /value/votes BKR5…` + `replace /value/entries/1 {consequenced:true, eventId: bd00b09f…}` + `remove-by-value /value/votes BKR5…`, `consequence_of` = ONE id; votes doc totals add-unique 2 / remove-by-value 1; per-event consequence count max 1 (the store-side count cannot see the same-wave double — VERIFIED). "both voters' swatches visible" 60 035 ms in W0 l1 vs 504/505/506 ms in W3 l1–l3.
- **W3 lunch runs** (binary sha `cb7da13673e4dda4`, gitSha `c3732e50b`, `shellServerExecutionDefine: "true"`): rc=0 ×3, walls 36/20/17 s; `appended 11 / processed 12`; `lt1LeftoversPurged 1 / lt1LateSealsRefused 0 / orphanDeliveriesRefused 0` each; stores: 16 events, max 1 consequence commit per event, votes add-unique 3 / remove-by-value 0 — all VERIFIED. "both join lands" step timings: W0 9 / 7 / 300 036(FAIL) ms; W3 16 / 13 / 11 ms — the step passes at the first CDP probe in every green run; the test step (`lunch-poll-vote.test.ts:208–216`) waits for the HOST body to contain "2 joined" right after the guest's click — consistent with the host page already showing spec-Alice + confirmed-Alice. The builder's "spurious pass" reading is consistent with the artifacts and the code; the "~1-in-8" flake rate is an estimate — observed 1 of 6 runs.
- **W3 chat smoke**: median 1 541 ms (q1 1 408 / q3 1 818), `appended 28 / processed 28`, α counters 0/0/0, load 9.4–9.6 — VERIFIED.
- waves/exhausted: W3 61/38, 52/26, 52/25 (ratios 0.62 / 0.50 / 0.48); W0 46/21, 44/17, 38/10 (0.46 / 0.39 / 0.26).

---

## Appendix A — the fix probe (F1+F2) as applied to `packages/runner/src/executor/wave.ts` at `4f2bda2d7` (reverted; reproduce-and-own, not a patch to land as-is)

F1 — `wave.ts:2288–2296` (the batch build's seq-less-entry marking):
```ts
    const survivedEventIds = new Set<string>();
    for (const contribution of this.#survivors(requeued, droppedWhole)) {
      if (
        contribution.context.kind === "event-handler" &&
        contribution.context.eventId !== undefined &&
        contribution.context.lt1 === true // F1: only the LT1 copy's OWN run marks its entry
      ) {
        survivedEventIds.add(contribution.context.eventId);
      }
    }
```
F2 — `wave.ts:1628–1684` (the requeue closure), beside `eventRequeued`:
```ts
          const eventOrphaned = sameEvent !== undefined &&
            this.#contributions.some((c) =>
              orphanRefused.has(c.index) && c.context.eventId === sameEvent
            );
          if (
            !parentRequeued && !eventRequeued && !readWithdrawn &&
            !emitterWithdrawn && !eventOrphaned
          ) {
            continue;
          }
          if (contribution.context.kind === "event-handler") {
            if (
              (emitterWithdrawn || eventOrphaned) && !parentRequeued &&
              !eventRequeued && !readWithdrawn
            ) {
              droppedWhole.add(idx);
              orphanRefused.add(idx);
              outcome.orphanDeliveriesRefused += 1; // consider counting per EVENT once siblings fold
            } else {
              requeued.add(idx);
            }
          } else { … unchanged … }
```
With F1+F2 and the two probes appended to `executor-events-down.test.ts`: 18/18 steps green (16 originals + P1 + P2).

## Appendix B — probe P1's core (the sibling shape; full probe files in the scratchpad copy `w3/executor-events-down.with-probes.test.ts`)

Pin "(α1b)+(α4)"'s construction with the child handler replaced by:
```ts
        async (tx: IExtendedStorageTransaction, _event: unknown) => {
          childRuns += 1;
          if (childRuns === 1) {
            // The sibling: a SEPARATE event-handler-stamped tx carrying THIS
            // event's id, committed mid-run (navigate-to.ts:213's intent tx
            // shape), BEFORE the await that spans the deadline.
            const side = w.serving.edit();
            w.serving.stampServerRun(side, {
              actionId: "probe/side-intent",
              kind: "event-handler",
              eventId: tx.dispatchedEventId!,
            });
            sideServing.withTx(side).set({ n: (sideServing.withTx(side).get()?.n ?? 0) + 1 });
            side.commit();
          }
          await childGate.promise;
          w.servingC.withTx(tx).set({ n: (w.servingC.withTx(tx).get()?.n ?? 0) + 1 });
        }
```
then: fire root → wait for the child's entry to land → 800 ms → open the gate → 1.5 s → `serving.idle()` → assert `engineN(counterC) === 1`. Tip: `counterC 0` (entry consequenced before the gate, `refused 1`, `processed 1`). W1 base sources: `counterC 1`.
P2 = pin "(α3)" with the same sibling stamp inside the `ping` branch of the s2 handler; assert `engineN(side) === 0`. Tip: `side 1`.
