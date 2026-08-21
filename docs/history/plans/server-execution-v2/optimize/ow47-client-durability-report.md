---
status: active
created: 2026-08-21
reason: "OW47 client own-write durability under ON (seats S-E/S-F/S-G, plus OW45's client half S-B/S-C and OW46's S-D): the S-E trace of WHY a USER's binding write dies under ON, the fix with its which-direction argument, and the skip-lift evidence. Working report of the optimize-on-main client-durability agent; updated incrementally."
---

# OW47 client own-write durability — trace + fix report

Agent: client-durability (optimize-on-main phase). Worktree
`/Users/berni/labs-worktrees/ow47-durability`, branch
`claude/server-exec-v2-ow47-durability` off `origin/main` @ `ce92b445f`.
Status: **IN PROGRESS** — updated incrementally with each push.

## 0. Assignment

Close the client write-path durability cluster:

- **OW47** (primary; seats S-E/S-F/S-G): a USER's binding write into a
  serve-owned doc can be silently LOST under ON. Reproducers: the
  `cellset-lww.test.ts` end-to-end step (deterministic,
  `speculative-basis-refused`, step-level ON skip) and
  cfc-group-chat-demo's local shape (Bob's `messageDraft` `$value`
  patch never reaches the store, 0/4 runs incl. a 300 s probe).
- **OW45, client half** (seats S-B, S-C): the pending-commit barrier
  must cover program-materialization commits; heal-on-read re-issues
  program materialization on adopt/open. (S-A — the §2b carriage —
  belongs to OW31's train, another agent.)
- **OW46** (seat S-D): the `structureLoadDeferred` forever-park must
  count and log after N cycles.

Evidence base: `stage-c/on-render-stall-rootcause.md` §1/§2b/§6,
`stage-c/first-on-ci-gate.md` rows 2/4/7, verification-coverage.md §3
rows OW45/OW46/OW47, serving-loop.md §3d.

## 1. Code-reading map (pre-trace; confirmed against the worktree)

The refusal that kills the cellset-lww typed name is the speculation.md
§6 export refusal, and its anatomy is now located:

- **The refusal site**: `packages/runner/src/storage/v2.ts`
  `commitOperations` (~:4165): `speculativeLayersOf(commit)` finds any
  commit read whose `localSeq` layer array names a member of
  `#speculativeLocalSeqs`; if non-empty →
  `makeSpeculativeBasisRefusal` (~:5552) — `SpeculativeBasisError`,
  TERMINAL (never retried), raised BEFORE the optimistic apply.
- **How a blind UI write gets a speculative layer into its basis**:
  `buildReads` (~:4878). A blind UI-input `set` (handleCellSet's
  blind-leaf-write mode) drops its own value reads
  (`ignoreReadForCommit`) and emits ONE structural nonRecursive read at
  the cell's PARENT (`getBlindStructuralTarget`). `pushCommitRead`
  names **ALL pending layers of that doc** below the commit's localSeq
  — with no distinction between durable in-flight layers and
  speculative overlay layers. So a handler echo (speculative sealed
  commit, `sealOperations` with `options.speculative` — tracked in
  `#speculativeLocalSeqs`, ~:3719) that wrote ANY path of the same doc
  poisons the basis of every later blind write to that doc until the
  echo retires.
- **The ruling's premise vs. this shape**: speculation.md §6's export
  refusal was ruled 2026-08-13 on the premise "only ui components land
  here and they don't use intermediate values like this". The blind
  write does NOT consume the speculative value — the basis names the
  layer only because layer-naming in `pushCommitRead` is per-DOC, not
  per-value-dependency. The refusal message's own recovery premise
  ("re-derivation after the authoritative value lands is the recovery
  path") is serving-loop.md §3d's derivation-write premise — false for
  non-re-derivable USER input, exactly as the OW47 register row states.
- **Echo retirement** (why a layer can still be standing):
  `packages/runner/src/speculation/overlay-destination.ts` — intent
  echoes retire on the event's consequence fields (speculation.md §4
  step 2); input echoes on ack + W-coverage + the ARRIVAL GATE (step
  3). A standing echo between an event fire and its consequence
  arrival is a NORMAL window, so the poisoned-basis refusal does not
  need a retirement bug to fire — any user write to the same doc
  racing its own handler echo hits it.

Hypothesis to verify by instrumented run (NOT yet evidence): in the
end-to-end step, iteration i's `saveProfile` echo stands on the piece
argument doc when iteration i+1's typed-name `set` builds its
structural parent read → refusal → typed name dropped client-side
(nothing renders, nothing retries); the save then reads the stale
draft. Bob's shape generalizes if his profile-save (or another
handler) echo stands on his user-scope instance doc while he types —
each keystroke's `$value` patch refused terminally; his 12 other
writes commit because their bases name no speculative layer. Whether
Bob's echo stands transiently (race window) or permanently (arrival
gate never satisfied for his instance after `shell.login`) decides
the S-E fix's second half.

## 2. Trace log (S-E) — COMPLETE

Topology: local toolshed off this worktree, `EXPERIMENTAL_SERVER_EXECUTION=true`,
fresh `MEMORY_DIR`, port 8055, `servingLoop` verified in `/api/health/stats`;
test run exactly as CI's ON lane (`API_URL=http://localhost:8055/`,
`EXPERIMENTAL_SERVER_EXECUTION=true`, `deno test --no-lock --no-check -A
integration/cellset-lww.test.ts`), step skip scratch-lifted.

1. **Baseline reds reproduced, and the step is a RACE locally**: 2/6
   unmodified runs red with the gate's exact signature —
   `speculative-basis-refused … speculativeLayers: [28]`, assert
   `iter 1: actual "alice-typed-0" expected "alice-typed-1"`. The other
   runs green: on this fast machine the echo usually retires inside the
   settle rounds; on CI-class hardware the standing window exceeds
   them, which is why the gate saw it deterministically. The other 3
   steps green in all runs (they fire no events, so no echo ever
   stands).
2. **Instrumented client build** (scratch `console.warn` taps in
   `overlay-destination.ts` seal/retire/sweep and the `v2.ts` refusal;
   reverted after the trace). The red timeline, one run
   (t = ms mod 100000):
   - `t=50615` seal-entry `localSeq:28`,
     `eventId: evt:cdf0b55b…` (iteration 0's `saveProfile`), floor 95,
     wrote: the piece argument doc (PATCH — the handler's
     `nameDraft.set(trimmedName)` write-back into the draft), plus
     whole-doc writes to `of:fid1:7SgJ…`, `of:fid1:W9SR…`,
     `cid:fid1:tXRw…` — speculatively-created profile entity docs.
   - `t=50647…50694` repeated `sweep-unarrived` for 28: watermark 95 ≥
     floor 95 (coverage satisfied) but the ARRIVAL GATE holds it —
     the entity docs it wrote sit at `confirmedSeq 0` (the served run's
     copies had not landed on this replica).
   - `t=50667` **the refusal**: `localSeq:36`,
     `ops: ["patch:of:fid1:Q9zx…:/value/profileDraft"]` (the user's
     typed name — in this run's id space the argument doc is
     `of:fid1:Q9zx…`), `pendingReads: ["of:fid1:Q9zx…@28"]` — ONE
     pending read, the blind write's structural parent read, naming
     exactly layer 28. Terminal; raised before the optimistic apply;
     the typed name never exists anywhere afterwards.
   - `t=50748` layer 28 finally retires (arrival satisfied) — **81 ms
     after the refusal killed the user's write**; standing window
     ~133 ms in this run.
3. **The failing assert's "actual"** (`alice-typed-0`) is the
   overlay/durable echo of iteration 0's save — iteration 1's save read
   the draft that still held the trimmed iteration-0 name because the
   typed-1 write had been dropped.

## 3. Findings (S-E mechanism, confirmed)

**The write dies at speculation.md §6's export refusal — synchronously,
client-side, before the optimistic apply.** Chain:

1. A blind UI-input write (`handleCellSet` — every renderer `$value`
   binding, runtime-processor.ts:1036; the worker mirrors it) drops its
   own value reads and emits ONE structural nonRecursive read at the
   cell's PARENT (`getBlindStructuralTarget` → `buildReads`).
2. `buildReads`' `pushCommitRead` named EVERY pending layer of that doc
   below the commit — with no distinction between durable in-flight
   commits and the client's own process-local SPECULATION layers
   (`#speculativeLocalSeqs`).
3. A standing handler echo on the doc therefore put its layer into the
   blind write's exported basis, and `commitOperations`' export refusal
   (`makeSpeculativeBasisRefusal`, `SpeculativeBasisError`, terminal)
   fired — on a read that carries NO value dependency. The refusal
   message's own recovery premise ("re-derivation after the
   authoritative value lands is the recovery path") is §3d's
   derivation premise, false for user input — the register row's exact
   sentence.
4. The echo's standing window is structural, not a bug: retirement
   needs the intent's consequence mark (`retireIntent`) or
   coverage+ARRIVAL (`#sweep`), and the arrival gate (RULED 2026-08-16)
   deliberately holds an echo until every doc it wrote holds a
   confirmed value ≥ floor. Handler-created entity docs arrive a full
   served round trip later at best — and NEVER for a never-served
   instance (speculation.md §4 explicitly keeps such echoes standing
   forever). So "user typed while their own echo stood" is a routine
   state with an unbounded worst case.

**Resolution of rootcause §6.1's open questions:**

- Candidate (a) "withdrawn-overlay origin commit dropped on a wave
  race": close but not it — the entry is a STANDING (not withdrawn)
  echo; no wave race is needed.
- Candidate (b) "a flush queued behind the arrival/echo gate that never
  drains": REFUTED for cellset — nothing was ever queued; the write was
  refused synchronously and never became pending. (The arrival gate IS
  implicated, but as what holds the echo, not as what holds a flush.)
- `shell.login` necessity: NOT necessary — the cellset reproducer has
  no identity switch. For Bob it plausibly extends the window
  (per-user instance docs after a login are exactly the never-confirmed
  instance shape), but the mechanism is identity-independent.

**Generalization to Bob (cfc-group-chat-demo local shape):** his
`messageDraft` `$value` patch is the same `handleCellSet` blind class
into the piece root's user-scope instance doc; his profile save's echo
(the save handler writes myProfile/profiles/nameDraft) stands on that
doc, un-retirable while its written instance docs stay unconfirmed
under his identity — so EVERY subsequent draft keystroke was refused
terminally, forever (the 300 s probe), while his 12 other writes (into
docs with no standing layer) committed. The store cannot see any of
this because refused writes never export — matching the rootcause's
"the store can't see it".
**Fixed-by-same-change; not separately re-verified live** (the file's
ON skip remains for OW31's CI shape — see §6).

## 4. Fix + which-direction argument

**Fix (S-E), landed:** `packages/runner/src/storage/v2.ts` `buildReads`
— `pushCommitRead` gains `excludeSpeculativeLayers`; the ONE call site
that passes it is the blind write's structural-read emission. The
structural read's named layers now skip `#speculativeLocalSeqs`
members; everything else about the read is unchanged (`basisSeq` stays
the true confirmed basis; durable in-flight layers stay named, keeping
dependency-cascade and CT-1910 own-session-exclusion semantics).

Why this is the right seam, stated against the 2026-08-13 ruling: the
ruling's premise — "only ui components land here and they don't use
intermediate values like this" — is TRUE of the blind write (it
consumes no overlay value); the basis named the layer only because
layer-naming was per-DOC. The fix makes the exported basis tell the
truth the ruling assumed. The ruled refusal itself is untouched: a
value-consuming authored commit over an echo still refuses terminally
(pinned).

**Which-direction, both ways (the repairs-that-manufacture-failures
hazard):**

- *Loss direction (what was broken):* the user's write must export
  despite a standing process-local echo. Post-fix it exports
  immediately, in issue order, exactly once.
- *Double-apply direction (what a repair must not do):* this fix
  re-issues NOTHING — there is no retry, no queue, no replay; the same
  single commit exports with a smaller named-layer set. A re-issue
  design (retry-after-settlement) was considered and REJECTED for
  exactly the which-direction hazard: an auto-retried set can land
  after a newer user set and clobber it (LWW inversion), and it adds
  the machinery the ruling said to avoid.
- *Dependency direction:* a blind write no longer dooms with a
  withdrawn echo (correct — it never depended on it), and still dooms
  with a dropped DURABLE dependency (unchanged filter scope).

**Tests (red-first, watched):**

- `packages/runner/test/speculation-overlay.test.ts`, new pin "a blind
  UI-input write into a doc carrying a speculative layer EXPORTS":
  FAILED pre-fix at exactly the 409 `SpeculativeBasisError`
  (`outcome.error` defined), green post-fix. Pins: export succeeds;
  EXACTLY ONE new engine commit; the durable value read through an
  overlay-free second reader; the echo entry count untouched (basis
  exclusion, never a withdrawal).
- The standing §6 pin ("an authored tx that read a speculative echo is
  refused LOUDLY…") green before and after — the over-widening guard.
- Integration lift: `cellset-lww.test.ts` end-to-end step **5/5 green
  ON** (true ON topology, lane-shaped local toolshed) after 2/6-red
  pre-fix at the same tip; OFF arm green.
- Neighborhood: speculation-arrival-gate, speculation-intent-listener,
  memory-v2-transaction-path, memory-v2-sync-under-pending,
  blind-write-structural-precondition, memory-v2-stacked-commit — 94
  passed, 0 failed (with the runner suite's `--preload=test/clock-preload.ts`).

**S-F disposition — no separate defect:** every commit()-entered write
is tracked at the transaction chokepoint
(`trackPendingCommit`, v2-transaction.ts:2194/:2445) and
`Scheduler.idleWithPendingCommits` sources exactly that set
(`storageManager.hasPendingCommits()`), so exported binding writes ARE
barrier-covered. The pre-fix loss was the synchronous refusal — such a
write never existed as pending, so no barrier could have held it. The
rootcause's S-F reading ("idle returned while the write was
unflushed") was candidate (b), which the trace refutes.

**S-G, landed:** `cfc-group-chat-demo.test.ts` Bob's send click now
waits `waitForDisabled(page, "#trusted-send-button", false)` exactly
like Alice's (correct under both arms; fixes nothing by itself —
proven by the 300 s probe — but removes the test-side mis-aim).

## 5. Flagged (flag-don't-fill)

- **CFC-label reads of a blind write** could in principle also name a
  standing echo layer (if a handler echo ever patched a doc's `cfc`
  label): those reads keep the ruled refusal. Not observed (the traced
  refused commit had exactly one pending read); left refusing loudly
  rather than widening the exclusion.
- **Derivation-speculation entries block each other's sweeps** for
  extended stretches (`sweep-held blocked=true` repeated dozens of
  times per settle in the trace: an unacked — because speculative —
  layer below an entry blocks its retirement). Rendering-only today;
  recorded because a future reader of `#sweep` perf should know the
  blocked-loop shows up hot in traces.
- **The §2b `/messages/*` "missing trusted-event policy input"
  rejection storm** (rootcause's flagged observation): NOT touched or
  observed by this pass (my instrumentation never reached that path in
  the cellset runs). Still open for the OW31 train.
- **Two scope instances of one computed doc, one never confirmed**: the
  trace's early derivation entries wrote `computed:… @7` and a second
  scope instance `@0` that never arrived (OW32-adjacent shape,
  speculation.md §4's never-served instance). Retirement of those
  entries eventually happened via later sweeps in-run; noted, not
  investigated.

## 6. Skip-entry status / joint-lift readiness

- `integration/cellset-lww.test.ts` step entry: **REMOVED** (this PR),
  with the in-file guard binding (the file had no other entries). Lift
  evidence: 5/5 ON local + the unit pin; CI's ON lane now runs the
  step.
- `integration/cfc-group-chat-demo.test.ts` file entry: **REMAINS**,
  reason updated — the OW47 half of its reason is closed; it lifts with
  OW31's §2b carriage build (its CI shape). Joint-lift test against a
  local merge of OW31's branch: OW31's branch was not yet pushed at
  this writing — joint lift NOT yet exercised.
- `integration/home-profile-reload-durability.test.ts` file entry:
  untouched here (OW45/OW31; S-B/S-C are this agent's remaining seats,
  next PR).

## 7. Register rows

- **OW47**: updated to CLOSED in this PR (S-E fixed, S-F resolved as
  no-defect with the evidence chain, S-G landed; lift evidence named).
- **OW45 client half (S-B/S-C), OW46 (S-D)**: pending — next PRs of
  this pass; their rows update with those PRs (docs-move-together).
