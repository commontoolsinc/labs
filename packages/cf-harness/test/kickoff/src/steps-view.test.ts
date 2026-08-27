import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { clampSelection } from "../../../kickoff/src/steps-view.ts";

describe("kickoff/src/steps-view", () => {
  describe("clampSelection", () => {
    it("keeps a selection the run is long enough to hold", () => {
      expect(clampSelection(3, 9)).toBe(3);
    });

    it("moves a selection past a shorter run's end to its last step", () => {
      expect(clampSelection(8, 3)).toBe(2);
    });

    it("answers zero for a run that recorded no steps", () => {
      expect(clampSelection(8, 0)).toBe(0);
    });

    it("answers zero for a step before the first", () => {
      expect(clampSelection(-1, 9)).toBe(0);
    });
  });
});
