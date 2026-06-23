// Scheduler-side half of the conflict/subscription coherence invariant that
// #4210 depends on (and #4220 establishes).
//
// #4210 makes a reactive compute STOP re-queueing itself when its commit fails
// with a granular ConflictError, on the premise that the write which caused the
// conflict already dirtied the compute's (still-subscribed) reads, so normal
// reader-dirty propagation re-runs it. That premise holds only if every
// commit-conflict is also a reader-dirty trigger:
//
//     commitConflicts(write, read)  ==>  readerDirty(write, read)
//
// The two predicates live in different code paths:
//
//   - commit-conflict (memory engine `validateConfirmedReads` -> `patchOverlapsRead`)
//     PARENT-INJECTS before #4220: an `add` of `votes/alice` touches
//     `[votes/alice, votes]`, and the injected parent `votes` prefix-matches a
//     read of the disjoint sibling `votes/bob`  ==> CONFLICT.
//   - reader-dirty (scheduler `arraysOverlap`, fed by leaf-only
//     `schedulerTouchedLeafPathsForPatch`) is LEAF-ONLY: `votes/alice` does not
//     overlap `votes/bob`  ==> NOT a reader, NOT dirtied.
//
// So before #4220 a compute that reads one key, racing a peer that adds a
// disjoint sibling key, gets a granular ConflictError but is never re-triggered;
// with #4210's re-queue removed its derived write is silently dropped. #4220
// aligns the commit-conflict matcher onto the same leaf-only paths the scheduler
// uses, so the spurious conflict disappears and the invariant holds.
//
// Coverage split (both layers needed; neither is reachable from a single-replica
// runtime test, where the client-side whole-document attestation guard
// short-circuits with `StorageTransactionInconsistent` before the engine's
// path-granular matcher runs):
//   - commit-conflict layer: packages/memory/test/v2-engine-test.ts ->
//     "memory v2 engine: leaf-only commit conflict — disjoint-key writers merge".
//     That test PASSES with #4220's leaf-only matcher and FAILS (ConflictError,
//     validateConfirmedReads) on the parent-injecting matcher — i.e. it flips
//     exactly at #4220, which is the commit-conflict half of the coupling.
//   - reader-dirty layer: the assertions below, on the real scheduler predicate.

import { assert } from "@std/assert";
import {
  arraysOverlap,
  nonRecursiveReadMayOverlapWrite,
} from "../src/reactive-dependencies.ts";

Deno.test(
  "reader-dirty re-triggers container readers but not disjoint-sibling readers",
  () => {
    // A sibling-leaf reader is exactly the reader leaf-only propagation does NOT
    // re-trigger — so a granular conflict against it cannot be recovered by
    // subscription, which is why #4210 is unsafe until #4220 stops the engine
    // from raising that conflict in the first place.
    assert(
      arraysOverlap(["votes", "alice"], ["votes", "bob"]) === false,
      "a write to votes.alice must NOT dirty a reader of the disjoint sibling votes.bob",
    );

    // A whole-container reader IS dirtied by the add — this is the
    // true-dependency case #4210's subscription-recovery relies on.
    assert(
      arraysOverlap(["votes", "alice"], ["votes"]) === true,
      "a write to votes.alice MUST dirty a reader of the container votes",
    );

    // A non-recursive (keyset / shape) reader of the container is also dirtied by
    // a direct-child add via the length+1 rule, so keyset readers recover too.
    assert(
      nonRecursiveReadMayOverlapWrite(["votes"], ["votes", "alice"]) === true,
      "a non-recursive reader of votes MUST be dirtied by adding the child votes.alice",
    );
  },
);
