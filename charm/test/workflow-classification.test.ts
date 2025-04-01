import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { 
  WorkflowType,
  classifyIntent,
  generatePlan,
  WORKFLOWS,
} from "../src/imagine.ts";

describe("Workflow Classification", () => {
  describe("WORKFLOWS constant", () => {
    it("should define three workflow types", () => {
      expect(Object.keys(WORKFLOWS).length).toBe(3);
      expect(WORKFLOWS.fix).toBeDefined();
      expect(WORKFLOWS.edit).toBeDefined();
      expect(WORKFLOWS.rework).toBeDefined();
    });

    it("should have the correct properties for each workflow", () => {
      // Fix workflow
      expect(WORKFLOWS.fix.name).toBe("fix");
      expect(WORKFLOWS.fix.updateSpec).toBe(false);
      expect(WORKFLOWS.fix.updateSchema).toBe(false);
      expect(WORKFLOWS.fix.allowsDataReferences).toBe(true);
      
      // Edit workflow
      expect(WORKFLOWS.edit.name).toBe("edit");
      expect(WORKFLOWS.edit.updateSpec).toBe(true);
      expect(WORKFLOWS.edit.updateSchema).toBe(false);
      expect(WORKFLOWS.edit.allowsDataReferences).toBe(true);
      
      // Rework workflow
      expect(WORKFLOWS.rework.name).toBe("rework");
      expect(WORKFLOWS.rework.updateSpec).toBe(true);
      expect(WORKFLOWS.rework.updateSchema).toBe(true);
      expect(WORKFLOWS.rework.allowsDataReferences).toBe(true);
    });
  });

  describe("classifyIntent function", () => {
    // These tests will use the fallback classification since we're not mocking the LLM
    
    it("should classify fix-related inputs", async () => {
      const result = await classifyIntent("Fix the button alignment issue");
      expect(result.workflowType).toBe("fix");
      expect(result.confidence).toBeGreaterThan(0);
    });
    
    it("should classify edit-related inputs", async () => {
      const result = await classifyIntent("Add a dark mode toggle");
      expect(result.workflowType).toBe("edit");
      expect(result.confidence).toBeGreaterThan(0);
    });
    
    it("should classify rework-related inputs", async () => {
      const result = await classifyIntent("Create a dashboard for my data");
      expect(result.workflowType).toBe("rework");
      expect(result.confidence).toBeGreaterThan(0);
    });
  });

  describe("generatePlan function", () => {
    // These tests will use the fallback plan since we're not mocking the LLM
    
    it("should generate plan for fix workflow", async () => {
      const plan = await generatePlan("Fix the button alignment", "fix");
      expect(plan.workflowType).toBe("fix");
      expect(plan.steps.length).toBeGreaterThan(0);
    });
    
    it("should generate plan for edit workflow", async () => {
      const plan = await generatePlan("Add a dark mode toggle", "edit");
      expect(plan.workflowType).toBe("edit");
      expect(plan.steps.length).toBeGreaterThan(0);
    });
    
    it("should generate plan for rework workflow", async () => {
      const plan = await generatePlan("Create a dashboard for my data", "rework");
      expect(plan.workflowType).toBe("rework");
      expect(plan.steps.length).toBeGreaterThan(0);
    });
  });
});