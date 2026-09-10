---
status: historical
created: 2026-08-20
archived: 2026-08-20
reason: "Stage-C combined W2.1+S1 independent adversarial review (read-only, at 4bf914a70): LANDABLE-WITH-FIXES — 2 MAJOR (F1 the late-grandchild-of-silent-child seal-time gap; F2 the latch consumed under a mid-seal content fold) / 5 MINOR / 8 notes; OW43's closure verified justified; the skip lift corroborated with an independent 7th green lunch run; every finding dispositioned in the fix round (combined-w21-s1-fix-report.md)."
---

# Independent adversarial review — W2.1 (cascade-echo retirement) + W3.1/S1 (drain-settle quiescence advance) + the receipt-race flake fix

Reviewer: independent (read-only; nothing pushed, nothing commented).
Date: 2026-08-19/20. Worktree: `/Users/berni/labs-worktrees/review-combined`,
detached at `4bf914a70` (= `origin/claude/server-exec-v2-w3-alpha` tip at
review start — exactly the expected tip). Every deno invocation `--no-lock`;
suites foreground; every probe reverted; tree clean at the end (§6).

## Ranges reviewed (stated per the brief)

- **W2.1**: `git diff 4d44b7261..ac30dd233 -- packages/`. The code sits in
  the three rebased commits `25451ed95` (fix + pins), `fb34b9fa9` (lunch
  step + churn counters), `9164d4c40` (witness refinement); the other five
  commits in the range are docs-only (no `packages/` hunks). Verified: this
  rebased delta is **byte-identical** (modulo `index` lines) to the original
  branch delta `6bec4a4bb..8efff7925` on
  `claude/server-exec-v2-w2-intent-listener` (the commits PR #6039's W2.1
  report names as `1afe64c13`/`145cf8680`/`8efff7925`), so reviewing the
  rebased range reviews the landed code. Files:
  `packages/runner/src/speculation/overlay-destination.ts`,
  `packages/runner/test/speculation-intent-listener.test.ts`,
  `packages/runner/test/speculation-intent-test-utils.ts`,
  `packages/patterns/integration/lunch-poll-vote.test.ts`,
  `packages/patterns/integration/cfc-browser-helpers.ts`.
- **W3.1/S1 + flake fix + skip lift**: `git diff e386a01be..4bf914a70 --
  packages/ tasks/` — commits `7ee58e35c` (S1 + spec + pins), `78959c26c`
  (receipt-race pin fix), `f250feacd` (register only), `4bf914a70` (skip
  lift: `tasks/` + docs only — so the ON binary built at `f250feacd`
  carries the tip's `packages/` code exactly).

## 1. Verdict

**LANDABLE-WITH-FIXES.** No blocker under the brief's definitions: no
stranded-echo class W2.1 *reintroduces* (finding 1 is a class W2.1
*misses* — those echoes stranded before W2.1 too), no masked-value class
S1 misses beyond its own flagged residue family (finding 2 is a new,
narrow, self-inflicted member of that family — same consequence bounds as
flagged residual (i), heals on the next authored input), no lost or
duplicated delivery anywhere (verified in code, pins, and my own store
archaeology), and no OFF change (both deltas live entirely inside
ON-only constructs; OFF witnesses green). Two MAJOR findings each have a
small, local, probe-validated fix shape and should land as a fast-follow
(or before the train merges, at the owner's discretion); neither
invalidates the lift or OW43's closure.

## 2. Findings by severity (file:line at `4bf914a70`)

### MAJOR

**F1 (W2.1). A LATE grandchild of a SILENT (write-less) cascade child
strands forever — the seal-time jobless check is one level deep while
the thread can be deeper.**
`packages/runner/src/speculation/overlay-destination.ts:536-541` (pre-seal
check) and `:724-729` (post-`sealInto` re-check) test only
`#terminalIntents.has(context.eventId)` and
`#terminalIntents.has(context.parentEventId)` — the DIRECT parent. A
child with an entry joins the jobless set when retired (`:1427`), so its
late grandchildren are caught — but a SILENT child (forwards only, writes
nothing) never has an entry, is never retired, and never joins the set.
Scenario: click P → silent forwarder C (no writes; thread `C→P` recorded
at `:499-503`) → P's mark arrives and `retireIntent(P)` runs (nothing to
retire; C has no entry) → grandchild G (parentEventId=C) seals LATE (a
parked dispatch on a busy client — the exact timing the committed
W2.1-3 pin already exercises for the entry-having-child variant). G
passes both jobless checks, REGISTERS, and nothing ever retires it: P's
retirement already ran; G's client-derived entity doc is never written by
the server, so the sweep's arrival gate (`:1770-1777`,
`confirmedSeq === 0` → never arrived) never passes — even after S1. This
is the stranded-echo class the whole delta exists to retire (a false
rendered value standing indefinitely), surviving through one gap.
**Probe-verified** (probe P1, §3): `entryCount=1, dropped=false,
retired=false` — registered, uncounted, stranded. Not a regression (this
class stranded pre-W2.1 too) — an incompleteness of the fix; the
committed pin W2.1-3 covers the silent child's grandchild only when it
seals BEFORE the mark. Reachability: the silent-forwarder ("router")
hop is not exotic — it is the shape the thread map was BUILT for (the
W2.1 report §1: "a 'router' child that only forwards … still links its
grandchildren to the root"), and the late-dispatch timing is the same
one the committed pin already models for the entry-having variant; a
3-hop cascade with a silent middle hop under client load hits it.
**Fix shape** (small, local): make both seal-time jobless checks walk the
`parentEventId` chain through `#cascadeParents` (the same bounded walk as
`#cascadeReaches`, on ids instead of entries — P is in `#terminalIntents`
via `#settleIntentConsequence` `:1177`, so a chain walk finds it), and
extend pin W2.1-3 with the late-grandchild-of-silent-child case.

**F2 (S1). The once-per-transition latch is consumed even when the
advance-only wave picked up CONTENT mid-seal — the folded content's seq
is then uncovered until the next authored input (a narrow, unflagged
member of the stall-residue family).**
`packages/runner/src/executor/space-server.ts:3525-3539`. The seal-outcome
block runs arm-then-consume: `#ownWaveSeqs.add`; arm if
`closing.contentContributionCount > 0`; then, if this cycle's quiescence
advance sealed (`settleAdvanceFrom !== undefined`), consume
(`#settleAdvanceOwed = false`). But the advance's wave can CARRY content:
between the gate snapshot (`:3272-3285`, where `!haveContributions` held)
and `#currentWave = undefined` (`:3404`), the cycle awaits the watermark
tx commit (`:3379`) and `#sealChain` (`:3405`) — and any transaction
sealing in that window joins the still-open closing wave (`#openWave()`
`:1284-1289` reuses `#currentWave`; the seal path `:1150-1202` chains into
it; post-commit async builtin work is explicitly NOT awaited by the
settle, serving-loop.md §3). In that interleaving the wave commits with
both the advance AND the content; the content arms the latch and the
consume immediately erases it; `advanceTo` (computed before the fold) sits
BELOW `outcome.seq`; the next echo cycle finds the latch false → no
advance. If the space then stays quiet, a client floor that includes
`outcome.seq` (the folded content was pushed and re-derived over) is
unreachable until the next authored commit — the swatch-stall shape,
reintroduced in a microtask-wide race. Same consequence bound as the
builder's FLAGGED residual (i) (late authored record): stall until next
input, not forever — but this one is S1's own bookkeeping and is NOT
flagged. The register even defends the ordering ("the arm precedes the
consume; stated … so nobody 'fixes' the ordering") — that note justifies
mutation B's inertness (§3), not this interleaving.
**Fix shape** (one line, probe-validated): gate the consume on the
advance wave having stayed bookkeeping-only —
`if (settleAdvanceFrom !== undefined && closing.contentContributionCount === 0)`
consume; otherwise leave the latch armed so the next quiescence covers the
folded tail. I ran the full `executor-settle-advance` + `executor-serving-loop`
suites under exactly this patch: **28/28 steps green** (§3, probe S1-P3) —
the fix does not disturb the designed once-per-transition behavior, the
no-self-chase pin, or the stability pin. (A deterministic RED repro of the
race itself needs a mid-seal content injection seam — the same
shim-shaped gap the builder's flag (ii) names for the walk property; I
did not build one either. The interleaving argument is structural:
every element verified at the cited lines.)

### MINOR

**F3 (S1 pins). The client-visibility clauses of the S1 pins are
transport-blind to the production push half (`noteExecutorCommit`).**
Probe S1-P1 (§3): with the advance wave's `noteExecutorCommit` call
skipped (`space-server.ts:3573-3582` guarded off for
`settleAdvanceFrom !== undefined`), **all four S1 pins stay green** —
pin 1's `waitForSettled` sink self-satisfies through the emulated
transport / initial sync pull, pin 2's already-installed watermark sink
likewise. So the build report's "the advance reaches the client through
the ordinary watermark-doc push, which pin 1 verifies end to end" is
overstated for the PUSH mechanism specifically: the pins bind the doc
write (engine-direct read) and client arrival under the emulated
transport, not the M4 push notice. Compensating evidence: the real-binary
lunch gate (6/6 + my own run, §5/§6) exercises the production push — a
1 ms swatch wall on flickering runs requires the advance to reach the
browser. Fix shape: run pin 1 against a `subscriptionRefreshDelayMs:
"manual"` server, or assert the server `push` counters moved for the
advance wave.

**F4 (W2.1). The flicker counter systematically under-counts the
coalesced-purged shape.** The witness (`overlay-destination.ts:1456-1476`)
reads "arrived" when ANY written doc's confirmedSeq ≥ the mark frame's
seq. When both clicks mark in ONE commit that carries the OTHER voter's
confirmed add while THIS voter's child was purged (the root-cause
report's green-run shape s6/s13), the shared list doc moves to the mark's
own seq via the foreign write → reads arrived → the purged voter's real
one-wave flicker is NOT counted. This is the getter's disclosed
misreading (b) (`:398-400`) — disclosed abstractly, but it maps onto a
COMMON shape, and the owner just designated this counter the
(b)-decision instrument, so the blind spot should be named in the
register next to the W2.1 row. Directionally the counter also
over-counts (equality-cutoff, disclosed (a); late same-frame sidecar
appends over-stating markSeq — report §8 decision 2). No uncounted
retirement: `cascadeEchoRetirements` increments for every cascade
retirement unconditionally (`:1426`); only the unarrived SUBSET is
heuristic. No count without a retirement: the witness runs strictly
inside the retirement loop. Armed only on the consequenced non-error arm
(`:1300-1304`), verified; dropped/errored/refused arms pass no witness.

**F5 (W2.1). Stale doc-comment on the decision instrument.**
`packages/patterns/integration/cfc-browser-helpers.ts:1980-1985` — the
`overlayCascadeEchoFlickers` docstring still says "retired while NO doc
the echo wrote had yet moved past its BASIS": written in `fb34b9fa9` and
not updated by `9164d4c40`, which re-keyed the witness on the MARK
frame's seq (that re-keying being the entire point of the third commit).
Anyone reading the churn line's docs mis-learns the semantics. One-line
comment fix.

**F6 (W2.1). Prune-eviction of a live chain link strands silently, with
no counter.** Probe P2 (§3): flooding `#cascadeParents` past its 4096
bound between a silent child's seal and its root's mark evicts the live
`C→P` link; at the mark the grandchild's walk stops at the evicted link —
`entryCount=1, retired=0, drops=0`: stranded, uncounted. Requires 4096
cascade seals within one intent round trip — implausible in practice, and
the bound itself is the report's stated design (decision 1). The gap
worth one register line is the SILENCE: no counter distinguishes "walk
exhausted/evicted" from "no ancestor", so if the bound is ever hit in the
wild it presents as the original stranding with zero telemetry. (Same
observation applies to the depth-64 cap, `:1229`.)

**F7 (S1, nit). `#ownWaveSeqs` grows unboundedly on a space whose W is
persistently clamped.** Pruned only when W advances past entries
(`space-server.ts:3533-3535`); exhausted/clamped waves keep adding seqs.
A wedged shadow floor already surfaces as `watermarkClamped` churn, and
entries are numbers — memory is theoretical, but a bound (or a prune on
park) would make it airtight. No action required for landing.

### Notes (no action)

- **S1 quiescence-gate vs the amended sentence** (axis 4): the gate
  (`:3272-3277`) checks `!exhausted` (settled non-exhausted cycle),
  `!haveContributions` + `!havePendingEffects` (no contributions),
  `#feed.length === 0` + `!#eventScanOwed` (no pending events / drain
  empty) + `#pendingWaveSeals === 0` + `!#effectsRetirementOwed`
  (stricter than the sentence). One approximation: during a DEFERRED
  event-rescan window (`#armDeferredRescan` timer armed, `eventScanOwed`
  false) a pending-but-deferred stream event exists while the gate
  passes — harmless, because the deferred event's AUTHORED seq is a hole
  the walk cannot cross, so W stays below it; the walk, not the gate, is
  the soundness belt. The gate conditions are otherwise a superset of
  the spec's.
- **Push-reorder soundness** (axis 3, first question): the advance CAN
  reach a client before an earlier content commit's push, but retirement
  additionally requires every written doc's `confirmedSeq ≥ floor`
  (`overlay-destination.ts:1769-1777`), so W alone can never retire a
  layer whose authoritative value has not arrived. No lost value from
  ordering. `waitForSettled` semantics also safe: the walk can never
  cross an AUTHORED seq (authored seqs are never own-wave seqs, and seqs
  are dense), so `W ≥ my-authored-seq` still implies consequence
  coverage — probe of the walk's construction, verified at `:3280`
  against `#ownWaveSeqs`'s single producer (`:3525`, wave-commit
  outcomes only).
- **The advance's own commit and the "never chased" bound**: the latch
  consume is the no-chase mechanism (mutation B2 storms without it —
  reproduced, §3); the advance-only commit itself enters `#ownWaveSeqs`
  and is legitimately covered by the NEXT quiescence advance after later
  content (the spec's "the one derived commit W does not cover AT
  QUIESCENCE is the FINAL advance-carrying commit" — consistent).
- **`#recordSettleCoverage(advanceTo)` on the advance path is a no-op
  for the per-input settle series** (it only covers `#pendingSettles`
  entries ≤ coveredThrough, and no input seq can lie inside the advance's
  derived-only range) — so the "split from the settle series" claim
  holds; verified at `:998-1026`.
- **Two intents sharing a descendant id — impossible by minting** (axis
  1): `mintEventId` (`scheduler/event-identity.ts:26-36`) keys cascade
  ids on a per-transaction `crypto.randomUUID()` + send counter; retried
  attempts run in a new tx (fresh key). Collision = UUID collision,
  negligible. `#noteCascadeParent`'s first-wins insert (`:1208`) is
  therefore unreachable ambiguity.
- **Depth-64 cap** (axis 1): a >64-deep cascade descendant silently
  strands (pre-W2.1 posture); ids fresh per attempt so no cycles; cap
  plausible. See F6 for the telemetry note.
- **Jobless set × MAJ-1 live-set gate / re-entrancy** (axis 1): the
  MAJ-1 pin (re-entrant `trackIntent` inside an outcome callback) runs
  green in the suite; a re-fire mints fresh ids so the jobless set (ids
  only) cannot mis-drop it; `retireIntent` iterates a snapshot
  (`[...entries.values()]`, `:1420`) and a seal landing mid-retirement is
  caught by the post-`sealInto` re-check (`:724`) — modulo F1's
  depth-one gap, which is the real finding there.
- **A parent that NEVER reaches a terminal consequence** (axis 1): its
  cascade descendants strand exactly as the parent's own echo does in
  the fail-soft posture — stated in the W2.1 report (§1 end, §8
  decision 3: the W backstop does NOT cascade; the backstop sweep
  `:1779-1787` retires only the covered entry). Descendants whose docs
  include client-derived entity ids also fail the arrival gate forever.
  Pre-existing posture, honestly stated by the builder; F1 is the case
  where a terminal consequence DID arrive and the machinery still misses
  a descendant.
- **The lunch-gate step rewrite** (axis 1/6): `participantChipNames`
  descends shadow roots, keeps duplicates, and the step requires exactly
  {Alice, Bob} on BOTH browsers plus "2 joined" on both — RED on a
  standing echo (duplicate name / three chips), and its wall in every ON
  run ≥ a server round trip (253-256 ms observed, vs 7-16 ms on the
  stranded echo). The step change is honest and OFF-green (builder's o1
  run; the helper is arm-agnostic).

## 3. Mutation-probe table

All probes on `4bf914a70`; code restored (`git restore`) and `git status`
clean after each; every deno invocation `--no-lock`; the runner's package
flags + `--preload=test/clock-preload.ts` used throughout.

| # | delta | mutation / probe | expectation | observed |
|---|---|---|---|---|
| R1 | W2.1 | **builder M1 reproduced**: `#cascadeReaches` → always false | pins W2.1-1..4 + e2e RED, rest green | RED exactly: 2 test failures / 5 failed steps — the four scripted pins + the e2e pin; 1 other test green (11s) |
| R2 | W2.1 | **builder M4a reproduced**: witness keyed on the echo's basis (`> entry.confirmedFloor` instead of `>= markSeq`) | pin W2.1-4 RED (P3 concurrent-writer case reads arrived) | RED: exactly 1 failed step (W2.1-4), unarrived 1 ≠ 2 |
| P1 | W2.1 | **own**: LATE grandchild of a SILENT child, sealing after P's mark | drop at seal or retire (contract) | **registers and strands**: `entryCount=1 dropped=false retired=false` → finding F1 |
| P2 | W2.1 | **own**: evict the live `C→P` link by flooding 4096 cascade seals before the mark | retire, or honestly counted | **silent strand**: `entryCount=1 retired=0 drops=0` → finding F6 |
| R3 | S1 | **builder mutation A reproduced**: fire gate disabled | pin 1 RED on the frozen-W wait | RED with the builder's exact message: `timed out waiting for the drain-settle advance past the authored coverage (W frozen at input coverage; derived tail 4)`; pins 2, 3+5 also red; OFF pin green |
| R4 | S1 | **builder mutation B2 reproduced**: latch consume removed | pins 3+5 catch the storm (~920 ms) | RED in 836 ms: `settleAdvances.count` 197 vs ≤ 4 (the storm) |
| S1-P1 | S1 | **own** (coordinator's suggestion): advance wave skips the client push (`noteExecutorCommit` guarded off) | pin 1/2 catch the client never healing | **NOT caught — all 4 pins green** → finding F3 (transport-blind pins) |
| S1-P2 | S1 | **own**: register's mutation-B-inertness claim verified (latch armed on EVERY wave, bookkeeping included) | inert per the register | confirmed inert: 4/4 steps green — the register's vacuity admission is accurate |
| S1-P3 | S1 | **own**: F2's fix shape (consume only when `closing.contentContributionCount === 0`) | designed behavior undisturbed | `executor-settle-advance` + `executor-serving-loop`: **28/28 steps green** — fix is safe against the whole pinned population |

## 4. The S1 builder's five flags — each verified/refuted

1. **Late-authored-record hole (pre-S1 conservatism, unchanged) —
   VERIFIED.** A late authored record's seq is never in `#ownWaveSeqs`,
   so the walk stops below it (fail-closed) and its coverage waits for
   the ordinary input path; nothing in the delta changes that path. The
   flag's "unchanged; pre-S1 behavior" is accurate. (F2 is a NEW sibling
   of this residue — same consequence bound, S1's own bookkeeping,
   unflagged.)
2. **Fail-closed walk property construction-guaranteed, not
   interleaving-pinned — VERIFIED, argument airtight with one stated
   dependency.** The walk (`:3278-3284`) crosses only members of
   `#ownWaveSeqs`; the set's only producer is the wave-commit outcome
   (`:3525`); engine seqs are dense and unique, so an authored/foreign
   seq is never a member and can never be crossed — the property holds
   by set membership, not timing, and a notice-holding shim would pin
   the GATE's behavior, not change the walk's soundness. The dependency:
   any own commit that bypasses `commitWave` (outbox append deliveries,
   effect completions) leaves a hole — which is CONSERVATIVE (advance
   stops), never unsound. Would a shim pin it? Yes, cheaply (hold one
   authored notice across a quiescence, assert the advance stops below
   its seq) — worth doing, not blocking.
3. **The advance's own bookkeeping commit is definitionally uncovered;
   "no known reader" — VERIFIED with a caveat.** The watermark doc id
   class is excluded from piece demand, and I found no client derivation
   reading it (the client reads it via `watermarkCell` sinks only —
   `waitForSettled` and the overlay's watermark sink, neither a stamped
   derivation). The caveat is the flag's own: nothing PREVENTS a future
   stamped reader; the flag states this honestly.
4. **Spec-model does not model the tail advance — VERIFIED.** No
   spec-model source names the advance (checked `spec-model/` for
   settleAdvance/quiescence-advance references: none); its properties
   quantify over inputs/events and remain green (suite run, §6). The
   flag's proposed follow-up row is apt.
5. **Growth-landing adjacency heuristic unchanged — VERIFIED.**
   `#recordGrowthLanding()` (`:3518`) runs for EVERY committed wave
   including advance-only waves, before the S1 block; a quiescence
   advance right after a growth wake can still take the landing slot
   (pre-existing MINOR-4). The `settleAdvances.series` timestamps make it
   cross-referenceable, as the flag says.

## 5. Axes held (summary)

1. **W2.1 retirement correctness**: correct on the pinned surfaces
   (mark/error/drop/refused arms; scope precision — pin W2.1-2's
   only-P's-cascade verified; silent-forwarder threading; late child +
   late grandchild of a retired child). Gaps: F1 (late grandchild of
   silent child — probe-verified strand), F6 (prune-eviction silent
   strand), depth-64 silent strand (note). No-terminal-parent and
   fail-soft postures stranding = stated pre-existing behavior. Jobless ×
   MAJ-1 and re-entrancy: no hazard found. Shared descendant id:
   impossible by minting (UUID-per-tx). OFF: all W2.1 state and logic
   live inside `SpeculationOverlayDestination`; pin 11 green.
2. **Flicker accounting honesty**: the retirement counter is exact; the
   unarrived (flicker) counter is a disclosed heuristic — over-counts on
   equality-cutoff, under-counts the coalesced-purged shape (F4) and
   teardown. As the (b)-decision instrument it reads LOW in one common
   shape — flagged for the register, not a code bug.
3. **S1 advance correctness**: gate ⊇ spec conditions; walk fail-closed
   by construction; no authored seq ever covered; push-reorder safe via
   the sweep's per-doc arrival gate; idempotence + no-self-chase pinned
   (storm mutation reproduced, 836 ms); busy-path neutrality pinned
   (≤ 4 over 10 inputs — not vacuous: the B2 storm demonstrates the
   counter reaches 197 when the latch breaks, and my lunch run shows 10
   advances over 53 waves, quiescence-only). Gap: F2 (latch consumed
   under a mid-seal content fold — narrow race, fix probe-validated),
   F7 (set growth nit).
4. **S1 spec honesty**: the amended §4 sentence's five quiescence
   conditions all map to checked gate variables (one approximation noted
   — deferred-rescan window — protected by the walk); serving-loop §3/§7
   additions match the implementation and the counter's real shape
   (verified against a live run's `/api/health/stats`); the sweep-comment
   rewrite (OW43's subject) is now true modulo the flagged residuals and
   F2 ("every floor is reachable on a quiet space" has the residue family
   as exceptions — the register states residuals (i)-(iii) right below,
   F2 should join them). **OW43's closure is justified**: the row's own
   trigger was S1's landing; pin 2 reproduces the row's exact defect
   (diverged layer masking a delivered value, healed with zero authored
   traffic) red-first. The builder's flagged reading (W above
   non-authored seqs) is sound: the ruled definition's quantifier ranges
   over authored commits only, and the walk guarantees no authored seq is
   ever covered by the advance — the reading changes no client-visible
   "settled" semantics.
5. **Pin vacuity**: two builder mutations per delta reproduced killing
   exactly as claimed (R1-R4); two own probes per delta added (P1, P2,
   S1-P1, S1-P2/P3). One real vacuity found (F3 — transport-blind client
   clauses); the register's one admitted inert mutation (B) verified
   inert as stated.
6. **The skip lift**: correctly recorded — one-entry patterns list, loud
   skip preserved for `topics-navigation` (OW25 + phase-7 asserted by the
   test), `SERVER_EXECUTION_ON_SKIPS.patterns.length === 1` and shell 0
   pinned, both two-browser gates asserted absent. The lift ledger in the
   header matches the build report's table exactly (6/6; totals
   3467-4334 ms; joins 254-256 ms; swatch 1 ms every run; 11/12 ×4 +
   11/11 ×2; {1:16} all six; settleAdvances 10-13; loads 2.3-3.7; binary
   sha `53a712cede690b6e…`). The old entry's lift condition ("W2's
   cascade-echo fix lands, or the step is re-pointed, AND ≥3/3
   fresh-store") is doubly satisfied. **My own independent spot-check
   run** (driver `run-arm.sh`, tip binary sha verified
   `53a712cede690b6e`, fresh store, posture + `No default model` +
   0 LLM keys verified in-run, port 8985, load ~2.9): **GREEN**, total
   4467 ms, join 255 ms, swatch **1 ms**, events 11/12 with
   `lt1LeftoversPurged 1` (the purge shape), settleAdvances 10
   (quiescence-only per the series), flickers 0/0, and the store's
   consequence multiplicity **{1:16}** (verified with `inspect-store.py`
   myself) — a 7th green run corroborating the ledger, in the harder
   (purged) shape. The W2.1 report's BLOCKER-class flag against lifting
   on W2.1+(α) was conditioned on the stall being un-understood; it has
   since been root-caused and class-fixed (S1), the register's flag
   updated accordingly — the lift is justified.
7. **The flake fix** (`78959c26c`): a REAL fix, not a loosened assertion.
   The failing 15 s poll raced the DESIGNED enact→ack→retire pipeline
   (entry lifetime ~1 push RTT + 1 wave); the fix adds the RETIRED
   observable — enacted navigation AND the effects doc's session
   instance existing in the ENGINE (created only by server-side work in
   this test; the client never writes its instance here — note the
   comment's "only the server's intent write creates it" is slightly
   overstated in general, since a session may author writes to its own
   instance, but no such write exists in this test). The optimistic
   enactment alone cannot satisfy the wait (instance-head witness), the
   discarded 6/6-deterministic-failure draft supports that the guard is
   load-bearing, and the pin's substance — ZERO authored-class commits
   ever touching the served target doc — is untouched; the
   target-derived-create check became awaited (same race, same
   direction). Delivery-loss still fails the test (a never-acked entry
   stays live and times out downstream asserts). The 8/8-under-load
   claim is the builder's (not re-verified under comparable load); my
   own stability check: the file green 4× consecutively at the tip
   (once in the full-suite half, then 3× targeted, 15 steps each).

## 6. Suites and probes run (counts); tree state

All foreground, all `--no-lock`, runner via its package task's exact
flags + preload (`ENV=test deno test --no-lock --no-check
--preload=test/clock-preload.ts --allow-ffi --allow-env --allow-read
--allow-write=/tmp,/var/folders --allow-run=git,deno`), split in halves
under the call cap. All at tip `4bf914a70`:

- runner half A (`test/[a-l]*.test.ts test/scheduler/*.test.ts`):
  **523 passed (4051 steps) / 0 failed** (4m53s).
- runner half B (`test/[m-z]*.test.ts`): **693 passed (2702 steps) /
  0 failed** (2m59s). Total **1216 passed (6753 steps) / 0 failed** —
  matches the S1 build report's claimed counts exactly. The OFF
  witnesses ran green inside these halves: settle-advance pin 4 (half A)
  and intent-listener pin 11 / W2.1-5 (half B).
- skip-list test (`deno test --no-lock -A
  tasks/server-execution-on-skips.test.ts`): **17 passed / 0 failed** —
  the post-lift one-entry state pinned.
- spec-model: **23 passed / 0 failed**; confirmed the model has no
  settleAdvance/tail-advance term (flag iv verified — its C10 pins W
  jumping only at input quiescence).
- Targeted runs during probing: `speculation-intent-listener` (3 tests /
  17 steps green at tip, red under R1/R2 as tabled),
  `executor-settle-advance` + `executor-serving-loop` (2 tests / 28
  steps green at tip and under the S1-P3 fix probe; red under R3/R4 as
  tabled).
- One independent lunch ON run via the builders' driver (§5 axis 6):
  GREEN with the ledger's exact shape; store multiplicity `{1:16}`
  verified by direct sqlite inspection.
- Flake-fix stability: `executor-effect-channel.test.ts` green 3×
  consecutive targeted runs (15 steps each, 12s) on top of the
  full-suite pass.
- `deno fmt --check` on all 12 delta files: clean (one transient
  "Found 1 problem" on the first batch invocation did not reproduce on
  per-file or repeat batch runs; final state clean). `deno lint` on the
  three touched src files: clean.
- Tree state at the end: `git status` EMPTY (every mutation restored via
  `git restore`, probe test file deleted); no `deno.lock` churn; the
  foreign `stash@{0}` (recipe-dx) untouched — `git stash` never used; no
  branch checkouts (worktree stayed detached at `4bf914a70`).

## 7. What I did NOT do

- No deterministic RED repro of F2's interleaving (needs a mid-seal
  content-injection seam — same shim class as the builder's flag (ii);
  the fix-shape probe S1-P3 validates the remedy against the pinned
  population instead).
- No re-run of the W2.1 builder's 6a/6b/6c lunch matrices or the
  bisect (their evidence quoted as claims; my single tip run + store
  archaeology is the independent corroboration).
- No re-run of the flake fix's 8/8 under comparable LOAD (my 4×
  consecutive greens were on a quiet box).
- OFF lunch run not repeated (the builder's o1 is the witness; both
  deltas' OFF-neutrality verified structurally + OFF pins).
- Docs commits in the ranges (register/INDEX/plan wording) reviewed only
  where they state code semantics (OW43, W2.1 rows, S1 residuals).
