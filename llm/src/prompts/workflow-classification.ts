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
 * Prompt for generating an execution plan with comprehensive specification
 */
export const PLAN_GENERATION_PROMPT = `
You are creating an execution plan and specification for a code generation request.
The user's request has been classified as a {{ WORKFLOW_TYPE }} operation.

User's request: "{{ INPUT }}"

Current Charm Context:
{{ CONTEXT }}

Based on the operation type, follow these guidelines:
- FIX: Preserve the existing specification completely, just fix implementation issues
- EDIT: Use the existing specification as a base and modify it to incorporate the new features
- REWORK: Create a new specification while considering the context of the existing one

Please create a comprehensive response with BOTH a step-by-step execution plan AND a detailed specification.
Always include all XML tags in your response.

Respond in the following format:

<steps>
1. First step of the plan
2. Second step of the plan
3. ...
</steps>

<specification>
A detailed description of what the charm does, its purpose, and functionality.
Include a clear explanation of how it works and what problems it solves.
For EDIT and REWORK, explain how it builds upon or differs from the existing charm.
</specification>

<data_model>
Describe the key data structures and relationships used in the implementation.
Explain how input data is processed and how output is structured.
For EDIT and REWORK, explain any changes to the existing data model.
</data_model>

{{ SCHEMA_SECTION }}

<references>
Describe how this charm uses any referenced data from other charms.
</references>
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
    system: "You are a helpful AI assistant tasked with classifying user intents for code generation",
    messages: [{ role: "user", content: prompt }],
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
  
  // Schema section is only needed for rework
  const schemaSection = workflowType === "rework"
    ? "<schema>\nJSON schema definition for the data model\n</schema>"
    : "";
  
  const prompt = hydratePrompt(PLAN_GENERATION_PROMPT, {
    INPUT: input,
    WORKFLOW_TYPE: workflowType.toUpperCase(),
    CONTEXT: context,
    SCHEMA_SECTION: schemaSection,
  });

  const response = await client.sendRequest({
    system: "You are a helpful AI assistant tasked with planning code generation workflows",
    messages: [{ role: "user", content: prompt }],
    model: model || "anthropic:claude-3-7-sonnet-latest",
  });

  try {
    // Parse the steps
    const stepsText = parseTagFromResponse(response, "steps");
    const steps = stepsText
      .split(/\d+\.\s+/)
      .filter(step => step.trim().length > 0)
      .map(step => step.trim());
    
    // For the spec, we'll combine all parts into a structured XML document
    // This becomes our full specification that gets saved
    const fullSpec = response; // Keep the entire response with all XML tags
    
    // Get individual components for specific usage
    let specification = "";
    let dataModel = "";
    let schema: JSONSchema | undefined;
    let references = "";
    
    try {
      specification = parseTagFromResponse(response, "specification");
    } catch (e) {
      // Specification might not be available
    }
    
    try {
      dataModel = parseTagFromResponse(response, "data_model");
    } catch (e) {
      // Data model might not be available
    }
    
    try {
      references = parseTagFromResponse(response, "references");
    } catch (e) {
      // References might not be available
    }
    
    // For rework, try to parse the schema
    if (workflowType === "rework") {
      try {
        const schemaJson = parseTagFromResponse(response, "schema");
        schema = JSON.parse(schemaJson);
      } catch (e) {
        // Schema might not be available or valid JSON
      }
    }
    
    // For fix workflow, if we have an existing spec, use that instead
    const updatedSpec = workflowType === "fix" && existingSpec 
      ? existingSpec 
      : fullSpec;
    
    return {
      steps,
      updatedSpec,
      updatedSchema: schema,
    };
  } catch (error) {
    console.error("Error parsing workflow plan response:", error);
    
    // Create a fallback spec that preserves the existing spec for fix/edit
    const fallbackSpec = workflowType === "fix" && existingSpec 
      ? existingSpec 
      : `<steps>
1. Analyze the request
2. Implement the changes
3. Verify the result
</steps>

<specification>
Implementation of "${input}" request
</specification>

<data_model>
Standard data model appropriate for this implementation
</data_model>

<references>
Uses any provided data references as appropriate
</references>`;
    
    return {
      steps: ["Analyze the request", "Implement the changes", "Verify the result"],
      updatedSpec: fallbackSpec,
    };
  }
}