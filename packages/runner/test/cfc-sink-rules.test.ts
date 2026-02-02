/**
 * CFC Sink Declassification Rules — unit + integration tests
 *
 * Tests sink-aware declassification (Phase 9): builtins like fetchData can
 * inspect per-path taint and selectively strip authority-only atoms at
 * specific sink paths.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { applySinkDeclassification } from "../src/cfc/sink-gate.ts";
import type { SinkDeclassificationRule } from "../src/cfc/sink-rules.ts";
import { TaintMap } from "../src/cfc/taint-map.ts";
import type { Label } from "../src/cfc/labels.ts";
import { emptyIntegrity } from "../src/cfc/integrity.ts";
import { serviceAtom, userAtom } from "../src/cfc/atoms.ts";
import {
  CFCViolationError,
  createActionContext,
} from "../src/cfc/action-context.ts";
import {
  attachTaintContext,
  checkSinkAndWrite,
  detachTaintContext,
  recordTaintedRead,
} from "../src/cfc/taint-tracking.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createPolicy } from "../src/cfc/policy.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockTx(): IExtendedStorageTransaction {
  return {} as IExtendedStorageTransaction;
}

/** Service(google-auth) at Authorization header is OK for fetchData. */
const googleAuthSinkRule: SinkDeclassificationRule = {
  taintPattern: { kind: "Service", params: { id: "google-auth" } },
  allowedSink: "fetchData",
  allowedPaths: [["options", "headers", "Authorization"]],
  variables: [],
};

/** Wildcard: any Service($X) at Authorization header for fetchData. */
const wildcardServiceSinkRule: SinkDeclassificationRule = {
  taintPattern: { kind: "Service", params: { id: "$X" } },
  allowedSink: "fetchData",
  allowedPaths: [["options", "headers", "Authorization"]],
  variables: ["$X"],
};

const tokenLabel: Label = {
  confidentiality: [
    [userAtom("did:alice")],
    [serviceAtom("google-auth")],
  ],
  integrity: emptyIntegrity(),
};

const userOnlyTarget: Label = {
  confidentiality: [[userAtom("did:alice")]],
  integrity: emptyIntegrity(),
};

// ---------------------------------------------------------------------------
// SinkDeclassificationRule matching
// ---------------------------------------------------------------------------

describe("SinkDeclassificationRule matching", () => {
  it("matches Service(google-auth) at allowed path for correct sink", () => {
    const taintMap = new TaintMap();
    taintMap.add(["options", "headers", "Authorization"], tokenLabel);

    const result = applySinkDeclassification(
      taintMap,
      "fetchData",
      [googleAuthSinkRule],
    );

    // Service(google-auth) clause should be stripped; User(Alice) remains
    expect(result.confidentiality.length).toBe(1);
    expect(result.confidentiality[0]).toEqual([userAtom("did:alice")]);
  });

  it("does NOT match at wrong path", () => {
    const taintMap = new TaintMap();
    taintMap.add(["options", "body"], tokenLabel);

    const result = applySinkDeclassification(
      taintMap,
      "fetchData",
      [googleAuthSinkRule],
    );

    // Both clauses remain — no stripping at body path
    expect(result.confidentiality.length).toBe(2);
  });

  it("does NOT match for wrong sink", () => {
    const taintMap = new TaintMap();
    taintMap.add(["options", "headers", "Authorization"], tokenLabel);

    const result = applySinkDeclassification(
      taintMap,
      "otherBuiltin",
      [googleAuthSinkRule],
    );

    // No stripping for wrong sink
    expect(result.confidentiality.length).toBe(2);
  });

  it("matches with variable binding (Service($X))", () => {
    const taintMap = new TaintMap();
    taintMap.add(["options", "headers", "Authorization"], {
      confidentiality: [[serviceAtom("github-api")]],
      integrity: emptyIntegrity(),
    });

    const result = applySinkDeclassification(
      taintMap,
      "fetchData",
      [wildcardServiceSinkRule],
    );

    // Service clause stripped via wildcard
    expect(result.confidentiality.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applySinkDeclassification
// ---------------------------------------------------------------------------

describe("applySinkDeclassification", () => {
  it("strips token taint at Authorization header path", () => {
    const taintMap = new TaintMap();
    taintMap.add(["options", "headers", "Authorization"], {
      confidentiality: [[serviceAtom("google-auth")]],
      integrity: emptyIntegrity(),
    });
    taintMap.add([], {
      confidentiality: [[userAtom("did:alice")]],
      integrity: emptyIntegrity(),
    });

    const result = applySinkDeclassification(
      taintMap,
      "fetchData",
      [googleAuthSinkRule],
    );

    expect(result.confidentiality.length).toBe(1);
    expect(result.confidentiality[0]).toEqual([userAtom("did:alice")]);
  });

  it("does NOT strip token taint at body path", () => {
    const taintMap = new TaintMap();
    taintMap.add(["options", "body"], {
      confidentiality: [[serviceAtom("google-auth")]],
      integrity: emptyIntegrity(),
    });
    taintMap.add([], {
      confidentiality: [[userAtom("did:alice")]],
      integrity: emptyIntegrity(),
    });

    const result = applySinkDeclassification(
      taintMap,
      "fetchData",
      [googleAuthSinkRule],
    );

    // Both clauses remain
    expect(result.confidentiality.length).toBe(2);
  });

  it("non-matching taint (User atom) is unaffected", () => {
    const taintMap = new TaintMap();
    taintMap.add(["options", "headers", "Authorization"], {
      confidentiality: [[userAtom("did:alice")]],
      integrity: emptyIntegrity(),
    });

    const result = applySinkDeclassification(
      taintMap,
      "fetchData",
      [googleAuthSinkRule],
    );

    // User atom doesn't match Service pattern — stays
    expect(result.confidentiality.length).toBe(1);
    expect(result.confidentiality[0]).toEqual([userAtom("did:alice")]);
  });

  it("multiple rules, multiple paths — correct composition", () => {
    const multiPathRule: SinkDeclassificationRule = {
      taintPattern: { kind: "Service", params: { id: "google-auth" } },
      allowedSink: "fetchData",
      allowedPaths: [
        ["options", "headers", "Authorization"],
        ["options", "headers", "X-Custom-Auth"],
      ],
      variables: [],
    };

    const taintMap = new TaintMap();
    // Token at both allowed header paths
    taintMap.add(["options", "headers", "Authorization"], {
      confidentiality: [[serviceAtom("google-auth")]],
      integrity: emptyIntegrity(),
    });
    taintMap.add(["options", "headers", "X-Custom-Auth"], {
      confidentiality: [[serviceAtom("google-auth")]],
      integrity: emptyIntegrity(),
    });

    const result = applySinkDeclassification(
      taintMap,
      "fetchData",
      [multiPathRule],
    );

    expect(result.confidentiality.length).toBe(0);
  });

  it("empty rules → no declassification (backwards compat)", () => {
    const taintMap = new TaintMap();
    taintMap.add([], tokenLabel);

    const result = applySinkDeclassification(taintMap, "fetchData", []);

    expect(result.confidentiality.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// checkSinkAndWrite integration
// ---------------------------------------------------------------------------

describe("checkSinkAndWrite", () => {
  it("Gmail scenario: token in header → write to User-only target succeeds", () => {
    const policy = createPolicy([], 1, [googleAuthSinkRule]);
    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
      policy,
    });
    attachTaintContext(tx, ctx);

    // Read token with path tracking
    recordTaintedRead(tx, tokenLabel, [
      "options",
      "headers",
      "Authorization",
    ]);

    // Sink-aware write check: Service(google-auth) stripped at header path
    expect(() => checkSinkAndWrite(tx, userOnlyTarget, "fetchData")).not
      .toThrow();

    detachTaintContext(tx);
  });

  it("Gmail scenario: token in body → write blocked", () => {
    const policy = createPolicy([], 1, [googleAuthSinkRule]);
    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
      policy,
    });
    attachTaintContext(tx, ctx);

    // Read token with body path (NOT in allowed paths)
    recordTaintedRead(tx, tokenLabel, ["options", "body"]);

    // Should throw — Service(google-auth) not stripped at body path
    expect(() => checkSinkAndWrite(tx, userOnlyTarget, "fetchData")).toThrow(
      CFCViolationError,
    );

    detachTaintContext(tx);
  });

  it("no sink rules → falls through to standard exchange rules", () => {
    const policy = createPolicy([], 1, []); // No sink rules
    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
      policy,
    });
    attachTaintContext(tx, ctx);

    recordTaintedRead(tx, tokenLabel, [
      "options",
      "headers",
      "Authorization",
    ]);

    // Without sink rules, Service(google-auth) is NOT stripped → blocked
    expect(() => checkSinkAndWrite(tx, userOnlyTarget, "fetchData")).toThrow(
      CFCViolationError,
    );

    detachTaintContext(tx);
  });

  it("no taint context → no-op", () => {
    const tx = mockTx();
    // No taint context attached — should not throw
    expect(() => checkSinkAndWrite(tx, userOnlyTarget, "fetchData")).not
      .toThrow();
  });
});
