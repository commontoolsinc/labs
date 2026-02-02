import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  accumulateTaint,
  applyRule,
  atomEquals,
  type AtomPattern,
  CFCViolationError,
  checkWrite,
  classificationAtom,
  createActionContext,
  createPolicy,
  DEFAULT_POLICY,
  emptyIntegrity,
  emptyLabel,
  evaluateRules,
  type ExchangeRule,
  hashPolicy,
  hasRoleAtom,
  integrityFromAtoms,
  type Label,
  matchAtomPattern,
  matchPrecondition,
  spaceAtom,
  TrustLattice,
  userAtom,
} from "../src/cfc/index.ts";

// ---------------------------------------------------------------------------
// TrustLattice
// ---------------------------------------------------------------------------

describe("TrustLattice", () => {
  const lattice = new TrustLattice();

  it("classification ordering: unclassified < confidential < secret < topsecret", () => {
    expect(lattice.classificationLeq("unclassified", "confidential")).toBe(
      true,
    );
    expect(lattice.classificationLeq("confidential", "secret")).toBe(true);
    expect(lattice.classificationLeq("secret", "topsecret")).toBe(true);
    expect(lattice.classificationLeq("unclassified", "topsecret")).toBe(true);
    expect(lattice.classificationLeq("topsecret", "unclassified")).toBe(false);
    expect(lattice.classificationLeq("secret", "confidential")).toBe(false);
  });

  it("classificationLeq is transitive", () => {
    expect(lattice.classificationLeq("unclassified", "confidential")).toBe(
      true,
    );
    expect(lattice.classificationLeq("confidential", "secret")).toBe(true);
    expect(lattice.classificationLeq("unclassified", "secret")).toBe(true);
  });

  it("same atoms are equal", () => {
    const a = userAtom("did:example:alice");
    const b = userAtom("did:example:alice");
    expect(lattice.compareAtoms(a, b)).toBe("equal");
  });

  it("different User atoms are incomparable", () => {
    const a = userAtom("did:example:alice");
    const b = userAtom("did:example:bob");
    expect(lattice.compareAtoms(a, b)).toBe("incomparable");
  });

  it("different Space atoms are incomparable", () => {
    const a = spaceAtom("space-a");
    const b = spaceAtom("space-b");
    expect(lattice.compareAtoms(a, b)).toBe("incomparable");
  });

  it("compareLabels works for composite labels", () => {
    const low: Label = {
      confidentiality: [[classificationAtom("unclassified")]],
      integrity: emptyIntegrity(),
    };
    const high: Label = {
      confidentiality: [[classificationAtom("unclassified")], [
        classificationAtom("secret"),
      ]],
      integrity: emptyIntegrity(),
    };
    expect(lattice.compareLabels(low, high)).toBe("below");
    expect(lattice.compareLabels(high, low)).toBe("above");
    expect(lattice.compareLabels(low, low)).toBe("equal");
  });
});

// ---------------------------------------------------------------------------
// Exchange Rules
// ---------------------------------------------------------------------------

describe("Exchange Rules", () => {
  it("matchAtomPattern: literal match", () => {
    const pattern: AtomPattern = {
      kind: "Space",
      params: { space: "my-space" },
    };
    const atom = spaceAtom("my-space");
    const result = matchAtomPattern(pattern, atom, new Map());
    expect(result).not.toBeNull();
  });

  it("matchAtomPattern: variable binding", () => {
    const pattern: AtomPattern = { kind: "Space", params: { space: "$X" } };
    const atom = spaceAtom("my-space");
    const result = matchAtomPattern(pattern, atom, new Map());
    expect(result).not.toBeNull();
    expect(result!.get("$X")).toBe("my-space");
  });

  it("matchAtomPattern: binding conflict", () => {
    const pattern: AtomPattern = { kind: "Space", params: { space: "$X" } };
    const atom = spaceAtom("my-space");
    const bindings = new Map([["$X", "other-space"]]);
    const result = matchAtomPattern(pattern, atom, bindings);
    expect(result).toBeNull();
  });

  it("matchPrecondition: simple match", () => {
    const rule: ExchangeRule = {
      confidentialityPre: [{ kind: "Space", params: { space: "$X" } }],
      integrityPre: [],
      addAlternatives: [],
      variables: ["$X"],
    };
    const label: Label = {
      confidentiality: [[spaceAtom("my-space")]],
      integrity: emptyIntegrity(),
    };
    const results = matchPrecondition(label, rule);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].get("$X")).toBe("my-space");
  });

  it("matchPrecondition: no match", () => {
    const rule: ExchangeRule = {
      confidentialityPre: [{ kind: "Space", params: { space: "nonexistent" } }],
      integrityPre: [],
      addAlternatives: [],
      variables: [],
    };
    const label: Label = {
      confidentiality: [[spaceAtom("my-space")]],
      integrity: emptyIntegrity(),
    };
    const results = matchPrecondition(label, rule);
    expect(results).toHaveLength(0);
  });

  it("matchPrecondition: multiple bindings", () => {
    const rule: ExchangeRule = {
      confidentialityPre: [{ kind: "Space", params: { space: "$X" } }],
      integrityPre: [],
      addAlternatives: [],
      variables: ["$X"],
    };
    const label: Label = {
      confidentiality: [[spaceAtom("a")], [spaceAtom("b")]],
      integrity: emptyIntegrity(),
    };
    const results = matchPrecondition(label, rule);
    expect(results.length).toBe(2);
    const boundValues = results.map((r) => r.get("$X")).sort();
    expect(boundValues).toEqual(["a", "b"]);
  });

  it("applyRule: adds alternatives to matching clause", () => {
    const rule: ExchangeRule = {
      confidentialityPre: [{ kind: "Space", params: { space: "$X" } }],
      integrityPre: [],
      addAlternatives: [{ kind: "User", params: { did: "did:example:bob" } }],
      variables: ["$X"],
    };
    const label: Label = {
      confidentiality: [[spaceAtom("my-space")]],
      integrity: emptyIntegrity(),
    };
    const bindings = new Map([["$X", "my-space"]]);
    const result = applyRule(label, rule, bindings);
    expect(result.confidentiality.length).toBe(1);
    const clause = result.confidentiality[0];
    expect(clause.length).toBe(2);
    expect(clause.some((a) => atomEquals(a, spaceAtom("my-space")))).toBe(true);
    expect(clause.some((a) => atomEquals(a, userAtom("did:example:bob")))).toBe(
      true,
    );
  });

  it("evaluateRules: fixpoint converges", () => {
    const rule: ExchangeRule = {
      confidentialityPre: [{ kind: "Space", params: { space: "$X" } }],
      integrityPre: [],
      addAlternatives: [{ kind: "User", params: { did: "did:example:bob" } }],
      variables: ["$X"],
    };
    const label: Label = {
      confidentiality: [[spaceAtom("my-space")]],
      integrity: emptyIntegrity(),
    };
    const result = evaluateRules(label, [rule]);
    expect(result.confidentiality[0].length).toBe(2);
  });

  it("evaluateRules: empty rules = no change", () => {
    const label: Label = {
      confidentiality: [[spaceAtom("my-space")]],
      integrity: emptyIntegrity(),
    };
    const result = evaluateRules(label, []);
    expect(result.confidentiality).toEqual(label.confidentiality);
  });

  it("practical rule: Space(X) data readable by User(Y) if HasRole(Y, X, reader)", () => {
    const rule: ExchangeRule = {
      confidentialityPre: [{ kind: "Space", params: { space: "$X" } }],
      integrityPre: [
        {
          kind: "HasRole",
          params: { principal: "$Y", space: "$X", role: "reader" },
        },
      ],
      addAlternatives: [{ kind: "User", params: { did: "$Y" } }],
      variables: ["$X", "$Y"],
    };

    const label: Label = {
      confidentiality: [[spaceAtom("space-1")]],
      integrity: integrityFromAtoms([
        hasRoleAtom("did:example:alice", "space-1", "reader"),
      ]),
    };

    const result = evaluateRules(label, [rule]);
    const clause = result.confidentiality[0];
    expect(clause.some((a) => atomEquals(a, userAtom("did:example:alice"))))
      .toBe(true);
    expect(clause.some((a) => atomEquals(a, spaceAtom("space-1")))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

describe("Policy", () => {
  it("createPolicy generates deterministic id", () => {
    const p1 = createPolicy([], 1);
    const p2 = createPolicy([], 1);
    expect(p1.id).toBe(p2.id);
  });

  it("hashPolicy is deterministic", () => {
    const body = {
      exchangeRules: [] as ExchangeRule[],
      sinkRules: [],
      version: 1,
    };
    const h1 = hashPolicy(body);
    const h2 = hashPolicy(body);
    expect(h1).toBe(h2);
  });

  it("DEFAULT_POLICY has no rules", () => {
    expect(DEFAULT_POLICY.exchangeRules).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ActionTaintContext
// ---------------------------------------------------------------------------

describe("ActionTaintContext", () => {
  it("createActionContext sets correct principal, clearance, empty taint", () => {
    const ctx = createActionContext({
      userDid: "did:example:alice",
      space: "space-1",
    });
    expect(ctx.principal.integrity.atoms.length).toBe(1);
    expect(ctx.principal.integrity.atoms[0]).toEqual({
      kind: "AuthoredBy",
      did: "did:example:alice",
    });
    expect(ctx.clearance.confidentiality.length).toBe(2);
    expect(ctx.accumulatedTaint.confidentiality).toEqual([]);
    expect(ctx.accumulatedTaint.integrity.atoms).toEqual([]);
  });

  it("accumulateTaint joins labels correctly", () => {
    const ctx = createActionContext({
      userDid: "did:example:alice",
      space: "space-1",
    });
    const readLabel: Label = {
      confidentiality: [[spaceAtom("space-1")]],
      integrity: emptyIntegrity(),
    };
    accumulateTaint(ctx, readLabel);
    expect(ctx.accumulatedTaint.confidentiality.length).toBe(1);

    const readLabel2: Label = {
      confidentiality: [[userAtom("did:example:bob")]],
      integrity: emptyIntegrity(),
    };
    accumulateTaint(ctx, readLabel2);
    expect(ctx.accumulatedTaint.confidentiality.length).toBe(2);
  });

  it("checkWrite: passes when taint <= write target", () => {
    const ctx = createActionContext({
      userDid: "did:example:alice",
      space: "space-1",
    });
    const target: Label = {
      confidentiality: [[spaceAtom("space-1")]],
      integrity: emptyIntegrity(),
    };
    expect(() => checkWrite(ctx, target, [])).not.toThrow();
  });

  it("checkWrite: throws CFCViolationError when taint > write target", () => {
    const ctx = createActionContext({
      userDid: "did:example:alice",
      space: "space-1",
    });
    accumulateTaint(ctx, {
      confidentiality: [[spaceAtom("space-1")], [userAtom("did:example:bob")]],
      integrity: emptyIntegrity(),
    });
    const target = emptyLabel();
    expect(() => checkWrite(ctx, target, [])).toThrow(CFCViolationError);
  });

  it("checkWrite with exchange rule that declassifies: passes", () => {
    const ctx = createActionContext({
      userDid: "did:example:alice",
      space: "space-1",
    });

    ctx.accumulatedTaint = {
      confidentiality: [[spaceAtom("space-1")]],
      integrity: emptyIntegrity(),
    };

    const target: Label = {
      confidentiality: [[spaceAtom("space-1"), userAtom("did:example:alice")]],
      integrity: emptyIntegrity(),
    };

    const rule: ExchangeRule = {
      confidentialityPre: [{ kind: "Space", params: { space: "space-1" } }],
      integrityPre: [],
      addAlternatives: [{ kind: "User", params: { did: "did:example:alice" } }],
      variables: [],
    };

    expect(() => checkWrite(ctx, target, [])).toThrow(CFCViolationError);
    expect(() => checkWrite(ctx, target, [rule])).not.toThrow();
  });

  it("backwards compat: empty labels (no ifc annotations) never trigger violations", () => {
    const ctx = createActionContext({
      userDid: "did:example:alice",
      space: "space-1",
    });
    accumulateTaint(ctx, emptyLabel());
    expect(() => checkWrite(ctx, emptyLabel(), [])).not.toThrow();
  });
});
