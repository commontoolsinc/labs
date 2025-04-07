/**
 * Workflow module - Contains the core workflow processing pipeline for charm operations
 *
 * This module defines:
 * 1. Workflow types (Fix, Edit, Rework)
 * 2. Classification process
 * 3. Plan generation pipeline
 * 4. Schema and specification generation
 * 5. Workflow steps and execution
 */

import { Cell } from "@commontools/runner";
import { Charm, CharmManager } from "./charm.ts";
import { JSONSchema } from "@commontools/builder";
import { classifyWorkflow, generateWorkflowPlan } from "@commontools/llm";
import { genSrc, iterate } from "./iterate.ts";
import { getIframeRecipe } from "./iframe/recipe.ts";
import { extractUserCode } from "./iframe/static.ts";
import { formatPromptWithMentions } from "./format.ts";
const { castNewRecipe } = await import("./iterate.ts");

// Types for workflow classification
export type WorkflowType = "fix" | "edit" | "rework";

// Configuration for each workflow type
export interface WorkflowConfig {
  name: WorkflowType;
  description: string;
  updateSpec: boolean;
  updateSchema: boolean;
  allowsDataReferences: boolean;
}

export const WORKFLOWS: Record<WorkflowType, WorkflowConfig> = {
  fix: {
    name: "fix",
    description:
      "Fix issues in the code without changing functionality or spec",
    updateSpec: false,
    updateSchema: false,
    allowsDataReferences: true,
  },
  edit: {
    name: "edit",
    description:
      "Update functionality while maintaining the same core data structure",
    updateSpec: true,
    updateSchema: false,
    allowsDataReferences: true,
  },
  rework: {
    name: "rework",
    description: "Create a new charm with a potentially different data schema",
    updateSpec: true,
    updateSchema: true,
    allowsDataReferences: true,
  },
};

/**
 * Results from the intent classification stage
 */
export interface IntentClassificationResult {
  workflowType: WorkflowType;
  confidence: number; // 0-1 confidence score
  reasoning: string;
  enhancedPrompt?: string; // Optional refined prompt based on classification
}

/**
 * The execution plan for a workflow
 */
export interface ExecutionPlan {
  workflowType: WorkflowType;
  steps: string[];
  spec: string;
  schema: JSONSchema;
}

/**
 * Structure representing a successfully parsed mention in a prompt
 */
export interface ParsedMention {
  id: string;
  name: string;
  originalText: string;
  startIndex: number;
  endIndex: number;
  charm: Cell<Charm>;
}

/**
 * Result of processing a prompt with mentions
 */
export interface ProcessedPrompt {
  text: string; // Processed text with mentions replaced by readable names
  mentions: Record<string, Cell<Charm>>; // Map of mention IDs to charm cells
}

/**
 * Step 1: Classify user intent into one of the supported workflows
 *
 * This is the first step in the workflow pipeline. It processes the user
 * input and determines which workflow type best matches their intent.
 *
 * @param input User input text
 * @param currentCharm Current charm context (optional)
 * @param model LLM model to use
 * @param dataReferences Referenced charm data
 * @param charmManager CharmManager for processing mentions
 * @returns Classification result
 */
export async function classifyIntent(
  input: string,
  currentCharm?: Cell<Charm>,
  model?: string,
  dataReferences?: Record<string, Cell<any>>,
  charmManager?: CharmManager,
): Promise<IntentClassificationResult> {
  // Process the input for @mentions if a CharmManager is provided
  // Extract context from the current charm if available
  let existingSpec: string | undefined;
  let existingSchema: JSONSchema | undefined;
  let existingCode: string | undefined;

  if (currentCharm) {
    const iframeRecipe = getIframeRecipe(currentCharm);
    if (iframeRecipe && iframeRecipe.iframe) {
      existingSpec = iframeRecipe.iframe.spec;
      existingSchema = iframeRecipe.iframe.argumentSchema;
      existingCode = extractUserCode(iframeRecipe.iframe.src || "") ||
        undefined;
    }
  }

  try {
    // Check if we have any mentions of other charms (except the current charm)
    // If so, we should automatically classify as "rework" since we need to build
    // a combined schema and create a new argument cell that can access all referenced data
    const hasOtherCharmReferences = dataReferences &&
      Object.keys(dataReferences).filter((key) => key !== "currentCharm")
          .length > 0;

    if (hasOtherCharmReferences) {
      // Auto-classify as rework when referencing other charms
      return {
        workflowType: "rework",
        confidence: 1.0,
        reasoning:
          "Automatically classified as 'rework' because the prompt references other charms. " +
          "When referencing other charms, we need to construct a new argument cell that can " +
          "access data from all references with a combined schema.",
        enhancedPrompt: input,
      };
    }

    const result = await classifyWorkflow(
      input,
      existingSpec,
      existingSchema,
      existingCode,
      model,
    );

    return {
      workflowType: result.workflowType,
      confidence: result.confidence,
      reasoning: result.reasoning,
      enhancedPrompt: result.enhancedPrompt,
    };
  } catch (error) {
    console.error("Error during workflow classification:", error);

    // First check if we have any charm references, as this should force "rework" workflow
    const hasOtherCharmReferences = dataReferences &&
      Object.keys(dataReferences).filter((key) => key !== "currentCharm")
          .length > 0;

    if (hasOtherCharmReferences) {
      return {
        workflowType: "rework",
        confidence: 0.9,
        reasoning:
          "Fallback classification: Input references other charms, which requires rework workflow",
      };
    }

    // If no references, fallback to a simple heuristic based on keywords
    const lowerInput = input.toLowerCase();

    if (
      lowerInput.includes("fix") || lowerInput.includes("bug") ||
      lowerInput.includes("issue")
    ) {
      return {
        workflowType: "fix",
        confidence: 0.7,
        reasoning: "Fallback classification: Input suggests a fix operation",
      };
    } else if (
      lowerInput.includes("edit") || lowerInput.includes("update") ||
      lowerInput.includes("improve") || lowerInput.includes("add")
    ) {
      return {
        workflowType: "edit",
        confidence: 0.6,
        reasoning:
          "Fallback classification: Input suggests enhancing functionality",
      };
    } else {
      return {
        workflowType: "rework",
        confidence: 0.5,
        reasoning: "Fallback classification: Input suggests new functionality",
      };
    }
  }
}

/**
 * Step 2: Generate execution plan for the given intent and workflow
 *
 * This is the second step in the workflow pipeline. Based on the classified
 * workflow type, it generates an execution plan, updated spec, and schema.
 *
 * @param input User input
 * @param workflowType The classified workflow type
 * @param currentCharm Current charm context
 * @param model LLM model to use
 * @param dataReferences Referenced charm data
 * @param charmManager CharmManager for processing mentions
 * @returns Execution plan with steps, spec, and schema
 */
export async function generatePlan(
  input: string,
  workflowType: WorkflowType,
  currentCharm?: Cell<Charm>,
  model?: string,
  dataReferences?: Record<string, Cell<any>>,
  charmManager?: CharmManager,
): Promise<ExecutionPlan> {
  // Extract context from the current charm if available
  let existingSpec: string | undefined;
  let existingSchema: JSONSchema | undefined;
  let existingCode: string | undefined;

  if (currentCharm) {
    const iframeRecipe = getIframeRecipe(currentCharm);
    if (iframeRecipe && iframeRecipe.iframe) {
      existingSpec = iframeRecipe.iframe.spec;
      existingSchema = iframeRecipe.iframe.argumentSchema;
      existingCode = extractUserCode(iframeRecipe.iframe.src || "") ||
        undefined;
    }
  }

  try {
    const result = await generateWorkflowPlan(
      input,
      workflowType,
      existingSpec,
      existingSchema,
      existingCode,
      model,
    );

    return {
      workflowType,
      steps: result.steps,
      spec: result.spec,
      schema: result.schema,
    };
  } catch (error) {
    console.error("Error during plan generation:", error);

    // Fallback to a simple plan if LLM generation fails
    const steps: string[] = [];

    if (workflowType === "fix") {
      steps.push("Analyze existing code to identify the issue");
      steps.push("Implement fix while maintaining current functionality");
      steps.push("Verify the fix doesn't introduce side effects");
    } else if (workflowType === "edit") {
      steps.push("Update specification to reflect new requirements");
      steps.push("Modify code to implement the new functionality");
      steps.push("Ensure backward compatibility with existing data");
    } else { // rework
      steps.push("Generate new specification and schema");
      steps.push("Create new implementation based on requirements");
      steps.push("Link to referenced data from existing charms");
    }

    if (!existingSpec || !existingSchema) {
      throw new Error("must have both spec and schema before proceeding");
    }

    return {
      workflowType,
      steps,
      spec: existingSpec,
      schema: existingSchema,
    };
  }
}

/**
 * The workflow form that contains all the data needed for code generation
 * This is progressively filled in through the workflow process
 */
export interface WorkflowForm {
  // Input information
  input: {
    rawInput: string;
    processedInput: string;
    existingCharm?: Cell<Charm>;
    references: Record<string, Cell<any>>;
  };

  // Classification information
  classification: {
    workflowType: WorkflowType;
    confidence: number;
    reasoning: string;
  };

  // Planning information
  plan: {
    steps: string[];
    spec?: string;
    schema?: JSONSchema;
  };

  // Generation information (only when actually generating code)
  generation?: {
    charm: Cell<Charm>;
  };

  // Metadata and workflow state
  meta: {
    isComplete: boolean;
    isFilled: boolean;
    modelId?: string;
    charmManager?: CharmManager;
  };
}

/**
 * Create a new workflow form with default values
 */
export function createWorkflowForm(rawInput: string): WorkflowForm {
  return {
    input: {
      rawInput,
      processedInput: rawInput, // Initially same as raw input
      references: {},
    },
    classification: {
      workflowType: "edit", // Default type
      confidence: 0,
      reasoning: "",
    },
    plan: {
      steps: [],
    },
    meta: {
      isComplete: false,
      isFilled: false,
    },
  };
}

/**
 * Process the input part of the workflow form
 * Handles mentions, references, and sets up the processedInput
 */
export async function processInputSection(
  charmManager: CharmManager,
  form: WorkflowForm,
  options: {
    existingCharm?: Cell<Charm>;
    dataReferences?: Record<string, Cell<any>>;
  } = {},
): Promise<WorkflowForm> {
  const newForm = { ...form };

  // Skip for empty inputs
  if (!form.input.rawInput || form.input.rawInput.trim().length === 0) {
    newForm.meta.isFilled = true; // Mark as filled since there's nothing to do
    return newForm;
  }

  // Process mentions if CharmManager is provided
  let processedInput = form.input.rawInput;
  let references = { ...form.input.references };

  try {
    const { text, sources } = await formatPromptWithMentions(
      form.input.rawInput,
      charmManager,
    );
    processedInput = text;

    // Merge mentioned charms into references
    for (const [mentionId, charm] of Object.entries(sources)) {
      if (!references[mentionId]) {
        references[mentionId] = charm;
      }
    }
  } catch (error) {
    console.warn("Error processing mentions in form:", error);
  }

  // Add existing charm as a reference if provided
  if (options.existingCharm) {
    references = {
      ...references,
      "currentCharm": options.existingCharm,
    };
    newForm.input.existingCharm = options.existingCharm;
  }

  // Add any additional references
  if (options.dataReferences) {
    for (const [key, value] of Object.entries(options.dataReferences)) {
      if (!references[key]) {
        references[key] = value;
      }
    }
  }

  // Update the form
  newForm.input.processedInput = processedInput;
  newForm.input.references = references;
  newForm.meta.charmManager = charmManager;

  return newForm;
}

/**
 * Fill the classification section of the workflow form
 */
export async function fillClassificationSection(
  form: WorkflowForm,
  options: {} = {},
): Promise<WorkflowForm> {
  const newForm = { ...form };

  // Skip for empty inputs
  if (!form.input.rawInput || form.input.rawInput.trim().length === 0) {
    newForm.classification = {
      workflowType: "edit",
      confidence: 0,
      reasoning: "Empty input",
    };
    return newForm;
  }

  // Check if we have references to other charms that would force rework
  const hasOtherCharmReferences = form.input.references &&
    Object.keys(form.input.references).filter((key) => key !== "currentCharm")
        .length > 0;

  const classification = await classifyIntent(
    form.input.processedInput,
    form.input.existingCharm,
    form.meta.modelId,
    form.input.references,
    form.meta.charmManager,
  );

  // Update classification in the form
  newForm.classification = {
    workflowType: classification.workflowType as WorkflowType,
    confidence: classification.confidence,
    reasoning: classification.reasoning,
  };

  return newForm;
}

/**
 * Fill the planning section of the workflow form
 */
export async function fillPlanningSection(
  form: WorkflowForm,
  options: {} = {},
): Promise<WorkflowForm> {
  const newForm = { ...form };

  // Skip for empty inputs
  if (!form.input.rawInput || form.input.rawInput.trim().length === 0) {
    newForm.plan = {
      steps: [],
    };
    return newForm;
  }

  let planningResult;
  // Generate new plan based on workflow type
  if (
    form.classification.workflowType === "fix" && form.input.existingCharm
  ) {
    // For fix workflow, preserve existing spec
    let existingSpec: string | undefined;

    try {
      const { iframe } = getIframeRecipe(form.input.existingCharm);
      existingSpec = iframe?.spec;
    } catch (error) {
      console.warn("Error getting existing spec for fix workflow:", error);
    }

    // Generate just the plan without updating spec
    const executionPlan = await generatePlan(
      form.input.processedInput,
      form.classification.workflowType,
      form.input.existingCharm,
      form.meta.modelId,
      form.input.references,
      form.meta.charmManager,
    );

    planningResult = {
      steps: executionPlan.steps,
      spec: existingSpec, // Use existing spec for fix workflow
      schema: executionPlan.schema,
    };
  } else {
    // For edit/rework, generate both plan and spec
    const executionPlan = await generatePlan(
      form.input.processedInput,
      form.classification.workflowType,
      form.input.existingCharm,
      form.meta.modelId,
      form.input.references,
      form.meta.charmManager,
    );

    planningResult = {
      steps: executionPlan.steps,
      spec: executionPlan.spec,
      schema: executionPlan.schema,
    };
  }

  // Update planning in the form
  newForm.plan = {
    steps: planningResult.steps || [],
    spec: planningResult.spec,
    schema: planningResult.schema,
  };

  // Mark the form as filled (ready for generation) once we have a plan
  newForm.meta.isFilled = true;

  return newForm;
}

/**
 * Generate code based on a filled workflow form
 * This is the final step that actually creates a charm
 */
export async function generateCode(form: WorkflowForm): Promise<WorkflowForm> {
  const newForm = { ...form };

  // Check if the form is filled properly
  if (!newForm.meta.isFilled) {
    throw new Error("Cannot generate code from an incomplete workflow form");
  }

  if (!newForm.meta.charmManager) {
    throw new Error("CharmManager is required for code generation");
  }

  let charm: Cell<Charm>;

  // Execute the appropriate workflow based on the classification
  switch (form.classification.workflowType) {
    case "fix":
      if (!form.input.existingCharm) {
        throw new Error("Fix workflow requires an existing charm");
      }
      charm = await executeFixWorkflow(
        newForm.meta.charmManager,
        form.input.existingCharm,
        form.input.processedInput,
        form.meta.modelId,
        { steps: form.plan.steps },
        form.plan.spec,
      );
      break;

    case "edit":
      if (!form.input.existingCharm) {
        throw new Error("Edit workflow requires an existing charm");
      }
      charm = await executeEditWorkflow(
        newForm.meta.charmManager,
        form.input.existingCharm,
        form.input.processedInput,
        form.meta.modelId,
        {
          steps: form.plan.steps,
          updatedSpec: form.plan.spec,
        },
      );
      break;

    case "rework":
      charm = await executeReworkWorkflow(
        newForm.meta.charmManager,
        form.input.processedInput,
        {
          steps: form.plan.steps,
          updatedSpec: form.plan.spec,
          updatedSchema: form.plan.schema,
        },
        form.input.references,
        form.input.existingCharm,
      );
      break;

    default:
      throw new Error(
        `Unknown workflow type: ${form.classification.workflowType}`,
      );
  }

  // Update the form with the generated charm
  newForm.generation = {
    charm,
  };

  // Mark the form as complete
  newForm.meta.isComplete = true;

  return newForm;
}

/**
 * Process a workflow request from start to finish or just fill the form
 *
 * @param input The user's input text
 * @param dryRun If true, only fills the form but doesn't generate code
 * @param options Additional options for processing
 * @returns The filled (and possibly completed) workflow form
 */
export async function processWorkflow(
  input: string,
  dryRun: boolean = false,
  options: {
    charmManager?: CharmManager;
    existingCharm?: Cell<Charm>;
    dataReferences?: Record<string, Cell<any>>;
    prefill?: Partial<WorkflowForm>;
    model?: string;
  } = {},
): Promise<WorkflowForm> {
  // Create a new form or use prefilled form
  let form = createWorkflowForm(input);
  if (options.prefill) {
    form = { ...form, ...options.prefill };
  }

  // If using prefill, ensure the raw input is set correctly
  if (options.prefill) {
    form.input.rawInput = input;
  }

  // Step 1: Process input (mentions, references, etc.) if not already processed
  if (
    !form.input.processedInput ||
    form.input.processedInput === form.input.rawInput
  ) {
    if (!options.charmManager) {
      throw new Error("charmManager required to format input");
    }

    form = await processInputSection(options.charmManager, form, {
      existingCharm: options.existingCharm,
      dataReferences: options.dataReferences,
    });
  }

  // Step 2: Classification if not already classified
  if (form.classification.confidence === 0) {
    form = await fillClassificationSection(form, {
      model: options.model,
    });
  }

  // Step 3: Planning if not already planned
  if (!form.plan || !form.plan.steps || form.plan.steps.length === 0) {
    form = await fillPlanningSection(form, {
      preGeneratedPlan: form.plan?.steps && form.plan.steps.length > 0
        ? form.plan.steps
        : undefined,
      preGeneratedSpec: form.plan?.spec,
      preGeneratedSchema: form.plan?.schema,
    });
  }

  // Step 4: Generation (if not a dry run and not already generated)
  if (!dryRun && options.charmManager && !form.generation?.charm) {
    form = await generateCode(form);
  }

  return form;
}

/**
 * Generate a live preview of the spec and plan based on user input
 * Used in the UI to show a real-time preview while the user is typing
 */
export async function generateWorkflowPreview(
  input: string,
  existingCharm?: Cell<Charm>,
  model?: string,
  dataReferences?: Record<string, Cell<any>>,
  charmManager?: CharmManager,
  prefill?: Partial<WorkflowForm>,
): Promise<{
  workflowType: WorkflowType;
  confidence: number;
  plan: string[];
  spec?: string;
  updatedSchema?: JSONSchema;
  reasoning?: string;
  processedInput?: string;
  mentionedCharms?: Record<string, Cell<Charm>>;
}> {
  // Process the workflow but with dryRun=true to fill the form without generating code
  const form = await processWorkflow(input, true, {
    charmManager,
    existingCharm,
    dataReferences,
    prefill,
    model,
  });

  // Extract mentioned charms from references (any reference that's not currentCharm)
  const mentionedCharms: Record<string, Cell<Charm>> = {};
  for (const [key, value] of Object.entries(form.input.references)) {
    if (key !== "currentCharm") {
      mentionedCharms[key] = value as Cell<Charm>;
    }
  }

  // Return the preview format expected by the UI
  return {
    workflowType: form.classification.workflowType,
    confidence: form.classification.confidence,
    plan: form.plan.steps,
    spec: form.plan.spec,
    updatedSchema: form.plan.schema,
    reasoning: form.classification.reasoning,
    processedInput: form.input.processedInput,
    mentionedCharms,
  };
}

/**
 * Format a spec to include user prompt and execution plan
 * This ensures the full context is preserved in the recipe
 */
export function formatSpecWithPlanAndPrompt(
  originalSpec: string,
  userPrompt: string,
  plan: string[] | string,
): string {
  // Format the plan as a string if it's an array
  const planText = Array.isArray(plan) ? plan.join("\n- ") : plan;

  // Create a formatted spec with XML tags to separate sections
  return `<ORIGINAL_SPEC>
${originalSpec}
</ORIGINAL_SPEC>

<USER_PROMPT>
${userPrompt}
</USER_PROMPT>

<EXECUTION_PLAN>
- ${planText}
</EXECUTION_PLAN>`;
}

/**
 * Execute the Fix workflow
 *
 * The Fix workflow preserves the existing specification and schema,
 * focusing only on fixing issues in the implementation.
 */
export async function executeFixWorkflow(
  charmManager: CharmManager,
  currentCharm: Cell<Charm>,
  input: string,
  model?: string,
  executionPlan?: { steps: string[] },
  existingSpec?: string,
): Promise<Cell<Charm>> {
  console.log("Executing FIX workflow");

  // For the fix workflow, we always preserve the existing spec
  if (!existingSpec) {
    const { iframe } = getIframeRecipe(currentCharm);
    existingSpec = iframe?.spec;
  }

  // Pass the execution plan steps if available
  const planSteps = executionPlan?.steps;

  // Call iterate with the existing spec to ensure it's preserved
  return iterate(
    charmManager,
    currentCharm,
    input,
    false,
    model,
    existingSpec,
    planSteps,
  );
}

/**
 * Execute the Edit workflow
 *
 * The Edit workflow builds upon the existing specification but retains
 * the existing schema, modifying the implementation to add features
 * or enhance functionality while maintaining compatibility.
 */
export async function executeEditWorkflow(
  charmManager: CharmManager,
  currentCharm: Cell<Charm>,
  input: string,
  model?: string,
  executionPlan?: { steps: string[]; updatedSpec?: string },
): Promise<Cell<Charm>> {
  console.log("Executing EDIT workflow");

  // For edit workflow, we use the updated spec but pass shiftKey as true
  // to ensure it preserves compatibility with existing data
  return iterate(
    charmManager,
    currentCharm,
    input,
    true,
    model,
    executionPlan?.updatedSpec,
    executionPlan?.steps,
  );
}

/**
 * Helper function to convert a string to camelCase
 */
function toCamelCase(input: string): string {
  // Handle empty string case
  if (!input) return "currentCharm";

  // Split the input string by non-alphanumeric characters
  return input
    .split(/[^a-zA-Z0-9]/)
    .filter((word) => word.length > 0) // Remove empty strings
    .map((word, index) => {
      // First word should be all lowercase
      if (index === 0) {
        return word.toLowerCase();
      }
      // Other words should have their first letter capitalized and the rest lowercase
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join("");
}

/**
 * Execute the Rework workflow
 *
 * The Rework workflow creates a new charm with potentially different
 * schema, allowing for more significant changes or combinations of
 * data from multiple existing charms.
 */
export async function executeReworkWorkflow(
  charmManager: CharmManager,
  input: string,
  executionPlan: {
    steps: string[];
    updatedSpec?: string;
    updatedSchema?: JSONSchema;
  },
  dataReferences?: Record<string, Cell<any>>,
  currentCharm?: Cell<Charm>,
): Promise<Cell<Charm>> {
  console.log("Executing REWORK workflow");

  // Process references - this allows the new charm to access data from multiple sources
  let allReferences: Record<string, Cell<any>> = {};

  // Add all external references first with validation
  if (dataReferences && Object.keys(dataReferences).length > 0) {
    for (const [id, cell] of Object.entries(dataReferences)) {
      if (id === "currentCharm") continue;

      if (
        !cell || typeof cell !== "object" || !("get" in cell) ||
        typeof cell.get !== "function"
      ) {
        console.warn(`Reference "${id}" is not a valid cell, skipping`);
        continue;
      }

      try {
        // Create a valid camelCase identifier
        const cellData = cell.get();
        const charmName = cellData && cellData["NAME"] ? cellData["NAME"] : id;
        const camelCaseId = toCamelCase(charmName);

        // Make sure the ID is unique
        let uniqueId = camelCaseId;
        let counter = 1;
        while (uniqueId in allReferences) {
          uniqueId = `${camelCaseId}${counter++}`;
        }

        allReferences[uniqueId] = cell;
        console.log(`Added reference "${id}" as "${uniqueId}"`);
      } catch (error) {
        console.error(`Error processing reference "${id}":`, error);
      }
    }
  }

  // Add current charm if available
  if (
    currentCharm && typeof currentCharm === "object" && "get" in currentCharm &&
    typeof currentCharm.get === "function"
  ) {
    try {
      const charmData = currentCharm.get();
      const charmName = charmData && charmData["NAME"]
        ? charmData["NAME"]
        : "currentCharm";
      const camelCaseId = toCamelCase(charmName);

      // Make sure the ID is unique
      let uniqueId = camelCaseId;
      let counter = 1;
      while (uniqueId in allReferences) {
        uniqueId = `${camelCaseId}${counter++}`;
      }

      allReferences[uniqueId] = currentCharm;
      console.log(`Added current charm as "${uniqueId}"`);

      // Remove any generic "currentCharm" entry
      if (allReferences["currentCharm"]) {
        delete allReferences["currentCharm"];
      }
    } catch (error) {
      console.error(`Error processing current charm:`, error);
    }
  }

  // Format the spec to include plan and prompt
  let formattedSpec = executionPlan.updatedSpec;
  if (executionPlan.updatedSpec && executionPlan.steps) {
    formattedSpec = formatSpecWithPlanAndPrompt(
      executionPlan.updatedSpec,
      input,
      executionPlan.steps,
    );
  }

  // TODO(bf): update spec of recipe?

  // Cast a new recipe with references, spec, and schema
  return castNewRecipe(
    charmManager,
    input,
    allReferences,
  );
}

/**
 * Main entry point for all workflow processing
 *
 * This function orchestrates the entire workflow process:
 * 1. Input processing and mention detection
 * 2. Classification (if not overridden)
 * 3. Plan generation
 * 4. Code generation
 */
export async function executeWorkflow(
  charmManager: CharmManager,
  input: string,
  context: {
    currentCharm?: Cell<Charm>;
    dataReferences?: Record<string, Cell<any>>;
    prefill?: Partial<WorkflowForm>;
    model?: string;
  },
): Promise<Cell<Charm>> {
  // Process the workflow with dryRun=false to fully execute and generate code
  const form = await processWorkflow(input, false, {
    charmManager,
    existingCharm: context.currentCharm,
    dataReferences: context.dataReferences,
    model: context.model,
    prefill: context.prefill,
  });

  // A completed form should have a generated charm
  if (!form.generation?.charm) {
    throw new Error("Workflow execution failed to create a charm");
  }

  return form.generation.charm;
}
