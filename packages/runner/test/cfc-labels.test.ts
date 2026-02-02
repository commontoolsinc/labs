import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  authoredByAtom,
  classificationAtom,
  codeHashAtom,
  emptyConfidentiality,
  emptyIntegrity,
  emptyLabel,
  endorsedByAtom,
  expiresAtom,
  hasRoleAtom,
  integrityFromAtoms,
  labelFromStoredLabels,
  policyPrincipalAtom,
  resourceAtom,
  serviceAtom,
  spaceAtom,
  toLabelStorage,
  userAtom,
} from "../src/cfc/index.ts";
import type { Atom } from "../src/cfc/atoms.ts";
import type { Labels } from "../src/storage/interface.ts";
import type { Label } from "../src/cfc/labels.ts";

// =========================================================================
// 1. Discriminated union atoms serialize cleanly through JSON round-trip
// =========================================================================

describe("Atom JSON round-trip serialization", () => {
  const atoms: Atom[] = [
    userAtom("did:key:z6Mk123"),
    spaceAtom("space:work"),
    classificationAtom("secret"),
    resourceAtom("doc", "abc-123"),
    serviceAtom("svc-llm"),
    expiresAtom(1700000000),
    policyPrincipalAtom("sha256-deadbeef"),
    codeHashAtom("sha256-cafe"),
    authoredByAtom("did:key:z6MkAuthor"),
    endorsedByAtom("did:key:z6MkEndorser"),
    hasRoleAtom("did:key:z6MkPrincipal", "space:org", "admin"),
  ];

  it("each atom survives JSON round-trip with structural equality", () => {
    for (const atom of atoms) {
      const roundTripped = JSON.parse(JSON.stringify(atom));
      expect(roundTripped).toEqual(atom);
    }
  });

  it("Labels object with atoms round-trips through JSON", () => {
    const labels: { confidentiality: Atom[][]; integrity: Atom[] } = {
      confidentiality: [
        [userAtom("did:123"), spaceAtom("space:work")],
        [classificationAtom("secret")],
      ],
      integrity: [codeHashAtom("abc"), authoredByAtom("did:alice")],
    };

    const roundTripped = JSON.parse(JSON.stringify(labels));
    expect(roundTripped).toEqual(labels);
  });

  it("empty Labels round-trips through JSON", () => {
    const labels: { confidentiality: Atom[][]; integrity: Atom[] } = {
      confidentiality: [],
      integrity: [],
    };
    const roundTripped = JSON.parse(JSON.stringify(labels));
    expect(roundTripped).toEqual(labels);
  });
});

// =========================================================================
// 2. labelFromStoredLabels
// =========================================================================

describe("labelFromStoredLabels", () => {
  it("converts classification strings to Classification atoms", () => {
    const stored: Labels = { classification: ["secret"] };
    const label = labelFromStoredLabels(stored);

    expect(label.confidentiality.length).toBe(1);
    expect(label.confidentiality[0]).toEqual([classificationAtom("secret")]);
    expect(label.integrity.atoms).toEqual([]);
  });

  it("converts rich confidentiality and integrity fields", () => {
    const stored: Labels = {
      confidentiality: [[userAtom("did:123")]],
      integrity: [codeHashAtom("abc")],
    };
    const label = labelFromStoredLabels(stored);

    expect(label.confidentiality).toEqual([[userAtom("did:123")]]);
    expect(label.integrity).toEqual({ atoms: [codeHashAtom("abc")] });
  });

  it("returns emptyLabel components for empty/undefined fields", () => {
    const stored: Labels = {};
    const label = labelFromStoredLabels(stored);

    expect(label.confidentiality).toEqual(emptyConfidentiality());
    expect(label.integrity).toEqual(emptyIntegrity());
  });

  it("prefers confidentiality over classification when both present", () => {
    const stored: Labels = {
      classification: ["public"],
      confidentiality: [[userAtom("did:owner")]],
    };
    const label = labelFromStoredLabels(stored);

    expect(label.confidentiality).toEqual([[userAtom("did:owner")]]);
  });
});

// =========================================================================
// 3. toLabelStorage
// =========================================================================

describe("toLabelStorage", () => {
  it("converts Label with atoms to Labels with arrays", () => {
    const label: Label = {
      confidentiality: [[classificationAtom("secret")]],
      integrity: integrityFromAtoms([codeHashAtom("abc")]),
    };
    const stored = toLabelStorage(label);

    expect(stored.confidentiality).toEqual([[classificationAtom("secret")]]);
    expect(stored.integrity).toEqual([codeHashAtom("abc")]);
  });

  it("converts emptyLabel to empty object", () => {
    const stored = toLabelStorage(emptyLabel());

    expect(stored.confidentiality).toBeUndefined();
    expect(stored.integrity).toBeUndefined();
    expect(Object.keys(stored).length).toBe(0);
  });

  it("omits empty confidentiality but keeps non-empty integrity", () => {
    const label: Label = {
      confidentiality: emptyConfidentiality(),
      integrity: integrityFromAtoms([authoredByAtom("did:alice")]),
    };
    const stored = toLabelStorage(label);

    expect(stored.confidentiality).toBeUndefined();
    expect(stored.integrity).toEqual([authoredByAtom("did:alice")]);
  });

  it("omits empty integrity but keeps non-empty confidentiality", () => {
    const label: Label = {
      confidentiality: [[userAtom("did:owner")]],
      integrity: emptyIntegrity(),
    };
    const stored = toLabelStorage(label);

    expect(stored.confidentiality).toEqual([[userAtom("did:owner")]]);
    expect(stored.integrity).toBeUndefined();
  });
});

// =========================================================================
// 4. Round-trip: Label → toLabelStorage → labelFromStoredLabels
// =========================================================================

describe("Label ↔ storage round-trip", () => {
  it("round-trips a label with both components", () => {
    const original: Label = {
      confidentiality: [
        [userAtom("did:alice"), spaceAtom("space:work")],
        [classificationAtom("secret")],
      ],
      integrity: integrityFromAtoms([
        codeHashAtom("hash1"),
        authoredByAtom("did:bob"),
      ]),
    };

    const stored = toLabelStorage(original);
    const restored = labelFromStoredLabels(stored);

    expect(restored.confidentiality).toEqual(original.confidentiality);
    expect(restored.integrity).toEqual(original.integrity);
  });

  it("round-trips emptyLabel", () => {
    const original = emptyLabel();
    const stored = toLabelStorage(original);
    const restored = labelFromStoredLabels(stored);

    expect(restored.confidentiality).toEqual(original.confidentiality);
    expect(restored.integrity).toEqual(original.integrity);
  });

  it("round-trips a label with only confidentiality", () => {
    const original: Label = {
      confidentiality: [[classificationAtom("top-secret")]],
      integrity: emptyIntegrity(),
    };

    const stored = toLabelStorage(original);
    const restored = labelFromStoredLabels(stored);

    expect(restored.confidentiality).toEqual(original.confidentiality);
    expect(restored.integrity).toEqual(original.integrity);
  });

  it("round-trips a label with only integrity", () => {
    const original: Label = {
      confidentiality: emptyConfidentiality(),
      integrity: integrityFromAtoms([endorsedByAtom("did:auditor")]),
    };

    const stored = toLabelStorage(original);
    const restored = labelFromStoredLabels(stored);

    expect(restored.confidentiality).toEqual(original.confidentiality);
    expect(restored.integrity).toEqual(original.integrity);
  });

  it("round-trips through JSON as well (full serialization path)", () => {
    const original: Label = {
      confidentiality: [[resourceAtom("doc", "abc")]],
      integrity: integrityFromAtoms([hasRoleAtom("did:p", "space:s", "admin")]),
    };

    const stored = toLabelStorage(original);
    const jsonRoundTripped = JSON.parse(JSON.stringify(stored));
    const restored = labelFromStoredLabels(jsonRoundTripped);

    expect(restored.confidentiality).toEqual(original.confidentiality);
    expect(restored.integrity).toEqual(original.integrity);
  });
});
