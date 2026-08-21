---
status: historical
created: 2026-08-21
archived: 2026-08-21
reason: "The sx2-events rapid-fire coalescing gate (derivedDelta < N) flake: both read claims from the danfuzz-side writeup VERIFIED (the append queue serializes arrivals, so the ratio is a load observation the test cannot control; derivedCommits is host-global). Per-space derivedCommitsBySpace landed as observability. Three dispositions evaluated; recommendation (owner ruling required): constructed-queue-depth pin in the runner suite + demote the sx2 ratio assert to the logged line."
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

## 3. The gate: three dispositions (owner ruling required)

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
   the exact lever: `executor-events-down.test.ts`'s
   `GatedStorageManager` `syncGate`/`syncGateWhen` parks the serving
   DRAIN at the sidecar-doc sync, deterministically, before any
   entry's guard check (built for the seal→outcome-window pin). The
   pin: park the drain, commit K=10 event appends (K durable entries
   accumulate pending), release — the drain scans all K in one pass;
   assert (i) K completed runs, one consequence naming each
   (exactly-once, deterministic), and (ii) the K consequences land in
   ≪K derived commits. The premise the current test races
   ("faster than wave time") becomes CONSTRUCTED ("K entries queued
   ahead of one drain"), so a red means batching is actually broken
   (one commit per queued handler run — the v1 failure shape), never
   that the server was fast. The criterion RE-TENSES instead of
   retiring.

**Recommendation (not decided here): (3) + (1)-at-the-sx2-surface.**
Land the constructed-depth pin in the runner suite as the criterion's
coalescing assert; demote sx2's `derivedDelta < N` to its already-
present logged line (the browser-facing surface keeps processed ≥ N
and the final-only value as its asserts). With §2 landed, the sx2 log
can also scope its reported delta to the test's own space. The
testing.md row change ships only after the ruling; the replacement
pin can be prepared on a branch meanwhile.

Status here: claims verified, §2 landed, dispositions written. The
option-3 pin is NOT built in this pass (the OW51 investigation is the
queue's remaining mandated item); its feasibility evidence is the
existing gate machinery cited above.
