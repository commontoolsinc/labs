import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { suggestionForPatternUserCommand } from "./pattern-user-post-bash.ts";

describe("pattern-user-post-bash", () => {
  describe("suggestionForPatternUserCommand()", () => {
    it("warns when a new piece omits attached tests", () => {
      expect(
        suggestionForPatternUserCommand("cf piece new main.tsx"),
      ).toContain("No tests were attached");
    });

    it("warns when a source update omits attached tests", () => {
      expect(
        suggestionForPatternUserCommand("cf piece setsrc main.tsx --piece ID"),
      ).toContain("No tests were attached");
    });

    it("reminds the agent that attached tests still need to run", () => {
      expect(
        suggestionForPatternUserCommand(
          "cf piece new main.tsx --test main.test.tsx",
        ),
      ).toContain("Attached tests are packaged, not run");
    });

    it("warns when a custom home pattern omits attached tests", () => {
      expect(
        suggestionForPatternUserCommand(
          "cf piece set-home --identity key main.tsx",
        ),
      ).toContain("No tests were attached");
    });

    it("does not require tests when resetting the home pattern", () => {
      expect(
        suggestionForPatternUserCommand(
          "cf piece set-home --identity key --reset",
        ),
      ).toBe("");
    });

    it("checks every deployment in a compound command", () => {
      const suggestion = suggestionForPatternUserCommand(
        "cf piece setsrc a.tsx --test a.test.tsx --piece A; " +
          "cf piece setsrc b.tsx --piece B",
      );

      expect(suggestion).toContain("Attached tests are packaged, not run");
      expect(suggestion).toContain("No tests were attached");
    });

    it("keeps a line-continuation deployment in one command segment", () => {
      const suggestion = suggestionForPatternUserCommand(
        "cf piece new main.tsx \\\n  --test main.test.tsx",
      );

      expect(suggestion).toContain("Attached tests are packaged, not run");
      expect(suggestion).not.toContain("No tests were attached");
    });

    it("does not let a reset exempt another custom home deployment", () => {
      expect(
        suggestionForPatternUserCommand(
          "cf piece set-home --reset; cf piece set-home main.tsx",
        ),
      ).toContain("No tests were attached");
    });

    it("allows a test pattern to be the executable diagnostic entry", () => {
      expect(
        suggestionForPatternUserCommand("cf piece new ./main.test.tsx"),
      ).toContain("Test pattern deployed as the executable diagnostic entry");
    });

    it("keeps the recomputation guidance for state writes", () => {
      expect(
        suggestionForPatternUserCommand("cf piece set --piece ID title"),
      ).toContain("Run 'cf piece step'");
    });

    it("returns no suggestion for unrelated commands", () => {
      expect(suggestionForPatternUserCommand("git status")).toBe("");
    });
  });
});
