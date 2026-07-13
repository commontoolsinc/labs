import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cfcAtom } from "@commonfabric/api/cfc";
import {
  createRenderConfidentialityResolver,
  RENDER_DISPLAY_SINK_CLASS,
} from "../src/cfc/render-ceiling.ts";
import type { SpaceMembershipProvider } from "../src/cfc/space-membership.ts";
import { atomsOutsideCeiling } from "../src/cfc/observation.ts";

// Epic H3b (docs/history/plans/cfc-future-work-implementation.md §7): the display-sink
// render ceiling resolves §15.2 principal shapes via exchange rules
// (spec §8.10.6 — "ordinary exchange-rule evaluation runs before the fit
// check"; §4.3.3 SpaceReaderAccess; §4.9.3 HasRole membership facts). The
// resolver runs RUNNER-side; the reconciler consumes the resolved label and
// fits it clause-subsumption-wise (§8.10.3) against the ceiling.

const ALICE = "did:key:alice";
const MALLORY = "did:key:mallory";
const SPACE_TEAM = "did:key:team-space";
const SPACE_OTHER = "did:key:other-space";

const userAlice = cfcAtom.user(ALICE);
const personalSpaceAlice = cfcAtom.personalSpace(ALICE);

// The §8.10.6 default display ceiling for Alice: her identity + personal-space
// principal forms. Space principals are admitted via verified HasRole
// exchange, never listed statically.
const aliceCeiling = [userAlice, personalSpaceAlice];

describe("CFC render confidentiality resolver (H3b)", () => {
  it("resolves nothing but admits a direct User(actingUser) label (test 1)", () => {
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
    });
    const resolved = resolve({ confidentiality: [userAlice] });
    // Post-resolution the acting user's own identity atom fits the User ceiling.
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([]);
  });

  it("admits PersonalSpace(actingUser) directly, no rule needed", () => {
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
    });
    const resolved = resolve({ confidentiality: [personalSpaceAlice] });
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([]);
  });

  it("resolves a Space atom through a declared reader role (test 2)", () => {
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      // §4.9.3: Alice's verified reader membership in the team space.
      memberSpaces: [SPACE_TEAM],
    });
    const resolved = resolve({ confidentiality: [cfcAtom.space(SPACE_TEAM)] });
    // Space(team) gained a User(alice) alternative and now fits the ceiling.
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([]);
  });

  it("does NOT mint a reader fact from cell residency alone (fail-closed)", () => {
    // Residency is not read authority: a cell tagged Space(team) that is merely
    // resident in the acting user's runtime (e.g. synced under an ACL-off
    // deployment) must NOT resolve. HasRole facts come only from the verified
    // member set (§4.9.3), never inferred from the cell's storage space.
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
    });
    const resolved = resolve({ confidentiality: [cfcAtom.space(SPACE_TEAM)] });
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([
      cfcAtom.space(SPACE_TEAM),
    ]);
  });

  it("resolves the acting user's own space (a verified reader space)", () => {
    // A principal definitionally reads its own space (space DID == principal
    // DID), independent of deployment ACL mode — so the own space is always a
    // sound verified member fact.
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      memberSpaces: [ALICE],
    });
    const resolved = resolve({ confidentiality: [cfcAtom.space(ALICE)] });
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([]);
  });

  it("leaves an unresolvable Space atom outside the ceiling (test 3, fail-closed)", () => {
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      memberSpaces: [SPACE_TEAM],
    });
    // Data claims a space Alice is NOT a verified reader of.
    const resolved = resolve({
      confidentiality: [cfcAtom.space(SPACE_OTHER)],
    });
    const offending = atomsOutsideCeiling(resolved, aliceCeiling);
    expect(offending).toEqual([cfcAtom.space(SPACE_OTHER)]);
  });

  it("does not resolve a Space atom for a different principal's role", () => {
    // The membership fact names Alice; the acting principal is Alice, so a role
    // belonging to Mallory cannot admit the data even if supplied.
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: MALLORY,
      memberSpaces: [SPACE_TEAM],
    });
    const resolved = resolve({ confidentiality: [cfcAtom.space(SPACE_TEAM)] });
    // The clause gains a User(mallory) alternative — outside Alice's ceiling —
    // so it stays blocked at the fit check (one offending clause).
    const offending = atomsOutsideCeiling(resolved, aliceCeiling);
    expect(offending.length).toBe(1);
    expect(atomsOutsideCeiling(resolved, [cfcAtom.user(MALLORY)])).toEqual([]);
  });

  it('mints a display-class boundary context (sinkClass:"display")', () => {
    // The display sink class is the render sibling of B5's network class.
    expect(RENDER_DISPLAY_SINK_CLASS).toBe("display");
  });

  it("returns the label unchanged when it carries no confidentiality", () => {
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
    });
    expect(resolve({ confidentiality: [] })).toEqual([]);
  });

  it("mints no role facts without an acting principal (fail-closed)", () => {
    // No acting principal → no HasRole facts can be minted for any member
    // space, so a Space label cannot resolve.
    const resolve = createRenderConfidentialityResolver({
      memberSpaces: [SPACE_TEAM],
    });
    const resolved = resolve({ confidentiality: [cfcAtom.space(SPACE_TEAM)] });
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([
      cfcAtom.space(SPACE_TEAM),
    ]);
  });
});

// §4.9.3 per-label membership discovery: instead of a static member set, the
// resolver mints HasRole facts PER-LABEL from the Space atoms present in the
// label, consulting a SpaceMembershipProvider (the ACL-doc-backed lookup).
const providerGranting = (
  grantedSpaces: readonly string[],
): SpaceMembershipProvider => ({
  readerRole: (space) => grantedSpaces.includes(space) ? "reader" : null,
  subscribe: () => () => {},
});

describe("CFC render resolver — per-label membership discovery (§4.9.3)", () => {
  it("resolves a Space label the provider verifies the acting user reads", () => {
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      membershipProvider: providerGranting([SPACE_TEAM]),
    });
    const resolved = resolve({ confidentiality: [cfcAtom.space(SPACE_TEAM)] });
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([]);
  });

  it("blocks a Space label the provider does not grant (fail-closed)", () => {
    // The provider grants nothing for SPACE_OTHER — residency/an unsynced ACL
    // mints no fact, so the clause stays outside the ceiling.
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      membershipProvider: providerGranting([SPACE_TEAM]),
    });
    const resolved = resolve({ confidentiality: [cfcAtom.space(SPACE_OTHER)] });
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([
      cfcAtom.space(SPACE_OTHER),
    ]);
  });

  it("§4.9.4 conjunctive: admits iff EVERY Space clause resolves", () => {
    // A value carrying two Space atoms gets an independent verified fact per
    // space; both must resolve for the value to fit.
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      membershipProvider: providerGranting([SPACE_TEAM]),
    });
    // Only TEAM granted: OTHER stays offending.
    const partial = resolve({
      confidentiality: [cfcAtom.space(SPACE_TEAM), cfcAtom.space(SPACE_OTHER)],
    });
    expect(atomsOutsideCeiling(partial, aliceCeiling)).toEqual([
      cfcAtom.space(SPACE_OTHER),
    ]);
    // Both granted: the whole conjunction fits.
    const resolveBoth = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      membershipProvider: providerGranting([SPACE_TEAM, SPACE_OTHER]),
    });
    const both = resolveBoth({
      confidentiality: [cfcAtom.space(SPACE_TEAM), cfcAtom.space(SPACE_OTHER)],
    });
    expect(atomsOutsideCeiling(both, aliceCeiling)).toEqual([]);
  });

  it("combines the static fast-path member set with per-label discovery", () => {
    // Own space stays a static fast-path member (no ACL read); a cross-space
    // Space atom is discovered per-label via the provider.
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      memberSpaces: [ALICE],
      membershipProvider: providerGranting([SPACE_TEAM]),
    });
    const resolved = resolve({
      confidentiality: [cfcAtom.space(ALICE), cfcAtom.space(SPACE_TEAM)],
    });
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([]);
  });

  it("does not consult the provider for a space in the static fast path", () => {
    // The own/session fast path needs no ACL read; the provider must not be
    // asked about spaces already trusted statically.
    const consulted: string[] = [];
    const provider: SpaceMembershipProvider = {
      readerRole: (space) => {
        consulted.push(space);
        return null;
      },
      subscribe: () => () => {},
    };
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      memberSpaces: [ALICE],
      membershipProvider: provider,
    });
    resolve({ confidentiality: [cfcAtom.space(ALICE)] });
    expect(consulted).not.toContain(ALICE);
  });

  it("discovers Space atoms nested inside an anyOf clause", () => {
    // §4.3.4 multi-binding: a disjunctive clause offers one access path per
    // role held; the provider is consulted for Space atoms inside anyOf too.
    const consulted: string[] = [];
    const provider: SpaceMembershipProvider = {
      readerRole: (space) => {
        consulted.push(space);
        return space === SPACE_TEAM ? "reader" : null;
      },
      subscribe: () => () => {},
    };
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      membershipProvider: provider,
    });
    resolve({
      confidentiality: [{
        anyOf: [cfcAtom.space(SPACE_TEAM), cfcAtom.user(MALLORY)],
      }],
    });
    expect(consulted).toContain(SPACE_TEAM);
  });
});
