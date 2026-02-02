import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { TaintMap } from "../src/cfc/taint-map.ts";
import {
  accumulateTaint,
  CFCViolationError,
  createActionContext,
  taintAtPath,
} from "../src/cfc/action-context.ts";
import {
  emptyLabel,
  type Label,
  labelFromClassification,
} from "../src/cfc/labels.ts";
import { emptyIntegrity } from "../src/cfc/integrity.ts";
import { serviceAtom, userAtom } from "../src/cfc/atoms.ts";
import {
  attachTaintContext,
  checkTaintedWrite,
  detachTaintContext,
  getTaintAtPath,
  recordTaintedRead,
} from "../src/cfc/taint-tracking.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

// ---------------------------------------------------------------------------
// TaintMap unit tests
// ---------------------------------------------------------------------------

describe("TaintMap", () => {
  const secret = labelFromClassification("secret");
  const confidential = labelFromClassification("confidential");

  it("add and labelAt basic operations", () => {
    const map = new TaintMap();
    map.add(["token"], secret);
    expect(map.labelAt(["token"])).toEqual(secret);
  });

  it("ancestor propagation: taint at [] visible at ['a', 'b']", () => {
    const map = new TaintMap();
    map.add([], secret);
    expect(map.labelAt(["a", "b"])).toEqual(secret);
  });

  it("path isolation: taint at ['a'] not visible at ['b']", () => {
    const map = new TaintMap();
    map.add(["a"], secret);
    expect(map.labelAt(["b"])).toEqual(emptyLabel());
  });

  it("flatLabel joins all entries", () => {
    const map = new TaintMap();
    map.add(["token"], secret);
    map.add(["email"], confidential);
    const flat = map.flatLabel();
    // Should contain both classification atoms
    expect(flat.confidentiality.length).toBeGreaterThanOrEqual(2);
  });

  it("empty map returns emptyLabel everywhere", () => {
    const map = new TaintMap();
    expect(map.labelAt(["anything"])).toEqual(emptyLabel());
    expect(map.flatLabel()).toEqual(emptyLabel());
    expect(map.isEmpty()).toBe(true);
  });

  it("joins labels when adding to same path twice", () => {
    const map = new TaintMap();
    map.add(["x"], secret);
    map.add(["x"], confidential);
    const label = map.labelAt(["x"]);
    expect(label.confidentiality.length).toBeGreaterThanOrEqual(2);
  });

  it("child path sees parent taint but not sibling", () => {
    const map = new TaintMap();
    map.add(["headers"], secret);
    map.add(["body"], confidential);
    // headers.Authorization sees headers taint
    expect(map.labelAt(["headers", "Authorization"])).toEqual(secret);
    // body doesn't see headers taint
    expect(map.labelAt(["body"])).toEqual(confidential);
  });
});

// ---------------------------------------------------------------------------
// ActionTaintContext path integration
// ---------------------------------------------------------------------------

describe("ActionTaintContext path taint", () => {
  const secret = labelFromClassification("secret");

  it("accumulateTaint with path populates taintMap", () => {
    const ctx = createActionContext({
      userDid: "did:test:user",
      space: "test-space",
    });
    accumulateTaint(ctx, secret, ["token"]);

    // Flat taint still works
    expect(ctx.accumulatedTaint).toEqual(secret);
    // Path-level taint works
    expect(taintAtPath(ctx, ["token"])).toEqual(secret);
    // Other paths are clean
    expect(taintAtPath(ctx, ["email"])).toEqual(emptyLabel());
  });

  it("accumulateTaint without path does not add to taintMap", () => {
    const ctx = createActionContext({
      userDid: "did:test:user",
      space: "test-space",
    });
    accumulateTaint(ctx, secret);

    expect(ctx.accumulatedTaint).toEqual(secret);
    expect(ctx.taintMap.isEmpty()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// taint-tracking.ts helpers with path
// ---------------------------------------------------------------------------

describe("taint-tracking path helpers", () => {
  const secret = labelFromClassification("secret");

  // Minimal mock transaction for testing
  function mockTx(): any {
    return {
      readLabelOrUndefined: () => undefined,
    };
  }

  it("recordTaintedRead with path flows to getTaintAtPath", () => {
    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:test:user",
      space: "test-space",
    });
    attachTaintContext(tx, ctx);

    recordTaintedRead(tx, secret, ["token"]);

    expect(getTaintAtPath(tx, ["token"])).toEqual(secret);
    expect(getTaintAtPath(tx, ["email"])).toEqual(emptyLabel());
  });

  it("getTaintAtPath returns emptyLabel when no context", () => {
    const tx = mockTx();
    expect(getTaintAtPath(tx, ["anything"])).toEqual(emptyLabel());
  });
});

// ---------------------------------------------------------------------------
// Phase 8.3: Link-based taint propagation verification
// ---------------------------------------------------------------------------

describe("Link-based taint propagation (8.3)", () => {
  function mockTx(): IExtendedStorageTransaction {
    return {} as IExtendedStorageTransaction;
  }

  it("cell-to-link conversion does not accumulate linked cell's taint", () => {
    // When diffAndUpdate converts a Cell to a link via getAsLink(), no
    // read of the cell's value occurs. The writing action's taint context
    // should NOT include the linked cell's label.
    //
    // Simulated: action reads email (no ifc), passes token cell as link.
    // Only the email read should appear in taint.
    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    attachTaintContext(tx, ctx);

    // Lift reads the email field (no ifc → empty label, no taint)
    recordTaintedRead(tx, emptyLabel(), ["email"]);

    // Lift passes token cell as-is → getAsLink() → no recordTaintedRead
    // (nothing to call here — that's the point: no read happens)

    // Accumulated taint should be empty — only the email read happened
    // and it had no label
    expect(ctx.accumulatedTaint).toEqual(emptyLabel());
    expect(ctx.taintMap.isEmpty()).toBe(false); // email path recorded
    expect(getTaintAtPath(tx, ["token"])).toEqual(emptyLabel()); // no token taint

    detachTaintContext(tx);
  });

  it("dereferencing a link accumulates the target's taint at the dereference path", () => {
    // When a builtin (e.g., fetchData) later dereferences the link to
    // read the actual token string, that read accumulates taint at the
    // known path.
    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    attachTaintContext(tx, ctx);

    // Builtin dereferences token cell at headers.Authorization path
    const tokenLabel: Label = {
      confidentiality: [[serviceAtom("google-auth")]],
      integrity: emptyIntegrity(),
    };
    recordTaintedRead(tx, tokenLabel, [
      "options",
      "headers",
      "Authorization",
    ]);

    // Taint is now at the specific path, not at root
    expect(getTaintAtPath(tx, ["options", "headers", "Authorization"]))
      .toEqual(tokenLabel);
    expect(getTaintAtPath(tx, ["options", "body"])).toEqual(emptyLabel());

    // Flat taint includes it (for standard write checks)
    expect(ctx.accumulatedTaint.confidentiality.length).toBe(1);

    detachTaintContext(tx);
  });

  it("OpaqueCell pass-through: no taint when cell reference is not read", () => {
    // OpaqueCell has no .get() method, so passing it through a lift
    // does not trigger any recordTaintedRead. Verify that an action
    // which only passes cell references has empty taint.
    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    attachTaintContext(tx, ctx);

    // No reads happen — the lift only shuffles OpaqueCell references
    // (simulated by not calling recordTaintedRead at all)

    expect(ctx.accumulatedTaint).toEqual(emptyLabel());
    expect(ctx.taintMap.isEmpty()).toBe(true);

    // Write to any target succeeds — no taint to block it
    checkTaintedWrite(tx, emptyLabel());
    checkTaintedWrite(tx, {
      confidentiality: [[userAtom("did:alice")]],
      integrity: emptyIntegrity(),
    });

    detachTaintContext(tx);
  });
});

// ---------------------------------------------------------------------------
// Phase 8.5: Field-selective taint — lift reads specific fields
// ---------------------------------------------------------------------------

describe("Field-selective taint via path tracking (8.5)", () => {
  const secret = labelFromClassification("secret");

  function mockTx(): IExtendedStorageTransaction {
    return {} as IExtendedStorageTransaction;
  }

  it("lift reading only the non-secret field → path taint clean at secret path", () => {
    // Object has two fields: token (secret) and email (no ifc).
    // A lift that only reads email does not accumulate secret taint.
    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    attachTaintContext(tx, ctx);

    // Traverse reads email field — no ifc, empty label
    recordTaintedRead(tx, emptyLabel(), ["value", "email"]);

    // Token field is NOT read (lift doesn't access it)
    // → no secret taint accumulated
    expect(ctx.accumulatedTaint).toEqual(emptyLabel());
    expect(getTaintAtPath(tx, ["value", "token"])).toEqual(emptyLabel());

    // Write to unclassified target succeeds
    expect(() => checkTaintedWrite(tx, emptyLabel())).not.toThrow();

    detachTaintContext(tx);
  });

  it("lift reading the secret field → taint accumulated at that path", () => {
    // Same object, but now the lift reads the secret token field.
    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    attachTaintContext(tx, ctx);

    // Traverse reads token field — has ifc: secret
    recordTaintedRead(tx, secret, ["value", "token"]);

    // Secret taint accumulated
    expect(ctx.accumulatedTaint).toEqual(secret);
    expect(getTaintAtPath(tx, ["value", "token"])).toEqual(secret);
    expect(getTaintAtPath(tx, ["value", "email"])).toEqual(emptyLabel());

    // Write to unclassified target blocked
    expect(() => checkTaintedWrite(tx, emptyLabel())).toThrow(
      CFCViolationError,
    );

    // Write to secret target succeeds
    expect(() => checkTaintedWrite(tx, secret)).not.toThrow();

    detachTaintContext(tx);
  });

  it("mixed reads: secret + non-secret fields → only secret path tainted", () => {
    const tx = mockTx();
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    attachTaintContext(tx, ctx);

    // Read both fields
    recordTaintedRead(tx, emptyLabel(), ["value", "email"]);
    recordTaintedRead(tx, secret, ["value", "token"]);

    // Path-level: only token carries secret
    expect(getTaintAtPath(tx, ["value", "token"])).toEqual(secret);
    expect(getTaintAtPath(tx, ["value", "email"])).toEqual(emptyLabel());

    // Flat taint includes secret (from token read)
    expect(ctx.accumulatedTaint).toEqual(secret);

    detachTaintContext(tx);
  });
});
