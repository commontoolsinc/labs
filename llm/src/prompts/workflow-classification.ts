import { hydratePrompt, parseTagFromResponse } from "./prompting.ts";
import { client } from "../client.ts";
import type { JSONSchema } from "@commontools/builder";
import { WorkflowType } from "@commontools/charm";
import { llmPrompt } from "../index.ts";

/**
 * Basic prompt for classifying user intent into a workflow type
 */
export const WORKFLOW_CLASSIFICATION_PROMPT = await llmPrompt(
  "workflow-classification",
  `
You are analyzing a user's request to determine the most appropriate workflow for code generation.
Based on the user's request, classify it into one of the following workflows:

1. FIX: Correct issues in the code without changing functionality or specification
   - Example: "Fix the alignment of buttons" or "Correct the calculation bug"
   - Only modifies code, not the specification or schema

2. EDIT: Add features or modify functionality while preserving core data structure
   - Example: "Add dark mode support" or "Include a search feature"
   - Modifies code and specification, but preserves core schema structure

3. IMAGINE: Create something new, potentially combining multiple data sources
   - Example: "Create a dashboard combining my tasks and calendar"
   - Creates new code, specification, and potentially new schema

User's request: "{{ INPUT }}"

Current Charm Context:
{{ CONTEXT }}

Please analyze this request and respond in the following format:

<workflow>FIX|EDIT|IMAGINE</workflow>
<confidence>0.0-1.0</confidence>
<reasoning>Brief explanation of your classification</reasoning>
<enhanced_prompt>Optional improved or clarified version of the user's request</enhanced_prompt>
`,
);

/**
 * Prompt for generating an execution plan with comprehensive specification
 */
export const PLAN_GENERATION_PROMPT = await llmPrompt(
  "plan-generation",
  `
You are creating a brief execution plan and specification for a tool to fulfill a user's intent.
The user's request has been classified as a {{ WORKFLOW_TYPE }} operation.

User's request: "{{ INPUT }}"

<current-charm-context>
{{ CONTEXT }}
</current-charm-context>

Based on the workflow type, follow these guidelines:

- FIX workflow:
  * PURPOSE: Fix bugs without changing functionality
  * SPEC: Keep existing specification exactly as-is
  * SCHEMA: No schema changes needed
  * CODE: Focus solely on fixing the implementation

- EDIT workflow:
  * PURPOSE: Enhance functionality within existing data structure
  * SPEC: Build upon the existing specification
  * SCHEMA: Can add properties but never remove existing ones
  * CODE: Modify implementation while maintaining backward compatibility

- IMAGINE workflow:
  * PURPOSE: Create new functionality, possibly using existing charms as sources
  * SPEC: Write a fresh specification, possibly referencing existing ones
  * SCHEMA: Will receive combined input schema, generate output schemas
  * CODE: Create a new implementation that may use data from other charms

Please create a medium-detail plan with BOTH a step-by-step execution plan AND a clear specification.
Always include all XML tags in your response and ensure JSON schemas are correctly formatted.

Respond in the following format:

(include ~5 steps)
<steps>
1. First step of the plan
2. Second step of the plan
3. ...
</steps>

(include ~1 paragraph)
<specification>
A clear description of what the charm does, its purpose, and functionality.
Include a clear explanation of how it works and what problems it solves.
For EDIT and IMAGINE, explain how it builds upon or differs from the existing charm.
</specification>

<data_model>
List key actions and the data types they affect.
e.g add(title, description) -> TodoItem(title, description, completed)
edit(item: TodoItem, { description, title, completed }) -> TodoItem(title, description, completed)
delete(item: TodoItem) -> void

Include how this charm uses any referenced data.
</data_model>

DO NOT GENERATE A SCHEMA.
`,
);

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
    // Provide more detailed schema context with clear labeling
    context +=
      `\nExisting Schema (IMPORTANT - preserve this structure):\n\`\`\`json\n${
        JSON.stringify(existingSchema, null, 2)
      }\n\`\`\`\n`;

    // Add explicit guidance on handling the existing schema
    context += `\nSchema Handling Guidelines:
- For FIX workflows: This schema must be preserved exactly as-is
- For EDIT workflows: Keep this basic structure, but you may add new properties
- For IMAGINE workflows: Use this as reference, but you can create a new schema structure\n`;
  }

  if (existingCode) {
    context += `\nExisting Code (excerpt):\n\`\`\`javascript\n${
      existingCode.substring(0, 500)
    }${existingCode.length > 500 ? "..." : ""}\n\`\`\`\n`;
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
  generationId?: string,
): Promise<{
  workflowType: WorkflowType;
  confidence: number;
  reasoning: string;
  enhancedPrompt?: string;
}> {
  const context = generateCharmContext(
    existingSpec,
    existingSchema,
    existingCode,
  );

  const prompt = hydratePrompt(WORKFLOW_CLASSIFICATION_PROMPT, {
    INPUT: input,
    CONTEXT: context,
  });

  const systemPrompt = await llmPrompt(
    "classify-system",
    "You are a helpful AI assistant tasked with classifying user intents for code generation",
  );

  const response = await client.sendRequest({
    system: systemPrompt.text,
    messages: [{ role: "user", content: prompt.text }],
    model: model || "anthropic:claude-3-7-sonnet-latest",
    metadata: {
      context: "workflow",
      workflow: "classification",
      generationId,
      systemPrompt: systemPrompt.version,
      userPrompt: prompt.version,
    },
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
      workflowType: workflow as WorkflowType,
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
 * Helper function to clean JSON strings from LLM responses
 * Handles markdown code blocks and other common issues
 */
function cleanJsonString(jsonStr: string): string {
  // Strip markdown code blocks if present
  let cleaned = jsonStr.trim();

  // Remove markdown code block markers
  const codeBlockRegex = /^```(?:json)?\s*([\s\S]*?)```$/;
  const match = cleaned.match(codeBlockRegex);
  if (match) {
    cleaned = match[1].trim();
    console.log("Removed markdown code block markers");
  }

  // Check and fix common JSON issues
  // Sometimes LLM adds explanatory text before or after the JSON
  try {
    // Try to find the start of a JSON object or array
    const jsonStartRegex = /(\{|\[)/;
    const jsonStart = cleaned.search(jsonStartRegex);
    if (jsonStart > 0) {
      // There's text before the JSON starts
      cleaned = cleaned.substring(jsonStart);
      console.log("Trimmed text before JSON starts");
    }

    // Try to find the end of a JSON object or array
    const lastBrace = Math.max(
      cleaned.lastIndexOf("}"),
      cleaned.lastIndexOf("]"),
    );
    if (lastBrace > 0 && lastBrace < cleaned.length - 1) {
      // There's text after the JSON ends
      cleaned = cleaned.substring(0, lastBrace + 1);
      console.log("Trimmed text after JSON ends");
    }

    // Validate JSON by parsing it
    JSON.parse(cleaned);
  } catch (e) {
    console.warn(
      "Could not automatically fix JSON, returning cleaned string as-is",
    );
  }

  return cleaned;
}

/**
 * Generates an execution plan for a workflow
 */
export async function generateWorkflowPlan(
  input: string,
  workflowType: WorkflowType,
  existingSpec?: string,
  existingSchema?: JSONSchema,
  existingCode?: string,
  model?: string,
  generationId?: string,
): Promise<{
  steps: string[];
  spec: string;
  dataModel: string;
}> {
  const context = generateCharmContext(
    existingSpec,
    existingSchema,
    existingCode,
  );

  const prompt = hydratePrompt(PLAN_GENERATION_PROMPT, {
    INPUT: input,
    WORKFLOW_TYPE: workflowType.toUpperCase(),
    CONTEXT: context,
  });

  const systemPrompt = await llmPrompt(
    "plan-generation-system",
    "You are a helpful AI assistant tasked with planning code generation workflows",
  );

  const response = await client.sendRequest({
    system: systemPrompt.text,
    messages: [{ role: "user", content: prompt.text }],
    model: model || "anthropic:claude-3-7-sonnet-latest",
    metadata: {
      context: "workflow",
      workflow: workflowType.toLowerCase(),
      generationId,
      systemPrompt: systemPrompt.version,
      userPrompt: prompt.version,
    },
  });

  try {
    // Parse the steps
    const stepsText = parseTagFromResponse(response, "steps");
    const steps = stepsText
      .split(/\d+\.\s+/)
      .filter((step) => step.trim().length > 0)
      .map((step) => step.trim());

    // Get individual components for specific usage
    let specification = "";
    let dataModel = "";
    let schema: JSONSchema | undefined;
    const references = "";

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

    // For fix workflow, if we have an existing spec, use that instead
    const updatedSpec = workflowType === "fix" && existingSpec
      ? existingSpec
      : specification;

    return {
      steps,
      spec: updatedSpec,
      dataModel,
    };
  } catch (error) {
    console.error(error);
    throw new Error("Error parsing workflow plan response:");
  }
}
