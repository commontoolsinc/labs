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
import { iterate } from "./iterate.ts";
import { getIframeRecipe } from "./iframe/recipe.ts";
import { extractUserCode } from "./iframe/static.ts";
import { formatPromptWithMentions } from "./format.ts";
import { castNewRecipe } from "./iterate.ts";

// Types for workflow classification
export type WorkflowType =
  | "fix"
  | "edit"
  | "imagine"
  | "imagine-single-phase";

// Configuration for each workflow type
export interface WorkflowConfig {
  name: WorkflowType;
  label: string;
  description: string;
  updateSpec: boolean;
  updateSchema: boolean;
  allowsDataReferences: boolean;
}

export const WORKFLOWS: Record<WorkflowType, WorkflowConfig> = {
  fix: {
    name: "fix",
    label: "FIX",
    description:
      "Fix issues in the code without changing functionality or spec",
    updateSpec: false,
    updateSchema: false,
    allowsDataReferences: false,
  },
  edit: {
    name: "edit",
    label: "EDIT",
    description:
      "Update functionality while maintaining the same core data structure",
    updateSpec: true,
    updateSchema: false,
    allowsDataReferences: false,
  },
  imagine: {
    name: "imagine",
    label: "IMAGINE",
    description: "Create a new charm with a potentially different data schema",
    updateSpec: true,
    updateSchema: true,
    allowsDataReferences: true,
  },
  "imagine-single-phase": {
    name: "imagine-single-phase",
    label: "IMAGINE (SINGLE PHASE)",
    description: "IN DEVELOPMENT",
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
  dataModel: string;
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
 * @param references Referenced charm data
 * @param generationId Optional ID for tracking generation
 * @param cache Optional flag to enable/disable LLM cache
 * @returns Classification result
 */
export async function classifyIntent(
  input: string,
  currentCharm?: Cell<Charm>,
  model?: string,
  references?: Record<string, Cell<any>>,
  generationId?: string,
  cache = true,
): Promise<IntentClassificationResult> {
  // Process the input for @mentions if a CharmManager is provided
  // Extract context from the current charm if available
  let existingSpec: string | undefined;
  let existingSchema: JSONSchema | undefined;
  let existingCode: string | undefined;

  if (currentCharm) {
    const { spec, schema, code } = extractContext(currentCharm);
    existingSpec = spec;
    existingSchema = schema;
    existingCode = code;
  }

  if (!existingSpec || !existingSchema) {
    return {
      workflowType: "imagine",
      confidence: 1.0,
      reasoning:
        "Automatically classified as 'imagine' because there is nothing to refer to (either no current charm or no iframe recipe).",
      enhancedPrompt: input,
    };
  }

  // Check if we have any mentions of other charms (except the current charm)
  // If so, we should automatically classify as "rework" since we need to build
  // a combined schema and create a new argument cell that can access all referenced data
  const hasOtherCharmReferences = references &&
    Object.keys(references).filter((key) => key !== "currentCharm")
        .length > 0;

  if (hasOtherCharmReferences) {
    // Auto-classify as rework when referencing other charms
    return {
      workflowType: "imagine",
      confidence: 1.0,
      reasoning:
        "Automatically classified as 'imagine' because the prompt references other charms. " +
        "When referencing other charms, we need to construct a new argument cell that can " +
        "access data from all references with a combined schema.",
      enhancedPrompt: input,
    };
  }

  try {
    const result = await classifyWorkflow(
      input,
      existingSpec,
      existingSchema,
      existingCode,
      model,
      generationId,
      cache,
    );

    return {
      workflowType: result.workflowType,
      confidence: result.confidence,
      reasoning: result.reasoning,
      enhancedPrompt: result.enhancedPrompt,
    };
  } catch (error) {
    console.error("Error during workflow classification:", error);

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
        workflowType: "imagine",
        confidence: 0.5,
        reasoning: "Fallback classification: Input suggests new functionality",
      };
    }
  }
}

function extractContext(charm: Cell<Charm>) {
  let spec: string | undefined;
  let schema: JSONSchema | undefined;
  let code: string | undefined;

  try {
    const iframeRecipe = getIframeRecipe(charm);
    if (iframeRecipe && iframeRecipe.iframe) {
      spec = iframeRecipe.iframe.spec;
      schema = iframeRecipe.iframe.argumentSchema;
      code = extractUserCode(iframeRecipe.iframe.src || "") ||
        undefined;
    }
  } catch {
    console.warn("Failed to extract context from charm");
  }

  return {
    spec,
    schema,
    code,
  };
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
 * @param generationId Optional ID for tracking generation
 * @param cache Optional flag to enable/disable LLM cache
 * @returns Execution plan with steps, spec, and schema
 */
export async function generatePlan(
  { input, workflowType, currentCharm, model, generationId, cache = true }: {
    input: string;
    workflowType: WorkflowType;
    currentCharm?: Cell<Charm>;
    model?: string;
    generationId?: string;
    cache: boolean;
  },
): Promise<ExecutionPlan> {
  // Extract context from the current charm if available
  let existingSpec: string | undefined;
  let existingSchema: JSONSchema | undefined;
  let existingCode: string | undefined;

  if (currentCharm) {
    const { spec, schema, code } = extractContext(currentCharm);
    existingSpec = spec;
    existingSchema = schema;
    existingCode = code;
  }

  try {
    const result = await generateWorkflowPlan(
      input,
      workflowType,
      existingSpec,
      existingSchema,
      existingCode,
      model,
      generationId,
      cache,
    );

    return {
      workflowType,
      steps: result.steps,
      spec: result.spec,
      dataModel: result.dataModel,
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
    } else { // imagine
      steps.push("Generate new specification and schema");
      steps.push("Create new implementation based on requirements");
      steps.push("Link to referenced data from existing charms");
    }

    return {
      workflowType,
      steps,
      spec: input,
      dataModel: "",
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
  } | null;

  // Planning information
  plan: {
    steps?: string[];
    spec?: string;
    dataModel?: string;
  } | null;

  // Generation information (only when actually generating code)
  generation?: {
    charm: Cell<Charm>;
  };

  // Metadata and workflow state
  meta: {
    isComplete: boolean;
    isFilled: boolean;
    modelId?: string;
    generationId?: string;
    charmManager?: CharmManager;
    cache: boolean;
  };
}

/**
 * Create a new workflow form with default values
 *
 * @param input The user's input text
 * @param modelId Optional model ID
 * @param charm Optional existing charm
 * @param generationId Optional generation ID
 * @param cache Optional flag to enable/disable LLM cache
 * @returns A new workflow form object
 */
export function createWorkflowForm(
  { input, modelId, charm, generationId, cache = true }: {
    input: string;
    modelId?: string;
    charm?: Cell<Charm>;
    generationId?: string;
    cache: boolean;
  },
): WorkflowForm {
  return {
    input: {
      rawInput: input,
      processedInput: "",
      references: {},
      existingCharm: charm,
    },
    classification: null,
    plan: null,
    meta: {
      isComplete: false,
      isFilled: false,
      modelId,
      generationId: generationId ?? crypto.randomUUID(),
      cache,
    },
  };
}

/**
 * Process the input part of the workflow form
 * Handles mentions, references, and sets up the processedInput
 *
 * @param charmManager The charm manager
 * @param form The workflow form
 * @param options Optional configuration options
 * @param options.existingCharm Optional existing charm to extend
 * @param options.prefill Optional prefilled form data
 * @param options.model Optional LLM model override
 * @param options.onProgress Optional callback for progress updates
 * @param options.cancellation Optional object to signal cancellation
 * @param options.cache Optional flag to enable/disable LLM cache
 * @returns The processed workflow form
 */
export async function processInputSection(
  charmManager: CharmManager,
  form: WorkflowForm,
): Promise<WorkflowForm> {
  const newForm = { ...form };

  // Skip for empty inputs
  if (!form.input.rawInput || form.input.rawInput.trim().length === 0) {
    throw new Error("Input is empty");
  }

  // Process mentions if CharmManager is provided
  let processedInput = form.input.rawInput;
  const references = { ...form.input.references };

  try {
    const { text, sources } = await formatPromptWithMentions(
      form.input.rawInput,
      charmManager,
    );
    processedInput = text;

    // Merge mentioned charms into references
    for (const [mentionId, charm] of Object.entries(sources)) {
      if (!references[mentionId]) {
        references[mentionId] = charm.cell;
      }
    }
  } catch (error) {
    console.warn("Error processing mentions in form:", error);
  }

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

  const classification = await classifyIntent(
    form.input.processedInput,
    form.input.existingCharm,
    form.meta.modelId,
    form.input.references,
    form.meta.generationId,
    form.meta.cache,
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
): Promise<WorkflowForm> {
  if (!form.classification) {
    throw new Error("Classification is required");
  }

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
    if (form.input.existingCharm) {
      const { spec, schema, code } = extractContext(form.input.existingCharm);

      if (!form.plan) {
        form.plan = { spec };
      } else {
        form.plan.spec = spec;
      }
    }

    // Generate just the plan without updating spec
    const executionPlan = await generatePlan(
      {
        input: form.input.processedInput,
        workflowType: form.classification.workflowType,
        currentCharm: form.input.existingCharm,
        model: form.meta.modelId,
        generationId: form.meta.generationId,
        cache: form.meta.cache,
      },
    );

    planningResult = {
      steps: executionPlan.steps,
      spec: form.plan?.spec, // Use existing spec for fix workflow
      dataModel: "",
    };
  } else {
    // For edit/imagine, generate both plan and spec
    const executionPlan = await generatePlan(
      {
        input: form.input.processedInput,
        workflowType: form.classification.workflowType,
        currentCharm: form.input.existingCharm,
        model: form.meta.modelId,
        generationId: form.meta.generationId,
        cache: form.meta.cache,
      },
    );

    planningResult = {
      steps: executionPlan.steps,
      spec: form.plan?.spec ?? executionPlan.spec, // if we have a prefilled spec, prefer that
      dataModel: executionPlan.dataModel,
    };
  }

  // Update planning in the form
  newForm.plan = {
    steps: planningResult.steps || [],
    spec: planningResult.spec,
    dataModel: planningResult.dataModel,
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
  if (!form.classification || !form.plan) {
    throw new Error("Classification and plan are required for code generation");
  }

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
      charm = await executeFixWorkflow(newForm.meta.charmManager, form);
      break;

    case "edit":
      if (!form.input.existingCharm) {
        throw new Error("Edit workflow requires an existing charm");
      }
      charm = await executeEditWorkflow(newForm.meta.charmManager, form);
      break;

    case "imagine":
    case "imagine-single-phase":
      charm = await executeImagineWorkflow(newForm.meta.charmManager, form);
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
    prefill?: Partial<WorkflowForm>;
    model?: string;
    onProgress?: (form: WorkflowForm) => void;
    cancellation?: { cancelled: boolean };
    cache: boolean;
  } = { cache: true },
): Promise<WorkflowForm> {
  console.groupCollapsed("processWorkflow");
  const startTime = performance.now();
  const timings: Record<string, number> = {};

  // Create a new form or use prefilled form
  let form = createWorkflowForm({
    input,
    charm: options.existingCharm,
    modelId: options.model,
    cache: options.cache,
  });
  console.log("creating form", form);

  try {
    // Function to check if the workflow has been cancelled
    const checkCancellation = () => {
      if (options.cancellation?.cancelled) {
        console.log("cancelled workflow");
        throw new Error("cancelled workflow");
      }
    };

    // Check for cancellation before starting work
    checkCancellation();

    if (options.prefill) {
      console.log("prefilling form", options.prefill);
      // do not prefill the meta
      delete options.prefill.meta;
      form = { ...options.prefill, ...form };
    }

    // Step 1: Process input (mentions, references, etc.) if not already processed
    if (
      !form.input?.processedInput ||
      form.input?.processedInput === form.input?.rawInput
    ) {
      if (!options.charmManager) {
        throw new Error("charmManager required to format input");
      }

      console.log("processing input...");
      const stepStartTime = performance.now();
      form = await processInputSection(options.charmManager, form);
      timings.processInput = performance.now() - stepStartTime;
      options.onProgress?.(form);
      console.log("processed input!", form);
    }

    globalThis.dispatchEvent(
      new CustomEvent("job-start", {
        detail: {
          type: "job-start",
          jobId: form.meta.generationId,
          title: form.input.processedInput,
          status: "Initializing...",
        },
      }),
    );

    checkCancellation();

    // Step 2: Classification if not already classified
    if (!form.classification) {
      console.log("classifying task");
      globalThis.dispatchEvent(
        new CustomEvent("job-update", {
          detail: {
            type: "job-update",
            jobId: form.meta.generationId,
            title: form.input.processedInput,
            status: `Classifying task ${form.meta.modelId}...`,
          },
        }),
      );
      const stepStartTime = performance.now();
      form = await fillClassificationSection(form);
      timings.classification = performance.now() - stepStartTime;
      options.onProgress?.(form);
      // console.log("classified task!", form);
    }

    checkCancellation();

    // Step 3: Planning if not already planned
    if (!form.plan || !form.plan.spec || !form.plan.steps) {
      console.log("planning task");
      globalThis.dispatchEvent(
        new CustomEvent("job-update", {
          detail: {
            type: "job-update",
            jobId: form.meta.generationId,
            title: form.input.processedInput,
            status: `Planning task ${form.meta.modelId}...`,
          },
        }),
      );
      const stepStartTime = performance.now();
      form = await fillPlanningSection(form);
      timings.planning = performance.now() - stepStartTime;
      options.onProgress?.(form);
      console.log("planned task!", form);
    }

    checkCancellation();

    // Step 4: Generation (if not a dry run and not already generated)
    if (!dryRun && options.charmManager && !form.generation?.charm) {
      console.log("generating code");
      globalThis.dispatchEvent(
        new CustomEvent("job-update", {
          detail: {
            type: "job-update",
            jobId: form.meta.generationId,
            title: form.input.processedInput,
            status: `Generating charm ${form.meta.modelId}...`,
          },
        }),
      );
      const stepStartTime = performance.now();
      form = await generateCode(form);
      timings.generation = performance.now() - stepStartTime;
      options.onProgress?.(form);
      console.log("generated code!", form);
    }

    const totalTime = performance.now() - startTime;
    console.log("Workflow timing summary:");
    console.log(`Total duration: ${totalTime.toFixed(2)}ms`);
    Object.entries(timings).forEach(([step, duration]) => {
      console.log(
        `  - ${step}: ${duration.toFixed(2)}ms (${
          ((duration / totalTime) * 100).toFixed(1)
        }%)`,
      );
    });

    globalThis.dispatchEvent(
      new CustomEvent("job-complete", {
        detail: {
          type: "job-complete",
          jobId: form.meta.generationId,
          title: form.input.processedInput,
          status: "Completed successfully",
          result: form,
          viewAction: form.generation?.charm
            ? {
              label: "View Results",
              action: () => {
                console.log("made", form.generation?.charm);
              },
            }
            : undefined,
        },
      }),
    );

    console.log("completed workflow!");
    console.groupEnd();
    return form;
  } catch (error) {
    const totalTime = performance.now() - startTime;
    console.warn("workflow failed:", error);
    console.log(`Workflow failed after ${totalTime.toFixed(2)}ms`);

    globalThis.dispatchEvent(
      new CustomEvent("job-failed", {
        detail: {
          type: "job-failed",
          jobId: form.meta.generationId,
          title: form.input.processedInput,
          error,
          duration: totalTime,
        },
      }),
    );

    console.groupEnd();
    return form;
  }
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
export function executeFixWorkflow(
  charmManager: CharmManager,
  form: WorkflowForm,
): Promise<Cell<Charm>> {
  console.log("Executing FIX workflow");

  return iterate(
    charmManager,
    form.input.existingCharm!,
    form.plan,
    form.meta.modelId,
    form.meta.generationId,
    form.meta.cache,
  );
}

/**
 * Execute the Edit workflow
 *
 * The Edit workflow builds upon the existing specification but retains
 * the existing schema, modifying the implementation to add features
 * or enhance functionality while maintaining compatibility.
 */
export function executeEditWorkflow(
  charmManager: CharmManager,
  form: WorkflowForm,
): Promise<Cell<Charm>> {
  console.log("Executing EDIT workflow");

  return iterate(
    charmManager,
    form.input.existingCharm!,
    form.plan,
    form.meta.modelId,
    form.meta.generationId,
    form.meta.cache,
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
export function executeImagineWorkflow(
  charmManager: CharmManager,
  form: WorkflowForm,
): Promise<Cell<Charm>> {
  console.log("Executing IMAGINE workflow");

  // Process references - this allows the new charm to access data from multiple sources
  let allReferences: Record<string, Cell<any>> = {};

  // Add all external references first with validation
  if (form.input.references && Object.keys(form.input.references).length > 0) {
    for (const [id, cell] of Object.entries(form.input.references)) {
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
    form.input.existingCharm
  ) {
    try {
      const charmData = form.input.existingCharm.get();
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

      // HACK: avoid nesting for a single self reference
      if (Object.keys(allReferences).length === 0) {
        allReferences = form.input.existingCharm as any;
      } else {
        allReferences[uniqueId] = form.input.existingCharm;
      }

      console.log(`Added current charm as "${uniqueId}"`);

      // Remove any generic "currentCharm" entry
      if (allReferences["currentCharm"]) {
        delete allReferences["currentCharm"];
      }
    } catch (error) {
      console.error(`Error processing current charm:`, error);
    }
  }

  form.input.references = allReferences;

  // Cast a new recipe with references, spec, and schema
  return castNewRecipe(
    charmManager,
    form,
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
    prefill?: Partial<WorkflowForm>;
    model?: string;
  },
): Promise<Cell<Charm>> {
  // Process the workflow with dryRun=false to fully execute and generate code
  const form = await processWorkflow(input, false, {
    charmManager,
    existingCharm: context.currentCharm,
    model: context.model,
    prefill: context.prefill,
    cache: true,
  });

  // A completed form should have a generated charm
  if (!form.generation?.charm) {
    throw new Error("Workflow execution failed to create a charm");
  }

  return form.generation.charm;
}
