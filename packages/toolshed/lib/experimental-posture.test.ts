import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  experimentalPosture,
  publishExperimentalPosture,
} from "./experimental-posture.ts";

describe("experimental-posture", () => {
  it("reports nothing before a Runtime has published one", () => {
    publishExperimentalPosture(null);
    expect(experimentalPosture()).toBe(null);
  });

  it("reports the boolean flags a Runtime resolved", () => {
    publishExperimentalPosture({
      modernCellRep: false,
      serverExecution: true,
    });
    expect(experimentalPosture()).toEqual({
      modernCellRep: false,
      serverExecution: true,
    });
  });

  it("omits a flag the Runtime left unresolved", () => {
    // A client reads an absent flag as "this server said nothing" and keeps
    // its own default. Publishing `false` for it would instead turn every
    // default-on flag off across the fleet.
    publishExperimentalPosture({
      modernCellRep: true,
      systemPatternAutoUpdate: undefined,
    });
    expect(experimentalPosture()).toEqual({ modernCellRep: true });
  });

  it("replaces the previous posture rather than merging into it", () => {
    publishExperimentalPosture({ modernCellRep: true });
    publishExperimentalPosture({ serverExecution: true });
    expect(experimentalPosture()).toEqual({ serverExecution: true });
    publishExperimentalPosture(null);
  });
});
