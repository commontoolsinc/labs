---
status: historical
created: 2026-09-08
archived: 2026-09-08
reason: "Investigation of issue #6969 using an emulated graph and CPU profiling."
---

# `setsrc --check` expands shared graphs while comparing default merges

A small, acyclic graph reproduces the preflight's heap exhaustion. The failure
is in a whole-value equality check inside `mergeSchemaDefaults`, which hashes a
lazy, schema-less argument view. Hashing repeatedly follows shared links, and
the transaction retains the resulting read activity. This is a strong candidate
explanation for
[Mike's report, #6969](https://github.com/commontoolsinc/labs/issues/6969), but
the deployed Topics board was not read or changed in this investigation. Its
exact failure still needs a snapshot replay or a JavaScript profile.

Investigated revision: `ada72e0ca513826095c815f27f6e458a1d323fae`, current
`origin/main` when fetched, on macOS with Deno 2.9.4. The relevant
`runner-utils.ts`, `query-result-proxy.ts`, `valueEqual.ts`, and `value-hash.ts`
files are identical to those at `63de1a1e8c`, the revision named in the related
rehearsal report. The preflight's materialization, merge, and validation
sequence is also present at that revision.

## The call path

1. `packages/cli/lib/piece.ts:checkPiecePattern` calls
   `PieceController.checkPattern`.
2. `packages/piece/src/ops/piece-controller.ts:pieceSourceCompatibilityReview`
   reads `argumentCell.asSchema(undefined).get()`. This returns a lazy
   query-result proxy; this call alone does not expand the graph.
3. The review passes that view to `mergeSchemaDefaults` with
   `mergeMaterializedLinks: true`.
4. `packages/runner/src/runner-utils.ts:mergeSchemaDefaultsInternal` copies the
   object and merges fields. Its final equality check runs even when all fields
   remain exactly the same objects and no default was inserted.
5. `schemaDefaultValueEqual` calls `valueEqual`, which hashes both objects. The
   hash walker in `packages/data-model/src/value-hash.ts` recursively feeds
   every nested property into one content stream. It does not deduplicate shared
   subgraphs during that walk. Reading a proxy property follows its storage link
   and records transaction activity.

The recursion and memoization guards elsewhere do not bound this hash walk. A
repeating native stack therefore does not require a graph cycle: ordinary
recursive expansion of a shared acyclic graph produces one too.

## Reproduction and measurements

The [included probe](2026-09-08-setsrc-check-heap-probe.ts) creates a pattern
with one optional string input, `seed`, and stores an extra linked graph in its
arguments. Every graph node has `left` and `right` links to the same next node.
All nodes point forward; the final node is a scalar-bearing leaf. At depth 20,
there are 22 argument/graph documents, plus the ordinary piece and compiler
artifacts, but over one million paths to the leaf.

All writes use `StorageManager.emulate`. The probe calls the real `checkPattern`
with the piece's unchanged source.

From the repository root:

```sh
deno run --quiet --frozen \
  --allow-env --allow-read --allow-write --allow-ffi \
  --v8-flags=--max-old-space-size=512 \
  docs/history/packages/piece/2026-09-08-setsrc-check-heap-probe.ts 12
```

Depth 12 completes with `compatible: true`. Replacing `12` with `20`
deliberately reproduces the fatal heap exhaustion in a bounded child process.
The initial full-preflight reproduction exited 133, with repeated native frames
and V8 reporting approximately 510 MB retained near its 512 MB limit.

A separate helper-level measurement isolated the default merge:

| Measurement                              | Unmodified code | Unchanged-object experiment |
| ---------------------------------------- | --------------: | --------------------------: |
| Depth-16 schema-less read                |         0.65 ms |                     0.59 ms |
| Read plus default merge                  |          620 ms |                     1.66 ms |
| Read activities before merge             |             212 |                         212 |
| Read activities after merge              |         655,766 |                         228 |
| Heap used after merge                    |         173 MiB |                      41 MiB |
| Depth-20 full preflight, 512 MB heap cap |       Fatal OOM |           Compatible, 29 ms |

These are individual runs, not stable performance thresholds. The read counts
show the amplification independently of timing. A CPU profile of the depth-16
helper run attributed 1,282.8 ms of 1,283.9 ms sampled under
`mergeSchemaDefaultsInternal` to `schemaDefaultValueEqual`, through
`valueEqual`, `hashStringOf`, and the recursive `feedValue` / `feedObjectValue`
/ `feedPlainObject` chain.

A raw-value control at depth 20 completed the helper merge in approximately 1.6
ms because stored link envelopes remain finite values. This control does not
establish that substituting `getRaw()` preserves preflight semantics.

## Experimental repair and remaining work

The [experimental patch](2026-09-08-setsrc-check-unchanged-object.patch) tracks
whether the object merge inserted or changed any immediate field. When every
field retains its identity, it returns the original object without hashing it.
This makes the depth-20 full preflight finish and retains its compatible
verdict. The existing preflight suite passed all 11 steps, and the runner-utils
group passed all 46 steps with the patch applied.

The patch was then removed from runtime source and saved here as experimental
evidence. It is not a complete repair: array and union equality paths remain,
and an actual default insertion can still fall through to whole-value hashing. A
production change should avoid expanding unchanged linked values throughout
default merging, preserve opaque references, and add regression coverage for
arrays, unions, actual defaults, and cycles. Changing canonical hash semantics
or blindly replacing validation reads with raw links would require separate
correctness analysis.

Rehearse the repair against a writable copy of the deployed Topics space,
following `docs/development/space-clone-rehearsal.md`. The 8,379-document field
read reported in #6969 was not reproduced here; it may increase the reachable
graph, but shared-graph expansion is sufficient to crash without that volume.
The `shortName` compatibility refusal is a separate verdict: removing the
resource failure must not suppress it.

The store writes discussed in
[#6964](https://github.com/commontoolsinc/labs/issues/6964#issuecomment-5556079380)
are also separate. Mike's correction identifies candidate compilation and
content-addressed artifacts as their cause, rather than starting the piece.

No GitHub comment, production request, commit, or deployment was made.
