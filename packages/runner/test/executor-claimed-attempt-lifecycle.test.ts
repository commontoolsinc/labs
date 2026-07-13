import { assertEquals } from "@std/assert";
import type { ExecutionClaim } from "@commonfabric/memory/v2";
import {
  ClaimedAttemptLifecycle,
  claimedAttemptRejection,
  deleteExactClaimForAction,
} from "../src/executor/claimed-attempt-lifecycle.ts";

const claim = (generation: number): ExecutionClaim => ({
  branch: "",
  space: "did:key:z6Mk-claimed-attempt",
  contextKey: "space",
  pieceId: "of:claimed-attempt-piece",
  actionId: "action:claimed-attempt",
  actionKind: "computation",
  implementationFingerprint: "impl:claimed-attempt",
  runtimeFingerprint: "runtime:claimed-attempt",
  leaseGeneration: 2,
  claimGeneration: generation,
  expiresAt: 100_000,
});

Deno.test("claimed attempt readiness and settlement finish only the exact incarnation", async () => {
  const lifecycle = new ClaimedAttemptLifecycle<object>();
  const action = {};
  const activeClaim = claim(3);
  const handle = lifecycle.start(activeClaim, action);

  assertEquals(lifecycle.markRouted(activeClaim, {}), false);
  assertEquals(lifecycle.finish(claim(4), action), false);
  assertEquals(lifecycle.size, 1);

  assertEquals(lifecycle.markRouted(activeClaim, action), true);
  assertEquals(await handle.routeReady, "routed");
  assertEquals(lifecycle.finish(activeClaim, action), true);
  await handle.finalSettlement;
  assertEquals(lifecycle.size, 0);
});

Deno.test("releasing before route readiness unblocks both claimed waiters", async () => {
  const lifecycle = new ClaimedAttemptLifecycle<object>();
  const action = {};
  const activeClaim = claim(5);
  const handle = lifecycle.start(activeClaim, action);

  assertEquals(lifecycle.finish(activeClaim, action), true);
  assertEquals(await handle.routeReady, "released");
  await handle.finalSettlement;
  assertEquals(lifecycle.size, 0);
});

Deno.test("a later rerun release revokes authority after activation already settled", async () => {
  const lifecycle = new ClaimedAttemptLifecycle<object>();
  const claims = new WeakMap<object, ExecutionClaim>();
  const action = {};
  const activeClaim = claim(6);
  claims.set(action, activeClaim);
  const activation = lifecycle.start(activeClaim, action);
  lifecycle.markRouted(activeClaim, action);
  lifecycle.finish(activeClaim, action);
  await activation.finalSettlement;

  // A later reactive rerun has no activation waiter, but an unserved or
  // abandoned rejection must still release the action's live authority.
  assertEquals(lifecycle.finish(activeClaim, action), false);
  assertEquals(
    deleteExactClaimForAction(claims, activeClaim, action),
    true,
  );
  assertEquals(claims.has(action), false);
  assertEquals(
    deleteExactClaimForAction(claims, activeClaim, action),
    false,
  );
});

Deno.test("claimed rejection keeps active retries but releases abandoned attempts", () => {
  assertEquals(
    claimedAttemptRejection(
      { name: "ConflictError" },
      "retrying",
    ),
    { release: false },
  );
  assertEquals(
    claimedAttemptRejection(
      { name: "TransactionError" },
      "retrying",
    ),
    { release: false },
  );
  assertEquals(
    claimedAttemptRejection(
      { name: "TransactionError" },
      "abandoned",
    ),
    {
      release: true,
      diagnosticCode: "commit-retries-exhausted:TransactionError",
    },
  );
  assertEquals(
    claimedAttemptRejection(
      { name: "StorageTransactionAborted" },
      "retrying",
    ),
    {
      release: true,
      diagnosticCode: "commit-rejected:StorageTransactionAborted",
    },
  );
  assertEquals(
    claimedAttemptRejection(
      { name: "ExecutionLeaseFenceError" },
      "retrying",
    ),
    {
      release: true,
      diagnosticCode: "commit-rejected:ExecutionLeaseFenceError",
    },
  );
});
