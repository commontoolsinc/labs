import {
  Cell,
  isCell,
  isStream,
  registerNewRecipe,
  tsToExports,
  getEntityId
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
  text: string;                           // Processed text with mentions replaced by readable names
  mentions: Record<string, Cell<Charm>>;  // Map of mention IDs to charm cells
}

/**
 * Formats a prompt with @mentions by replacing them with their readable names
 * and extracting the referenced Charm cells.
 * 
 * @param rawPrompt The original prompt text that may contain @mentions
 * @param charmManager CharmManager instance to look up charms
 * @returns Processed prompt with mentions replaced and a mapping of mention IDs to Charm cells
 */
export async function formatPromptWithMentions(
  rawPrompt: string,
  charmManager: CharmManager
): Promise<ProcessedPrompt> {
  // Regular expression to find @mentions in text
  // Matches @word where word contains letters, numbers, hyphens, or underscores
  const mentionRegex = /@([a-zA-Z0-9\-_]+)/g;
  
  const mentions: Record<string, Cell<Charm>> = {};
  const parsedMentions: ParsedMention[] = [];
  
  // First pass: Find all mentions and retrieve the charm cells
  let match;
  while ((match = mentionRegex.exec(rawPrompt)) !== null) {
    const mentionText = match[0]; // The full mention text (e.g., @charm-name)
    const mentionId = match[1];   // Just the identifier (e.g., charm-name)
    const startIndex = match.index;
    const endIndex = startIndex + mentionText.length;
    
    try {
      // Get all charms
      const allCharms = charmManager.getCharms().get();
      
      // Find the charm that matches this mention ID
      // First look for exact match with charm docId
      let matchingCharm = allCharms.find(charm => {
        const id = getEntityId(charm);
        return id && id["/"] === mentionId;
      });
      
      // If no exact match, try matching by name
      if (!matchingCharm) {
        matchingCharm = allCharms.find(charm => {
          const charmName = charm.get()["NAME"]?.toLowerCase();
          return charmName === mentionId.toLowerCase();
        });
      }
      
      if (matchingCharm) {
        const charmName = matchingCharm.get()["NAME"] || "Untitled";
        
        parsedMentions.push({
          id: mentionId,
          name: charmName,
          originalText: mentionText,
          startIndex,
          endIndex,
          charm: matchingCharm
        });
        
        // Store the mention mapping
        mentions[mentionId] = matchingCharm;
      }
    } catch (error) {
      console.warn(`Failed to resolve mention ${mentionText}:`, error);
    }
  }
  
  // Second pass: Replace mentions with their readable names
  // Sort in reverse order to avoid messing up indices when replacing
  parsedMentions.sort((a, b) => b.startIndex - a.startIndex);
  
  let processedText = rawPrompt;
  for (const mention of parsedMentions) {
    processedText = 
      processedText.substring(0, mention.startIndex) +
      `${mention.name} (referenced as @${mention.id})` +
      processedText.substring(mention.endIndex);
  }
  
  return {
    text: processedText,
    mentions
  };
}

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
  dataReferences?: Record<string, Cell<any>>, // Add support for mentioned charms
  charmManager?: CharmManager, // Add CharmManager for mention processing
): Promise<IntentClassificationResult> {
  // Extract context from the current charm if available
  let existingSpec: string | undefined;
  let existingSchema: JSONSchema | undefined;
  let existingCode: string | undefined;
  
  // Process the input for @mentions if a CharmManager is provided
  let processedInput = input;
  let mentionedCharms: Record<string, Cell<Charm>> = {};
  
  if (charmManager) {
    try {
      const processed = await formatPromptWithMentions(input, charmManager);
      processedInput = processed.text;
      mentionedCharms = processed.mentions;
      
      // Add the mentioned charms to the dataReferences
      if (Object.keys(mentionedCharms).length > 0) {
        if (!dataReferences) {
          dataReferences = {};
        }
        
        // Merge mentioned charms into dataReferences
        for (const [mentionId, charm] of Object.entries(mentionedCharms)) {
          if (!dataReferences[mentionId]) {
            dataReferences[mentionId] = charm;
          }
        }
      }
    } catch (error) {
      console.warn("Error processing mentions in prompt:", error);
    }
  }
  
  // Additional context for references
  let referencesContext = "";
  
  if (currentCharm) {
    const iframeRecipe = getIframeRecipe(currentCharm);
    if (iframeRecipe && iframeRecipe.iframe) {
      existingSpec = iframeRecipe.iframe.spec;
      existingSchema = iframeRecipe.iframe.argumentSchema;
      existingCode = extractUserCode(iframeRecipe.iframe.src || "") || undefined;
    }
  }
  
  // Process any referenced charms to include their context
  if (dataReferences && Object.keys(dataReferences).length > 0) {
    referencesContext = "Referenced Charms:\n";
    
    for (const [refId, charm] of Object.entries(dataReferences)) {
      if (refId === "currentCharm") continue; // Skip current charm as it's already included
      
      try {
        // Get spec and schema from the charm
        const iframeRecipe = getIframeRecipe(charm as Cell<Charm>);
        if (iframeRecipe && iframeRecipe.iframe) {
          const name = charm.get()["NAME"] || "Untitled";
          referencesContext += `\n- Reference '${refId}' (${name}):\n`;
          
          if (iframeRecipe.iframe.spec) {
            referencesContext += `  Spec: ${iframeRecipe.iframe.spec.substring(0, 200)}...\n`;
          }
          
          if (iframeRecipe.iframe.argumentSchema) {
            referencesContext += `  Schema: ${JSON.stringify(iframeRecipe.iframe.argumentSchema).substring(0, 200)}...\n`;
          }
        }
      } catch (e) {
        console.warn(`Failed to process reference ${refId}:`, e);
      }
    }
  }
  
  try {
    // Use our LLM-based classification function with the processed input
    // Include references context in the input
    const enhancedInput = referencesContext ? 
      `${processedInput}\n\n${referencesContext}` : processedInput;
    
    const result = await classifyWorkflow(
      enhancedInput,
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
  dataReferences?: Record<string, Cell<any>>, // Add support for mentioned charms
  charmManager?: CharmManager, // Add CharmManager for mention processing
): Promise<ExecutionPlan> {
  // Extract context from the current charm if available
  let existingSpec: string | undefined;
  let existingSchema: JSONSchema | undefined;
  let existingCode: string | undefined;
  
  // Process the input for @mentions if a CharmManager is provided
  let processedInput = input;
  let mentionedCharms: Record<string, Cell<Charm>> = {};
  
  if (charmManager) {
    try {
      const processed = await formatPromptWithMentions(input, charmManager);
      processedInput = processed.text;
      mentionedCharms = processed.mentions;
      
      // Add the mentioned charms to the dataReferences
      if (Object.keys(mentionedCharms).length > 0) {
        if (!dataReferences) {
          dataReferences = {};
        }
        
        // Merge mentioned charms into dataReferences
        for (const [mentionId, charm] of Object.entries(mentionedCharms)) {
          if (!dataReferences[mentionId]) {
            dataReferences[mentionId] = charm;
          }
        }
      }
    } catch (error) {
      console.warn("Error processing mentions in prompt:", error);
    }
  }
  
  // Additional context for references
  let referencesContext = "";
  
  if (currentCharm) {
    const iframeRecipe = getIframeRecipe(currentCharm);
    if (iframeRecipe && iframeRecipe.iframe) {
      existingSpec = iframeRecipe.iframe.spec;
      existingSchema = iframeRecipe.iframe.argumentSchema;
      existingCode = extractUserCode(iframeRecipe.iframe.src || "") || undefined;
    }
  }
  
  // Process any referenced charms to include their context
  if (dataReferences && Object.keys(dataReferences).length > 0) {
    referencesContext = "Referenced Charms:\n";
    
    for (const [refId, charm] of Object.entries(dataReferences)) {
      if (refId === "currentCharm") continue; // Skip current charm as it's already included
      
      try {
        // Get spec and schema from the charm
        const iframeRecipe = getIframeRecipe(charm as Cell<Charm>);
        if (iframeRecipe && iframeRecipe.iframe) {
          const name = charm.get()["NAME"] || "Untitled";
          referencesContext += `\n- Reference '${refId}' (${name}):\n`;
          
          if (iframeRecipe.iframe.spec) {
            referencesContext += `  Spec: ${iframeRecipe.iframe.spec.substring(0, 200)}...\n`;
          }
          
          if (iframeRecipe.iframe.argumentSchema) {
            referencesContext += `  Schema: ${JSON.stringify(iframeRecipe.iframe.argumentSchema).substring(0, 200)}...\n`;
          }
        }
      } catch (e) {
        console.warn(`Failed to process reference ${refId}:`, e);
      }
    }
  }
  
  try {
    // Use our LLM-based plan generation with the processed input that has mentions replaced
    // And include references context in the input
    const enhancedInput = referencesContext ? 
      `${processedInput}\n\n${referencesContext}` : processedInput;
    
    const result = await generateWorkflowPlan(
      enhancedInput,
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
    previewPlan?: string[]; // Add ability to pass through a pre-generated plan
  },
  workflowOverride?: WorkflowType,
  model?: string,
): Promise<Cell<Charm>> {
  // Process the input for @mentions
  let processedInput = input;
  let dataReferences = context.dataReferences || {};
  
  try {
    const processed = await formatPromptWithMentions(input, charmManager);
    processedInput = processed.text;
    
    // Merge mentioned charms into dataReferences
    for (const [mentionId, charm] of Object.entries(processed.mentions)) {
      if (!dataReferences[mentionId]) {
        dataReferences = { 
          ...dataReferences,
          [mentionId]: charm 
        };
      }
    }
  } catch (error) {
    console.warn("Error processing mentions in imagine prompt:", error);
  }
  
  // 1. Classify intent if not overridden
  const classification = await classifyIntent(
    processedInput, // Use processed input with mentions replaced
    context.currentCharm, 
    model, 
    dataReferences
  );
  
  // Use the overridden workflow type or the classified one
  const workflowType = workflowOverride || classification.workflowType;
  
  // 2. Generate plan and spec, but for "fix" workflow, keep the existing spec
  let executionPlan;
  let existingSpec: string | undefined;
  
  // Check if we have a pre-generated plan from context
  const hasPregeneratedPlan = context.previewPlan && context.previewPlan.length > 0;
  
  if (workflowType === "fix" && context.currentCharm) {
    // Get the existing spec for "fix" workflows
    const { iframe } = getIframeRecipe(context.currentCharm);
    existingSpec = iframe?.spec;
    
    if (hasPregeneratedPlan) {
      // If we have a pre-generated plan, use it with the existing spec
      executionPlan = {
        workflowType,
        steps: context.previewPlan,
        // Keep the existing spec for fix workflows
      };
      
      console.log("Using pre-generated plan for fix workflow:", executionPlan.steps);
    } else {
      // Otherwise generate the plan normally
      executionPlan = await generatePlan(
        processedInput, // Use processed input with mentions replaced
        workflowType, 
        context.currentCharm, 
        model, 
        dataReferences
      );
    }
  } else {
    // For edit/rework workflows
    if (hasPregeneratedPlan) {
      // If we have a pre-generated plan, use it
      // Get spec from the current charm for reference
      let referenceSpec: string | undefined;
      if (context.currentCharm) {
        const { iframe } = getIframeRecipe(context.currentCharm);
        referenceSpec = iframe?.spec;
      }
      
      // Generate a quick spec and schema from the input and plan
      // This avoids a full roundtrip to the LLM for the plan
      const planText = context.previewPlan && Array.isArray(context.previewPlan) 
        ? context.previewPlan.join('\n') 
        : "Generate implementation based on specification";
        
      const quickSpec = await generateSpecAndSchema(
        `${processedInput}\n\nFollow this plan:\n${planText}`,
        undefined,
        model
      );
      
      executionPlan = {
        workflowType,
        steps: context.previewPlan,
        updatedSpec: quickSpec.spec,
        updatedSchema: quickSpec.resultSchema
      };
      
      console.log("Using pre-generated plan for edit/rework:", executionPlan.steps);
    } else {
      // Otherwise generate both plan and spec normally
      executionPlan = await generatePlan(
        processedInput, // Use processed input with mentions replaced
        workflowType, 
        context.currentCharm, 
        model, 
        dataReferences
      );
    }
  }
  
  // 3. Execute plan based on workflow type with the appropriate spec
  if (workflowType === "fix" && context.currentCharm) {
    // For fix, we use the existing iterate function but pass the unchanged spec
    // existingSpec was already retrieved above
    
    // Pass the existing spec directly to prevent regeneration, but also include plan
    return iterate(
      charmManager, 
      context.currentCharm, 
      processedInput, 
      false, 
      model, 
      existingSpec, 
      executionPlan.steps // Pass the plan to preserve it in the spec
    );
  } else if (workflowType === "edit" && context.currentCharm) {
    // For edit, use iterate with the updated spec from our execution plan
    return iterate(
      charmManager, 
      context.currentCharm, 
      processedInput, 
      true, 
      model, 
      executionPlan.updatedSpec,
      executionPlan.steps // Pass the plan to preserve it in the spec
    );
  } else { // rework
    // For rework, use castNewRecipe with the pre-generated spec and schema
    // The processed input with mentions replaced is passed as the goal
    
    // Format the spec to include plan and user prompt for consistency
    let formattedSpec = executionPlan.updatedSpec;
    if (executionPlan.updatedSpec && executionPlan.steps) {
      formattedSpec = formatSpecWithPlanAndPrompt(
        executionPlan.updatedSpec,
        processedInput,
        executionPlan.steps
      );
    }
    
    return castNewRecipe(
      charmManager, 
      processedInput, // Already processed for mentions
      dataReferences,
      formattedSpec, // Use the formatted spec with plan and prompt
      executionPlan.updatedSchema
    );
  }
}

/**
 * Formats a spec to include the user prompt and execution plan
 * This ensures the full context is preserved in the recipe even for "fix" workflows
 * where we preserve the original spec
 */
function formatSpecWithPlanAndPrompt(originalSpec: string, userPrompt: string, plan: string[] | string): string {
  // Format the plan as a string if it's an array
  const planText = Array.isArray(plan) ? plan.join('\n- ') : plan;
  
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
  dataReferences?: Record<string, Cell<any>>, // Add support for mentioned charms
  charmManager?: CharmManager, // Add CharmManager for mention processing
  forcedWorkflowType?: WorkflowType, // Allow forcing a specific workflow type
): Promise<{
  workflowType: WorkflowType;
  confidence: number;
  plan: string[];
  spec?: string;
  updatedSchema?: JSONSchema;
  reasoning?: string;
  processedInput?: string; // Add the processed input with mentions replaced
  mentionedCharms?: Record<string, Cell<Charm>>; // Add the mentioned charms
}> {
  if (!input || input.trim().length === 0) {
    return {
      workflowType: "edit", // Default to edit for empty input
      confidence: 0,
      plan: [],
    };
  }
  
  // Process the input for @mentions if a CharmManager is provided
  let processedInput = input;
  let mentionedCharms: Record<string, Cell<Charm>> = {};
  
  if (charmManager) {
    try {
      const processed = await formatPromptWithMentions(input, charmManager);
      processedInput = processed.text;
      mentionedCharms = processed.mentions;
      
      // Add the mentioned charms to the dataReferences
      if (Object.keys(mentionedCharms).length > 0) {
        if (!dataReferences) {
          dataReferences = {};
        }
        
        // Merge mentioned charms into dataReferences
        for (const [mentionId, charm] of Object.entries(mentionedCharms)) {
          if (!dataReferences[mentionId]) {
            dataReferences[mentionId] = charm;
          }
        }
      }
    } catch (error) {
      console.warn("Error processing mentions in preview prompt:", error);
    }
  }
  
  // Always add the current charm as a reference if it exists and we're modifying
  if (existingCharm && !dataReferences) {
    dataReferences = { "currentCharm": existingCharm };
  } else if (existingCharm && dataReferences) {
    // Add current charm to references if not already there
    dataReferences = { ...dataReferences, "currentCharm": existingCharm };
  }
  
  // 1. Classify intent (or use the forced workflow type if provided)
  let classification;
  if (forcedWorkflowType) {
    // If a specific workflow type is forced, use it but still run classification to get a reason
    const tempClassification = await classifyIntent(
      processedInput, // Use the processed input with mentions replaced
      existingCharm, 
      model, 
      dataReferences,
      charmManager // Pass CharmManager to handle nested mentions
    );
    
    // Create a classification result with the forced workflow type
    classification = {
      workflowType: forcedWorkflowType,
      confidence: 1.0, // Max confidence since it's explicitly chosen
      reasoning: `User explicitly selected ${forcedWorkflowType} workflow. Original classification: ${tempClassification.workflowType} (${Math.round(tempClassification.confidence * 100)}%). ${tempClassification.reasoning}`,
    };
  } else {
    // Otherwise run normal classification
    classification = await classifyIntent(
      processedInput, // Use the processed input with mentions replaced
      existingCharm, 
      model, 
      dataReferences,
      charmManager // Pass CharmManager to handle nested mentions
    );
  }
  
  // 2. Generate plan (and spec if needed)
  let spec: string | undefined;
  let updatedSchema: JSONSchema | undefined;
  let steps: string[] = [];
  
  // For "fix" workflows, keep the existing spec rather than generating a new one
  if (classification.workflowType === "fix" && existingCharm) {
    // Get the existing spec from the current charm
    const iframeRecipe = getIframeRecipe(existingCharm);
    
    if (iframeRecipe && iframeRecipe.iframe) {
      spec = iframeRecipe.iframe.spec;
    }
    
    // Generate just the plan without updating spec
    const executionPlan = await generatePlan(
      processedInput, // Use the processed input with mentions replaced
      classification.workflowType,
      existingCharm,
      model,
      dataReferences,
      charmManager // Pass CharmManager to handle nested mentions
    );
    
    updatedSchema = executionPlan.updatedSchema;
    steps = executionPlan.steps;
    
    // In this case, updatedSpec should be undefined since we're keeping the existing spec
  } else {
    // For edit/rework, generate both plan and spec
    const executionPlan = await generatePlan(
      processedInput, // Use the processed input with mentions replaced
      classification.workflowType,
      existingCharm,
      model,
      dataReferences,
      charmManager // Pass CharmManager to handle nested mentions
    );
    
    // Get the spec and schema from the plan
    spec = executionPlan.updatedSpec;
    updatedSchema = executionPlan.updatedSchema;
    steps = executionPlan.steps;
  }
  
  // If no spec is available (unexpected), try to get from existing charm
  if (!spec && existingCharm) {
    const iframeRecipe = getIframeRecipe(existingCharm);
    
    if (iframeRecipe && iframeRecipe.iframe) {
      spec = iframeRecipe.iframe.spec;
    }
  }
  
  // If no schema for rework, try to get from existing charm
  if (!updatedSchema && classification.workflowType === "rework" && existingCharm) {
    const iframeRecipe = getIframeRecipe(existingCharm);
    
    if (iframeRecipe && iframeRecipe.iframe) {
      updatedSchema = iframeRecipe.iframe.argumentSchema;
    }
  }
  
  return {
    workflowType: classification.workflowType,
    confidence: classification.confidence,
    plan: steps,
    spec,
    updatedSchema,
    reasoning: classification.reasoning,
    processedInput, // Return the processed input with mentions replaced
    mentionedCharms, // Return the mentioned charms for UI display or other purposes
  };
}
