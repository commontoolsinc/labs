import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { canonicalizeSchedulerActionLocation } from "../src/runner-utils.ts";

describe("runner scheduler action identity helpers", () => {
  it("strips generated compile ids from source-mapped action locations", () => {
    const fromParentProgram =
      "fid1:eU59jFoFYyU3glCh88QaFzK23pIUSI0KjkZV_FmK2o0/api/patterns/notes/notebook.tsx:1198:45";
    const fromRecompiledExport =
      "fid1:hLsaZ74A_SV_L39Dhg4y6sF78ktRL1wX8y4TmL7In3I/api/patterns/notes/notebook.tsx:1198:45";

    expect(canonicalizeSchedulerActionLocation(fromParentProgram)).toBe(
      "/api/patterns/notes/notebook.tsx:1198:45",
    );
    expect(canonicalizeSchedulerActionLocation(fromRecompiledExport)).toBe(
      "/api/patterns/notes/notebook.tsx:1198:45",
    );
  });

  it("leaves non-compiled action names unchanged", () => {
    expect(canonicalizeSchedulerActionLocation("sink:space/of:cell/value"))
      .toBe("sink:space/of:cell/value");
    expect(canonicalizeSchedulerActionLocation("/api/patterns/foo.tsx:1:2"))
      .toBe("/api/patterns/foo.tsx:1:2");
  });
});
