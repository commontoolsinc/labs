import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { instructionsFromSwift } from "../scripts/want-eval/judge.ts";

describe("judge", () => {
  describe("instructionsFromSwift()", () => {
    it("returns the declared instructions with continuations joined and the indent removed", () => {
      const source = [
        "enum WantSaidNow {",
        '    static let instructions = """',
        "    Answer briefly, \\",
        "        in one line.",
        "    Offer what comes next.",
        '    """',
        "}",
      ].join("\n");

      expect(instructionsFromSwift(source)).toBe(
        "Answer briefly, in one line.\nOffer what comes next.",
      );
    });

    it("returns undefined for a source that declares no instructions", () => {
      expect(instructionsFromSwift("enum Empty {}")).toBeUndefined();
    });
  });
});
