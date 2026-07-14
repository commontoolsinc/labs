---
status: historical
created: 2026-07-01
archived: 2026-07-09
reason: "Scheduler-v2 investigation record: the pull-side gate (push-pull Track 1) measured as a structural no-go."
---

# Addendum A7 — Pull-side gate (push-pull Track 1) — structural NO-GO

> **Status**: Structural NO-GO
> **Context**: multi-user cfc-group-chat scheduler-v2 vs main slowness investigation (2026-06/07), informing PR #4288.
> **Companion**: [scheduler-v2 README](../../../../specs/scheduler-v2/README.md); sibling addenda in this folder.

## Finding

A standard-signals pull-side gate — reverse-walk a re-run's read-set to its
upstream writer nodes and suppress the re-run when no writer changed — does
**not** help the cfc-group-chat workload. Roughly half of the hot apex's re-run
consults have *no* scheduler-registered upstream writer in their read-set:
those re-runs are driven by **direct cell writes** (the cross-runtime
sync-apply of the message `/value`), not by tracked writer nodes. The
reverse-walk is structurally inapplicable to that half, so the gate cannot fire
where the redundancy actually is. NO-GO, root-caused.

## Evidence

- **Target.** The group-chat surplus localizes to a whole-state render EFFECT —
  the `pull:of:` root sink — re-running ~18×. Measured apex re-run counts:
  v2 ~165 vs main ~74.
- **Mechanism available.** The reverse edge already exists:
  `packages/runner/src/scheduler/dependency-graph.ts` maintains
  `reverseDependencies` as a reader→writers map (see the liveness comment at
  ~L392: "`reverseDependencies` is reader -> writers"), also held on
  `facade.ts:reverseDependencies` (~L267). A pull-side gate reverse-walks a
  re-run's read-set through this map and skips when no upstream writer fired.
- **Prototype.** `CF_PUSHPULL` gate built in a scratch branch
  (`claude/sched-v2-pushpull`). An "effect-defer" effect-coalesce pass was
  ported verbatim and then generalized to computations.
- **Results (measured).**
  - Stage 1 (effects only): NEUTRAL, 165 → 163 apex re-runs.
  - Stage 2 (computations): REGRESSED, 165 → 181.
- **Root-cause refutation (per-consult apex trace).** ~half of the apex's
  re-run consults have `writers = 0` — the read-set contains **no**
  scheduler-registered upstream writer. Those re-runs are driven by direct
  cell writes (the cross-runtime sync-apply of the message `/value`), not by
  tracked writer nodes. The diagnosis's premise — "rows in the read-set after
  the first run have registered writers" — holds only in the `writers = 1`
  MINORITY.
- **Safety.** Full runner suite 656/0 with flag-on == flag-off. Prototype left
  flagged off at `PUSHPULL_GATE_COMPUTATIONS=false` (Stage 1, value-neutral).

## What it means

The +16% redundancy on this workload is driven by cross-runtime data
*arrival*, not by an intra-graph writer whose change a gate could observe and
suppress. A pull-side gate can only reason about edges the scheduler owns
(reader→writer within one runtime's graph). When the trigger is a raw
sync-apply write landing on a shared cell, there is no writer node to walk back
to and nothing to compare against — the read genuinely changed, so the re-run
is *correct*, just duplicated across runtimes. This is the third independent
confirmation that the effective lever is cross-runtime duplication, not
intra-runtime propagation.

## Status & open questions

- **Settled.** The pull-side gate is a structural NO-GO for cfc-group-chat, and
  the reason is understood (half the re-runs have no walkable writer). A
  flagged-off prototype persists for the value-neutral Stage-1 slice only.
- **Open.** Nothing to salvage here for this workload. The remaining question
  is entirely on the cross-runtime side: how to deduplicate or adopt re-runs
  triggered by sync-apply arrival — see the related addenda.

## Related

- `08-effect-defer-neutral.md` — the effect-defer sibling ported into this
  prototype; its measured neutrality.
- `06-cross-runtime-adoption-what-would-be-needed.md` — where the lever
  actually is: adopting cross-runtime-arrival re-runs.
- `09-remediation-direction.md` — synthesis of the direction the fix must take.
