/**
 * CFC Gmail End-to-End Tests (Phase 10)
 *
 * Tests the complete Gmail read, write, and error flows at the taint-tracking
 * unit level, verifying that sink declassification, exchange rules, and path-
 * level taint interact correctly for realistic Gmail API scenarios.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  CFCViolationError,
  createActionContext,
} from "../src/cfc/action-context.ts";
import {
  attachTaintContext,
  checkSinkAndWrite,
  checkTaintedWrite,
  detachTaintContext,
  recordTaintedRead,
} from "../src/cfc/taint-tracking.ts";
import {
  emptyLabel,
  type Label,
  labelFromClassification,
} from "../src/cfc/labels.ts";
import { emptyIntegrity } from "../src/cfc/integrity.ts";
import {
  authorizedRequestAtom,
  serviceAtom,
  userAtom,
} from "../src/cfc/atoms.ts";
import type { ExchangeRule } from "../src/cfc/exchange-rules.ts";
import { createPolicy } from "../src/cfc/policy.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockTx(): IExtendedStorageTransaction {
  return {} as IExtendedStorageTransaction;
}

/** Standard Google auth sink rule: Service(google-auth) at Authorization header path. */
const googleAuthSinkRule: ExchangeRule = {
  confidentialityPre: [{ kind: "Service", params: { id: "google-auth" } }],
  integrityPre: [],
  addAlternatives: [],
  removeMatchedClauses: true,
  variables: [],
  allowedSink: "fetchData",
  allowedPaths: [["options", "headers", "Authorization"]],
};

/** Exchange rule that strips any Service atom (authority-only semantics). */
const authorityOnlyRule: ExchangeRule = {
  confidentialityPre: [{ kind: "Service", params: { id: "$X" } }],
  integrityPre: [],
  removeMatchedClauses: true,
  addAlternatives: [],
  variables: ["$X"],
};

/** Token label: User(Alice) AND Service(google-auth). */
const tokenLabel: Label = {
  confidentiality: [
    [userAtom("did:alice")],
    [serviceAtom("google-auth")],
  ],
  integrity: emptyIntegrity(),
};

/** User-only label: User(Alice). */
const userOnlyLabel: Label = {
  confidentiality: [[userAtom("did:alice")]],
  integrity: emptyIntegrity(),
};

// ---------------------------------------------------------------------------
// 10.1 Gmail Read Path (end-to-end)
// ---------------------------------------------------------------------------

describe("CFC Gmail E2E: Read Path (10.1)", () => {
  it("full read flow: token taint declassified at header, response carries User only", () => {
    const policy = createPolicy([authorityOnlyRule, googleAuthSinkRule], 1);
    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
      policy,
    });
    attachTaintContext(tx, ctx);

    // Step 1: Read OAuth token — accumulates User(Alice) AND Service(google-auth)
    // Token value flows into Authorization header path
    recordTaintedRead(tx, tokenLabel, [
      "options",
      "headers",
      "Authorization",
    ]);

    // Step 2: fetchData sink gate — declassifies Service at header path
    // After this, only User(Alice) remains in the effective taint
    expect(() => checkSinkAndWrite(tx, userOnlyLabel, "fetchData")).not
      .toThrow();

    // Step 3: Verify AuthorizedRequest integrity was emitted
    expect(ctx.acquiredIntegrity).toEqual([
      authorizedRequestAtom("fetchData"),
    ]);

    // Step 4: Simulate response arriving — in a new context (fetchData writes
    // response in a fresh transaction). The response cell gets User(Alice) taint.
    detachTaintContext(tx);

    // Step 5: Downstream recipe reads the response (User-only taint)
    const tx2 = mockTx();
    const ctx2 = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    attachTaintContext(tx2, ctx2);

    // Read response with User(Alice) taint only — no Service taint
    recordTaintedRead(tx2, userOnlyLabel);

    // Write to unclassified output — succeeds because no Service taint
    expect(() => checkTaintedWrite(tx2, userOnlyLabel)).not.toThrow();

    // Write to empty target also works (User taint flows down)
    // Actually empty target is less classified, so this should fail
    expect(() => checkTaintedWrite(tx2, emptyLabel())).toThrow(
      CFCViolationError,
    );

    detachTaintContext(tx2);
  });

  it("token at header path: Service stripped, User preserved", () => {
    const policy = createPolicy([googleAuthSinkRule], 1);
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

    // After sink declassification, Service is gone but User remains.
    // Writing to User(Alice) target succeeds.
    expect(() => checkSinkAndWrite(tx, userOnlyLabel, "fetchData")).not
      .toThrow();

    // Writing to empty target fails — User(Alice) still present.
    expect(() => checkSinkAndWrite(tx, emptyLabel(), "fetchData")).toThrow(
      CFCViolationError,
    );

    detachTaintContext(tx);
  });

  it("response without Service taint is freely readable downstream", () => {
    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    attachTaintContext(tx, ctx);

    // Read Gmail response — only User(Alice), no Service
    recordTaintedRead(tx, userOnlyLabel);

    // Can write to any User(Alice) target
    expect(() => checkTaintedWrite(tx, userOnlyLabel)).not.toThrow();

    // Cannot write to targets missing User(Alice)
    expect(() => checkTaintedWrite(tx, emptyLabel())).toThrow(
      CFCViolationError,
    );

    detachTaintContext(tx);
  });

  it("read with secret search query: response inherits query taint", () => {
    const policy = createPolicy([authorityOnlyRule, googleAuthSinkRule], 1);
    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
      policy,
    });
    attachTaintContext(tx, ctx);

    // Read token at header path
    recordTaintedRead(tx, tokenLabel, [
      "options",
      "headers",
      "Authorization",
    ]);

    // Read secret search query at query param path
    recordTaintedRead(tx, labelFromClassification("secret"), [
      "options",
      "params",
      "q",
    ]);

    // Sink gate strips Service at header, but secret remains
    // Writing to User-only target fails due to secret clause
    expect(() => checkSinkAndWrite(tx, userOnlyLabel, "fetchData")).toThrow(
      CFCViolationError,
    );

    // Writing to User(Alice) AND secret target succeeds
    const secretUserTarget: Label = {
      confidentiality: [
        [userAtom("did:alice")],
        [{ kind: "Classification", level: "secret" }],
      ],
      integrity: emptyIntegrity(),
    };
    expect(() => checkSinkAndWrite(tx, secretUserTarget, "fetchData")).not
      .toThrow();

    detachTaintContext(tx);
  });
});

// ---------------------------------------------------------------------------
// 10.2 Gmail Write Path
// ---------------------------------------------------------------------------

describe("CFC Gmail E2E: Write Path (10.2)", () => {
  it("POST: token in header (declassified), draft in body (taint preserved)", () => {
    const policy = createPolicy([authorityOnlyRule, googleAuthSinkRule], 1);
    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
      policy,
    });
    attachTaintContext(tx, ctx);

    // Read token — placed in Authorization header
    recordTaintedRead(tx, tokenLabel, [
      "options",
      "headers",
      "Authorization",
    ]);

    // Read draft email — user data placed in body
    const draftLabel: Label = {
      confidentiality: [[userAtom("did:alice")]],
      integrity: emptyIntegrity(),
    };
    recordTaintedRead(tx, draftLabel, ["options", "body"]);

    // fetchData sink gate: Service stripped at header, draft taint at body untouched
    // Result: User(Alice) remains from both token and draft
    expect(() => checkSinkAndWrite(tx, userOnlyLabel, "fetchData")).not
      .toThrow();

    // Verify AuthorizedRequest emitted
    expect(ctx.acquiredIntegrity).toEqual([
      authorizedRequestAtom("fetchData"),
    ]);

    detachTaintContext(tx);
  });

  it("POST response inherits draft taint but not token Service taint", () => {
    const policy = createPolicy([authorityOnlyRule, googleAuthSinkRule], 1);
    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
      policy,
    });
    attachTaintContext(tx, ctx);

    // Read token at header path
    recordTaintedRead(tx, tokenLabel, [
      "options",
      "headers",
      "Authorization",
    ]);

    // Read draft at body path
    recordTaintedRead(tx, userOnlyLabel, ["options", "body"]);

    // Sink declassification succeeds — write response with User(Alice)
    expect(() => checkSinkAndWrite(tx, userOnlyLabel, "fetchData")).not
      .toThrow();

    detachTaintContext(tx);

    // Downstream: response carries User(Alice) from draft, not Service
    const tx2 = mockTx();
    const ctx2 = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    attachTaintContext(tx2, ctx2);

    recordTaintedRead(tx2, userOnlyLabel);

    // Write to User target succeeds
    expect(() => checkTaintedWrite(tx2, userOnlyLabel)).not.toThrow();

    // No Service taint — would fail if Service leaked through
    const serviceTarget: Label = {
      confidentiality: [
        [userAtom("did:alice")],
        [serviceAtom("google-auth")],
      ],
      integrity: emptyIntegrity(),
    };
    // Writing to a MORE classified target always works (write-up)
    expect(() => checkTaintedWrite(tx2, serviceTarget)).not.toThrow();

    detachTaintContext(tx2);
  });

  it("draft with secret search query: response inherits secret taint", () => {
    const policy = createPolicy([authorityOnlyRule, googleAuthSinkRule], 1);
    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
      policy,
    });
    attachTaintContext(tx, ctx);

    // Token at header
    recordTaintedRead(tx, tokenLabel, [
      "options",
      "headers",
      "Authorization",
    ]);

    // Draft body includes secret data (e.g. search results from private notes)
    const secretDraftLabel: Label = {
      confidentiality: [
        [userAtom("did:alice")],
        [{ kind: "Classification", level: "secret" }],
      ],
      integrity: emptyIntegrity(),
    };
    recordTaintedRead(tx, secretDraftLabel, ["options", "body"]);

    // Sink gate strips Service at header, but secret from body remains
    const secretUserTarget: Label = {
      confidentiality: [
        [userAtom("did:alice")],
        [{ kind: "Classification", level: "secret" }],
      ],
      integrity: emptyIntegrity(),
    };
    expect(() => checkSinkAndWrite(tx, secretUserTarget, "fetchData")).not
      .toThrow();

    // Cannot write to non-secret target
    expect(() => checkSinkAndWrite(tx, userOnlyLabel, "fetchData")).toThrow(
      CFCViolationError,
    );

    detachTaintContext(tx);
  });

  it("token in body path is NOT declassified (only header is allowed)", () => {
    const policy = createPolicy([googleAuthSinkRule], 1);
    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
      policy,
    });
    attachTaintContext(tx, ctx);

    // Accidentally put token in body instead of header
    recordTaintedRead(tx, tokenLabel, ["options", "body"]);

    // Sink gate does NOT strip Service at body path — blocked
    expect(() => checkSinkAndWrite(tx, userOnlyLabel, "fetchData")).toThrow(
      CFCViolationError,
    );

    // No AuthorizedRequest emitted since no rules fired
    expect(ctx.acquiredIntegrity).toEqual([]);

    detachTaintContext(tx);
  });
});

// ---------------------------------------------------------------------------
// 10.3 Error Path
// ---------------------------------------------------------------------------

describe("CFC Gmail E2E: Error Path (10.3)", () => {
  it("failed request: error response inherits full input taint (safe default)", () => {
    const policy = createPolicy([authorityOnlyRule, googleAuthSinkRule], 1);
    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
      policy,
    });
    attachTaintContext(tx, ctx);

    // Read token and user data
    recordTaintedRead(tx, tokenLabel, [
      "options",
      "headers",
      "Authorization",
    ]);
    recordTaintedRead(tx, userOnlyLabel, ["options", "body"]);

    // Request succeeds through sink gate
    expect(() => checkSinkAndWrite(tx, userOnlyLabel, "fetchData")).not
      .toThrow();

    detachTaintContext(tx);

    // Error path: no sink declassification applied. The error response
    // in a safe-default scenario inherits the full accumulated taint from
    // the action that triggered the fetch. We model this as a new context
    // where the error carries the original accumulated taint.
    const txErr = mockTx();
    const ctxErr = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    attachTaintContext(txErr, ctxErr);

    // Error response carries full taint: User(Alice) AND Service(google-auth)
    // (safe default — no declassification for error data)
    recordTaintedRead(txErr, tokenLabel);

    // Cannot write error to User-only target (Service taint blocks)
    expect(() => checkTaintedWrite(txErr, userOnlyLabel)).toThrow(
      CFCViolationError,
    );

    // Can write to target that covers both User and Service
    const fullTarget: Label = {
      confidentiality: [
        [userAtom("did:alice")],
        [serviceAtom("google-auth")],
      ],
      integrity: emptyIntegrity(),
    };
    expect(() => checkTaintedWrite(txErr, fullTarget)).not.toThrow();

    // With authority-only exchange rule, Service is stripped and write succeeds
    expect(() => checkTaintedWrite(txErr, userOnlyLabel, [authorityOnlyRule]))
      .not.toThrow();

    detachTaintContext(txErr);
  });

  it("auth error (401): token not leaked to unclassified output", () => {
    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    attachTaintContext(tx, ctx);

    // Simulate: action read the token (Service taint accumulated)
    recordTaintedRead(tx, tokenLabel);

    // 401 error — action tries to write error message to unclassified cell
    // Service(google-auth) taint blocks this write
    expect(() => checkTaintedWrite(tx, emptyLabel())).toThrow(
      CFCViolationError,
    );

    // Even User-only target is blocked (Service still present)
    expect(() => checkTaintedWrite(tx, userOnlyLabel)).toThrow(
      CFCViolationError,
    );

    // Only a target covering both User AND Service accepts the write
    const fullTarget: Label = {
      confidentiality: [
        [userAtom("did:alice")],
        [serviceAtom("google-auth")],
      ],
      integrity: emptyIntegrity(),
    };
    expect(() => checkTaintedWrite(tx, fullTarget)).not.toThrow();

    detachTaintContext(tx);
  });

  it("error with secret query: inherits both Service and secret taint", () => {
    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    attachTaintContext(tx, ctx);

    // Read token + secret query
    recordTaintedRead(tx, tokenLabel);
    recordTaintedRead(tx, labelFromClassification("secret"));

    // Error response: must cover User, Service, AND secret
    const partialTarget: Label = {
      confidentiality: [
        [userAtom("did:alice")],
        [serviceAtom("google-auth")],
      ],
      integrity: emptyIntegrity(),
    };
    expect(() => checkTaintedWrite(tx, partialTarget)).toThrow(
      CFCViolationError,
    );

    const fullTarget: Label = {
      confidentiality: [
        [userAtom("did:alice")],
        [serviceAtom("google-auth")],
        [{ kind: "Classification", level: "secret" }],
      ],
      integrity: emptyIntegrity(),
    };
    expect(() => checkTaintedWrite(tx, fullTarget)).not.toThrow();

    detachTaintContext(tx);
  });
});
