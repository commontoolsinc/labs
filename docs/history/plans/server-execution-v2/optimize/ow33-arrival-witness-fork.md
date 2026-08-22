---
status: historical
created: 2026-08-22
archived: 2026-08-22
reason: "Fork memo for the owner (flag-don't-fill): the speculation overlay's arrival-gated retirement (RULED 2026-08-16) is implemented as a doc-granular seq comparison that accepts the client's OWN authored structure write as the arrival witness, retiring first-run speculations before the served value lands (the OW33 pattern-and-data-persistence flake). Four candidate witness predicates with their edges; a recommendation on file; no build until ruled."
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

- the client's own authored SETUP commit at seq S writes the computed
  docs' STRUCTURE (the creation act — sanctioned, protocol.md §1);
- the speculative run's reads sit on that same commit, so its
  `floor = S`;
- so `confirmedSeq(computed doc) = S >= floor = S` holds the moment
  ANY watermark ≥ S arrives — e.g. wave 1 of a budget-split settle
  serving the OTHER instance — and the entry retires on the client's
  OWN structure write while the served value is still a wave away.
  The read then sees `undefined` for 40–260 ms (measured). This is
  the ruled sentence's own excluded class, one notch narrower:
  not "never served" but "served one wave later".

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
- Edge: a wave that ELIDES an unchanged output writes nothing to the
  doc, so a derived cover never appears and the entry strands — IF
  waves elide unchanged outputs. Whether they do is a sub-question
  below; note that under today's gate this shape mostly
  self-resolves only because the speculative value equals the stored
  one (the drop is invisible), which (A) would preserve by simply
  keeping the equal-valued layer.

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

**(C) Exclude the entry's own basis commits.** Arrival =
`confirmedSeq >= floor` where the covering seq is not one of the
entry's own origin/basis commit seqs.
- Cheapest (no class plumbing; the entry already carries
  `confirmedFloor` and `originLocalSeqs`).
- Edges: admits foreign authored covers as arrival (same as (B)'s
  edge, without the strict-reading escape); and a basis commit that
  ALSO wrote the doc is indistinguishable from a same-seq foreign
  write by seq alone, so the exclusion must key on "the covering
  write came from the entry's own acked origin", which the view does
  not currently expose either.

**(D) Path-granular arrival.** Arrival = the written PATH holds a
confirmed value whose covering commit is ≥ floor (the structure
write at S never wrote `/value`, so `/value`'s cover can only be the
derivation).
- Closest to the sentence's "the store has actually spoken for the
  instance THIS CLIENT READS".
- Largest plumbing (the confirmed record is doc-granular; per-path
  cover tracking is new state), and `set`/`delete` whole-doc ops
  complicate the bookkeeping.

## Sub-questions the ruling should settle alongside the predicate

1. **Do waves elide unchanged outputs?** If a served derivation whose
   output equals the stored value writes nothing, predicates (A)/(B)
   never see a derived cover for it. (Today's behavior: the equal
   speculative layer's drop is invisible, so no user-visible defect —
   but the entry's lifetime differs by predicate.)
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
smallest predicate that (i) closes the observed hole, (ii) keeps the
legitimate at-floor re-derivation retirement, and (iii) stays inside
the ruled sentence's vocabulary. It needs commit class threaded onto
the replica's confirmed record for the equality arm only; sub-question
2 should be answered explicitly rather than inherited from the
predicate choice. The triage did NOT build any candidate.

## Acceptance evidence for whichever predicate is ruled

Red-first unit pin in the runner: a first-run speculation whose
written doc's only confirmed cover is the client's own authored
structure write at the floor seq does NOT retire on watermark
coverage; it retires when the served derivation's cover arrives.
Plus: `pattern-and-data-persistence.test.ts` green 10/10 at the true
ON topology (the skip entry's lift condition), and the existing
`speculation-overlay.test.ts` retirement pins stay green.
