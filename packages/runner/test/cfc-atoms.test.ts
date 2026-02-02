import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  atomEquals,
  authoredByAtom,
  // Atoms
  canonicalizeAtom,
  classificationAtom,
  codeHashAtom,
  confidentialityLeq,
  // Confidentiality
  emptyConfidentiality,
  // Integrity
  emptyIntegrity,
  // Composite labels
  emptyLabel,
  endorsedByAtom,
  integrityContains,
  integrityFromAtoms,
  integrityLeq,
  isConfidentialityAtom,
  isIntegrityAtom,
  joinConfidentiality,
  joinIntegrity,
  joinLabel,
  labelFromClassification,
  labelFromSchemaIfc,
  labelLeq,
  meetConfidentiality,
  meetIntegrity,
  normalizeConfidentiality,
  serviceAtom,
  spaceAtom,
  userAtom,
} from "../src/cfc/index.ts";

// =========================================================================
// 1. Atom tests
// =========================================================================

describe("Atoms", () => {
  describe("canonicalization", () => {
    it("is deterministic regardless of property insertion order", () => {
      const a = { kind: "User" as const, did: "did:alice" };
      const b = Object.create(null);
      b.did = "did:alice";
      b.kind = "User";
      expect(canonicalizeAtom(a)).toBe(canonicalizeAtom(b));
    });

    it("produces sorted keys in output", () => {
      const atom = userAtom("did:alice");
      const canonical = canonicalizeAtom(atom);
      // "did" comes before "kind" alphabetically
      expect(canonical).toBe('{"did":"did:alice","kind":"User"}');
    });
  });

  describe("atomEquals", () => {
    it("returns true for structurally identical atoms", () => {
      expect(atomEquals(userAtom("did:alice"), userAtom("did:alice"))).toBe(
        true,
      );
    });

    it("returns false for different atoms", () => {
      expect(atomEquals(userAtom("did:alice"), userAtom("did:bob"))).toBe(
        false,
      );
    });

    it("returns false for atoms of different kinds", () => {
      expect(
        atomEquals(userAtom("did:alice"), spaceAtom("did:alice")),
      ).toBe(false);
    });
  });

  describe("type guards", () => {
    it("isConfidentialityAtom identifies confidentiality atoms", () => {
      expect(isConfidentialityAtom(userAtom("did:alice"))).toBe(true);
      expect(isConfidentialityAtom(spaceAtom("space:work"))).toBe(true);
      expect(isConfidentialityAtom(classificationAtom("secret"))).toBe(true);
      expect(isConfidentialityAtom(serviceAtom("svc1"))).toBe(true);
    });

    it("isConfidentialityAtom rejects integrity atoms", () => {
      expect(isConfidentialityAtom(codeHashAtom("abc123"))).toBe(false);
      expect(isConfidentialityAtom(authoredByAtom("did:alice"))).toBe(false);
    });

    it("isIntegrityAtom identifies integrity atoms", () => {
      expect(isIntegrityAtom(codeHashAtom("abc123"))).toBe(true);
      expect(isIntegrityAtom(authoredByAtom("did:alice"))).toBe(true);
      expect(isIntegrityAtom(endorsedByAtom("did:bob"))).toBe(true);
    });

    it("isIntegrityAtom rejects confidentiality atoms", () => {
      expect(isIntegrityAtom(userAtom("did:alice"))).toBe(false);
      expect(isIntegrityAtom(classificationAtom("secret"))).toBe(false);
    });
  });
});

// =========================================================================
// 2. Confidentiality tests
// =========================================================================

describe("Confidentiality", () => {
  const alice = userAtom("did:alice");
  const bob = userAtom("did:bob");
  const work = spaceAtom("space:work");
  const secret = classificationAtom("secret");
  const topSecret = classificationAtom("top-secret");

  it("emptyConfidentiality is bottom (leq to everything)", () => {
    const bottom = emptyConfidentiality();
    const label = [[alice], [work]];
    expect(confidentialityLeq(bottom, label)).toBe(true);
    expect(confidentialityLeq(bottom, emptyConfidentiality())).toBe(true);
  });

  it("join concatenates clauses", () => {
    const a = [[alice]];
    const b = [[work]];
    const joined = joinConfidentiality(a, b);
    expect(joined.length).toBe(2);
  });

  it("join is commutative in terms of leq: join(a,b) >= a and >= b", () => {
    const a = [[alice]];
    const b = [[work]];
    const joined = joinConfidentiality(a, b);
    expect(confidentialityLeq(a, joined)).toBe(true);
    expect(confidentialityLeq(b, joined)).toBe(true);
  });

  it("meet produces greatest lower bound", () => {
    const a = [[alice]];
    const b = [[bob]];
    const met = meetConfidentiality(a, b);
    expect(confidentialityLeq(met, a)).toBe(true);
    expect(confidentialityLeq(met, b)).toBe(true);
  });

  it("leq: single clause vs multi-clause", () => {
    const single = [[alice]];
    const multi = [[alice], [work]];
    expect(confidentialityLeq(single, multi)).toBe(true);
    expect(confidentialityLeq(multi, single)).toBe(false);
  });

  describe("normalization", () => {
    it("removes duplicate clauses", () => {
      const label = [[alice], [alice]];
      const normalized = normalizeConfidentiality(label);
      expect(normalized.length).toBe(1);
    });

    it("removes subsumed clauses", () => {
      const label = [[alice], [alice, bob]];
      const normalized = normalizeConfidentiality(label);
      expect(normalized.length).toBe(1);
      expect(normalized[0].length).toBe(1);
    });

    it("deduplicates atoms within a clause", () => {
      const label = [[alice, alice, bob]];
      const normalized = normalizeConfidentiality(label);
      expect(normalized[0].length).toBe(2);
    });
  });

  describe("edge cases", () => {
    it("empty clauses list is bottom", () => {
      expect(confidentialityLeq([], [[alice]])).toBe(true);
    });

    it("single-atom clauses", () => {
      const a = [[secret]];
      const b = [[topSecret]];
      expect(confidentialityLeq(a, b)).toBe(false);
      expect(confidentialityLeq(b, a)).toBe(false);
    });
  });
});

// =========================================================================
// 3. Integrity tests
// =========================================================================

describe("Integrity", () => {
  const hashA = codeHashAtom("abc123");
  const _hashB = codeHashAtom("def456");
  const alice = authoredByAtom("did:alice");
  const bob = endorsedByAtom("did:bob");

  it("emptyIntegrity is top (leq from everything)", () => {
    const top = emptyIntegrity();
    const label = integrityFromAtoms([hashA, alice]);
    expect(integrityLeq(top, label)).toBe(true);
    expect(integrityLeq(top, emptyIntegrity())).toBe(true);
  });

  it("non-empty is NOT leq empty (label with endorsements is stronger)", () => {
    const label = integrityFromAtoms([hashA]);
    expect(integrityLeq(label, emptyIntegrity())).toBe(false);
  });

  it("join = intersection (combining weakens)", () => {
    const a = integrityFromAtoms([hashA, alice]);
    const b = integrityFromAtoms([hashA, bob]);
    const joined = joinIntegrity(a, b);
    expect(joined.atoms.length).toBe(1);
    expect(integrityContains(joined, hashA)).toBe(true);
    expect(integrityContains(joined, alice)).toBe(false);
  });

  it("meet = union (adding endorsement strengthens)", () => {
    const a = integrityFromAtoms([hashA]);
    const b = integrityFromAtoms([alice]);
    const met = meetIntegrity(a, b);
    expect(met.atoms.length).toBe(2);
    expect(integrityContains(met, hashA)).toBe(true);
    expect(integrityContains(met, alice)).toBe(true);
  });

  it("integrityLeq: subset check", () => {
    const small = integrityFromAtoms([hashA]);
    const big = integrityFromAtoms([hashA, alice, bob]);
    expect(integrityLeq(small, big)).toBe(true);
    expect(integrityLeq(big, small)).toBe(false);
  });

  it("integrityContains finds present atoms", () => {
    const label = integrityFromAtoms([hashA, alice]);
    expect(integrityContains(label, hashA)).toBe(true);
    expect(integrityContains(label, alice)).toBe(true);
    expect(integrityContains(label, bob)).toBe(false);
  });
});

// =========================================================================
// 4. Composite Label tests
// =========================================================================

describe("Composite Label", () => {
  it("emptyLabel has empty confidentiality and integrity", () => {
    const label = emptyLabel();
    expect(label.confidentiality).toEqual([]);
    expect(label.integrity.atoms).toEqual([]);
  });

  it("joinLabel joins both components", () => {
    const a = {
      confidentiality: [[userAtom("did:alice")]],
      integrity: integrityFromAtoms([codeHashAtom("abc123")]),
    };
    const b = {
      confidentiality: [[spaceAtom("space:work")]],
      integrity: integrityFromAtoms([
        codeHashAtom("abc123"),
        authoredByAtom("did:bob"),
      ]),
    };
    const joined = joinLabel(a, b);
    expect(joined.confidentiality.length).toBe(2);
    expect(joined.integrity.atoms.length).toBe(1);
  });

  it("labelLeq checks both components", () => {
    const lower = {
      confidentiality: [[classificationAtom("secret")]],
      integrity: integrityFromAtoms([codeHashAtom("abc123")]),
    };
    const higher = {
      confidentiality: [
        [classificationAtom("secret")],
        [classificationAtom("top-secret")],
      ],
      integrity: integrityFromAtoms([
        codeHashAtom("abc123"),
        authoredByAtom("did:alice"),
      ]),
    };
    expect(labelLeq(lower, higher)).toBe(true);
    expect(labelLeq(higher, lower)).toBe(false);
  });

  it("labelLeq fails if only one component satisfies leq", () => {
    const a = {
      confidentiality: emptyConfidentiality(),
      integrity: integrityFromAtoms([
        codeHashAtom("abc123"),
        authoredByAtom("did:alice"),
      ]),
    };
    const b = {
      confidentiality: [[classificationAtom("secret")]],
      integrity: integrityFromAtoms([codeHashAtom("abc123")]),
    };
    expect(labelLeq(a, b)).toBe(false);
  });

  it("labelFromClassification round-trip", () => {
    const label = labelFromClassification("secret");
    expect(label.confidentiality.length).toBe(1);
    expect(label.confidentiality[0].length).toBe(1);
    expect(label.confidentiality[0][0]).toEqual(classificationAtom("secret"));
    expect(label.integrity.atoms).toEqual([]);
  });

  it("labelFromSchemaIfc with multiple classifications produces multiple clauses (AND)", () => {
    const label = labelFromSchemaIfc({
      classification: ["secret", "internal"],
    });
    expect(label.confidentiality.length).toBe(2);
    expect(label.confidentiality[0]).toEqual([classificationAtom("secret")]);
    expect(label.confidentiality[1]).toEqual([classificationAtom("internal")]);
  });

  it("labelFromSchemaIfc with empty classification returns emptyLabel", () => {
    const label = labelFromSchemaIfc({ classification: [] });
    expect(label.confidentiality).toEqual([]);
    expect(label.integrity.atoms).toEqual([]);
  });

  it("labelFromSchemaIfc with missing classification returns emptyLabel", () => {
    const label = labelFromSchemaIfc({});
    expect(label.confidentiality).toEqual([]);
    expect(label.integrity.atoms).toEqual([]);
  });
});

// =========================================================================
// 5. Property tests (concrete examples demonstrating lattice properties)
// =========================================================================

describe("Lattice properties", () => {
  describe("confidentiality", () => {
    const alice = userAtom("did:alice");
    const work = spaceAtom("space:work");
    const secret = classificationAtom("secret");

    it("join(a, b) >= a", () => {
      const a = [[alice]];
      const b = [[work], [secret]];
      const joined = joinConfidentiality(a, b);
      expect(confidentialityLeq(a, joined)).toBe(true);
    });

    it("leq(a, join(a, b)) is always true", () => {
      const a = [[alice], [secret]];
      const b = [[work]];
      expect(confidentialityLeq(a, joinConfidentiality(a, b))).toBe(true);
      expect(confidentialityLeq(b, joinConfidentiality(a, b))).toBe(true);
    });

    it("join is idempotent: join(a, a) equivalent to a", () => {
      const a = [[alice], [work]];
      const joined = joinConfidentiality(a, a);
      expect(confidentialityLeq(a, joined)).toBe(true);
      expect(confidentialityLeq(joined, a)).toBe(true);
    });
  });

  describe("integrity", () => {
    const hashA = codeHashAtom("abc123");
    const alice = authoredByAtom("did:alice");
    const bob = endorsedByAtom("did:bob");

    it("join(a, b) >= a (intersection is leq both inputs)", () => {
      const a = integrityFromAtoms([hashA, alice]);
      const b = integrityFromAtoms([hashA, bob]);
      const joined = joinIntegrity(a, b);
      expect(integrityLeq(joined, a)).toBe(true);
      expect(integrityLeq(joined, b)).toBe(true);
    });

    it("leq(a, join(a, b)) — join result is leq both operands", () => {
      const a = integrityFromAtoms([hashA, alice]);
      const b = integrityFromAtoms([hashA, bob]);
      const joined = joinIntegrity(a, b);
      expect(integrityLeq(joined, a)).toBe(true);
      expect(integrityLeq(joined, b)).toBe(true);
    });

    it("join is idempotent: join(a, a) equivalent to a", () => {
      const a = integrityFromAtoms([hashA, alice, bob]);
      const joined = joinIntegrity(a, a);
      expect(integrityLeq(a, joined)).toBe(true);
      expect(integrityLeq(joined, a)).toBe(true);
    });
  });
});
