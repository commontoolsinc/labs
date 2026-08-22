---
status: historical
created: 2026-08-22
archived: 2026-08-22
reason: "OW33 triage at main 51350077e (+ the #6195 review pass): four of the family's five surfaces are GREEN at the true ON topology and LIFTED (CT-1606 PerUser render and single-navigateTo 12/12 — both STEP skips lifted; derive_array_leak 5/5 counter 50/50; topics-navigation's recorded fail-fast myName red did not reproduce and its residual 2/10 flake was the unbarriered fid capture — barriered, 10/10 with the echo-drop absorbed twice, skip LIFTED, the smell minted as register row OW60), and the one persisting red (pattern-and-data-persistence, a rotating flake — 4/8 original-file runs red) is ROOT-CAUSED to the speculation overlay's arrival-gate witness hole — the gate accepts an authored structure write at the floor as the arrival witness — with the predicate choice surfaced as a fork memo (ow33-arrival-witness-fork.md), not filled."
---

# OW33 triage — the ON-posture Deno-client family, re-reproduced at main

The OW33 register row (verification-coverage.md §3) recorded four reds
surfaced on 2026-08-16 when the ON lanes became UNIFORM, plus the
patterns-suite sibling `topics-navigation`. The row predates the (d′)
demand-model rulings, the OW51 unresolved-input semantics, OW34/OW59
per-run trust attribution, the explicit warm request, and the §6
verifier-read fixes — all on main by this triage's base. Every member
was therefore re-reproduced at current main under the true ON topology
BEFORE any theorizing. This report records the per-member evidence,
mechanisms, and dispositions; the one genuine design fork it surfaced
is flagged in
[`ow33-arrival-witness-fork.md`](ow33-arrival-witness-fork.md), never
filled.

## 0. Method

- Base: `origin/main` @ `51350077e` (worktree
  `claude/server-exec-v2-ow33-triage`), 2026-08-22.
- Diagnosis runs: toolshed FROM SOURCE, port 9612, fresh
  `MEMORY_DIR`, self-referential `MEMORY_URL` (never port 8000 — the
  stale-toolshed trap), `EXPERIMENTAL_SERVER_EXECUTION=true`, client
  posture declared from env, `servingLoop` probed present per launch.
- Gate runs: the ON-BUILT binary (`deno task build-binaries toolshed`
  under `EXPERIMENTAL_SERVER_EXECUTION=true`; sha256 `68331b3f3838…`),
  ports 9613, fresh store per gate series, posture probed per launch
  (`/api/meta shellServerExecutionDefine === "true"`,
  `/api/health/stats servingLoop` present) — the CI ON lane's exact
  shape.
- One test file per deno invocation throughout. Machine load recorded
  beside every timing-sensitive series (1-min load ranged 3.5–7.8; a
  sibling OW53 triage ran in parallel on disjoint surfaces).
- Store archaeology on the fresh per-run sqlite stores
  (`revision` + `commit` tables, commit classes); overlay lifecycle
  instrumented via a worktree-local wrapped
  `SpeculationOverlayDestination.prototype.seal` plus
  `entryCount()` sampling (diagnostic copy deleted; never committed).

## 1. Verdict table

| member | register's red | at main 51350077e | disposition |
| --- | --- | --- | --- |
| (a) `runner/integration/pattern-and-data-persistence.test.ts` | Phase-3 new piece reads `sum` undefined, deterministic | still red, now a **rotating flake** — the failing read alternates between the new and the resumed instance (observed: 4/8 original-file runs red; 2/10 and 1/8 in instrumented variants) | ROOT-CAUSED (§2): overlay arrival-gate witness hole. Skip STAYS, reason re-tensed; predicate choice = **fork memo** |
| (b) `runtime-client client.test.ts` :: CT-1606 PerUser header render | never reaches first render in 15 s, 3/3 | **GREEN 12/12** (10 binary + 2 source), renders in ~1 s | HEALED; STEP skip **LIFTED** |
| (c) same file :: single navigateTo dispatch | flaky 1/3 — two dispatches for one fire | **GREEN 12/12** | HEALED; STEP skip **LIFTED** |
| (d) `runner/integration/derive_array_leak.test.ts` | 0 of 50 increments land (warned; green only via memory assert) | **counter 50/50, 5/5 runs** | HEALED (was never skip-listed; row re-tensed) |
| sibling: `patterns/integration/topics-navigation.test.ts` | fails FAST at the controller prop set: `missing required property myName` (PiecePropIo.set → validateWriteDestination) | that red **did NOT reproduce in 11 runs** (9/11 green); the residual 2/10 flake was the unbarriered fid capture (§6) — barriered in the review pass, then **10/10 green** with the echo-drop absorbed twice | test-posture fix + skip **LIFTED**; the echo-drop smell minted as **OW60** |

## 2. Member (a): the arrival-gate witness hole

### What the row said, and what still holds

The row's mechanism note — "no sink → no demand — the sink is the
demand — and the ON client's own speculative run did not surface the
value through this read path either" — is superseded on both halves:

- **The demand half is DISCHARGED.** `Cell.pull()` kicks a `sync()`
  whose watch joins the session's tracked set, which is the (d′)
  demand union — and the server SERVES: in every reproduction the
  fresh store ends with both instances' computed values as
  derived-class commits, `demandArrivals` > 0, `demandedInstancesMax`
  ≈ 26. The ruled `.pull`-for-round-one imperative-creation flow
  (protocol.md §1, owner 2026-08-07) works at main. One nuance
  observed, no defect: an ephemeral session that pulls and disposes
  within milliseconds can miss its own round (the wave right after
  phase 2's setup committed watermark-only; the value was served one
  session later when standing demand re-covered the instance) —
  convergence is correct, only the test's read raced it.
- **The speculation half is now the whole story.** The client DOES
  speculatively run both the new and the resumed instance before the
  read (per-phase-labeled lift logs prove attribution), and the runs
  DO seal overlay entries — which are then **retired before the served
  value arrives**.

### The mechanism, step by step (instrumented red runs; store-decoded)

1. A setup commit writes authored at some seq — the input cell plus
   the piece's result/computed docs' STRUCTURE (the creation act).
   For the NEW instance that commit is the client's own phase-3 setup
   at seq S; for the RESUMED instance it is a PRIOR session's setup
   commit (phase 2's), already confirmed in the store.
2. The client speculatively runs both instances; each derivation seals
   an overlay entry whose `floor` sits at its setup commit's seq (its
   reads sit on that commit) and whose `writtenDocs` are its computed
   docs.
3. **The store-proven invariant (both decoded red stores, both
   arms):** the watermark covering the entry's floor reaches the
   client AT LEAST ONE FRAME BEFORE the victim's served value, and
   the ONLY confirmed cover at/above the floor is an AUTHORED
   STRUCTURE write — never a derived value. The two arms: the
   NEW-instance victim's cover is the client's OWN setup commit at
   exactly the floor seq; the RESUMED-instance victim's cover is the
   PRIOR session's authored setup write (run 0's entries retired at
   seal against a PRE-EXISTING values-free watermark-only commit from
   the prior wave — `derived-8: watermark→7`, no values — while the
   victim's values rode the FIRST values commit of the new settle,
   `derived-10`, arriving after the read).
4. How W gets ahead of the victim's value, honestly scoped: an
   EXHAUSTED wave FREEZES the watermark (`space-server.ts` — both
   `inputAdvanceTo` and `derivedThrough` take `this.#watermark` when
   `exhausted`), so under budget exhaustion
   (`wavesBudgetExhausted` observed in these runs) the covering W
   rides a LATER values wave or a VALUES-FREE advance commit; and
   with several writers in one settle, demand-arrival order can put
   the victim's writer in a later wave while W rides the first values
   wave. Either way the covering W's frame precedes the victim's
   served value at the client.
5. When that covering W arrives (or already stands, the resumed arm),
   the overlay sweep runs and the victim's entries pass the ARRIVAL
   gate spuriously: the gate (overlay-destination.ts `#sweep`)
   witnesses arrival as `confirmedSeq(writtenDoc) >= floor`, and the
   computed docs' confirmed head IS the authored STRUCTURE write at
   the floor. The entries retire; the pending layers drop; live entry
   count hits 0 (sampled: entries sealed at `liveEntries=2`, retired
   to 0 within the same millisecond burst — or instantly at seal when
   the cover pre-exists).
6. The bare `getAsQueryResult()` read lands in the hole — `undefined`
   — and heals when the victim's served value applies (measured
   41–262 ms after the read point). Which instance is the victim
   follows from whose served value lands after the covering W's frame
   — which is why the failing assert rotates (run 0: resumed
   instance, cover pre-existing; later runs: new instance, cover =
   own setup; both signatures observed at main, and independently
   reproduced by the #6195 review with both signatures, entries=0 at
   the read, heal +36 ms).

The RULED arrival sentence (speculation.md §4, 2026-08-16) is
explicit that coverage without arrival is the OW32
retire-to-nothing class and that the gate exists to hold the echo
"until the authoritative value lands"; the implementation's
doc-granular seq comparison does not meet the sentence for docs whose
covering confirmed write is the client's own authored structure
write. The fix DIRECTION is therefore determined by the ruling; the
WITNESS PREDICATE (how the replica distinguishes "the authoritative
derivation arrived" from "some confirmed write at that seq exists")
has several candidates with real semantic edges — that choice is the
fork memo, flagged not filled.

Evidence trail (scratch logs, per-run stores): the original file red
4/8 across the first series, 2/10 and 1/8 in instrumented variants;
overlay `entryCount == 0` at the read point in EVERY run (green runs
were green because the served value had already applied); seal
narration showing derivation-kind seals registering then retiring
inside the same burst; store timelines showing structure authored at
the floor seq, values derived above it, split across separate derived
commits — with the covering watermark arriving via a values-free
advance commit or riding a values wave that precedes the victim's
(never an exhausted wave: those freeze `derivedThrough`).

### Disposition

- Product defect, runner-side (overlay arrival witness). NOT a
  test-posture question: with the gate honoring the ruled sentence,
  the speculative cover makes the test's every read deterministic
  (the run completes inside `pull()`'s idle), so the test needs no
  change.
- Skip entry STAYS; reason re-tensed to this mechanism with the lift
  condition "the ruled predicate lands and the file greens 10/10 at
  the true ON topology".
- The predicate fork: [`ow33-arrival-witness-fork.md`](ow33-arrival-witness-fork.md).

## 3. Member (b): CT-1606 PerUser header render — HEALED, lifted

Reproduction at main: the step renders in ~1 s and the follow-up
`nameCell.set("Alex")` re-render passes. Gate: **10/10** full-suite
runs of `integration/client.test.ts` on the ON-built binary (fresh
store, posture probed; 45 steps, 0 failed, both formerly-skipped
steps confirmed EXECUTING in the transcripts), plus 2 earlier
source-toolshed ON runs — 12/12 total. The heal is consistent with
the stack landed since 2026-08-16 (fan-out stage B's per-demander run
supply for user-scoped instances; OW51's scoped-row
absence-is-knowledge semantics, under which the absent `PerUser`
row's `""` default renders instead of wedging; the stage-C
arrival/retirement tuning) — no single-PR attribution was attempted,
and none is needed for a lift whose bar is green evidence at the true
topology. STEP skip entry REMOVED.

## 4. Member (c): single navigateTo dispatch — HEALED, lifted

Same 12/12 series as (b) (the step executes in every run;
`navigations.length === 1` holds). The double-dispatch class the F10
handler-fork contract names is covered at main by the effects-channel
nonce reconciliation plus the late-echo seal rules (stage C T2/W2.1)
— the optimistic enactment records its nonce and the served intent
acks without re-enacting. Formerly 1/3 flaky, so the lift gate was
run at the 10-run bar. STEP skip entry REMOVED.

## 5. Member (d): derive_array_leak — HEALED

**5/5 runs: counter 50/50 under ON** (the row recorded 0/50 with the
test green only via its memory assert). The event's 50-increment
handler consequence lands and the client's post-`synced()` read sees
it. Not skip-listed, so nothing to lift; the register row is
re-tensed by this report. One measurement caveat for future readers:
the test finds "the" toolshed by `pgrep -f toolshed`, so on a machine
running several toolsheds its MEMORY ratio may measure a bystander
process — the counter half, which is the OW33 signal, is
process-exact either way.

## 6. Sibling: topics-navigation — the recorded red is gone; the residual flake closed by a barriered capture; skip LIFTED

At the true ON topology (ON binary, fresh store per series): 9/11
runs green (1 initial + 10-run gate, 8/10). The register's recorded
fail-fast red — `updated result does not match its write destination:
missing required property myName` at `PiecePropIo.set →
validateWriteDestination` — appeared in NONE of the 11 runs.

The two red runs share one signature, different from the recorded
red:

- The controller client's TWO `addTopic` echo runs are dropped at the
  stream-action validation guard (`runner.ts`: "stream action
  argument is undefined (potential schema mismatch) -- not running")
  — the resolved `$ctx` at send time holds `myName: ""` and
  `topics: []` but is MISSING the required derived `crossrefs`
  member.
- The topics are still created correctly SERVER-side: the browser
  renders both titles, the store holds exactly two title-bearing
  topic docs (no duplicates — checked across every gate space), and
  the serving stats show `events appended == processed` (28/28 over
  the series) with `structureLoadFailures: 0`.
- The failing assert is on IDS, not behavior: `topicAt`'s beforeAll
  capture — `pull()`-then-read with no served-arrival barrier — runs
  with NO speculative cover (the echo was dropped), captures wrong
  ids for the not-yet-arrived `topics` array, and the later
  navigation assert compares the browser's CORRECT target against
  the wrong capture. Store proof: the "wrong" navigated id in a red
  run IS the real "Navigation target" topic piece.

So the residual flake stacks two mechanisms this triage already
names: the echo-side drop (a validation guard predating the OW51
refusal semantics — it silently skips instead of
refuse-and-retrigger) and the unbarriered capture read (the same
read-contract family as §2's hole — reads between the echo cover and
the served arrival are undefined-windows). Flagged, not filled:
whether the stream-action validation drop should take the OW51
refusal+retrigger disposition, and whether `$ctx` composite
materialization racing the send is itself a defect, are design
questions for the owner — the guard's disposition is not determined
by the OW51 ruling as scoped (#6179 scoped the refusal to the
schema-aware lazy READ path).

### The review pass: the capture barriered, the skip LIFTED, the smell minted as OW60

The #6195 review took the lift path (its F4): the unbarriered capture
is the waiting-in-tests doctrine's exact class — a capture racing the
serve — so the beforeAll's fid capture is now BARRIERED on both
created topics being readable (`waitForCellValue` over the board
result's `topics` key, sink-driven with the predicate applied at
quiescence; both titles present). In the echo-covered path the ids
converge by cause, so the barrier is correct in both arms. The
red-first evidence for the fix is the recorded 2/10 red series above
— the exact mechanism the barrier closes; a deterministic on-demand
reproduction of the race is not constructible without instrumenting
the runtime, so the mechanism trace stands as the red.

The lift gate, re-run with the barrier (fresh store `bin3`, same
ON-built binary, posture probed; loads 5.8–6.5):

| run | result | echo-drop observed |
| --- | --- | --- |
| 1–8 | green (6–12 s) | no |
| 9 | green | YES — dropped and ABSORBED |
| 10 | green | YES — dropped and ABSORBED |

**10/10 green — with the echo-drop occurring at its natural ~2/10
rate in runs 9–10 and no longer failing the test.** That is the
strongest available validation: the exact former red mechanism
recurred under the fix and was absorbed. The file's skip entry is
REMOVED.

The canary function the flake was serving moves to a NAMED register
record instead: the echo-drop product smell — the stream-action
validation guard silently skipping an echo run whose composite
`$ctx` has not materialized, predating the OW51 refusal semantics —
is minted as verification-coverage.md **OW60**, carrying the full
trace and the flagged disposition question (refusal+retrigger vs
silent skip), so the smell stays tracked without a flaky test
carrying it.

## 7. Register and skip-list deltas shipped with this report

- `tasks/server-execution-on-skips.ts`: both runtime-client STEP
  entries REMOVED (12/12 gate) and the patterns topics-navigation
  entry REMOVED (the review pass's barriered 10/10 gate); the
  surviving runner entry's reason re-tensed to the root-caused
  mechanism; the header narrative updated. The in-file
  `onArmStepSkip` guard calls stay in `client.test.ts` — the binding
  mechanism for any future entry, inert without one.
- `tasks/server-execution-on-skips.test.ts`: the three content pins
  reconciled to the new register state (empty runtime-client list
  pinned so a re-skip is a deliberate entry; the re-tensed reasons'
  load-bearing substrings pinned).
- `packages/patterns/integration/topics-navigation.test.ts`: the
  beforeAll fid capture barriered (`waitForCellValue`; the review
  pass's F4).
- verification-coverage.md: the OW33 row's triage delta
  (re-reproduction results, the discharged demand question, the
  arrival-witness fork's flag, the topics lift), and the NEW OW60
  row (the echo-drop smell's named record).

## 8. Flagged, not filled

1. **The arrival-witness predicate** (§2; the fork memo) — awaiting
   the owner's ruling before any build.
2. **The stream-action validation drop vs the OW51 refusal
   disposition** (§6; now register row OW60) — the guard silently
   skips a run whose composite `$ctx` is missing a required derived
   member; under the ruled refusal semantics a comparable unresolved
   READ refuses and re-triggers. Extending that disposition to this
   guard is a spec decision, not an implementation detail. The smell
   demonstrably persists (absorbed twice inside the 10/10 lift
   gate).
3. **`pull()`'s read contract under ON** — `pull()` resolves on
   client idle + settled loads; it does not await a served round.
   Today the speculative cover is what makes pull-then-read
   deterministic; where that cover is absent (a dropped echo, a
   session reading another session's never-served instance), the
   read is honestly racy and the repo's own serving-loop tests
   `waitUntil` the value instead. Whether pull should gain a
   served-arrival option is a product question nobody has asked yet;
   recorded here so the next triage does not re-derive it.
4. **Ephemeral-session round-one timing** (§2) — a pull-then-dispose
   client can miss its own round-one serve (served on the next
   session's demand instead). Convergent and within the ruled model's
   letter; noted because `cf piece new`-style CLI flows are exactly
   this shape and may want the round awaited.
