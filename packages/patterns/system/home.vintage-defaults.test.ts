import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

// Home's published result contract already contains these defaults. Newly
// required generated outputs do not need migration defaults, but removing an
// existing default is still a contract change: older consumers may rely on its
// materialization semantics. The generic compatibility gate does not reject
// default removal, so these source pins are the protection against silently
// changing Home's established result contract. Generic generated-output
// behavior is covered by the piece compatibility, CFC schema-merge, and
// vintage replay suites.

const read = (relPath: string): string =>
  Deno.readTextFileSync(new URL(relPath, import.meta.url));

describe("home result-default contract stability", () => {
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

  // CFC-wrapped lists: the default goes OUTSIDE the WriteAuthorizedBy wrapper
  // (`Default<Cfc<…>, []>`), matching profile-home's externalLinks. profiles/mru
  // entered HomeOutput in #3830 — much later than favorites (#2478) — so a home
  // root that predates them (or is old enough to predate favorites) needs these
  // to merge. An empty default carries no elements, so no writer claim is
  // asserted; the profile-owner-cfc / writer-claim suites pin that invariant.
  it("profiles rides Default<TrustedProfileList, []> (wrapper-outside)", () => {
    expect(home).toContain("profiles: Default<TrustedProfileList, []>");
  });

  it("mru rides Default<TrustedProfileMru, []> (wrapper-outside)", () => {
    expect(home).toContain("mru: Default<TrustedProfileMru, []>");
  });

  // #4933 left defaultProfile as `defaultProfile: TrustedDefaultProfile;`
  // believing its `… | undefined` value type made it non-required. It does
  // NOT: the schema-generator decides `required` from the presence of a `?`
  // optional marker (schema-generator.ts `if (!member.questionToken)`), not
  // from the value type — so the bare spelling emitted defaultProfile as
  // required-with-no-default and the cold-start repair threw on it, one layer
  // past the six data fields above. The `?` is the fix that makes it genuinely
  // optional (dropped from `required`), so no default is needed.
  it("defaultProfile is optional (?) — the value-type-only assumption was wrong", () => {
    expect(home).toContain("defaultProfile?: TrustedDefaultProfile;");
  });

  it("Default is imported (the spellings above are inert without it)", () => {
    expect(home).toContain("Default");
    expect(home).toMatch(/from "commonfabric"/);
  });
});
