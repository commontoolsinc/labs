# Memory v2 Implementation Plan

## Summary
- [x] Write this plan into [implementation-plan.md](/Users/berni/src/labs.exp-memory-impl-4/docs/specs/memory-v2/implementation-plan.md).
- [x] Keep Memory v2 inside the existing packages rather than creating a new workspace package.
- [x] Treat the phase-1 cutover as: a `Runtime` configured with `memoryVersion: "v2"` uses v2 implementations for `IStorageProvider` and `IExtendedStorageTransaction`, while runner and scheduler call sites remain unchanged.
- [x] Execute the rollout with red/green TDD and commit in small slices, including red commits when they clarify the intended behavior.
- [x] Keep v1 and v2 running in parallel during migration, but keep storage physically separate. V2 uses its own SQLite layout and emulation path.
- [x] Keep the plan file at [implementation-plan.md](/Users/berni/src/labs.exp-memory-impl-4/docs/specs/memory-v2/implementation-plan.md) and update it to match the plan currently being executed on `codex/memory-v2`.

## Historical Completed Items
- [x] Add v2 code inside the existing packages rather than creating a new workspace package: shared/server code under [packages/memory](/Users/berni/src/labs.exp-memory-impl-4/packages/memory), client wiring under [packages/runner/src/storage](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/src/storage), and route/transport dispatch under [packages/toolshed/routes/storage/memory](/Users/berni/src/labs.exp-memory-impl-4/packages/toolshed/routes/storage/memory).
- [x] Treat the cutover target as non-branching v1 parity first: current runtime usage is centered on `syncCell()`, schema traversal, subscriptions, reconnect, optimistic pending writes, and scheduler notification ordering.
- [x] Treat immutable blob payload storage as lower priority than provider/query parity. The v1 cutover path does not currently depend on dedicated blob upload/download routes, but the v2 engine now has the foundational `blob_store` support.
- [x] Add `memoryVersion?: "v1" | "v2"` to `RuntimeOptions` in [runtime.ts](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/src/runtime.ts), default it to `"v1"`, and thread the resolved value into storage-manager construction and emulation.
- [x] Introduce `IStorageNotification` / `StorageNotificationRelay` as the canonical internal names for scheduler notifications, and export temporary aliases for `IStorageSubscription` / `StorageSubscription` until v1 is removed.
- [x] Keep compatibility-only fields such as classification and labels accepted at the cutover boundary, but treat them as ignored inputs on the v2 path and stop creating label side-writes in v2.
- [x] Define v2 shared types and codecs around `EntityDocument`, `Operation`, `ClientCommit`, `ConfirmedRead`, `PendingRead`, `PatchOp`, `SessionOpen`, `Receipt`, and `merkle-reference/json`; keep entity storage untyped and re-root selector paths to `["value", ...path]`.
- [x] Bootstrap the v2 per-space SQLite schema with `value`, `fact`, `head`, `commit`, `invocation`, `authorization`, `snapshot`, `branch`, and minimal blob tables, plus the required pragmas, prepared statements, and default-branch bootstrap.
- [x] Implement the phase-1 logical session model: the first WebSocket message negotiates `memory/v2`, `session.open` returns or resumes `sessionId`, the server keeps only lightweight session state, and the client owns replay of outstanding commits and subscriptions after reconnect.
- [x] Keep the existing `/api/storage/memory` route, but dispatch v2 WebSocket traffic through the new session protocol and keep PATCH transact/query handlers as thin compatibility adapters for tests and one-shot tooling.
- [x] Add a randomized v1/v2 comparison test that drives the same non-branching, non-classified workload through both implementations and compares only behavior visible at `IStorageProvider` and `IExtendedStorageTransaction`.
- [x] Initially reused the existing `Journal` / `Chronicle` / `StorageTransaction` stack for the first cutover seam before replacing it with a v2-native transaction core.

## Current Status
- [x] Establish the runtime cutover seam with `memoryVersion: "v2"` in [runtime.ts](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/src/runtime.ts) and the runner storage manager.
- [x] Build the spec-native v2 engine as a clean-room implementation under [packages/memory/v2](/Users/berni/src/labs.exp-memory-impl-4/packages/memory/v2), without reusing v1 storage internals.
- [x] Hard-cut the websocket protocol to `memory/v2` for v2 runtimes instead of preserving the old query/transact/subscription wire shape.
- [x] Route v2 runtime traffic through the spec-native engine on both the real toolshed route and the emulated path.
- [x] Reach parity for the main v1-used reactive flows already exercised on this branch: schema sync, linked-document propagation, deep link chains, reconnect resubscribe, scheduler pull reactivity, alias schema round-trip, and alias retargeting.
- [x] Add runner-level v2 integration coverage for remote link reactivity: new link discovery, linked-document updates, and deep link chains against a real toolshed app instance.
- [x] Pin tests that intentionally depend on v1-only storage internals to explicit `memoryVersion: "v1"` construction and typed v1 helpers, so a future default flip does not confuse harness debt with real v2 regressions.
- [x] Finish the client/session replay path for reconnect when there is still outstanding local optimistic work, including in-flight and queued commit replay by `localSeq`.
- [x] Replace the old reconnect harness with a real v2 runner integration test that survives an actual server restart and resumes subscribed runtime updates.
- [x] Centralize the default memory version in `DEFAULT_MEMORY_VERSION` and set it to `"v2"`, while keeping explicit `memoryVersion: "v1"` opt-ins only where tests intentionally depend on v1 internals.
- [x] Align the v2 runner/toolshed test suites with the cleaned-up storage interfaces on current `main`, including test-local provider helpers and `setRawUntyped()` for storage-layer link writes.
- [x] Reproduce the remaining CLI notebook case with the same `ct test --timeout 180000 --root packages/patterns` harness used by repo integration and confirm it passes in isolation, so it is not currently a proven Memory v2 blocker.
- [x] Run an initial v1/v2 benchmark survey across the runner benches and record the current outlier clusters before deliberate tuning. The main regressions currently cluster in no-op/equal-value commits, repeated small `Cell.set()` updates, and subscription-heavy scheduler fan-out.
- [x] Fix the last real default-v2 product regression by registering same-space navigated pieces from the shell-side navigate handler, rather than papering over the piece list in the default-app pattern.
- [x] Complete clean repo-wide `deno task test` and `deno task integration` sweeps with `DEFAULT_MEMORY_VERSION = "v2"`.
- [x] Materialize v2 snapshots for patch-heavy entities and use them during current and point-in-time reads, so the engine no longer depends on pure replay for long patch chains.
- [x] Tighten confirmed-read validation from whole-entity conflicts to path-aware overlap checks for later patch writes, while keeping conservative `set` and `delete` invalidation.
- [x] Add minimal v2 blob upload/download routes and pin the phase-1 split between immutable blob payloads and ordinary `urn:blob-meta:<hash>` entity metadata.
- [x] Preserve rich-storable immutability on the v2 transaction path by isolating caller-owned writes and freezing raw transaction reads at the boundary, while keeping the internal working copy mutable.
- [x] Forward the v2-native transaction inspection hooks through `ExtendedStorageTransaction` and `TransactionWrapper`, so callers do not need to unwrap `.tx` to reach `getReactivityLog()`, `getReadActivities()`, or `getWriteDetails()`.
- [x] Drop equal-value v2 writes at write time so no-op transactions do not accumulate synthetic write-details, reactivity-log entries, or avoidable commit-time dirty-doc scans.
- [ ] Finish the remaining engine-native pieces that are not required for v1 parity but are still part of the v2 design, especially post-cutover optimizations and advanced features beyond v1 parity.

## Test Split For Default Flip
- [x] Keep the old v1-internal tests explicitly on v1 when they depend on structures that do not exist in v2, such as `StorageManagerEmulator.mount()`, `StorageManager.openConnection(...).provider`, or `Provider.replica.heap`.
- [x] Treat linked-document propagation and deep link-chain reactivity as already covered on the v2 path by [memory-v2.test.ts](/Users/berni/src/labs.exp-memory-impl-4/packages/toolshed/routes/storage/memory/memory-v2.test.ts).
- [x] Treat provider-visible non-branching behavior as already covered on the v2 path by [memory-v2-comparison.test.ts](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/test/memory-v2-comparison.test.ts).
- [x] Treat notification ordering and conflict-before-revert behavior as already covered on the v2 path by [memory-v2-subscription.test.ts](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/test/memory-v2-subscription.test.ts).
- [x] Add the true v2 counterpart for the pending-nursery-style cases that still matter: stacked optimistic local commits, reconnect with outstanding local work, own-commit de-duplication, and retry-after-revert behavior.

## Reprioritized For V1 Parity
- [x] Treat non-branching v1 parity as the actual cutover target. The current runtime depends on `syncCell()`, schema traversal, subscriptions, reconnect, optimistic writes, and notification ordering.
- [x] Treat branch lifecycle, branch-scoped reads, merges, and branch-aware subscriptions as explicitly post-cutover work. There is no current v1 branch surface to preserve.
- [x] Treat direct patch emission from `Cell.set()` as post-cutover work. Phase 1 can continue materializing full entity documents before commit.
- [x] Treat dedicated blob transport and metadata policy as lower priority than provider/query/runtime parity. Existing v1 runtime flows do not depend on blob endpoints.
- [x] Reuse shared traversal behavior from [traverse.ts](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/src/traverse.ts) for v2 graph queries and subscriptions rather than rebuilding that logic in the server.
- [x] Preserve the v1-visible notification contract at the runtime boundary: optimistic `"commit"`, synchronous `"revert"` before the promise resolves, and async `"integrate"` for remote updates.

## Immediate Next Slice
- [x] Add focused tests for reconnect with outstanding local commits, including disconnect during an in-flight commit and replay after reconnect.
- [x] Preserve notification ordering when reconnect replay, remote integrate, and local optimistic state all interact in the same space.
- [x] Add coverage for stacked pending commits plus remote updates to prove own-commit de-duplication and retry-after-revert behavior.
- [x] Resolve the remaining high-value runner integration gap by porting the real v2 reactivity/reconnect suites and pinning the intentionally v1-internal harnesses to explicit `memoryVersion: "v1"`.

## Public Interfaces And Cutover Boundary
- [x] Add `memoryVersion?: "v1" | "v2"` to `RuntimeOptions` and thread the resolved value into storage-manager construction and emulation.
- [x] Keep `IStorageManager`, `IStorageProvider`, `IExtendedStorageTransaction`, `StorageValue`, `syncCell()`, and `subscribe()` stable at the runtime boundary for phase 1.
- [x] Introduce `IStorageNotification` / `StorageNotificationRelay` as the canonical internal names for scheduler notifications, while keeping temporary aliases for `IStorageSubscription` / `StorageSubscription`.
- [x] Keep compatibility-only fields such as classification and labels accepted at the cutover boundary, but ignore them on the v2 path and stop creating label side-writes in v2.
- [x] Add explicit v1 guard assertions at the remaining v1 provider, transaction, consumer, and server entry points so a runtime configured for v2 fails immediately if it ever reaches a v1-only path.

## Phase 1: Core V2 Stack Required Before Cutover
- [x] Define the shared v2 types and codecs around `EntityDocument`, `Operation`, `ClientCommit`, `ConfirmedRead`, `PendingRead`, `PatchOp`, `SessionOpen`, `Receipt`, and `merkle-reference/json`.
- [x] Bootstrap the v2 per-space SQLite schema with `value`, `fact`, `head`, `commit`, `invocation`, `authorization`, `snapshot`, `branch`, and minimal blob tables, including pragmas and default-branch bootstrap.
- [x] Implement the core read path for current v1-parity needs: head lookup, point-in-time reconstruction by `seq`, patch replay, `source` link traversal, and schema-driven `graph.query` using the shared traversal code path.
- [x] Make `graph.query` follow write redirects for plain alias sync as well as schema-bearing selectors, so live alias retargeting stays subscription-safe.
- [x] Add snapshot creation and lookup to the read engine so point-in-time reads do not depend entirely on replay.
- [x] Implement the core commit path for current v1-parity needs: parent resolution, global `seq` assignment, atomic fact/head/commit writes, and pending-read resolution from `(sessionId, localSeq)`.
- [x] Reject stale confirmed reads conservatively on the v2 path.
- [x] Tighten overlap-path conflict analysis beyond the current conservative confirmed-read checks where existing v1 behavior requires more precision.
- [x] Implement the phase-1 logical session model: websocket `hello`, `session.open`, resume by `sessionId`, and client-owned replay/resubscribe after reconnect.
- [x] Keep the existing `/api/storage/memory` route, but dispatch v2 traffic through the new protocol while keeping one-shot compatibility handlers only for tests and tooling.
- [x] Add foundational blob storage in the engine for immutable payload persistence.
- [x] Add the phase-1 mutable blob metadata split and any transport endpoints actually needed for runtime cutover.
- [x] Build v2 emulation on top of the real v2 server code rather than maintaining a fake-only v2 test backend.

## Phase 1: Client Provider And Transaction Adapter
- [x] Cut runtime `memoryVersion: "v2"` over to a real v2 storage path in the runner rather than the old compatibility-backed route.
- [x] Preserve the current provider/transaction surface so runner and scheduler call sites remain unchanged.
- [x] Keep `syncCell()` and schema sync on `graph.query`; one-shot query remains only a compatibility and testing path.
- [x] Replace the temporary v1-style transaction adapter with a v2-native transaction core and narrow inspection hooks (`getReactivityLog()`, `getReadActivities()`, `getWriteDetails()`) so v2 no longer depends on `Journal` / `Chronicle` internally.
- [x] Preserve basic notification timing for optimistic commit, revert, integrate, `load`, `pull`, and `reset`, with explicit coverage for conflict-before-revert ordering.
- [x] Reconnect the shared v2 client and resubscribe active `graph.query` views after websocket loss.
- [x] Preserve alias/schema/link-heavy reactive behavior through the v2 path, including deep links and alias retargeting.
- [x] Finish pending-first replica behavior for reconnect with outstanding local commits, including replay of in-flight and queued local writes.
- [x] Add stronger proof for own-commit de-duplication when local replay and remote integrate race after reconnect.
- [x] Keep cutover independent of direct patch emission from `Cell.set()`. True patch generation remains a post-cutover phase.

## Cutover Exit Criteria
- [x] A runtime instantiated with `memoryVersion: "v2"` can run existing runner, pattern, and CLI flows without reaching any v1 code path.
- [x] The remaining runner integration suites that matter for v1 behavior pass against a real toolshed server with v2 enabled, while the intentionally v1-internal suites stay pinned to explicit v1.
- [x] Add a randomized v1/v2 comparison test that drives the same non-branching, non-classified workload through both implementations and compares only behavior visible at `IStorageProvider` and `IExtendedStorageTransaction`.
- [x] Add server integration tests for version negotiation, `session.open`, transact success, transact rejection and revert ordering, graph-query subscriptions, reconnect replay, and live alias retargeting.
- [x] Extend server integration coverage to any runtime-critical blob behavior once the blob transport shape is finalized.
- [x] Add the focused client and provider tests for stacked pending commits plus remote integrates, own-commit de-duplication, and retry-after-revert behavior.
- [x] Finish an uninterrupted, completely clean repo-wide `deno task integration` pass under the v2 default. The previously suspicious CLI notebook case now also passes in the aggregate runner.

## Phase 2: Post-Cutover Optimizations
- [x] Add snapshot-retention-based compaction so the engine keeps only a configurable number of recent snapshots per entity/branch after materialization.
- [ ] Continue tuning snapshot cadence and retention defaults beyond the current interval-plus-retention policy.
- [x] Extend the v2-native transaction core with a direct reactivity-log export, while keeping the journal-activity path only as a compatibility fallback for older callers and tests.
- [x] Route v2 transactions to v2 replicas through a native commit-draft hook, so the hot path no longer has to round-trip through legacy `{ the, of, is }` facts before building `ClientCommit`.
- [x] Compact redundant descendant confirmed/pending read dependencies before sending v2 commits, while preserving distinct `nonRecursive` read scopes.
- [x] Add a native v2 batched-write hook behind `IExtendedStorageTransaction` and teach `applyChangeSet()` to prefer `writeValuesOrThrow()` when it is available, while keeping the one-write-at-a-time fallback for older or non-v2 transaction paths.
- [x] Change the transaction adapter so `Cell.set()` and path writes emit v2 patch operations directly when safe. The current fast path covers stable object-path `replace` / `add` / `remove`, plus array-structural writes normalized to `replace` on the containing array path; overlapping writes still fall back to full `set`.
- [ ] Add position-independent patch and remove helpers, and only relax claim tracking for patch classes that remain safe under optimistic pipelining.
- [ ] Decide whether array-structural writes should stay on containing-array `replace` patches or graduate to a dedicated wire op such as `set-length` / richer `splice`, based on measured workload evidence rather than speculation.
- [x] Add a short-lived server-side subscription and session resume cache so reconnecting clients can reuse unchanged subscribed query results without changing the `session.open` / `graph.query` contract.
- [x] Add prepared-statement caching to the hot v2 engine read/commit path so repeated SQLite `prepare(...)` calls are no longer part of normal commit-heavy workloads.
- [x] Make v2 provider sessions lazy so local-only transaction paths do not pay websocket/session setup until the first real sync or commit. The focused `storage-transaction-path.bench.ts` cases dropped from roughly `~7.5 / 6.9 / 7.3 ms` to `~5.5 / 5.4 / 6.0 ms` for `root read / single sibling write / five sibling writes` on this machine after removing eager session construction from `StorageManager.open(...)`.
- [x] Short-circuit the v2 manager-wide close path when there are no providers, instead of paying the global `synced()` timer path on an idle manager. This removed the remaining setup/teardown-only gap in the new immutable/setup split bench.
- [ ] Continue tuning blob I/O once benchmark evidence shows it is still a meaningful outlier.
- [ ] Revisit any future bulk-write shortcut only after benchmark evidence shows it clearly beats the existing `writeValueOrThrow()` compatibility path.

## Future Performance Follow-Ups
- [x] Reduce the remaining `storage-subscription-refresh.bench.ts` gap for many active path subscriptions on one document with repeated same-doc updates. The v2 path now canonicalizes schemaless same-document syncs down to one document-level subscription, and the focused bench is well ahead of the current v1 baseline (`~36-39 ms` on v2 vs `~157 ms` on v1 for the plain-doc variant on this machine).
- [x] Skip full reevaluation for sigil-only topology changes on plain-root queries when the changed document is not itself a root write redirect. This preserves source-lineage and alias-retarget correctness while converting inert plain-root sigil changes back to direct patches. On `pass-and-play/main.test.tsx` this cut the v2 storage slice from about `5.45s` to about `5.03s`, and reduced plain-root full-query fallbacks by roughly `415` on this machine.
- [x] Recompute plain-root source-lineage subscriptions directly when a source chain retargets, instead of falling back to full `graph.query`. The new focused bench in [storage-source-topology-refresh.bench.ts](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/test/storage-source-topology-refresh.bench.ts) now shows v2 ahead of v1 for this workload on this machine (`~41.5 ms` vs `~71.7 ms` for plain roots and `~70.7 ms` vs `~153.0 ms` for pattern-linked roots over 256 subscriptions and 5 retargets), and the real `room.test.tsx` pattern test dropped from about `4.3s` total / `4.1s` storage to about `3.4s` total / `3.1s` storage.
- [x] Stop re-reading already-loaded entities when building v2 `graph.query` results. The hot path now reuses the document/seq/hash cached in `EngineObjectManager`, which cut `store-mapper.test.tsx` from about `5.8s` total / `5.5s` storage to about `4.0s` total / `4.0s` storage on this machine, and brought the full `pattern-tests` aggregate down to about `22.5s` on v2 versus about `26.4s` on the v1-default comparison worktree.
- [ ] Re-profile `cell.bench.ts` hotspots such as `Cell get - simple value with schema` and `Cell creation - immutable`, which still suggest extra v2 overhead in schema-aware materialization, frozen rich-storable reads, or query-result wrapper setup.
- [x] Cache repeated rich-storable frozen transaction reads per document/path and invalidate that cache on writes. The new rich warm-read cases in [storage-transaction-internals.bench.ts](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/test/storage-transaction-internals.bench.ts) now show v2 ahead of v1 for the repeated-live-read microcase (`~4.1 ms` vs `~6.6 ms` for 10,000 rich warm root reads on this machine), even though the colder per-transaction benches still show setup-heavy overhead elsewhere.
- [ ] Keep pushing the large single-transaction `Cell.set()` write-count cases toward or past v1 without dropping back to document-wide `set`. The remaining target cluster is the large-object / small-array / repeated-update family in [cell-set.bench.ts](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/test/cell-set.bench.ts).
- [ ] Close the remaining direct `IExtendedStorageTransaction` path gap measured by [storage-transaction-path.bench.ts](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/test/storage-transaction-path.bench.ts). After making provider sessions lazy, the same-document cases are down to roughly `~5.5 / 5.4 / 6.0 ms` on v2 versus `~4.1 / 3.4 / 3.8 ms` on v1 on this machine for `root read / single sibling write / five sibling writes`, so the remaining cost is no longer mostly eager session startup.
- [ ] Use [storage-transaction-internals.bench.ts](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/test/storage-transaction-internals.bench.ts) as the next diagnostic benchmark for raw transaction-core tuning. Current results still put raw v1 `StorageTransaction` around `~1.3-1.4 ms` and raw v2 `V2StorageTransaction` around `~2.7-2.8 ms` for the same 100 root reads or sibling writes, so the remaining gap is inside the v2 transaction core itself rather than in the higher-level `Cell` wrapper or provider session startup.
- [x] Rule out `ExtendedStorageTransaction` itself as the main remaining transaction-path bottleneck. The new wrapper-level cases in [storage-transaction-internals.bench.ts](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/test/storage-transaction-internals.bench.ts) are effectively tied with the direct raw-transaction cases on both v1 and v2, so the remaining gap is not coming from the `readValueOrThrow()` / `writeValueOrThrow()` compatibility shell.
- [ ] Treat simple same-document lookup caches and `writer()` indirection as largely exhausted for the default transaction path. A last-document cache helps warm repeated-read microcases, and direct `writeWithinSpace(...)` benches were effectively identical to public `write(...)`, so the next likely gains are in per-operation bookkeeping (`activity`, `writeDetails`, repeated attestation traversal) rather than doc-map lookup or write-space checks alone.
- [x] Split v2 direct transaction inspection state away from eager `Activity` wrapper allocation. The v2 core now records concrete read/write entries plus a compact order log, and updates same-path write details in place. This keeps `journal.activity()` compatibility semantics while avoiding one wrapper allocation per operation.
- [x] Re-profile the immutable/setup path with a split bench instead of treating it as an immutable-cell operation regression. The new [cell-immutable.bench.ts](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/test/cell-immutable.bench.ts) rows showed the earlier `~3.8 ms` v2 outlier was almost entirely idle setup/teardown cost. After short-circuiting v2 manager close for the zero-provider case, the focused v2 rows are back in line with v1 on this machine: runtime setup/cleanup is about `~0.83 ms`, empty-tx abort/commit is about `~0.83-0.86 ms`, and immutable-cell variants are about `~0.85-0.88 ms`.
- [x] Reuse an ambient v2 read transaction for repeated post-commit reads until storage notifications invalidate it. The focused regression in [runtime-v2-read-tx-cache.test.ts](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/test/runtime-v2-read-tx-cache.test.ts) now pins both reuse and invalidation, and the latest [cell.bench.ts](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/test/cell.bench.ts) rerun on this machine moved `Cell get - simple value with schema` and `Cell getAsQueryResult - proxy creation schemaless` ahead of v1.
- [x] Add [cell-read-path.bench.ts](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/test/cell-read-path.bench.ts) to separate plain post-commit read costs from broader file-level noise. On this machine, the focused schemaless array-key and schema/asCell read cases are now at rough parity or faster on v2, so any remaining full-file `cell.bench.ts` regressions likely come from other setup/materialization paths rather than plain `runtime.readTx()` churn.
- [x] Add [cell-set-shape.bench.ts](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/test/cell-set-shape.bench.ts) to split `Cell.set()` into `recursivelyAddIDIfNeeded()`, `normalizeAndDiff()`, `diffAndUpdate()`, and full-loop costs for the common no-`asCell` object shape. On this machine, that focused bench shows `recursivelyAddIDIfNeeded()` at parity, with the remaining v2 gap concentrated in `normalizeAndDiff()` (`~1.38x`) and especially `diffAndUpdate()` / batch writes (`~1.64x`), so future work should target the transaction write path and diff-driven bookkeeping rather than more ID-annotation work.
- [x] Add [cell-set-array-shape.bench.ts](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/test/cell-set-array-shape.bench.ts) for the current top full-suite array outlier. In the isolated 10-item array shape, `normalizeAndDiff()` is already at parity or slightly faster on v2, full `cell.set()` is effectively tied, and the only repeatable lag is the fine-grained `diffAndUpdate()` write phase (`~1.44x` on this machine). That means the scary full-file `cell-set.bench.ts` array ratio does not reproduce cleanly in isolation, so future work should keep checking for harness/file-level interactions before landing complexity aimed only at that aggregate number.
- [ ] Use the attestation-vs-transaction delta in [storage-transaction-internals.bench.ts](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/test/storage-transaction-internals.bench.ts) to keep the next tuning pass honest. On this machine, direct attestation sibling `read+write` is only about `~9 µs` for 100 iterations, while the full v2 transaction sibling-write loop is still about `~2.5-2.6 ms`, so most of the remaining default-path cost is above raw attestation traversal.
- [ ] Keep the planned v2-internal transaction-core rewrite focused on simplifying the implementation behind `IExtendedStorageTransaction` instead of layering more caches onto the current shape. Recent speculative path-attestation caches did not move the benchmark, so future work should target simpler read/write bookkeeping rather than extra invalidation machinery.
- [ ] Continue using fair semantic document-value benches, not raw root-envelope writes, whenever comparing v1 and v2 storage paths. Benchmark shape mismatches already hid real progress once and should not steer future tuning.
- [ ] Investigate whether remaining scheduler/subscription outliers are dominated by wrapper/proxy fan-out costs above storage rather than the v2 engine itself before doing deeper storage-path surgery.
- [ ] Use the new `ct test --storage-stats` count-key output to chase the remaining pattern-test outliers by query shape, not just aggregate time. Current `store-mapper.test.tsx` diagnostics show the remaining v2-heavy work is dominated by subscription refresh fan-out (`~3985` considered subscriptions over `13` refreshes, with `~1760` full queries and `~1758` direct patches), especially schema-bearing internal stream paths, so future work should focus on collapsing or indexing those subscription shapes rather than only micro-optimizing commit cost.
- [ ] Keep chasing the remaining schema-bearing sigil-topology outlier in `store-mapper.test.tsx`. After the source-retarget fix, the remaining heavy keys are still `subscription-refresh/patch-skip/topology-change/sigil` (`~1342`) and schema-bearing full-query shapes like `argument.element:schema` / `internal.__#0stream:schema`, while the plain-root source subset has already fallen materially. Future work should focus on reducing the cost or count of those schema-bearing sigil reevaluations rather than revisiting the already-fixed plain source lineage case.
- [ ] If performance work returns to `reading-list.test.tsx`, treat it as a traversal hot path, not a storage-refresh regression. The latest v1/v2 storage totals are effectively tied there (`~13.7s` total in both defaults on this machine), with most of the time showing up under `traverse/traverse` and `traversePointerWithSchema` rather than extra v2 query fan-out.
- [ ] Decide whether the new schemaless same-document sync canonicalization should widen beyond `schema: false` roots, and only do so with explicit coverage for linked-doc / schema-driven query cases so we do not collapse meaningfully different subscriptions by accident.
- [ ] Treat structured in-process loopback transport as a non-priority unless new evidence appears. The focused v2 client transport bench showed effectively no win over JSON loopback, so the remaining hot path is elsewhere.

## Phase 3: Advanced Features After The Cutover
- [ ] Wire up branches end to end using the already-created `branch` table: create/delete/list, branch-scoped head resolution, merge proposals, branch-aware queries/subscriptions, and point-in-time reads on branches.
- [ ] Add garbage-collection scheduling for facts, snapshots, blobs, and deleted branches once retention rules are defined.
- [ ] Reintroduce classification and redaction only through the redesigned metadata model. Do not revive v1 label entities on the v2 path.
- [ ] Add richer patch classes such as CRDT/OT text operations only after the branch and conflict model is stable.

## Assumptions And Defaults
- [x] The cutover switch is a `RuntimeOptions` setting, not an environment variable or repo-global constant.
- [x] Phase 1 includes the schema/query/commit/session foundations needed for real runtime cutover, but not branching, classification/redaction redesign, or direct patch generation.
- [x] Phase 1 preserves current runner-facing APIs and uses adapters underneath them instead of rewriting scheduler and cell call sites first.
- [x] The current branch plan prioritizes v1-used runtime behavior over completeness of the full long-term v2 design.
