import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ExecutionPlan, WorkflowType } from "@commontools/charm";

describe("WorkflowFormData", () => {
  it("should properly structure workflow form data", () => {
    // Test with a basic form data object
    const formData: ExecutionPlan = {
      workflowType: "edit",
      steps: ["Step 1", "Step 2"],
      spec: "Test specification",
      dataModel: "an email",
    };

    // Ensure properties have the expected types
    expect(typeof formData.workflowType).toBe("string");
    expect(Array.isArray(formData.steps)).toBe(true);
    expect(typeof formData.spec).toBe("string");
    expect(typeof formData.dataModel).toBe("string");

    // Ensure workflowType is a valid type
    const validTypes: WorkflowType[] = ["fix", "edit", "imagine"];
    expect(validTypes).toContain(formData.workflowType);
  });
});
