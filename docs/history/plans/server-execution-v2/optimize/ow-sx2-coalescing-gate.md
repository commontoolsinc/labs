---
status: historical
created: 2026-08-21
archived: 2026-08-21
reason: "The sx2-events rapid-fire coalescing gate (derivedDelta < N) flake: both read claims from the danfuzz-side writeup VERIFIED (the append queue serializes arrivals, so the ratio is a load observation the test cannot control; derivedCommits is host-global). Per-space derivedCommitsBySpace landed as observability (#6158). RULED 2026-08-21 (owner: i like (3) as well) AND BUILT: constructed-queue-depth pin in the runner suite (exactly one consequence-carrying derived commit for K queued events; mutation-verified failable), sx2 ratio assert demoted to its log line, testing.md row 3 re-tensed. §4 carries the self-contained relay summary."
---

# The sx2-events rapid-fire coalescing gate — verification and dispositions

Origin: a danfuzz-side agent's writeup (2026-08-21, routed by the
coordinator into the OW51/OW52 loss-triage pass — same machinery, same
instrumentation). The flake: `packages/patterns/integration/
sx2-events.test.ts`, assert `derivedDelta < N` ("rapid-fire coalescing:
10 derived commits for 10 events must stay well under N"),
intermittently red on the ON pattern lane on unrelated PRs; re-run
clears it. Their measurements: CI passing runs log exactly 7, the
failing run 10; locally 4–5 over ~20 runs. Additional evidence (the
owner's ON-flake census, 2026-08-21 — 123 runs, 25 ON failures, its
item 4): one more CI occurrence at 15:25Z on #6136 with the
same-commit rerun green — the load-ratio shape exactly as analyzed
below; the disposition (owner ruling on the gate) is unchanged.

Relation to OW52, stated first because the two were plausibly one
question: they are NOT. The OW52 storm accounting
([ow52-storm-loss-report.md](ow52-storm-loss-report.md)) shows
coalescing collapses WAVE BOUNDARIES only, never handler runs — every
event runs its handler and lands its consequence exactly once
(40/40, zero duplicate `consequenceOf` entries). Nothing in the storm
dies at coalescing; its red was a harness settle race. So sx2's ratio
gate is purely a batching-EFFICIENCY observation, with no loss
question attached anywhere.

## 1. The two read claims, verified (main @ ce92b445f)

**Claim 1 — the client cannot control server-side arrival pacing:
VERIFIED.** `EventAppendQueue.#drain()`
(`packages/runner/src/storage/event-append-queue.ts`) sends STRICTLY
ONE entry per `ClientCommit`, sequentially — `#nextSendable()` →
`await this.#transact(this.#commitFor(next))`, one append patch + one
`EventAppendDecl` per commit, "strictly one in-flight append per
space" (the file's own ordering contract). OW27 pacing (default 20/s,
burst 20) never holds the test's 10 fires (burst covers them), so the
serialization is the one-in-flight rule alone: the 10 appends arrive
at the server spaced by one client→server commit round trip each,
regardless of the 0.4 ms fire loop. How many appends a wave finds
queued is therefore the ratio of round-trip time to wave time — a
LOAD RATIO the test has no lever on. A server fast enough to cover
each append individually derives 10× and coalesces nothing while
breaking no contract — from this counter, indistinguishable from the
v1 no-coalescing failure the bound exists to catch. Corroborating
runs from this triage: an idle dev machine logged exactly **7** (the
CI passing value); the OW52 storm (40 events, two writers pipelining)
produced 16 waves with `coalescedPerWaveMax` 11 — the ratio moves
with load and nothing else. Note the acceptance criterion's own
wording presumes what the test cannot enforce: "N events fired
**faster than wave time**" (testing.md §5 row 3) — over the wire, the
fire rate does not set the arrival rate.

**Claim 2 — `derivedCommits` is host-global: VERIFIED.**
`ServingLoopStats` is ONE process-wide object (the ExecutorHost
registers a single provider; `stats()` merges per-space state only
for `activeSpaces`/`watermarkLag` — `packages/runner/src/executor/
stats.ts`, `host.ts`). Both increment sites
(`space-server.ts` — the wave commit and the served-intent seal path)
add into the same total across every space. Two concrete cross-space
pollution paths exist on a shared lane toolshed even with files
running sequentially: (i) the S1 drain-settle quiescence advance — an
advance-only derived commit a PREVIOUS file's space mints when it
goes quiet, with no client input; the OW52 archaeology records one
(its run's commit seq 59: sole write the watermark doc, `replace
/value/seq → 58`, `derived_through: 58`, no `consequence_of` — the
S1 signature), landing after that test's assert had already read and
within the same second its process exited — see
[ow52-storm-loss-report.md](ow52-storm-loss-report.md) §3's
advance-only bullet; (ii) a parked
space reactivating and re-deriving. No evidence either caused the
observed 7→10 (concurring with the writeup); the path is open, and
retroactive decomposition is impossible precisely because the counter
is global — which is the observability hole below.

Kept regardless (concurring): the case's two DETERMINISTIC asserts —
`events.processed` delta ≥ N, and the final-only value
`assertEquals(latestValue, beforeRapid + N)` — are real contract
pins and stay.

## 2. Per-space scoping: LANDED (observability, not a fix)

`derivedCommitsBySpace: Record<string, number>` +
`derivedCommitsBySpaceDropped` in `ServingLoopStats`, bumped at both
`derivedCommits += 1` sites through one helper
(`bumpDerivedCommits` — total and row in lockstep, conservation
tested), bounded like `settle.series` (256 spaces, oldest row evicted
into the dropped fold), deep-copied in the host's `stats()` snapshot
like the settle series. Red-first unit test:
`packages/runner/test/executor-stats.test.ts` (lockstep, cap
eviction + conservation, evicted-space re-entry). Verified live: the
health route serves the block, and an sx2-events ON run attributes
all its derived commits to its one space.

This also serves the OW52-style accounting directly: the storm triage
needed a dedicated fresh toolshed purely because the counters were
host-global; per-space rows make that accounting possible against the
shared lane toolshed. It does NOT fix the flake — claim 1's load-ratio
sensitivity is untouched.

## 3. The gate: three dispositions (RULED 2026-08-21 — see the recommendation block)

The bound is named in the Phase-3 acceptance criterion (testing.md §5
row 3: "rapid-fire coalescing: N events fired faster than wave time
yield ≪N derived commits and final-only values") and the Phase-7 flip
bar leans on that table — so retiring OR re-tensing it is an owner
call. Evaluated:

1. **The writeup's fix — drop the `derivedDelta < N` assert, keep the
   log + the two deterministic asserts.** Kills the flake honestly
   (the assert measures load, not contract) but retires the
   criterion's coalescing half with NO replacement assert anywhere —
   D-v2-2's commit-level batching would be gate-less.
2. **Per-space scoping alone** (landed above). Closes only the
   claim-2 pollution path; claim 1's load sensitivity survives — a
   fast idle server still legitimately derives 10× and reds the
   assert. Concurring with the writeup: it does not fix the flake.
3. **Replace the raced ratio with a CONSTRUCTED-queue-depth pin —
   FEASIBLE, and the recommendation.** The runner suite already has
   the levers: `executor-events-down.test.ts` can accumulate K
   durable, unconsequenced entries AHEAD of any drain and then hand
   them to the serving loop at once. (At evaluation time this text
   cited the `GatedStorageManager` `syncGate` drain-park; the BUILD
   below uses the suite's even simpler construction — fire K with NO
   serving host, then bring the host up, the restart pin's
   activation-scan shape — same constructed premise, fewer moving
   parts.) The pin: K=10 events queued durably before dispatch, one
   drain scans them all; assert (i) K completed runs, one consequence
   naming each (exactly-once, deterministic), and (ii) the K
   consequences land in ≪K derived commits. The premise the current
   test races ("faster than wave time") becomes CONSTRUCTED
   ("K entries queued ahead of one drain"), so a red means batching
   is actually broken (one commit per queued handler run — the v1
   failure shape), never that the server was fast. The criterion
   RE-TENSES instead of retiring.

**Recommendation: (3) + (1)-at-the-sx2-surface — RULED AND BUILT
(2026-08-21).** The owner, on these dispositions:

> i like (3) as well

— owner (Berni), 2026-08-21. Built in the same pass:

- **The constructed-queue-depth pin** (runner suite,
  `packages/runner/test/executor-events-down.test.ts`, the
  "rapid-fire coalescing under CONSTRUCTED queue depth" step): K=10
  events fired with NO serving host (each append commits durably;
  nothing processes them), then the host comes up with a flush
  deadline far above the batch's work and an authored poke activates
  the space — the activation reprocess scan (serving-loop.md §6 step
  4) finds all K pending at once. (§3's disposition cited the
  syncGate drain-park lever; the build uses the even simpler
  no-host/activation-scan construction — the same constructed
  premise, fewer moving parts, and the shape the restart pin already
  proves deterministic.) Asserts, all deterministic and
  load-independent: K completed runs (the non-idempotent value
  reaches exactly K, and never overshoots), each eventId consequenced
  by exactly one derived commit, and **exactly ONE
  consequence-carrying derived commit for the whole batch** — the
  premise the live surface could only race is CONSTRUCTED, so a red
  means batching is actually broken. Failability mutation-checked:
  with the flush deadline mutated to 1 ms (every cycle cuts — the
  per-run-commit shape the criterion exists to catch) the pin goes
  RED; restored, all 19 steps green.
- **The sx2-surface demotion**: `sx2-events.test.ts`'s
  `derivedDelta < N` assert is now its console.log line only, with
  the ruling cited in place; the two deterministic asserts
  (processed ≥ N; the final-only value) stay untouched as that
  surface's gates.
- **The criterion re-tensed**: testing.md §5 row 3 now names the
  runner-suite pin as rapid-fire coalescing's discriminating half and
  the live surface's ratio as a logged load observation, with the
  RULED marker and attribution.

## 4. Relay summary (self-contained, for the danfuzz side)

Your flake report on `sx2-events`' `derivedDelta < N` assert was
verified in full and the assert is retired, replaced by a stronger
deterministic pin:

1. **Both your read claims were confirmed in code.** The client's
   event-append queue sends strictly one entry per commit, one
   in-flight per space — so server-side arrival pacing equals the
   commit round-trip time regardless of fire-loop speed, and how many
   appends a wave coalesces is a load ratio the test cannot control
   (an idle bench here logged exactly 7, your CI-passing value; the
   owner's census added an occurrence at 15:25Z on #6136,
   same-commit rerun green). And `derivedCommits` was host-global; a
   concrete cross-space pollution path exists — an advance-only
   quiescence commit minted for an EARLIER test's space with no
   client input, recorded with its store evidence in the committed
   OW52 report (`ow52-storm-loss-report.md` §3's advance-only
   bullet: sole write the watermark doc, no `consequence_of`).
2. **What landed.** (a) `derivedCommitsBySpace` — per-space
   derived-commit attribution on the health route (bounded, conserved
   against the global total; #6158) — so future ratio observations
   can scope to the test's own space. (b) The ratio assert is DEMOTED
   to the existing log line; `sx2-events` keeps its two deterministic
   gates (every event processed; final-only value). (c) The
   coalescing CONTRACT moved to a runner-suite pin that CONSTRUCTS
   the premise the live surface races: K events queued durably ahead
   of one drain must consequence in exactly one derived commit, each
   event exactly once — deterministic, load-independent, and
   mutation-verified failable.
3. **The ruling.** Owner (Berni), 2026-08-21: "i like (3) as well" —
   option (3) (the constructed-depth pin) plus option (1) (demote the
   live-surface ratio to a log), as dispositioned in §3. The Phase-3
   acceptance criterion (testing.md §5 row 3) is re-tensed
   accordingly with the RULED marker.
4. **The CI-visible effect, in CI terms.** The intermittent red of
   `Pattern Integration Tests / server-execution ON` on
   `sx2-events.test.ts`'s "rapid-fire coalescing" assert — the flake
   your writeup reported, which cleared on same-commit rerun —
   CANNOT RECUR: the assert no longer exists (the ratio only logs).
   Its replacement red, should batching ever actually break, appears
   in the `Test` (runner unit) lanes as the deterministic
   `executor-events-down.test.ts` constructed-depth step — same
   commit, every run, no rerun-clears-it ambiguity.

Status: claims verified; §2 landed (#6158); the ruling BUILT — pin +
demotion + criterion re-tense in one PR.
