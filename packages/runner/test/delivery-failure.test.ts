import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  observeDeliveryFailure,
  observeDeliveryRecovery,
  spentDeliveryFailureMs,
} from "../src/executor/delivery-failure.ts";
import { toReplicaLoadFailureError } from "../src/storage/interface.ts";

describe("served-event delivery failure policy", () => {
  it("accumulates failed episodes across recovery without charging recovery work", () => {
    const first = observeDeliveryFailure(undefined, {
      now: 1_000,
      phase: "dispatch-load",
      failureClass: "session-revoked",
      recoveryEpoch: "session:1",
    });
    expect(first.kind).toBe("deferred");
    if (first.kind !== "deferred") throw new Error("expected deferral");
    expect(spentDeliveryFailureMs(first.checkpoint, 21_000)).toBe(20_000);

    const recovering = observeDeliveryRecovery(
      first.checkpoint,
      "session:2",
      21_000,
    );
    expect(recovering).toEqual({
      ...first.checkpoint,
      accumulatedFailureMs: 20_000,
      activeFailureStartedAt: undefined,
      state: "recovering",
      recoveryEpoch: "session:2",
    });
    expect(spentDeliveryFailureMs(recovering, 51_000)).toBe(20_000);

    const repeated = observeDeliveryFailure(recovering, {
      now: 51_000,
      phase: "dispatch-load",
      failureClass: "connection",
      recoveryEpoch: "session:2",
    });
    expect(repeated.kind).toBe("deferred");
    if (repeated.kind !== "deferred") throw new Error("expected deferral");
    expect(repeated.checkpoint.accumulatedFailureMs).toBe(20_000);
    expect(repeated.checkpoint.activeFailureStartedAt).toBe(51_000);
    expect(repeated.checkpoint.failureCount).toBe(2);

    const exhausted = observeDeliveryFailure(repeated.checkpoint, {
      now: 91_000,
      phase: "dispatch-load",
      failureClass: "connection",
      recoveryEpoch: "session:2",
      budgetMs: 60_000,
    });
    expect(exhausted.kind).toBe("needs-attention");
    if (exhausted.kind !== "needs-attention") {
      throw new Error("expected terminal cover");
    }
    expect(exhausted.attention.accumulatedFailureMs).toBe(60_000);
    expect(exhausted.attention.failureCount).toBe(3);
    expect(exhausted.attention.code).toBe(
      "delivery-failure-budget-exhausted",
    );
  });

  it("clamps negative elapsed time and caps a forward jump at the budget", () => {
    const first = observeDeliveryFailure(undefined, {
      now: 10_000,
      phase: "commit-preparation",
      failureClass: "unknown",
      recoveryEpoch: "runtime:1",
    });
    if (first.kind !== "deferred") throw new Error("expected deferral");
    expect(spentDeliveryFailureMs(first.checkpoint, 9_000)).toBe(0);

    const jumped = observeDeliveryFailure(first.checkpoint, {
      now: Number.MAX_SAFE_INTEGER,
      phase: "commit-preparation",
      failureClass: "unknown",
      recoveryEpoch: "runtime:1",
      budgetMs: 60_000,
    });
    expect(jumped.kind).toBe("needs-attention");
    if (jumped.kind !== "needs-attention") {
      throw new Error("expected terminal cover");
    }
    expect(jumped.attention.accumulatedFailureMs).toBe(60_000);
  });

  it("terminalizes only positively evidenced permanent verdicts immediately", () => {
    const ambiguous = observeDeliveryFailure(undefined, {
      now: 1,
      phase: "dispatch-load",
      failureClass: "authorization",
      recoveryEpoch: "acl:1",
    });
    expect(ambiguous.kind).toBe("deferred");

    const permanent = observeDeliveryFailure(undefined, {
      now: 1,
      phase: "dispatch-load",
      failureClass: "authorization",
      recoveryEpoch: "acl:1",
      permanentEvidence: true,
    });
    expect(permanent.kind).toBe("needs-attention");
    if (permanent.kind !== "needs-attention") {
      throw new Error("expected terminal cover");
    }
    expect(permanent.attention.code).toBe("permanent-delivery-failure");

    const persisted = observeDeliveryFailure(permanent.checkpoint, {
      now: 2,
      phase: "dispatch-load",
      failureClass: "authorization",
      recoveryEpoch: "acl:1",
    });
    expect(persisted.kind).toBe("needs-attention");
    if (persisted.kind !== "needs-attention") {
      throw new Error("expected persisted permanent terminal cover");
    }
    expect(persisted.attention.code).toBe("permanent-delivery-failure");
  });

  it("accepts current-ACL evidence from the load producer, never from its name alone", () => {
    expect(
      toReplicaLoadFailureError({
        name: "AuthorizationError",
        message: "ambiguous denial",
      }, "load:1").failure,
    ).toEqual({
      failureClass: "authorization",
      recoveryEpoch: "load:1",
      permanentEvidence: false,
    });

    expect(
      toReplicaLoadFailureError({
        name: "AuthorizationError",
        message: "current ACL denied the load",
        permanentEvidence: true,
        aclRevision: 42,
      }, "load:2").failure,
    ).toEqual({
      failureClass: "authorization",
      recoveryEpoch: "acl:42",
      permanentEvidence: true,
    });
  });
});
