---
status: historical
created: 2026-09-10
archived: 2026-09-10
reason: "D3 verification and scoped label-view reuse measurements for design #7155."
---

# Scoped snapshot memo verification

The D3 verification used runtime revision `be92af0510` with two added
regressions and `packages/runner/test/snapshot-memo.bench.ts`. The machine was
an Apple M5 running Deno 2.9.4 on macOS arm64. No live poll was accessed.

## Correctness

The snapshot-memo suite passed all 41 steps. Its existing cases cover link
retargeting, replacement, path/schema/resolution-mode separation, per-call
trace replay, cross-space pull kicks, write invalidation, blind-write mode,
nonreactive reads, closed transactions, and proxy-view reuse.

Two added regressions check the intersections relevant to scoped memo reuse:

- A metadata-scoped label view remains reusable at its historical read epoch
  after the stored label changes. Current reads return the new label;
  historical reads return the old label. A read without the ambient metadata
  journals its own metadata access even at that historical epoch.
- Distinct ambient metadata objects, despite having equal fields, each journal
  an initial metadata read. Reentering either original object's scope reuses
  its own memo. An unscoped read journals separately.

These assertions check returned label values as well as read activity. The
measurements did not establish a need for another memoization mechanism.

## Exact read measurements

Each sample requests the label view of one stored, labeled address repeatedly.
Source and target name the same address. Each sample has a fresh transaction;
the historical case advances the transaction with an unrelated write before
entering the earlier read epoch. Setup is excluded from the measured interval.

| Scope | Calls | Metadata reads with reuse | Metadata reads with clearing |
| --- | ---: | ---: | ---: |
| Ambient metadata | 74 | 1 | 74 |
| Ambient metadata | 296 | 1 | 296 |
| Ambient metadata | 1,184 | 1 | 1,184 |
| Read epoch and ambient metadata | 74 | 1 | 74 |
| Read epoch and ambient metadata | 296 | 1 | 296 |
| Read epoch and ambient metadata | 1,184 | 1 | 1,184 |

The reused case includes its first miss. The control clears only the active
snapshot memo before each request; underlying storage read caches remain
active. The benchmark verifies these exact counts before registering timing
samples, and writes them to stderr. Reproduction from the repository root:

```sh
deno test -A packages/runner/test/snapshot-memo.test.ts
deno bench -A --json packages/runner/test/snapshot-memo.bench.ts
```

The counts describe transaction read activities, not proxy accesses, network
requests, or distinct documents. Both cases still merge views for every call.
The cleared control includes map clearing and additional journaling cost.
Timing was captured while other validation ran, so no timing comparison or
product speedup is inferred. This one-address fixture verifies reuse; it does
not model a full pattern with independently labeled documents or rendering.
