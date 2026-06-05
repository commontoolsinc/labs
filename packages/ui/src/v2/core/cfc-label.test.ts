import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { CfcLabelView } from "@commonfabric/runner/cfc";
import { ownerPrincipalFromLabel } from "./cfc-label.ts";

const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

const view = (entries: CfcLabelView["entries"]): CfcLabelView => ({
  version: 1,
  entries,
});

describe("ownerPrincipalFromLabel", () => {
  it("extracts the subject from an object-form represents-principal atom on a field path", () => {
    // Owner-protected profile fields carry the atom at their own path, not root.
    const label = view([
      {
        path: ["name"],
        label: { integrity: [{ kind: "represents-principal", subject: DID }] },
      },
    ]);
    expect(ownerPrincipalFromLabel(label)).toBe(DID);
  });

  it("extracts the subject from a string-form atom", () => {
    const label = view([
      {
        path: ["avatar"],
        label: { integrity: [`represents-principal:${DID}`] },
      },
    ]);
    expect(ownerPrincipalFromLabel(label)).toBe(DID);
  });

  it("ignores unrelated integrity atoms", () => {
    const label = view([
      {
        path: [],
        label: { integrity: ["profile-link", "authored-by:someone"] },
      },
      {
        path: ["x"],
        label: { integrity: [{ kind: "owned-by", subject: DID }] },
      },
    ]);
    expect(ownerPrincipalFromLabel(label)).toBeUndefined();
  });

  it("returns undefined for an empty or missing label", () => {
    expect(ownerPrincipalFromLabel(undefined)).toBeUndefined();
    expect(ownerPrincipalFromLabel(view([]))).toBeUndefined();
  });
});
