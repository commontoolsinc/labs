import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { classifyIntent, generatePlan, WORKFLOWS } from "../src/workflow.ts";

describe("Workflow Classification", () => {
  describe("WORKFLOWS constant", () => {
    it("should define three workflow types", () => {
      expect(Object.keys(WORKFLOWS).length).toBe(3);
      expect(WORKFLOWS.fix).toBeDefined();
      expect(WORKFLOWS.edit).toBeDefined();
      expect(WORKFLOWS.imagine).toBeDefined();
    });

    it("should have the correct properties for each workflow", () => {
      // Fix workflow
      expect(WORKFLOWS.fix.name).toBe("fix");
      expect(WORKFLOWS.fix.updateSpec).toBe(false);
      expect(WORKFLOWS.fix.updateSchema).toBe(false);
      expect(WORKFLOWS.fix.allowsDataReferences).toBe(false);

      // Edit workflow
      expect(WORKFLOWS.edit.name).toBe("edit");
      expect(WORKFLOWS.edit.updateSpec).toBe(true);
      expect(WORKFLOWS.edit.updateSchema).toBe(false);
      expect(WORKFLOWS.edit.allowsDataReferences).toBe(false);

      // Rework workflow
      expect(WORKFLOWS.imagine.name).toBe("imagine");
      expect(WORKFLOWS.imagine.updateSpec).toBe(true);
      expect(WORKFLOWS.imagine.updateSchema).toBe(true);
      expect(WORKFLOWS.imagine.allowsDataReferences).toBe(true);
    });
  });
});
