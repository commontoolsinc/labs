import {
  hydratePrompt,
  parseTagFromResponse,
  parseTagListFromResponse,
} from "./prompting.ts";
import { LLMClient } from "../client.ts";
import type { JSONSchema } from "../../../builder/src/index.ts";
import { WorkflowForm, WorkflowType } from "../../../charm/src/index.ts";
import { llmPrompt } from "../index.ts";
import { DEFAULT_MODEL_NAME } from "../types.ts";

/**
 * Basic prompt for classifying user intent into a workflow type
 */
export const WORKFLOW_CLASSIFICATION_PROMPT = llmPrompt(
  "workflow-classification",
  `
You are analyzing a user's request to determine the most appropriate workflow for code generation.
Based on the user's request, classify it into one of the following workflows:

{{WORKFLOWS}}

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

export const AUTOCOMPLETE_INTENT_PROMPT = llmPrompt(
  "autocomplete-intent",
  `
  This is Common Tools. Our system uses the concept of a \`Charm\`, a bundle of data + UI + functionality that can be composed, remixed and reused. Charms are smaller than apps, closer to a screen or panel of a web app, but can be networked together into complex systems. Charms communicate using a reactive graph database, any changes to referenced data automatically propagate. The 'behavior' of a Charm is defined by a Recipe, a data flow graph where the nodes are functions.

  Users will come to you with intentions, requests and vague ideas of their needs. Your task is to 'autocomplete' their thought, using your knowledge of the Common Tools system.

  Your Capabilities:

  1. generate a charm
      - generate a spec, implementation plan and code for a charm that meets the user's requirements
  2. search for and cast existing spells from the spellbook
      - a spell can be 'cast' on an existing charm to change its behavior, but re-use the data
  3. connect referenced data to a new charm
      - multiple charms can be
  4. edit an existing charm
      - code and schema can be modified independently
      - the user may ask you to fix bugs, add features or tweak the overall concept slightly
  5. navigate to an existing charm
      - sometimes, the user will ask for something that already exists, and you should be able to find it quickly

  Generate an 'autocompletion' of the user's request, in terms of the system capabilities. No dot points. Work with the user's voice, do not say 'I' or 'me'. It's a joint project with the user.
  Do not generate code or plan the project. e.g. "I need to buy groceries" -> "Make a 🛒 grocery list and determine 📍 where to buy everything". "Emails from my boss" -> "Find 📧 emails from a particular sender 👩‍💼 (boss)". "Plan a party" -> "Create an 💃 event charm with a 📋 guest list, 🗺️ location, date, time and 👩‍🎤 theme."
  Return your just the autocompletion between <autocomplete></autocomplete> tags.

  User's request: ({{WORKFLOW_TYPE}}) "{{ INPUT }}"`,
);

/**
 * Prompt for generating an execution plan with comprehensive specification
 */
export const PLAN_GENERATION_PROMPT = llmPrompt(
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
 * Classifies the workflow type based on user prompt and optional existing code context.
 *
 * @param input The user's input prompt.
 * @param options Configuration options for the classification process.
 * @returns A promise resolving to an object containing the classified workflow type and confidence score.
 * @throws Error if the classified workflow type is not in the permitted workflows list
 */
export async function classifyWorkflow(
  form: WorkflowForm,
  options?: {
    existingSpec?: string;
    existingSchema?: JSONSchema;
    existingCode?: string;
  },
): Promise<{
  workflowType: WorkflowType;
  confidence: number;
  reasoning: string;
  enhancedPrompt?: string;
}> {
  const {
    existingSpec,
    existingSchema,
    existingCode,
  } = options || {};

  const context = generateCharmContext(
    existingSpec,
    existingSchema,
    existingCode,
  );

  // Build workflows description, filtering to only include permitted workflows if specified
  let workflowsDescription = "";
  // Define workflow descriptions once to avoid repetition
  const workflowDescriptions: Partial<Record<WorkflowType, string>> = {
    edit:
      `\`edit\`: Add features or modify functionality while preserving core data structure
   - Example: "Add dark mode support" or "Include a search feature"
   - Modifies code and specification, but preserves core schema structure`,

    imagine:
      `\`imagine\`: Create something new, potentially combining multiple data sources
   - Example: "Create a dashboard combining my tasks and calendar"
   - Creates new code, specification, and potentially new schema`,

    "cast-spell":
      `\`cast-spell\`: Find a spell from the spellbook that fits the user's needs and can be used on their mentioned data
   - Example: "Find a spell to optimize my code for performance"`,
    //  'fix': `\`fix\`: Repair existing functionality without changing core behavior
    // - Example: "Fix the bug in my sorting function"
    // - Preserves specification and schema exactly as-is`,

    //  'imagine-single-phase': `\`imagine-single-phase\`: Create something new in a single phase
    // - Example: "Create a simple todo list"
    // - Creates new code, specification, and schema in one step`
  };

  if (form.meta.permittedWorkflows && form.meta.permittedWorkflows.length > 0) {
    // Only include permitted workflows in the prompt
    workflowsDescription = form.meta.permittedWorkflows
      .map((type, index) => `${index + 1}. ${workflowDescriptions[type]}`)
      .filter(Boolean)
      .join("\n\n");
  } else {
    // Include all workflows if no restrictions
    workflowsDescription = Object.entries(workflowDescriptions)
      .map(([_, desc], index) => `${index + 1}. ${desc}`)
      .join("\n\n");
  }

  const prompt = hydratePrompt(WORKFLOW_CLASSIFICATION_PROMPT, {
    INPUT: form.input.processedInput,
    CONTEXT: context,
    WORKFLOWS: workflowsDescription,
  });

  const systemPrompt = llmPrompt(
    "classify-system",
    "You are a helpful AI assistant tasked with classifying user intents for code generation",
  );

  const response = await new LLMClient().sendRequest({
    system: systemPrompt.text,
    messages: [{ role: "user", content: prompt.text }],
    model: form.meta.model ?? DEFAULT_MODEL_NAME,
    cache: form.meta.cache,
    metadata: {
      context: "workflow",
      workflow: "classification",
      generationId: form.meta.generationId,
      systemPrompt: systemPrompt.version,
      userPrompt: prompt.version,
      space: form.meta.charmManager.getSpaceName(),
    },
  });

  try {
    const workflow = parseTagFromResponse(response.content, "workflow")
      .toLowerCase() as WorkflowType;
    const confidence = parseFloat(
      parseTagFromResponse(response.content, "confidence"),
    );
    const reasoning = parseTagFromResponse(response.content, "reasoning");

    let enhancedPrompt: string | undefined;
    try {
      enhancedPrompt = parseTagFromResponse(
        response.content,
        "enhanced_prompt",
      );
    } catch (e) {
      // Enhanced prompt is optional
    }

    // Validate that the classified workflow is in the permitted workflows list
    if (
      form.meta.permittedWorkflows && form.meta.permittedWorkflows.length > 0
    ) {
      if (!form.meta.permittedWorkflows.includes(workflow)) {
        throw new Error(
          `Workflow type '${workflow}' is not permitted. Allowed workflows: ${
            form.meta.permittedWorkflows.join(", ")
          }`,
        );
      }
    }

    return {
      workflowType: workflow,
      confidence: isNaN(confidence) ? 0.5 : confidence,
      reasoning,
      enhancedPrompt,
    };
  } catch (error) {
    console.error("Error parsing workflow classification response:", error);

    // If we have permitted workflows, we should use the first one as default
    // instead of hardcoding "edit" as the fallback
    if (
      form.meta.permittedWorkflows && form.meta.permittedWorkflows.length > 0
    ) {
      return {
        workflowType: form.meta.permittedWorkflows[0],
        confidence: 0.5,
        reasoning: "Default classification due to parsing error",
      };
    }

    // Default to "edit" if parsing fails and no permitted workflows are specified
    return {
      workflowType: "edit",
      confidence: 0.5,
      reasoning: "Default classification due to parsing error",
    };
  }
}

/**
 * Generates an execution plan for a workflow
 *
 * @param input The user's input prompt.
 * @param workflowType The type of workflow to generate a plan for.
 * @param existingSpec Optional existing specification for context.
 * @param existingSchema Optional existing schema for context.
 * @param existingCode Optional existing code snippet for context.
 * @param model Optional specific LLM model to use.
 * @param generationId Optional identifier for the generation process.
 * @param cache Optional flag to enable/disable LLM cache.
 * @returns A promise resolving to an object containing the generation steps and schema specification.
 */
export async function generateWorkflowPlan(
  form: WorkflowForm,
  options?: {
    existingSpec?: string;
    existingSchema?: JSONSchema;
    existingCode?: string;
  },
): Promise<{
  autocompletion: string;
  features: string[];
}> {
  const context = generateCharmContext(
    options?.existingSpec,
    options?.existingSchema,
    options?.existingCode,
  );

  if (!form.classification) {
    throw new Error("Workflow classification is required");
  }

  const system = hydratePrompt(AUTOCOMPLETE_INTENT_PROMPT, {
    WORKFLOW_TYPE: form.classification.workflowType.toUpperCase(),
    CONTEXT: context,
  });

  const response = await new LLMClient().sendRequest({
    system: system.text,
    messages: [{ role: "user", content: form.input.processedInput }],
    model: form.meta.model ?? DEFAULT_MODEL_NAME,
    cache: form.meta.cache,
    metadata: {
      context: "workflow",
      workflow: form.classification.workflowType.toLowerCase(),
      generationId: form.meta.generationId,
      space: form.meta.charmManager.getSpaceName(),
      systemPrompt: system.version,
    },
  });

  try {
    let autocompletion = "";
    let features: string[] = [];

    try {
      autocompletion = parseTagFromResponse(response.content, "autocomplete");
    } catch (e) {
      // Specification might not be available
    }

    try {
      const body = parseTagFromResponse(response.content, "features");
      features = parseTagListFromResponse(body, "feature");
    } catch (e) {
      // Specification might not be available
    }

    return { autocompletion, features };
  } catch (error) {
    console.error(error);
    throw new Error("Error parsing workflow plan response:");
  }
}
