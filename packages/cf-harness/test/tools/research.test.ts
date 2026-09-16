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
    it("refuses an unknown follow-up before invoking research and retains task influence", async () => {
      let invoked = false;
      const context: Partial<HarnessToolContext> = {
        nextOutputId: () => createToolOutputId("follow-up", "research", 1),
        researchTaskCfcLabel: { confidentiality: ["task-influence"] },
        researchRuns: [],
        runResearch: () => {
          invoked = true;
          return Promise.reject(new Error("unexpected research invocation"));
        },
      };
      const output = await researchTool.invoke(context as HarnessToolContext, {
        task: "Clarify the input contract",
        purpose: "answer",
        followUpTo: "unknown-result",
      });
      expect(invoked).toBe(false);
      expect(output).toMatchObject({
        status: "error",
        message:
          "followUpTo must name an admitted research result available to this run",
        cfc: { outputLabel: { confidentiality: ["task-influence"] } },
      });
      expect(output).not.toHaveProperty("researchRecord");
    });

    it("retains an artifact-only fallback for an unconvertible provider cause", async () => {
      const context: Partial<HarnessToolContext> = {
        nextOutputId: () => createToolOutputId("unconvertible", "research", 1),
        runResearch: () => Promise.reject(Object.create(null)),
      };
      const output = await researchTool.invoke(context as HarnessToolContext, {
        task: "Find a recipe",
      });
      expect(output).toMatchObject({
        status: "error",
        rawCauseMessage: "error could not be converted to text",
      });
      expect(output).not.toHaveProperty("researchRecord");
    });

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
