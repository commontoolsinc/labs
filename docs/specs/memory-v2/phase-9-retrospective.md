# Phase 9 Retrospective: Wiring v2 Into Production

## Plan vs Reality: Key Deviations

**Route path:** Plan said v2 would coexist with v1 at `/api/storage/memory/v2`. Implementation **replaced** v1 at `/api/storage/memory`.

**V2TransactionAdapter was never built.** Instead of rewriting the transaction layer, a compatibility shim (`V2SpaceReplica`) was placed at the replica level, letting the existing v1 Transaction machinery work unchanged. More pragmatic, but completely different from the plan.

**Size estimates were 2-6x too low:**

| File | Planned | Actual | Ratio |
|------|---------|--------|-------|
| v2-provider.ts | ~200 | 1,227 | **6.1x** |
| v2-memory-service.ts | ~100 | 291 | 2.9x |
| v2-memory.handlers.ts | ~150 | 380 | 2.5x |
| v2-memory.routes.ts | ~80 | 187 | 2.3x |

**5 unplanned files were created:** `v2-consumer.ts`, `v2-replica.ts`, `v2-client-state.ts`, `v2-direct-transport.ts`, and the `V2EmulatedMemory`/`StorageManagerEmulator` classes in `cache.deno.ts`. The plan assumed some of these existed from earlier phases.

**Planned integration tests were never written.** Instead, the existing v1 test suite was run against v2 — which turned out to be more valuable, catching bugs at the v1/v2 boundary that purpose-built v2 tests would have missed.

---

## Architectural Surprises

1. **Claim routing (confirmed vs pending reads)** — 120 lines of hash comparison logic that the plan never anticipated. `cell.set()` always creates claims via `diffAndUpdate()`, so distinguishing parallel conflicts from pipelining is a correctness requirement, not an optimization.

2. **Double-notification prevention** — microtask ordering in V2DirectTransport means subscription updates for your OWN commits arrive BEFORE the commit response. Required filtering in two places.

3. **V2SpaceReplica.get() returning pending values** — seemingly trivial but load-bearing for pipelining correctness. Returning confirmed values caused false conflicts.

4. **`undefined` in clientCommit** — merkle-reference silently crashes on `undefined`. Direct property assignment (`branch: args.branch`) puts `undefined` as an own property; conditional spreads avoid it.

5. **V2HeapShim** — pure compatibility requirement for tests that access `provider.replica.heap.subscribe()`. Not mentioned anywhere in the plan.

6. **UCANTO-style message envelopes** (`task/effect`, `task/return`) — plan assumed simple JSON, implementation required envelope unwrapping.

---

## Retrospective: What Would Have Saved Time

1. **Budget 3-5x for compatibility layers.** The v2 protocol itself was clean; 70%+ of the code is bridging v1 interfaces to v2 internals.

2. **A "Pipelining and Claim Routing" section in the spec** with worked examples of blind writes, parallel conflicts, and pipelined writes would have turned 120 lines of debugging-discovered logic into spec-driven code.

3. **A `NO_UNDEFINED_IN_HASHABLE_OBJECTS` pattern** documented in codebase guidelines. The conditional spread pattern should be standard for anything going through `refer()`.

4. **Explicit microtask delivery ordering guarantees** for in-process transports. The double-notification bug was a protocol-level concern masquerading as a logic bug.

5. **Running the old test suite against the new backend first** — this was the most effective testing strategy, but was planned as the LAST step. Making it the first step would have surfaced interface mismatches earlier.

6. **Server-side parent resolution** (`resolveOperations`) appears in both the server and direct transport as duplicated code. The spec should have explicitly stated which side resolves parent references.
