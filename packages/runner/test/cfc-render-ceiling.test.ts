import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cfcAtom } from "@commonfabric/api/cfc";
import {
  createRenderConfidentialityResolver,
  RENDER_DISPLAY_SINK_CLASS,
} from "../src/cfc/render-ceiling.ts";
import { atomsOutsideCeiling } from "../src/cfc/observation.ts";

// Epic H3b (docs/plans/cfc-future-work-implementation.md §7): the display-sink
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

  it("mints the reader fact from the cell's own storage space", () => {
    // No static member set — the space the cell lives in (a space whose data
    // the runtime synced for this reader) is a verified reader fact by itself.
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
    });
    const resolved = resolve({
      confidentiality: [cfcAtom.space(SPACE_TEAM)],
      space: SPACE_TEAM,
    });
    expect(atomsOutsideCeiling(resolved, aliceCeiling)).toEqual([]);
  });

  it("leaves an unresolvable Space atom outside the ceiling (test 3, fail-closed)", () => {
    const resolve = createRenderConfidentialityResolver({
      actingPrincipal: ALICE,
      memberSpaces: [SPACE_TEAM],
    });
    // Data claims a space Alice is NOT a reader of, and it does not live there.
    const resolved = resolve({
      confidentiality: [cfcAtom.space(SPACE_OTHER)],
      space: SPACE_TEAM,
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
});
