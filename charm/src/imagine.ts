import {
  Cell,
  isCell,
  isStream,
  registerNewRecipe,
  tsToExports,
} from "@commontools/runner";
import { client as llm } from "@commontools/llm";
import { isObj } from "@commontools/utils";
import {
  createJsonSchema,
  JSONSchema,
  schema,
  type Writable,
} from "@commontools/builder";
import { Charm, CharmManager, charmSourceCellSchema } from "./charm.ts";
import { buildFullRecipe, getIframeRecipe } from "./iframe/recipe.ts";
import { buildPrompt, RESPONSE_PREFILL } from "./iframe/prompt.ts";
import { generateSpecAndSchema } from "@commontools/llm";
import { injectUserCode, extractUserCode } from "./iframe/static.ts";
import { 
  iterate, 
  generateNewRecipeVersion, 
  compileAndRunRecipe,
  castNewRecipe
} from "./iterate.ts";
// Import workflow classification functions directly from llm package
// These are re-exported in the main index.ts
import { 
  classifyWorkflow, 
  generateWorkflowPlan 
} from "@commontools/llm";

// Types for the workflow classification
export type WorkflowType = "fix" | "edit" | "rework";

// Configuration for each workflow
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
    description: "Fix issues in the code without changing functionality or spec",
    updateSpec: false,
    updateSchema: false,
    allowsDataReferences: true,
  },
  edit: {
    name: "edit",
    description: "Update functionality while maintaining the same core data structure",
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
  updatedSpec?: string;
  updatedSchema?: JSONSchema;
}

/**
 * Classifies the user's intent into one of the supported workflows
 * @param input User input text
 * @param currentCharm Current charm context (optional)
 * @param model LLM model to use
 * @returns Classification result
 */
export async function classifyIntent(
  input: string,
  currentCharm?: Cell<Charm>,
  model?: string,
): Promise<IntentClassificationResult> {
  // Extract context from the current charm if available
  let existingSpec: string | undefined;
  let existingSchema: JSONSchema | undefined;
  let existingCode: string | undefined;
  
  if (currentCharm) {
    const iframeRecipe = getIframeRecipe(currentCharm);
    if (iframeRecipe && iframeRecipe.iframe) {
      existingSpec = iframeRecipe.iframe.spec;
      existingSchema = iframeRecipe.iframe.argumentSchema;
      existingCode = extractUserCode(iframeRecipe.iframe.src || "") || undefined;
    }
  }
  
  try {
    // Use our LLM-based classification function
    const result = await classifyWorkflow(
      input,
      existingSpec,
      existingSchema,
      existingCode,
      model
    );
    
    return {
      workflowType: result.workflowType,
      confidence: result.confidence,
      reasoning: result.reasoning,
      enhancedPrompt: result.enhancedPrompt,
    };
  } catch (error) {
    console.error("Error during workflow classification:", error);
    
    // Fallback to a simple heuristic if the LLM classification fails
    const lowerInput = input.toLowerCase();
    
    if (lowerInput.includes("fix") || lowerInput.includes("bug") || lowerInput.includes("issue")) {
      return {
        workflowType: "fix",
        confidence: 0.7,
        reasoning: "Fallback classification: Input suggests a fix operation",
      };
    } else if (lowerInput.includes("edit") || lowerInput.includes("update") || lowerInput.includes("improve") || lowerInput.includes("add")) {
      return {
        workflowType: "edit",
        confidence: 0.6,
        reasoning: "Fallback classification: Input suggests enhancing functionality",
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
 * Generates an execution plan for the given intent and workflow
 * @param input User input
 * @param workflowType The classified workflow type
 * @param currentCharm Current charm context
 * @param model LLM model to use
 * @returns Execution plan with steps
 */
export async function generatePlan(
  input: string,
  workflowType: WorkflowType,
  currentCharm?: Cell<Charm>,
  model?: string,
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
      existingCode = extractUserCode(iframeRecipe.iframe.src || "") || undefined;
    }
  }
  
  try {
    // Use our LLM-based plan generation
    const result = await generateWorkflowPlan(
      input,
      workflowType,
      existingSpec,
      existingSchema,
      existingCode,
      model
    );
    
    return {
      workflowType,
      steps: result.steps,
      updatedSpec: result.updatedSpec,
      updatedSchema: result.updatedSchema,
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
    
    return {
      workflowType,
      steps,
    };
  }
}

/**
 * Main entry point for the new generation workflow
 * @param charmManager CharmManager instance
 * @param input User input describing the desired changes
 * @param context Current charm and/or data references
 * @param workflowOverride Optional override for the workflow type
 * @param model Optional LLM model to use
 * @returns Generated charm
 */
export async function imagine(
  charmManager: CharmManager,
  input: string,
  context: {
    currentCharm?: Cell<Charm>;
    dataReferences?: Record<string, any>;
  },
  workflowOverride?: WorkflowType,
  model?: string,
): Promise<Cell<Charm>> {
  // 1. Classify intent if not overridden
  const workflowType = workflowOverride || 
    (await classifyIntent(input, context.currentCharm, model)).workflowType;
  
  // 2. Generate execution plan
  const plan = await generatePlan(input, workflowType, context.currentCharm, model);
  
  // 3. Execute plan based on workflow type
  if (workflowType === "fix" && context.currentCharm) {
    // For fix, we use the existing iterate function but ensure spec isn't updated
    return iterate(charmManager, context.currentCharm, input, false, model);
  } else if (workflowType === "edit" && context.currentCharm) {
    // For edit, we use iterate but potentially update spec
    // TODO: Implement proper edit workflow
    return iterate(charmManager, context.currentCharm, input, true, model);
  } else { // rework
    // For rework, we use the existing castNewRecipe functionality from iterate.ts
    // TODO: Implement proper rework workflow that handles data references better
    return castNewRecipe(charmManager, input, context.dataReferences);
  }
}

/**
 * Generate a live preview of the spec and plan based on user input
 * This is similar to the existing useLiveSpecPreview hook but integrates with the new workflow
 * @param input User input
 * @param existingCharm Optional existing charm for context
 * @param model Optional LLM model to use
 */
export async function generateWorkflowPreview(
  input: string,
  existingCharm?: Cell<Charm>,
  model?: string,
): Promise<{
  workflowType: WorkflowType;
  confidence: number;
  plan: string[];
  spec?: string;
  updatedSchema?: JSONSchema;
  reasoning?: string;
}> {
  if (!input || input.trim().length === 0) {
    return {
      workflowType: "edit", // Default to edit for empty input
      confidence: 0,
      plan: [],
    };
  }
  
  // 1. Classify intent
  const classification = await classifyIntent(input, existingCharm, model);
  
  // 2. Generate plan
  const executionPlan = await generatePlan(
    input,
    classification.workflowType,
    existingCharm,
    model,
  );
  
  // Use the updated spec and schema from the plan if available
  let spec = executionPlan.updatedSpec;
  let updatedSchema = executionPlan.updatedSchema;
  
  // If the plan didn't provide spec/schema but we need them, get from existing charm
  if (!spec && classification.workflowType !== "fix" && existingCharm) {
    const iframeRecipe = getIframeRecipe(existingCharm);
    
    if (iframeRecipe && iframeRecipe.iframe) {
      spec = iframeRecipe.iframe.spec;
    }
  }
  
  if (!updatedSchema && classification.workflowType === "rework" && existingCharm) {
    const iframeRecipe = getIframeRecipe(existingCharm);
    
    if (iframeRecipe && iframeRecipe.iframe) {
      updatedSchema = iframeRecipe.iframe.argumentSchema;
    }
  }
  
  return {
    workflowType: classification.workflowType,
    confidence: classification.confidence,
    plan: executionPlan.steps,
    spec,
    updatedSchema,
    reasoning: classification.reasoning,
  };
}
