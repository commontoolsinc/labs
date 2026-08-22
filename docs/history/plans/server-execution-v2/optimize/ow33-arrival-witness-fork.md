---
status: historical
created: 2026-08-22
archived: 2026-08-22
reason: "Fork memo for the owner (flag-don't-fill): the speculation overlay's arrival-gated retirement (RULED 2026-08-16) is implemented as a doc-granular seq comparison that accepts an AUTHORED structure write at the floor as the arrival witness — the client's own setup for a new instance, a prior session's for a resumed one — retiring first-run speculations before the served value lands (the OW33 pattern-and-data-persistence flake). Five candidate witness predicates with their edges (four inference predicates over the confirmed record, plus the explicit arrival signal); a recommendation on file; no build until ruled."
---

# The arrival-witness fork (OW33) — what counts as "the authoritative derivation has ARRIVED"?

## The ruled sentence

Speculation.md §4's arrival-gated retirement (RULED 2026-08-16, the
OW32 close): a speculation entry

> retires only once every one of [the doc instances this run wrote]
> holds a CONFIRMED value at seq ≥ the entry's floor — the
> authoritative derivation for the instance this client reads has
> ARRIVED — not on watermark coverage of the basis alone.

The rationale in the same rule names the failure class this exists to
prevent: "Coverage without arrival is exactly the retire-to-nothing
loop (OW32) … The echo stays until the authoritative value lands."

## The hole (evidence: ow33-triage-report.md §2)

The implementation (`overlay-destination.ts` `#sweep`) witnesses
arrival as `speculationRetirementView(doc).confirmedSeq >= floor` —
doc-granular, class-blind. A FIRST-RUN speculation of a just-created
(or just-resumed) piece breaks it:

- an authored SETUP commit writes the computed docs' STRUCTURE (the
  creation act — sanctioned, protocol.md §1): the client's OWN phase-3
  setup at seq S for a NEW instance, or a PRIOR session's setup commit
  for a RESUMED one;
- the speculative run's reads sit on that same commit, so its
  `floor` = that commit's seq;
- so `confirmedSeq(computed doc) = floor` holds, and the entry retires
  the moment ANY watermark ≥ floor stands at the client — on the
  AUTHORED structure write, never a derived value. **The store-proven
  invariant (both decoded red stores, both victim arms, independently
  reproduced by the #6195 review):** the covering watermark reaches
  the client at least one frame BEFORE the victim's served value, and
  the only confirmed cover at/above the floor is that authored
  structure write. How W gets ahead, honestly scoped: an EXHAUSTED
  wave FREEZES the watermark (space-server.ts — `inputAdvanceTo` and
  `derivedThrough` both take `this.#watermark` when `exhausted`), so
  under budget exhaustion the covering W rides a LATER values wave or
  a VALUES-FREE advance commit; with several writers in one settle,
  demand-arrival order can put the victim's writer in a later wave
  while W rides the first values wave; and for a RESUMED instance the
  covering W can simply PRE-EXIST from a prior wave (observed: entries
  retired at seal against a values-free `watermark→7` commit while
  the victim's values rode the new settle's FIRST values commit).
  The read then sees `undefined` for 40–260 ms (measured). This is
  the ruled sentence's own excluded class, one notch narrower:
  not "never served" but "served frames later".

The fix direction is therefore DETERMINED (the sentence stands; the
witness must actually witness the authoritative derivation). The
predicate is not: the rulings do not say how the replica tells "the
authoritative derivation arrived at seq ≥ floor" apart from "some
confirmed write exists at seq ≥ floor". That choice has semantic
edges, so it ships as this fork memo rather than a locally-plausible
fill.

## Candidate predicates

**(A) Class-aware cover.** Arrival = a confirmed cover of the doc at
seq ≥ floor whose covering commit is DERIVED-class (protocol.md §1's
producer vocabulary — the authoritative derivation IS a derived
commit; a handler echo's authoritative consequence likewise rides a
derived commit).
- Plumbing: the replica's `ConfirmedVersion` (storage/v2.ts) carries
  no commit class today; frames/promotions would need to thread it.
- Edge: an unchanged output is NOT rewritten — settled ground,
  speculation.md's arrival-gate paragraph: "an unchanged
  authoritative value (equality cutoff — no rewrite, so the doc's seq
  stays below the floor) leaves the echo standing rather than
  retiring it, which is value-identical" — so under (A) no derived
  cover ever appears for that case and the value-identical echo
  stands, exactly today's normative posture (sub-question 1).

**(B) Strictly-above-floor, class at equality.** Arrival =
`confirmedSeq > floor`, OR `confirmedSeq == floor` with a
derived-class cover.
- Rationale: the spurious witness is exactly the equality case (the
  entry's own basis commit); a LEGITIMATE arrival that lands at the
  floor exists (a re-derivation whose run read the already-arrived
  value at seq D — floor = D = confirmedSeq, cover derived), so
  equality cannot be rejected outright.
- Edge: a FOREIGN AUTHORED write above the floor (another session's
  UI binding on a handler-write target) counts as arrival and drops
  the echo to the foreign value. That is LWW-plausible ("the store
  has spoken") but is not "the authoritative derivation" — the
  sentence's strict reading says it should NOT retire the echo; the
  consequence-mark path, not the sweep, owns that case today.
- Same class-threading cost as (A) for the equality arm only.

**(C) Exclude the entry's basis seqs (seq-keyed).** Arrival =
`confirmedSeq >= floor` where the covering seq is NOT in the entry's
basis-seq set — `{confirmedFloor} ∪ {ackedSeqOf(s) : s ∈
originLocalSeqs}`.
- IMPLEMENTABLE from state the entry already reaches, with no class
  plumbing: `commit.seq` is an INTEGER PRIMARY KEY — one seq names
  exactly one commit — so a cover AT a basis seq IS the basis commit
  (there is no "same-seq foreign write" to confuse it with), and the
  basis-commit covers are exactly the spurious witnesses in BOTH
  observed arms (new instance: `confirmedFloor` = the own setup;
  resumed instance: `confirmedFloor` = the prior session's setup).
- NOT closable by own-ORIGIN keying alone: the resumed arm's spurious
  witness is a PRIOR session's authored write, which is a CONFIRMED
  read basis, never one of the entry's own pending origins — an
  exclusion keyed on "came from the entry's own acked origin" misses
  it. The seq-keyed set above (confirmedFloor included) covers both.
- The real trade-off: seq-keyed (C) closes both arms but REFUSES
  (B)'s legitimate at-floor re-derivation retirement — a re-run that
  read the already-arrived derived value at seq D and re-wrote the
  same value has `confirmedFloor = D` and its only cover at D, which
  (C) excludes, so the value-identical echo STANDS. Standing it is
  not visually wrong (the values are equal), but a standing entry is
  an unacked pending layer, and the sweep's pending-layer rule
  (overlay-destination.ts `#sweep`: an unacked pending layer BELOW a
  later entry blocks that entry's retirement) means the stranded echo
  blocks every CHAINED entry above it on those docs until some
  strictly-newer cover lands.
- Also admits foreign authored covers above the floor as arrival
  (same as (B)'s edge, without the strict-reading escape).

**(D) Path-granular arrival.** Arrival = the written PATH holds a
confirmed value whose covering commit is ≥ floor (the structure
write at the floor never wrote `/value`, so `/value`'s cover can only
be the derivation).
- Closest to the sentence's "the store has actually spoken for the
  instance THIS CLIENT READS".
- Largest plumbing (the confirmed record is doc-granular; per-path
  cover tracking is new state), and `set`/`delete` whole-doc ops
  complicate the bookkeeping.

**(E) An explicit arrival signal.** The serving side MARKS the
derivation's arrival instead of the client INFERRING it from the
confirmed record — the derivation analogue of the events
consequence-mark path (events.md §2's `consequenceOf`, which is how
handler echoes retire first-line today; the sweep is only their
backstop).
- Shape: the wave's derived commit carries which (action, instance)
  runs it materialized (or the per-doc "this frame's write IS the
  derivation for your floor F" annotation); the overlay retires
  entries whose signal arrived, no inference over covers at all.
- Honest plumbing assessment: this is a WIRE/COMMIT-REPRESENTATION
  change, not a client-side predicate — the derived commit (or the
  push frame) must carry new metadata, protocol.md §3's
  frame-shape sentences move, and serving-loop.md §3's one-derived-
  commit-per-wave representation gains a per-run manifest. It also
  has to answer the elided-unchanged-output case explicitly (a run
  that wrote nothing still needs its signal, or those entries keep
  the standing-echo posture). Strictly the most faithful reading of
  "the authoritative derivation ... has ARRIVED", and strictly the
  most expensive; none of the inference predicates (A)–(D) need wire
  changes.

## Sub-questions the ruling should settle alongside the predicate

1. **The elided-unchanged-output posture per candidate.** Elision is
   SETTLED ground, not open: speculation.md's arrival-gate paragraph
   states it normatively — "an unchanged authoritative value (equality
   cutoff — no rewrite, so the doc's seq stays below the floor) leaves
   the echo standing rather than retiring it, which is
   value-identical." The question for the ruling is only what each
   candidate does GIVEN that sentence: (A)/(B) preserve today's
   standing-echo posture exactly (no derived cover ever appears, the
   value-identical echo stands); seq-keyed (C) additionally strands
   the at-floor re-derivation case (its trade-off above); (E) must
   decide whether an elided run still emits its arrival signal or
   deliberately keeps the standing-echo posture.
2. **Foreign authored covers on handler-write targets:** is a foreign
   session's authored write to a doc the echo also wrote "the store
   speaking" (retire) or not (hold for the consequence mark)? The
   sentence's strict reading says hold; the LWW intuition says
   retire.
3. **Scope of the fix:** derivation-kind entries only, or the
   event-handler backstop sweep too (the consequence-mark path
   already owns handler retirement; the sweep is its backstop and
   uses the same gate)?

## Recommendation (on file, not a fill)

(B) — strictly-above-floor with derived-class-only equality — is the
smallest predicate that (i) closes both observed arms, (ii) keeps the
legitimate at-floor re-derivation retirement (which seq-keyed (C)
refuses, stranding value-identical echoes that then block chained
entries via the pending-layer rule), and (iii) stays inside the ruled
sentence's vocabulary without (E)'s wire changes. It needs commit
class threaded onto the replica's confirmed record for the equality
arm only. Seq-keyed (C) is the zero-plumbing fallback if the class
threading is unwanted, at the stranding cost stated above;
sub-question 2 should be answered explicitly rather than inherited
from the predicate choice. The triage did NOT build any candidate.

## Acceptance evidence for whichever predicate is ruled

Red-first unit pin in the runner: a first-run speculation whose
written doc's only confirmed cover is the client's own authored
structure write at the floor seq does NOT retire on watermark
coverage; it retires when the served derivation's cover arrives.
Plus: `pattern-and-data-persistence.test.ts` green 10/10 at the true
ON topology (the skip entry's lift condition), and the existing
`speculation-overlay.test.ts` retirement pins stay green.
