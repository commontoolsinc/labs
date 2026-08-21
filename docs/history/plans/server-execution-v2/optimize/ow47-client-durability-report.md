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

## 2. Trace log (S-E)

_(pending — next update)_

## 3. Findings

_(pending)_

## 4. Fix design + which-direction argument

_(pending)_

## 5. Flagged (flag-don't-fill)

- _(accumulating)_

## 6. Skip-entry status / joint-lift readiness

_(pending)_
