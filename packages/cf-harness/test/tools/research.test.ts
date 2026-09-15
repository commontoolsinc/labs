import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { createToolOutputId } from "../../src/contracts/tool-result.ts";
import {
  isResearchToolSuccessOutput,
  researchTool,
} from "../../src/tools/research.ts";
import type { HarnessToolContext } from "../../src/tools/types.ts";

describe("research", () => {
  describe("isResearchToolSuccessOutput()", () => {
    it("returns false for values that are not result objects", () => {
      for (const output of [null, undefined, "ok", 1, []]) {
        expect(isResearchToolSuccessOutput(output)).toBe(false);
      }
    });
  });

  describe("researchTool", () => {
    it("returns a source-free error when no research runner is installed", async () => {
      const outputId = createToolOutputId("no-runner", "research", 1);
      const context: Partial<HarnessToolContext> = {
        nextOutputId: () => outputId,
      };
      const output = await researchTool.invoke(context as HarnessToolContext, {
        task: "Find a recipe",
      });
      expect(output).toMatchObject({
        outputId,
        status: "error",
        message: "research requires the host research runner",
        cfc: { coverage: "complete", missingLabels: [] },
      });
      expect(output).not.toHaveProperty("researchRecord");
    });
  });
});
