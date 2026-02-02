import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { TaintMap } from "../src/cfc/taint-map.ts";
import {
  accumulateTaint,
  createActionContext,
  taintAtPath,
} from "../src/cfc/action-context.ts";
import { emptyLabel, labelFromClassification } from "../src/cfc/labels.ts";
import {
  attachTaintContext,
  getTaintAtPath,
  recordTaintedRead,
} from "../src/cfc/taint-tracking.ts";

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
