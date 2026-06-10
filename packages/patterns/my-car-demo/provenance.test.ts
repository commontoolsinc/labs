import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  authoredBySubject,
  AuthoredClaim,
  authorSubject,
  IntegrityAtom,
  memberOwnerSet,
  representsPrincipalSubject,
  sameAuthorAsOwner,
  trustedAffiliatedVehicles,
} from "./provenance.ts";

const owner = (did: string): IntegrityAtom[] => [
  { kind: "represents-principal", subject: did },
];
const authoredBy = (did: string): IntegrityAtom[] => [
  { kind: "authored-by", subject: did },
];
const vehicle = (plateId: string) => ({
  plateId,
  plateState: "CA",
  color: "",
  make: "",
  model: "",
});

const ALICE = "did:key:alice";
const BOB = "did:key:bob";
const EVE = "did:key:eve";

describe("subject extraction", () => {
  it("reads the represents-principal subject (owner)", () => {
    expect(representsPrincipalSubject(owner(ALICE))).toBe(ALICE);
    expect(representsPrincipalSubject(authoredBy(BOB))).toBeUndefined();
  });

  it("reads the authored-by subject (voucher)", () => {
    expect(authoredBySubject(authoredBy(BOB))).toBe(BOB);
  });

  it("authorSubject prefers represents-principal, falls back to authored-by", () => {
    expect(authorSubject(owner(ALICE))).toBe(ALICE);
    expect(authorSubject(authoredBy(BOB))).toBe(BOB);
    expect(authorSubject(undefined)).toBeUndefined();
    expect(authorSubject([])).toBeUndefined();
  });
});

describe("sameAuthorAsOwner", () => {
  it("true when the value's author is the reference's owner", () => {
    expect(sameAuthorAsOwner(owner(ALICE), owner(ALICE))).toBe(true);
  });
  it("false on a different principal", () => {
    expect(sameAuthorAsOwner(owner(EVE), owner(ALICE))).toBe(false);
  });
  it("false when either side has no subject", () => {
    expect(sameAuthorAsOwner(undefined, owner(ALICE))).toBe(false);
    expect(sameAuthorAsOwner(owner(ALICE), [])).toBe(false);
  });
});

describe("memberOwnerSet", () => {
  it("collects owner DIDs from member profiles, dropping empties", () => {
    const set = memberOwnerSet([owner(ALICE), owner(BOB), undefined, []]);
    expect([...set].sort()).toEqual([ALICE, BOB].sort());
  });
});

describe("trustedAffiliatedVehicles (the provenance gate)", () => {
  const members = memberOwnerSet([owner(ALICE), owner(BOB)]);
  const claims: AuthoredClaim[] = [
    { vehicle: vehicle("ALICE1"), authorAtoms: owner(ALICE) }, // member → kept
    { vehicle: vehicle("EVE666"), authorAtoms: owner(EVE) }, // not a member → dropped
    { vehicle: vehicle("NOAUTH"), authorAtoms: [] }, // no author → dropped
  ];

  it("keeps only claims authored by a member-profile owner", () => {
    const out = trustedAffiliatedVehicles(claims, members);
    expect(out.map((v) => v.plateId)).toEqual(["ALICE1"]);
  });

  it("revocation: dropping a member from the set drops their claims", () => {
    const withoutAlice = memberOwnerSet([owner(BOB)]);
    expect(trustedAffiliatedVehicles(claims, withoutAlice)).toEqual([]);
  });

  it("a forged claim (author not a member) never becomes affiliated", () => {
    const forged: AuthoredClaim[] = [
      { vehicle: vehicle("FORGED"), authorAtoms: authoredBy(EVE) },
    ];
    expect(trustedAffiliatedVehicles(forged, members)).toEqual([]);
  });
});
