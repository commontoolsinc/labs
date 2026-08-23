---
status: historical
created: 2026-08-23
archived: 2026-08-23
reason: "Scoping memo (flag-don't-fill) for a THIRD arm of the OW45 arm-B client-start fork, surfaced by the adversarial review of the ruled-(a) build: close the first-hydration refusal by NARROWING the deferred start's commit conflict set — the way two sibling rows in the same register already closed this exact refusal class — instead of by retrying it. Scope only: what the start reads into its basis, whether those reads are structurally narrowable, what it would dissolve, what it risks, and what must be measured before anyone builds it. NOT the ruled (a); it needs the owner's ruling of its own."
---

# Narrowing the basis instead of retrying it — a third arm for OW45 arm B

## Why this memo exists

The owner ruled (a) — retry the deferred start on a stale-confirmed-read
conflict — and it was built with red-first pins
(`ow45-armb-client-start-fork.md`, RULED 2026-08-22). Two things then
happened, and together they say the fork's option set was incomplete:

- **The live ON gate did not clear the lift bar.** 2 reds in 7 runs on
  an ON-built binary carrying the fix (verified: the fix's own
  exhaustion-log string is present in the artifact). Both arm-B shapes
  reproduced WITH the retry shipped — the whole-piece shape
  (`isNotebook: false`, `noteCount: -1`, `storedUiNoteChips: 98`,
  0 rendered) and the single-chain shape (`notesLength: 7`,
  `mentionableLength: 7`, `renderedNoteChips: 6`).
- **The adversarial review surfaced a third disposition** that neither
  the fork memo nor the register considered: two sibling rows in THIS
  register closed this identical refusal class by narrowing what enters
  the commit's confirmed-read set, rather than by re-running the commit.

This memo scopes that third arm. It is NOT a build, and it is NOT the
ruled (a): if it is right it REPLACES (a) rather than refining it, which
is a decision for the owner.

## The precedent, stated exactly

Both sibling closures are in `verification-coverage.md`, and both ended
at the same seat — `buildReads` in `packages/runner/src/storage/v2.ts`,
which decides what a commit asserts as a concurrency precondition:

- The `cid:` exclusion (register row at the `stale confirmed read:
  cid:… at seq 0 conflicted with seq N` delivery-gap window).
  Content-addressed documents "carry no commit-time concurrency
  precondition at all: their content can never change … so there is no
  staleness for a conflict check to find", while the client's confirmed
  basis for one it resolved from an overlay or registry is 0 and the
  doc's first INSTALL is a real revision row. Exporting that read
  "killed the commit as `stale confirmed read: cid:… at seq 0` exactly
  in the delivery-gap window the resolution fallbacks serve". The fix
  drops the read; presence is "owned by server-side closure
  validation".
- The CFC blind-write exclusion (the sibling row above it), which
  narrows a different family of reads out of the conflict set on the
  same principle — with the precondition the ruling wanted to KEEP
  (a concurrent `/cfc` change) still conflicting.

The shape of both: a read was entering the conflict set that was never
a genuine precondition, and the refusal it caused was structural rather
than a real race. Neither was fixed by retrying.

## What the failing start actually asserts

The instrumented catch that founded arm B names its conflicted entity
precisely (run b04, `ow45-armb-client-start-fork.md`):

```text
ConflictError: stale confirmed read:
  computed:fid1:1PlbDz… at seq 0 conflicted with seq 10
```

The conflicted id is **`computed:`-kinded**, and that scheme is not
decoration. `packages/runner/src/entity-kind.ts` defines it as a
SEMANTIC property of the entity: `computed:fid1:<hash>` "names an
entity whose contents are re-derivable by the runtime that minted it",
and the kind exists to say "what conflict policy the server may apply".
The same grouping already appears in the serving loop:
`neverAPieceRootId` (`executor/space-server.ts`) treats
`computed:`-prefixed ids in the same structural class as `cid:` ones.

So the client's deferred start is asserting a CAS precondition — "this
computed document was absent at seq 0" — over a document whose content
is by definition re-derivable, and which under the flag the SERVING side
owns and is materializing at that very moment. That is the same
category error the `cid:` exclusion corrected, in a different scheme.

## The candidate, and its scoping questions

**Candidate:** drop `computed:`-kinded reads from the commit's confirmed
conflict set at `buildReads`, beside the `cid:` exclusion that is
already there.

If that holds, the race DISSOLVES rather than being re-run: the start
commits without asserting a precondition it has no business asserting,
on BOTH arms, with no retry, no bound to justify, no readiness gate to
depend on, and none of the re-entrancy hazards a retry introduces (the
review confirmed one such regression in the shipped (a): a re-attempt
token minted with no lifecycle check, repopulating a map `stopAll()`
had cleared).

It is NOT obviously correct, and these are the questions that decide it:

1. **Is the exclusion sound for a VALUE dependency?** A `cid:` doc's
   content can never change, which is what made its exclusion free. A
   `computed:` doc's content CAN change — it is re-derived. A start
   that genuinely consumed a computed value and writes a function of it
   would, without the precondition, commit against a stale view. The
   counter-argument is serving-loop.md §3d's own soundness rule for
   derived state ("dropping is sound exactly because derived values are
   re-derivable"), but §3d says that about the SERVER dropping derived
   WRITES from a wave, not about a client dropping derived READS from a
   basis. That is an analogy, not a proof, and it needs the owner's
   ruling rather than an implementer's inference.
2. **Should it be scoped to reads at ABSENCE (seq 0)?** The observed
   failure is specifically a pre-birth read: basis 0 against a doc the
   server was creating. A narrow exclusion — computed-kinded reads whose
   confirmed basis is 0 — dissolves the first-hydration race while
   leaving every read of an EXISTING computed doc asserting its true
   version. This is the smaller, more defensible cut.
3. **Should it be flag-scoped?** Under ON the serving side is the sole
   deriver, so a client asserting preconditions on computed docs is
   simply wrong. Under OFF the client derives them itself, and the
   precondition may be load-bearing. A flag-scoped exclusion keeps the
   OFF arm byte-identical (testing.md §2's requirement) at the cost of
   a branch the flip would later remove.
4. **Is the start's basis ONLY computed reads?** Unverified. One
   sample (b04) names a computed doc; the h01/h05 single-chain shape
   was never traced to its conflicted entity at all. If a start's basis
   also stales on `of:`-kinded docs, this narrowing closes part of the
   class and the remainder still needs an answer.

## What must be measured before building

- **The conflict set's composition.** Instrument the refused start to
  dump its full confirmed-read set (ids and seqs), not just the single
  entity the error message names. The message reports the FIRST
  conflict the engine found; the fix's scope depends on the whole set.
  This also settles whether the review's point about the retry pulling
  only one document — the single id parsed from the message — is the
  binding limitation it appears to be.
- **Whether the single-chain shape shares the mechanism.** It reds the
  same step with a fully-started piece (7 notes, 6 chips), so it may be
  a different seat entirely. Arm B was mapped as three defects; two
  were fixed; this memo must not assume the remaining reds are one
  thing.
- **An OFF-arm neutrality witness.** Whatever the scoping decision,
  testing.md §2 requires the OFF arm to be byte-identical, and the
  review recorded that the shipped (a) has no such witness.

## Status

Recorded for the owner. Three arms now exist for OW45 arm B: (a) the
ruled and built retry, which the live gate shows does not clear the
bar; (b) adopt-not-start, recorded POST-FLIP as OW61; and this one,
which would supersede (a) rather than extend it. The instrumented
verdict on whether (a)'s retry fires at all in a red run is the other
input the owner needs, and is reported with the gate evidence in the
OW45 row.
