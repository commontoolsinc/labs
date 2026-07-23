import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

// Estuary re-brick guard. A home root doc written before a given HomeOutput
// data field existed has no stored value for it. When the runtime materializes
// this pattern over such a doc (the cold-start setup repair in
// pieces-controller, reached whenever an unloadable/older root is swapped to
// current home.tsx), CFC schema-merge's `mergeRequired` REFUSES the setup
// commit for any additive required field that lacks a `default` — "required
// field <name> needs a default to preserve old documents". That rejection
// fails the repair closed and the home stays bricked ("Handler used as lift",
// the 2026-07-22 estuary failure, whose next-layer cascade this field set is).
//
// #4901 established the fix shape with seefeldb sign-off: post-genesis DATA
// fields "ride Default<>" (bio, isEditing did). These four are the rest of that
// cascade — "first-absence-wins, so each fixed field unmasks the next" (#4901).
// The generic mechanisms are covered elsewhere (schema-generator
// default-union.test.ts: `T[] | Default<[]>` emits `default: []`; runner
// cfc-schema-merge.test.ts: additive-required WITH a default merges, WITHOUT
// throws). This pins that home.tsx itself keeps the spellings, so a future edit
// that drops one goes red here instead of re-bricking estuary. Asserted against
// SOURCE TEXT (no runtime, robust across transformer changes), mirroring
// profile-home.owner-gated.test.ts.

const read = (relPath: string): string =>
  Deno.readTextFileSync(new URL(relPath, import.meta.url));

describe("estuary vintage-tolerance: home data fields carry defaults", () => {
  const home = read("./home.tsx");

  it("favorites rides Default<[]>", () => {
    expect(home).toContain("favorites: Writable<Favorite[] | Default<[]>>");
  });

  it("journal rides Default<[]>", () => {
    expect(home).toContain("journal: Writable<JournalEntry[] | Default<[]>>");
  });

  it("spaces rides Default<[]>", () => {
    expect(home).toContain("spaces: Writable<SpaceEntry[] | Default<[]>>");
  });

  it('defaultAppUrl rides Default<"">', () => {
    expect(home).toContain('defaultAppUrl: Writable<string | Default<"">>');
  });

  it("Default is imported (the spellings above are inert without it)", () => {
    expect(home).toContain("Default");
    expect(home).toMatch(/from "commonfabric"/);
  });
});
