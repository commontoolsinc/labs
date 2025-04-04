import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { WorkflowFormData, WorkflowType } from "../SpecPreview.tsx";

describe("WorkflowFormData", () => {
  it("should properly structure workflow form data", () => {
    // Test with a basic form data object
    const formData: WorkflowFormData = {
      workflowType: "edit",
      plan: ["Step 1", "Step 2"],
      spec: "Test specification",
      schema: { type: "object", properties: {} }
    };
    
    // Ensure properties have the expected types
    expect(typeof formData.workflowType).toBe("string");
    expect(Array.isArray(formData.plan)).toBe(true);
    expect(typeof formData.spec).toBe("string");
    expect(typeof formData.schema).toBe("object");
    
    // Ensure workflowType is a valid type
    const validTypes: WorkflowType[] = ["fix", "edit", "rework"];
    expect(validTypes).toContain(formData.workflowType);
  });
  
  it("should handle string plan format", () => {
    // Test with plan as a string instead of array
    const formData: WorkflowFormData = {
      workflowType: "fix",
      plan: "Single step plan",
      spec: "Test specification"
    };
    
    expect(typeof formData.plan).toBe("string");
    expect(formData.plan).toBe("Single step plan");
  });
  
  it("should support optional schema property", () => {
    // Test without schema
    const formData: WorkflowFormData = {
      workflowType: "rework",
      plan: ["Step 1"],
      spec: "Test specification"
    };
    
    expect(formData.schema).toBeUndefined();
  });
  
  it("should support optional spec property", () => {
    // Test without spec
    const formData: WorkflowFormData = {
      workflowType: "fix",
      plan: ["Fix bug"]
    };
    
    expect(formData.spec).toBeUndefined();
  });
  
  it("should be compatible with performOperation function requirements", () => {
    // Create a form that matches what performOperation would expect
    const formData: WorkflowFormData = {
      workflowType: "edit",
      plan: ["Update UI"],
      spec: "Specification"
    };
    
    // Extract plan as an array (handling string conversion)
    const planArray = typeof formData.plan === "string" 
      ? [formData.plan] 
      : formData.plan;
      
    // Verify plan extraction works as expected
    expect(Array.isArray(planArray)).toBe(true);
    expect(planArray[0]).toBe("Update UI");
    
    // Extract workflow type
    const { workflowType } = formData;
    expect(workflowType).toBe("edit");
  });
});