import { hydratePrompt, parseTagFromResponse } from "./prompting.ts";
import { client } from "../client.ts";
import type { JSONSchema } from "@commontools/builder";

/**
 * Basic prompt for classifying user intent into a workflow type
 */
export const WORKFLOW_CLASSIFICATION_PROMPT = `
You are analyzing a user's request to determine the most appropriate workflow for code generation.
Based on the user's request, classify it into one of the following workflows:

1. FIX: Correct issues in the code without changing functionality or specification
   - Example: "Fix the alignment of buttons" or "Correct the calculation bug"
   - Only modifies code, not the specification or schema

2. EDIT: Add features or modify functionality while preserving core data structure
   - Example: "Add dark mode support" or "Include a search feature"
   - Modifies code and specification, but preserves core schema structure

3. REWORK: Create something new, potentially combining multiple data sources
   - Example: "Create a dashboard combining my tasks and calendar" 
   - Creates new code, specification, and potentially new schema

User's request: "{{ INPUT }}"

Current Charm Context:
{{ CONTEXT }}

Please analyze this request and respond in the following format:

<workflow>FIX|EDIT|REWORK</workflow>
<confidence>0.0-1.0</confidence>
<reasoning>Brief explanation of your classification</reasoning>
<enhanced_prompt>Optional improved or clarified version of the user's request</enhanced_prompt>
`;

/**
 * Basic prompt for generating an execution plan
 */
export const PLAN_GENERATION_PROMPT = `
You are creating an execution plan for a code generation request.
The user's request has been classified as a {{ WORKFLOW_TYPE }} operation.

User's request: "{{ INPUT }}"

Current Charm Context:
{{ CONTEXT }}

Please create a step-by-step execution plan for this request.
For EDIT and REWORK workflows, also describe changes to specification and schema.

Respond in the following format:

<steps>
1. First step of the plan
2. Second step of the plan
3. ...
</steps>

{{ SPEC_SECTION }}

{{ SCHEMA_SECTION }}
`;

/**
 * Generate the context section for a charm
 */
function generateCharmContext(
  existingSpec?: string,
  existingSchema?: JSONSchema,
  existingCode?: string,
): string {
  if (!existingSpec && !existingSchema && !existingCode) {
    return "No existing charm context available.";
  }

  let context = "";
  
  if (existingSpec) {
    context += `\nExisting Specification:\n\`\`\`\n${existingSpec}\n\`\`\`\n`;
  }
  
  if (existingSchema) {
    context += `\nExisting Schema:\n\`\`\`json\n${JSON.stringify(existingSchema, null, 2)}\n\`\`\`\n`;
  }
  
  if (existingCode) {
    context += `\nExisting Code (excerpt):\n\`\`\`javascript\n${existingCode.substring(0, 500)}${existingCode.length > 500 ? '...' : ''}\n\`\`\`\n`;
  }
  
  return context;
}

/**
 * Classifies the user's intent into a workflow type
 */
export async function classifyWorkflow(
  input: string,
  existingSpec?: string,
  existingSchema?: JSONSchema,
  existingCode?: string,
  model?: string,
): Promise<{
  workflowType: "fix" | "edit" | "rework";
  confidence: number;
  reasoning: string;
  enhancedPrompt?: string;
}> {
  const context = generateCharmContext(existingSpec, existingSchema, existingCode);
  
  const prompt = hydratePrompt(WORKFLOW_CLASSIFICATION_PROMPT, {
    INPUT: input,
    CONTEXT: context,
  });

  const response = await client.sendRequest({
    system: prompt,
    messages: [],
    model: model || "anthropic:claude-3-7-sonnet-latest",
  });

  try {
    const workflow = parseTagFromResponse(response, "workflow").toLowerCase();
    const confidence = parseFloat(parseTagFromResponse(response, "confidence"));
    const reasoning = parseTagFromResponse(response, "reasoning");
    
    let enhancedPrompt: string | undefined;
    try {
      enhancedPrompt = parseTagFromResponse(response, "enhanced_prompt");
    } catch (e) {
      // Enhanced prompt is optional
    }

    return {
      workflowType: workflow as "fix" | "edit" | "rework",
      confidence: isNaN(confidence) ? 0.5 : confidence,
      reasoning,
      enhancedPrompt,
    };
  } catch (error) {
    console.error("Error parsing workflow classification response:", error);
    // Default to "edit" if parsing fails
    return {
      workflowType: "edit",
      confidence: 0.5,
      reasoning: "Default classification due to parsing error",
    };
  }
}

/**
 * Generates an execution plan for a workflow
 */
export async function generateWorkflowPlan(
  input: string,
  workflowType: "fix" | "edit" | "rework",
  existingSpec?: string,
  existingSchema?: JSONSchema,
  existingCode?: string,
  model?: string,
): Promise<{
  steps: string[];
  updatedSpec?: string;
  updatedSchema?: JSONSchema;
}> {
  const context = generateCharmContext(existingSpec, existingSchema, existingCode);
  
  // Add conditional sections based on workflow type
  const specSection = workflowType !== "fix" 
    ? "<updated_spec>Updated specification based on the request</updated_spec>" 
    : "";
  
  const schemaSection = workflowType === "rework"
    ? "<updated_schema>Updated schema in JSON format</updated_schema>"
    : "";
  
  const prompt = hydratePrompt(PLAN_GENERATION_PROMPT, {
    INPUT: input,
    WORKFLOW_TYPE: workflowType.toUpperCase(),
    CONTEXT: context,
    SPEC_SECTION: specSection,
    SCHEMA_SECTION: schemaSection,
  });

  const response = await client.sendRequest({
    system: prompt,
    messages: [],
    model: model || "anthropic:claude-3-7-sonnet-latest",
  });

  try {
    const stepsText = parseTagFromResponse(response, "steps");
    const steps = stepsText
      .split(/\d+\.\s+/)
      .filter(step => step.trim().length > 0)
      .map(step => step.trim());
    
    let updatedSpec: string | undefined;
    let updatedSchema: JSONSchema | undefined;
    
    if (workflowType !== "fix") {
      try {
        updatedSpec = parseTagFromResponse(response, "updated_spec");
      } catch (e) {
        // Updated spec might not be available
      }
    }
    
    if (workflowType === "rework") {
      try {
        const schemaJson = parseTagFromResponse(response, "updated_schema");
        updatedSchema = JSON.parse(schemaJson);
      } catch (e) {
        // Updated schema might not be available or not valid JSON
      }
    }
    
    return {
      steps,
      updatedSpec,
      updatedSchema,
    };
  } catch (error) {
    console.error("Error parsing workflow plan response:", error);
    return {
      steps: ["Analyze the request", "Implement the changes", "Verify the result"],
    };
  }
}