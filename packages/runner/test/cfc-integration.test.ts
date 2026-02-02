import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  createActionContext,
  CFCViolationError,
} from "../src/cfc/action-context.ts";
import {
  attachTaintContext,
  recordTaintedRead,
  checkTaintedWrite,
  detachTaintContext,
} from "../src/cfc/taint-tracking.ts";
import {
  emptyLabel,
  labelFromClassification,
  labelFromSchemaIfc,
  joinLabel,
  type Label,
} from "../src/cfc/labels.ts";
import {
  emptyIntegrity,
  integrityFromAtoms,
} from "../src/cfc/integrity.ts";
import {
  userAtom,
  spaceAtom,
  classificationAtom,
  hasRoleAtom,
} from "../src/cfc/atoms.ts";
import { emptyConfidentiality } from "../src/cfc/confidentiality.ts";
import type { ExchangeRule } from "../src/cfc/exchange-rules.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

/**
 * Create a minimal mock transaction object that satisfies the WeakMap key
 * requirement. We only need it as a key for taint-tracking; no real storage
 * operations are tested here.
 */
function mockTx(): IExtendedStorageTransaction {
  return {} as IExtendedStorageTransaction;
}

// ---------------------------------------------------------------------------
// Integration tests: end-to-end taint tracking through the transaction layer
// ---------------------------------------------------------------------------

describe("CFC integration: taint tracking through transactions", () => {
  it("read secret → write unclassified → FAILS", () => {
    const tx = mockTx();
    const ctx = createActionContext({ userDid: "did:alice", space: "space:work" });
    attachTaintContext(tx, ctx);

    // Simulate reading a secret-labeled cell
    recordTaintedRead(tx, labelFromClassification("secret"));

    // Attempt to write to an unclassified cell — should throw
    expect(() => checkTaintedWrite(tx, emptyLabel())).toThrow(CFCViolationError);

    detachTaintContext(tx);
  });

  it("read secret → write secret → SUCCEEDS", () => {
    const tx = mockTx();
    const ctx = createActionContext({ userDid: "did:alice", space: "space:work" });
    attachTaintContext(tx, ctx);

    recordTaintedRead(tx, labelFromClassification("secret"));

    // Write to a cell with matching classification — should succeed
    expect(() => checkTaintedWrite(tx, labelFromClassification("secret"))).not.toThrow();

    detachTaintContext(tx);
  });

  it("write-up: read unclassified → write secret → SUCCEEDS", () => {
    const tx = mockTx();
    const ctx = createActionContext({ userDid: "did:alice", space: "space:work" });
    attachTaintContext(tx, ctx);

    // No taint accumulated (or empty taint)
    recordTaintedRead(tx, emptyLabel());

    // Writing to a higher classification is always allowed
    expect(() => checkTaintedWrite(tx, labelFromClassification("secret"))).not.toThrow();

    detachTaintContext(tx);
  });

  it("multiple reads accumulate: secret + confidential → write confidential → FAILS", () => {
    const tx = mockTx();
    const ctx = createActionContext({ userDid: "did:alice", space: "space:work" });
    attachTaintContext(tx, ctx);

    recordTaintedRead(tx, labelFromClassification("secret"));
    recordTaintedRead(tx, labelFromClassification("confidential"));

    // Taint is now {secret, confidential}. Writing to just "confidential" is write-down.
    expect(() => checkTaintedWrite(tx, labelFromClassification("confidential"))).toThrow(CFCViolationError);

    detachTaintContext(tx);
  });

  it("multiple reads accumulate: secret + confidential → write to both → SUCCEEDS", () => {
    const tx = mockTx();
    const ctx = createActionContext({ userDid: "did:alice", space: "space:work" });
    attachTaintContext(tx, ctx);

    recordTaintedRead(tx, labelFromClassification("secret"));
    recordTaintedRead(tx, labelFromClassification("confidential"));

    // Write target that contains both classifications
    const target = labelFromSchemaIfc({ classification: ["secret", "confidential"] });
    expect(() => checkTaintedWrite(tx, target)).not.toThrow();

    detachTaintContext(tx);
  });

  it("no taint context → reads and writes are no-ops (backwards compat)", () => {
    const tx = mockTx();

    // No attachTaintContext call — simulates cfcEnabled=false
    recordTaintedRead(tx, labelFromClassification("secret"));
    expect(() => checkTaintedWrite(tx, emptyLabel())).not.toThrow();
  });

  it("empty labels on both sides never cause violations", () => {
    const tx = mockTx();
    const ctx = createActionContext({ userDid: "did:alice", space: "space:work" });
    attachTaintContext(tx, ctx);

    recordTaintedRead(tx, emptyLabel());
    expect(() => checkTaintedWrite(tx, emptyLabel())).not.toThrow();

    detachTaintContext(tx);
  });
});

// ---------------------------------------------------------------------------
// Integration: exchange rules through transaction layer
// ---------------------------------------------------------------------------

describe("CFC integration: exchange rules via transactions", () => {
  it("exchange rule declassifies space data for authorized user", () => {
    const tx = mockTx();
    const ctx = createActionContext({ userDid: "did:alice", space: "space:work" });
    attachTaintContext(tx, ctx);

    // Read space-labeled data
    const spaceLabel: Label = {
      confidentiality: [[spaceAtom("space:work")]],
      integrity: emptyIntegrity(),
    };
    recordTaintedRead(tx, spaceLabel);

    // Without exchange rule, writing to user-scoped target fails
    const userTarget: Label = {
      confidentiality: [[spaceAtom("space:work"), userAtom("did:alice")]],
      integrity: emptyIntegrity(),
    };

    // Simple exchange rule (no integrity precondition): Space(X) → add User alternative
    const rule: ExchangeRule = {
      confidentialityPre: [{ kind: "Space", params: { space: "$X" } }],
      integrityPre: [],
      addAlternatives: [{ kind: "User", params: { did: "did:alice" } }],
      variables: ["$X"],
    };

    // Without rule, write fails
    expect(() => checkTaintedWrite(tx, userTarget)).toThrow(CFCViolationError);
    // With the exchange rule, the write should succeed
    expect(() => checkTaintedWrite(tx, userTarget, [rule])).not.toThrow();

    detachTaintContext(tx);
  });

  it("exchange rule does NOT help when confidentiality precondition not met", () => {
    const tx = mockTx();
    const ctx = createActionContext({ userDid: "did:alice", space: "space:work" });
    attachTaintContext(tx, ctx);

    // Read user-labeled data (not space-labeled)
    const userLabel: Label = {
      confidentiality: [[userAtom("did:bob")]],
      integrity: emptyIntegrity(),
    };
    recordTaintedRead(tx, userLabel);

    const target: Label = {
      confidentiality: [[userAtom("did:alice")]],
      integrity: emptyIntegrity(),
    };

    // Rule only matches Space atoms, not User atoms
    const rule: ExchangeRule = {
      confidentialityPre: [{ kind: "Space", params: { space: "$X" } }],
      integrityPre: [],
      addAlternatives: [{ kind: "User", params: { did: "did:alice" } }],
      variables: ["$X"],
    };

    // Rule doesn't match User(bob) → still a violation
    expect(() => checkTaintedWrite(tx, target, [rule])).toThrow(CFCViolationError);

    detachTaintContext(tx);
  });
});

// ---------------------------------------------------------------------------
// Integration: dry-run mode
// ---------------------------------------------------------------------------

describe("CFC integration: dry-run mode", () => {
  it("dry-run logs but does not throw on violation", () => {
    const tx = mockTx();
    const ctx = createActionContext({ userDid: "did:alice", space: "space:work" });
    attachTaintContext(tx, ctx, { dryRun: true });

    recordTaintedRead(tx, labelFromClassification("secret"));

    // In dry-run, write-down does NOT throw
    expect(() => checkTaintedWrite(tx, emptyLabel())).not.toThrow();

    detachTaintContext(tx);
  });

  it("dry-run emits telemetry event", () => {
    const tx = mockTx();
    const ctx = createActionContext({ userDid: "did:alice", space: "space:work" });

    const events: unknown[] = [];
    const telemetry = {
      submit(event: unknown) { events.push(event); },
    };

    attachTaintContext(tx, ctx, {
      dryRun: true,
      telemetry: telemetry as any,
    });

    recordTaintedRead(tx, labelFromClassification("secret"));
    checkTaintedWrite(tx, emptyLabel());

    expect(events.length).toBe(1);
    expect((events[0] as any).type).toBe("cfc.violation");
    expect((events[0] as any).isDryRun).toBe(true);

    detachTaintContext(tx);
  });

  it("non-dry-run also emits telemetry before throwing", () => {
    const tx = mockTx();
    const ctx = createActionContext({ userDid: "did:alice", space: "space:work" });

    const events: unknown[] = [];
    const telemetry = {
      submit(event: unknown) { events.push(event); },
    };

    attachTaintContext(tx, ctx, {
      dryRun: false,
      telemetry: telemetry as any,
    });

    recordTaintedRead(tx, labelFromClassification("secret"));
    expect(() => checkTaintedWrite(tx, emptyLabel())).toThrow(CFCViolationError);

    expect(events.length).toBe(1);
    expect((events[0] as any).type).toBe("cfc.violation");
    expect((events[0] as any).isDryRun).toBe(false);

    detachTaintContext(tx);
  });
});

// ---------------------------------------------------------------------------
// Integration: multi-space isolation
// ---------------------------------------------------------------------------

describe("CFC integration: multi-space", () => {
  it("data from space-A cannot flow to space-B target", () => {
    const tx = mockTx();
    const ctx = createActionContext({ userDid: "did:alice", space: "space:a" });
    attachTaintContext(tx, ctx);

    recordTaintedRead(tx, {
      confidentiality: [[spaceAtom("space:a")]],
      integrity: emptyIntegrity(),
    });

    // Target is space:b — incomparable to space:a
    const target: Label = {
      confidentiality: [[spaceAtom("space:b")]],
      integrity: emptyIntegrity(),
    };

    expect(() => checkTaintedWrite(tx, target)).toThrow(CFCViolationError);

    detachTaintContext(tx);
  });

  it("data from space-A can flow to same space-A target", () => {
    const tx = mockTx();
    const ctx = createActionContext({ userDid: "did:alice", space: "space:a" });
    attachTaintContext(tx, ctx);

    recordTaintedRead(tx, {
      confidentiality: [[spaceAtom("space:a")]],
      integrity: emptyIntegrity(),
    });

    const target: Label = {
      confidentiality: [[spaceAtom("space:a")]],
      integrity: emptyIntegrity(),
    };

    expect(() => checkTaintedWrite(tx, target)).not.toThrow();

    detachTaintContext(tx);
  });
});

// ---------------------------------------------------------------------------
// Integration: schema ifc → label conversion end-to-end
// ---------------------------------------------------------------------------

describe("CFC integration: schema ifc to label flow", () => {
  it("labelFromSchemaIfc with classification feeds into taint correctly", () => {
    const tx = mockTx();
    const ctx = createActionContext({ userDid: "did:alice", space: "space:work" });
    attachTaintContext(tx, ctx);

    // Simulate what schema.ts does: convert ifc to label, then record read
    const schemaIfc = { classification: ["secret"] };
    const label = labelFromSchemaIfc(schemaIfc);
    recordTaintedRead(tx, label);

    // Now check that write to matching classification works
    const writeLabel = labelFromSchemaIfc({ classification: ["secret"] });
    expect(() => checkTaintedWrite(tx, writeLabel)).not.toThrow();

    // But write to empty fails
    expect(() => checkTaintedWrite(tx, emptyLabel())).toThrow(CFCViolationError);

    detachTaintContext(tx);
  });

  it("joinLabel merges schema + stored labels correctly", () => {
    const schemaLabel = labelFromSchemaIfc({ classification: ["secret"] });
    const storedLabel: Label = {
      confidentiality: [[userAtom("did:owner")]],
      integrity: emptyIntegrity(),
    };

    const merged = joinLabel(schemaLabel, storedLabel);

    // Merged label should require both secret AND user:owner
    expect(merged.confidentiality.length).toBe(2);

    const tx = mockTx();
    const ctx = createActionContext({ userDid: "did:alice", space: "space:work" });
    attachTaintContext(tx, ctx);

    recordTaintedRead(tx, merged);

    // Writing to just secret fails (missing user clause)
    expect(() => checkTaintedWrite(tx, labelFromClassification("secret"))).toThrow(CFCViolationError);

    // Writing to target with both succeeds
    const fullTarget: Label = {
      confidentiality: [
        [classificationAtom("secret")],
        [userAtom("did:owner")],
      ],
      integrity: emptyIntegrity(),
    };
    expect(() => checkTaintedWrite(tx, fullTarget)).not.toThrow();

    detachTaintContext(tx);
  });
});

// ---------------------------------------------------------------------------
// Integration: push/remove/sample scenarios
// ---------------------------------------------------------------------------

describe("CFC integration: push, remove, and sample taint scenarios", () => {
  it("push to secret array succeeds (write target is secret)", () => {
    const tx = mockTx();
    const ctx = createActionContext({ userDid: "did:alice", space: "space:work" });
    attachTaintContext(tx, ctx);

    // Reading unclassified data, then pushing to a secret array
    recordTaintedRead(tx, emptyLabel());

    // Write target is the secret array — write-up is fine
    expect(() => checkTaintedWrite(tx, labelFromClassification("secret"))).not.toThrow();

    detachTaintContext(tx);
  });

  it("push to secret array after reading secret succeeds (same level)", () => {
    const tx = mockTx();
    const ctx = createActionContext({ userDid: "did:alice", space: "space:work" });
    attachTaintContext(tx, ctx);

    // Reading secret data, then pushing to a secret array — same level
    recordTaintedRead(tx, labelFromClassification("secret"));
    expect(() => checkTaintedWrite(tx, labelFromClassification("secret"))).not.toThrow();

    detachTaintContext(tx);
  });

  it("remove from secret array then write to unclassified fails (get taints)", () => {
    const tx = mockTx();
    const ctx = createActionContext({ userDid: "did:alice", space: "space:work" });
    attachTaintContext(tx, ctx);

    // remove() calls get() on the secret array, which taints the action
    recordTaintedRead(tx, labelFromClassification("secret"));

    // Then set() writes the filtered array — if the target cell is
    // unclassified, this is a write-down violation
    expect(() => checkTaintedWrite(tx, emptyLabel())).toThrow(CFCViolationError);

    detachTaintContext(tx);
  });

  it("remove from secret array then write back to secret succeeds", () => {
    const tx = mockTx();
    const ctx = createActionContext({ userDid: "did:alice", space: "space:work" });
    attachTaintContext(tx, ctx);

    // remove() reads the secret array
    recordTaintedRead(tx, labelFromClassification("secret"));

    // set() writes back to the same secret array — same level, OK
    expect(() => checkTaintedWrite(tx, labelFromClassification("secret"))).not.toThrow();

    detachTaintContext(tx);
  });

  it("sample() of secret cell taints subsequent writes", () => {
    const tx = mockTx();
    const ctx = createActionContext({ userDid: "did:alice", space: "space:work" });
    attachTaintContext(tx, ctx);

    // sample() accumulates taint just like get()
    recordTaintedRead(tx, labelFromClassification("secret"));

    // Write to unclassified after sampling secret → violation
    expect(() => checkTaintedWrite(tx, emptyLabel())).toThrow(CFCViolationError);

    // Write to secret after sampling secret → OK
    expect(() => checkTaintedWrite(tx, labelFromClassification("secret"))).not.toThrow();

    detachTaintContext(tx);
  });

  it("sample() of unclassified does not taint", () => {
    const tx = mockTx();
    const ctx = createActionContext({ userDid: "did:alice", space: "space:work" });
    attachTaintContext(tx, ctx);

    // sample() of unclassified — no taint
    recordTaintedRead(tx, emptyLabel());

    // Write to unclassified — fine
    expect(() => checkTaintedWrite(tx, emptyLabel())).not.toThrow();

    detachTaintContext(tx);
  });
});
