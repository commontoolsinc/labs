---
status: historical
created: 2026-07-01
archived: 2026-07-09
reason: "Scheduler-v2 A/B investigation record: refuted free fixes (declared reads, asCell read-depth)."
---

# Addendum A4 — Refuted free fixes — declared reads and asCell read-depth

> **Status**: Refuted hypothesis
> **Context**: multi-user cfc-group-chat scheduler-v2 vs main slowness investigation (2026-06/07), informing PR #4288.
> **Companion**: [scheduler-v2 README](../../../../specs/scheduler-v2/README.md); sibling addenda in this folder.

## Finding

Two "maybe it's a cheap pattern-level fix" hypotheses were investigated and both
**refuted** by reading code. (1) The declared read-sets scheduler-v2 records are
neither over- nor under-specified — they faithfully match what each computation
actually traverses, so there is no free win from tightening them. (2) `asCell`
access modes already classify the read-heavy modes (`cell`, `comparable`,
`readonly`, `writeonly`) as **shallow**, so no mis-classification is silently
inflating read depth. The +16% is genuine re-derivation work, not spurious
over-demand.

## Evidence

- **Declared reads are faithful.** We checked whether v2's declared read-sets
  are broader than the computation actually traverses (over-demand → wasteful
  invalidation) or narrower (under-invalidate → correctness risk). They match
  actual traversal in both directions. No tightening opportunity exists — the
  reads that get recorded are the reads that happen.
- **asCell read-depth is kind-agnostic and already shallow for the relevant
  modes.** In `packages/runner/src/traverse.ts`,
  `SchemaObjectTraverser.hasAsCell()` (~L3897) is a boolean predicate that does
  not distinguish kinds. The only depth-special kind is `opaque`: the traverser
  short-circuits deeper reads when `ContextualFlowControl.getAsCellKind(...) ===
  "opaque"` (traverse.ts ~L3125 and again ~L3762). `cell`, `comparable`,
  `readonly`, and `writeonly` all hit the **same** shallow boundary — none of
  them forces a deep walk. (`Writable` aliases the `cell` kind.)
  `getAsCellKind` is defined in `packages/runner/src/cfc.ts`
  (`ContextualFlowControl.getAsCellKind`, ~L599).
- **The deepest read is the `unknown` / `true` schema, not any asCell mode.** The
  recursive read path is the true-schema branch in traverse.ts (~L3091:
  `this.tx.read(doc.address, READ_FOR_SCHEDULING); // recursively read this
  doc`). So `comparable` reads only "just enough to resolve links — what
  `unknown` reads shallowly." (User guidance during the investigation: "cell is
  like readwrite"; "comparable is only a shallow read".)
- **Depth is gated by the orthogonal `traverseCells` flag, not by asCell kind.**
  Deep DAG traversal is controlled by `this.traverseCells` (traverse.ts ~L1226,
  ~L3092), which is `false` on the `.get()` path and `true` only on the query
  path — independent of which asCell mode a field carries. asCell mode is
  therefore not covertly forcing deep reads.

_(Line numbers verified against the v2 checkout; they may drift on other
branches — anchor on the named symbols.)_

## What it means

Neither the declared-read surface nor the asCell read-depth is over-reading. The
extra cost scheduler-v2 pays on this benchmark is genuine re-derivation of
shared cells under multi-user contention (see A3), not phantom over-demand from a
sloppy read declaration or a mis-classified access mode. This rules out the
cheapest class of remediation — there is no schema-level knob or read-mode
correction that reclaims the +16% without touching the actual node-execution
work.

## Status & open questions

Both hypotheses are settled: **refuted** by code reading (not by measurement, and
not merely unverified). No open questions attach to these two levers. The real
lever remains the node-multiplication / shared-cell re-derivation surface
documented in the sibling addenda.

## Related

- `01-headline-and-node-multiplication.md` — the real source of the +16%; this
  addendum eliminates two decoys that pointed away from it.
- `05-serialized-scheduler-state-is-reload-only.md` — sibling refutation, same
  "ruled out by reading" epistemic status.
