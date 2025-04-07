import { hydratePrompt, parseTagFromResponse } from "./prompting.ts";
import { client } from "../client.ts";
import type { JSONSchema } from "@commontools/builder";
import { WorkflowType } from '@commontools/charm';

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

For IMAGINE workflows you MUST include both <result_schema> tags with valid JSON schemas.
Each schema must be a JSON object with "type": "object" and must include a "properties" object with property definitions.

Example schema format:
\`\`\`json
{
  "type": "object",
  "title": "Task Schema",
  "description": "Schema for task data",
  "properties": {
    "title": {
      "type": "string",
      "title": "Task Title",
      "description": "The title of the task",
      "default": "New Task"
    },
    "dueDate": {
      "type": "string",
      "format": "date",
      "title": "Due Date",
      "description": "When the task is due"
    },
    "completed": {
      "type": "boolean",
      "title": "Completed",
      "description": "Whether the task is completed",
      "default": false
    }
  },
  "required": ["title"]
}
\`\`\`

When writing schemas:
- Focus on essential properties (3-7 max)
- Include title, description, and sensible defaults
- Mark required properties in the "required" array
- Use proper JSON Schema format as shown in the examples
- Think about data flow and how properties will be used in the implementation

Please create a comprehensive response with BOTH a step-by-step execution plan AND a detailed specification.
Always include all XML tags in your response and ensure JSON schemas are correctly formatted.

Respond in the following format:

<steps>
1. First step of the plan
2. Second step of the plan
3. ...
</steps>

<specification>
A detailed description of what the charm does, its purpose, and functionality.
Include a clear explanation of how it works and what problems it solves.
For EDIT and IMAGINE, explain how it builds upon or differs from the existing charm.
</specification>

<data_model>
Describe the key data structures and relationships used in the implementation.
Explain how input data is processed and how output is structured.
For EDIT and IMAGINE, explain any changes to the existing data model.
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

  const response = await client.sendRequest({
    system:
      "You are a helpful AI assistant tasked with classifying user intents for code generation",
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
): Promise<{
  steps: string[];
  spec: string;
  schema: JSONSchema;
}> {
  const context = generateCharmContext(
    existingSpec,
    existingSchema,
    existingCode,
  );

  // Schema section only for rework workflow
  const schemaSection = workflowType === "imagine"
    ? `<argument_schema>
// Define the schema for input data
{
  "type": "object",
  "title": "Input Schema",
  "description": "Data required by this charm",
  "properties": {
    // Add 3-7 properties that represent the input data
    // Each property should have a type, title, and description
  },
  "required": []
}
</argument_schema>

<result_schema>
// Define the schema for output data
{
  "type": "object",
  "title": "Result Schema",
  "description": "Data returned by this charm",
  "properties": {
    // Add 3-7 properties that represent the output data
    // Each property should have a type, title, and description
  }
}
</result_schema>

SCHEMA GUIDELINES:
1. Keep schemas minimal:
   - Include only essential fields (3-7 properties max)
   - Focus on the core functionality
   - If user requested complex features, simplify for this first version

2. Each property should have:
   - A descriptive "title" field
   - A brief "description" field
   - A sensible default value where appropriate

3. Schemas must be valid JSON with:
   - "type": "object" at the top level
   - A "properties" object containing property definitions
   - Required properties listed in the "required" array`
    : "";

  const prompt = hydratePrompt(PLAN_GENERATION_PROMPT, {
    INPUT: input,
    WORKFLOW_TYPE: workflowType.toUpperCase(),
    CONTEXT: context,
    SCHEMA_SECTION: schemaSection,
  });

  const response = await client.sendRequest({
    system:
      "You are a helpful AI assistant tasked with planning code generation workflows",
    messages: [{ role: "user", content: prompt }],
    model: model || "anthropic:claude-3-7-sonnet-latest",
  });

  try {
    // Parse the steps
    const stepsText = parseTagFromResponse(response, "steps");
    const steps = stepsText
      .split(/\d+\.\s+/)
      .filter((step) => step.trim().length > 0)
      .map((step) => step.trim());

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

    // For rework workflows, extract both argument and result schemas
    if (workflowType === "imagine") {
      try {
        // Get argument and result schemas from the response
        const argumentSchemaJson = parseTagFromResponse(
          response,
          "argument_schema",
        );
        const resultSchemaJson = parseTagFromResponse(
          response,
          "result_schema",
        );

        // Validate both schemas exist
        if (!argumentSchemaJson || !resultSchemaJson) {
          throw new Error(
            "Missing schema tags in LLM response for imagine workflow",
          );
        }

        // Parse and validate argument schema
        const cleanArgumentJson = cleanJsonString(argumentSchemaJson);
        const argumentSchema = JSON.parse(cleanArgumentJson);

        if (argumentSchema.type !== "object" || !argumentSchema.properties) {
          throw new Error("Invalid argument schema structure");
        }

        // Parse and validate result schema
        const cleanResultJson = cleanJsonString(resultSchemaJson);
        const resultSchema = JSON.parse(cleanResultJson);

        if (resultSchema.type !== "object" || !resultSchema.properties) {
          throw new Error("Invalid result schema structure");
        }

        // Use argument schema as primary and attach result schema for downstream use
        schema = argumentSchema;
        (schema as any).resultSchema = resultSchema;
      } catch (e) {
        console.error("Schema extraction failed:", e);
        throw e; // Re-throw to ensure the client knows we failed
      }
    }

    // For fix workflow, if we have an existing spec, use that instead
    const updatedSpec = workflowType === "fix" && existingSpec
      ? existingSpec
      : fullSpec;

    const updatedSchema = workflowType !== "imagine" && existingSchema
      ? existingSchema
      : schema;

    if (!updatedSchema) {
      throw new Error("we need a schema");
    }

    return {
      steps,
      spec: updatedSpec,
      schema: updatedSchema,
    };
  } catch (error) {
    console.error(error);
    throw new Error("Error parsing workflow plan response:");
  }
}
