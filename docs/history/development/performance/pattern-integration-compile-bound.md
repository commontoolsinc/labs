---
status: historical
created: 2026-07-11
archived: 2026-07-11
reason: "Profiling snapshot of the pattern-integration CI job, measured June 2026."
---

# Pattern-integration CI: the long pole is compile, not sync

An investigation, for the [Performance Program](../../../development/PERFORMANCE_PROGRAM.md) and
the [CI Performance Policy](../../../development/CI_PERFORMANCE.md), into where the wall time goes
in the "Deno Workflow" pattern-integration job. That job is the usual CI
critical-path long pole, and its time is dominated by **per-pattern CFC
compile**, not by storage, networking, or sync.

## What was measured

Profiled June 2026 (one shard was about 228 seconds end to end):

- **Compiling the patterns is the bulk of it.** "Compile all patterns"
  (`all.test.ts`) was about 90 seconds, and a few patterns dominated that:
  `record.tsx` and `record-backup.tsx` each took roughly 29 seconds on their
  own.
- **Within one pattern compile,** parsing and binding (`createProgram`) is
  tiny, type-checking is about a quarter, and emit-plus-transform is about
  two-thirds. Emit-plus-transform is TypeScript running the CF transformer
  pipeline. About half of that is TypeScript's own checker answering type
  queries that the transformers make; the rest is spread across roughly six
  transformers, with the JSX expression-site router the largest. There is no
  single removable hot spot.
- **Instantiating a pattern against a live toolshed** (`cc.create`) is itself
  about 65% compile. Storage was about 63ms, memory about 3ms, and SES about
  79ms — sync and storage are not the bottleneck.

## What was ruled out as a win

- Caching the lib `.d.ts` parse (about 18ms).
- `noCheck` (about 8ms once warm).
- Sharing one dataflow analyzer across the transformers. This is unsafe: each
  transformer's rewrites invalidate the analysis, so sharing it would break a
  correctness contract.

## What this means for future work

CI performance work on this job should target the compiler and transformer
pipeline, or remove redundant compiles, rather than the storage, memory, or sync
layers. The same compile path is shared by the runner tests, the pattern unit
tests, `cf check`, and the generated-patterns suite, so a single improvement
there helps all of them.

Measurement caveat: a local developer machine is roughly ten times faster than
the CI Ubuntu runners, so reproduce the relative cost structure between phases
rather than the absolute times.
