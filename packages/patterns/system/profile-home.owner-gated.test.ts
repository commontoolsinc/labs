import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

// Host-embedding contract seam 7 (docs/development/HOST_EMBEDDING.md §7): pinning
// an element to a profile is authorized by OWNERSHIP, not by a trusted-UI
// gesture. The single authorized writer of profile `elements` is
// `mutateElements` in profile-home.tsx, typed `OwnerProtectedProfileWrite`
// (WriteAuthorizedBy + ownerPrincipal) with NO `uiContract`. Contrast the
// profile *create* surface (profile-create.tsx), where `uiContract` IS present
// on `TrustedProfileLink` — creating a profile is correctly gesture-gated.
//
// This asymmetry is deliberate and load-bearing: because pinning is owner-gated,
// headless (`cf piece call` into `addPiece`) and cross-pattern pin flows are
// SANCTIONED. A future change that "hardens" pinning by adding a `uiContract`
// to the profile-home write path would silently break those flows — this test
// goes red on that change.
//
// The contract is asserted against the pattern SOURCE TEXT rather than the
// transformed graph so it stays robust across transformer changes and needs no
// runtime; the markers checked (`uiContract`, `OwnerProtectedProfileWrite`,
// `TrustedProfileLink`, `addPiece`) are stable public type/handler names.

const read = (relPath: string): string =>
  Deno.readTextFileSync(new URL(relPath, import.meta.url));

describe("host embedding contract: profile pinning is owner-gated", () => {
  const home = read("./profile-home.tsx");
  const create = read("./profile-create.tsx");

  it("profile-home.tsx (the pin writer) carries NO uiContract", () => {
    // Pinning to an existing profile requires only ownership. If a uiContract
    // appears here, a headless/cross-pattern pin would start failing closed.
    expect(home.includes("uiContract")).toBe(false);
  });

  it("the elements write is typed OwnerProtectedProfileWrite (identity-gated)", () => {
    expect(home).toContain("type OwnerProtectedProfileWrite");
    expect(home).toContain(
      "elements: OwnerProtectedProfileWrite<ProfileElement[], typeof mutateElements>",
    );
    expect(home).toContain("WriteAuthorizedBy");
    expect(home).toContain("ownerPrincipal");
  });

  it("exposes addPiece as a Stream — the sanctioned headless pin path", () => {
    expect(home).toContain("addPiece: Stream<MutateProfileElementsEvent>");
    // The stream is bound to mutateElements in the "addPiece" mode.
    expect(home).toContain('mode: "addPiece"');
  });

  it("the create surface (profile-create.tsx) DOES carry a uiContract", () => {
    // Creating a profile is correctly gesture-gated — the opposite seam.
    expect(create).toContain("export type TrustedProfileLink");
    expect(create).toContain("uiContract");
    expect(create).toContain("ProfileCreateSurface");
  });
});
