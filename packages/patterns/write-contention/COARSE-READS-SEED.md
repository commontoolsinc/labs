# Coarse-grained reads — investigation seed (next session)

Continuation of the silent-write-drop / lunch-poll perf work (PR #4178). The
write-side conflict-granularity spikes are done; this is the **next, dominant**
lever. Read the `project_4178_write_drop` memory for full lineage.

## The problem, in one paragraph

The lunch-poll / write-contention slowdown is **not** primarily about direct-write
conflict granularity (that's addressed by #4199 / #4200). It is dominated by
**pervasive coarse reads of shared documents by the reactive MACHINERY** —
output-derivations, handler-argument binding, and live readers all read the
**whole** shared pattern doc (e.g. `["value"]`, `["value","map"]`) rather than
just the leaves they consume. Coarse reads hurt twice: (1) they **over-conflict**
with concurrent writes → retry storms → bounded-retry exhaustion → dropped writes;
(2) they **over-subscribe** → thundering-herd re-runs. Hard datapoint: in the
probe the shared doc is read **~69× for just 2 writers**.

## What is already established (verify, don't re-derive)

- **Two-mechanism finding** (disjoint-REPLACE via container-read compaction;
  disjoint-ADD via add-patch parent-injection). The two write-side fixes:
  - #4199 `spike/write-only-incremental-ops` — write-machinery reads excluded
    from conflict (blind write = pure producer). **DRAFT: real cross-space
    regression** (`home-profile.test.ts` multi-profile append — the `inSpace()`
    profile child's `Cell.set` under link-resolution-read exclusion). Needs design.
  - #4200 `spike/write-conflict-granularity` — engine honors `nonRecursive`
    (shape) reads, matching the scheduler. Functionally green (only the flaky
    wall-time Performance Check is red).
  - #4210 `spike/no-compute-retry` — reactive computes don't immediately re-queue
    on conflict (seefeld's point). **CI green, merge-ready.**
  - **All three fix DIRECT writes but DO NOT move the probe.** Probe MISSING is
    stable ~20 across every lever; 0 at low simultaneity ⇒ contention-driven,
    capped by `handler-retry-budget × simultaneity`. `missing ≈ exhaustions`
    (loud, not silent).
- **Dropping the eager scheduling read (`traverse.ts:3092`) alone did NOT move the
  probe** — so the coarse reads come from more than one machinery source.
- **Leads' input:** seefeld — computes shouldn't retry on conflict (→ #4210);
  wilk — **#4190 (too-many-subscriptions)** is the biggest *untested* lever;
  re-baseline the probe after #4190 merges to quantify its share.

## The goal

Narrow the machinery's reads of shared docs so output-derivation / handler-arg
binding / readers depend only on what they consume (shape-only / per-leaf), not
the whole container — eliminating the over-conflict + over-subscribe.

## Key open questions

1. **Provenance.** Of the ~69 `["value"]` / `["value","map"]` reads per 2 writers,
   what share is output-derivation vs handler-argument binding vs live readers?
   Quantify before fixing.
2. **Handler-arg binding.** Why does materializing a handler argument read the
   *whole* container? Can it be lazy / shape-only? (Not `traverse.ts:3092` alone.)
3. **Composition with #4200.** #4200 already makes proxy *container* reads
   `nonRecursive`; does extending shape-only reads to the machinery paths (or a
   different narrowing) close the gap?
4. **#4190 interaction.** Re-baseline the probe after #4190 lands.

## Touchpoints

- `packages/runner/src/traverse.ts:3092` (READ_FOR_SCHEDULING eager root read),
  the QueryResultProxy lazy reads (`query-result-proxy.ts`), `buildReads`
  (`storage/v2.ts`), `reactivityLogFromActivities` (scheduler subscriptions,
  `storage/reactivity-log.ts`), the scheduler reader-dirty index (`memory/v2/engine.ts`).
- #4200's `nonRecursive` shape-read machinery is the most relevant building block.

## Reproduce / measure

```bash
# distinct-key + shared-list contention; nested = lunch-poll castVote shape
deno run -A packages/patterns/write-contention/probe.ts --users=10 --rounds=5 --mode=both 2>/tmp/wc.err
deno run -A packages/patterns/write-contention/probe.ts --users=10 --rounds=5 --mode=nested
grep -c "exhausting all retries" /tmp/wc.err   # compare to MISSING in stdout
```

- **Re-add the read-set instrument** (removed from the merged branches): a dump in
  `buildReads` (`storage/v2.ts`, before its `return`) gated on an env var, printing
  the post-compaction confirmed reads. For raw read provenance use
  `getDirectTransactionReadActivities(tx)` (`storage/transaction-inspection.ts`).
  Both exist on the spike branches' history if you want to copy them.

## Suggested first step

Instrument **which machinery operation** emits each coarse `["value"]` /
`["value","map"]` read (a one-shot stack-trace in `tx.read` gated by env, keyed on
the last path segment — there's a working version in `spike/write-only-incremental-ops`
history). Quantify each source's share, then target the dominant one.

## Non-goals / cautions

- This is the *machinery-read* lever, distinct from direct-write granularity (done)
  and from OT/CRDT for genuine read-modify-write (deferred — seefeld).
- The Performance Check (wall-time) is flaky; don't chase it. CI test/integration
  is the real signal.
