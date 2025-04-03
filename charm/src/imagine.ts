import {
  Cell,
  getEntityId,
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
import { extractUserCode, injectUserCode } from "./iframe/static.ts";
import {
  castNewRecipe,
  compileAndRunRecipe,
  generateNewRecipeVersion,
  iterate,
} from "./iterate.ts";
// Import workflow classification functions directly from llm package
// These are re-exported in the main index.ts
import { classifyWorkflow, generateWorkflowPlan } from "@commontools/llm";

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
  text: string; // Processed text with mentions replaced by readable names
  mentions: Record<string, Cell<Charm>>; // Map of mention IDs to charm cells
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
  charmManager: CharmManager,
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
    const mentionId = match[1]; // Just the identifier (e.g., charm-name)
    const startIndex = match.index;
    const endIndex = startIndex + mentionText.length;

    try {
      // Get all charms
      const allCharms = charmManager.getCharms().get();

      // Find the charm that matches this mention ID
      // First look for exact match with charm docId
      let matchingCharm = allCharms.find((charm) => {
        const id = getEntityId(charm);
        return id && id["/"] === mentionId;
      });

      // If no exact match, try matching by name
      if (!matchingCharm) {
        matchingCharm = allCharms.find((charm) => {
          const charmName = charm.get()["NAME"]?.toLowerCase();
          return charmName === mentionId.toLowerCase();
        });
      }

      if (matchingCharm) {
        try {
          // Verify we can actually access the charm data
          const charmData = matchingCharm.get();
          const charmName = charmData["NAME"] || "Untitled";

          // Additional logging for debugging
          console.log(
            `Found matching charm for @${mentionId}: ${charmName} (entity ID: ${
              getEntityId(matchingCharm)?.["/"] || "unknown"
            })`,
          );

          // Store and validate the parsed mention
          parsedMentions.push({
            id: mentionId,
            name: charmName,
            originalText: mentionText,
            startIndex,
            endIndex,
            charm: matchingCharm,
          });

          // Store the mention mapping with validation
          if (isCell(matchingCharm)) {
            mentions[mentionId] = matchingCharm;
            console.log(
              `Successfully mapped mention @${mentionId} to charm ${charmName}`,
            );
          } else {
            console.warn(
              `Found matching charm for @${mentionId} but it's not a valid Cell object`,
            );
          }
        } catch (err) {
          console.error(
            `Error processing matching charm for @${mentionId}:`,
            err,
          );
        }
      } else {
        console.warn(`No matching charm found for mention @${mentionId}`);
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
    processedText = processedText.substring(0, mention.startIndex) +
      `${mention.name} (referenced as @${mention.id})` +
      processedText.substring(mention.endIndex);
  }

  return {
    text: processedText,
    mentions,
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
      existingCode = extractUserCode(iframeRecipe.iframe.src || "") ||
        undefined;
    }
  }

  // Process any referenced charms to include their context
  if (dataReferences && Object.keys(dataReferences).length > 0) {
    referencesContext = "Referenced Charms:\n";

    for (const [refId, charm] of Object.entries(dataReferences)) {
      if (refId === "currentCharm") continue; // Skip current charm as it's already included

      try {
        // Validate the charm is a cell with improved error handling
        if (!charm) {
          console.warn(
            `Reference '${refId}' is undefined or null, skipping in planning context`,
          );
          continue;
        }

        if (!isCell(charm)) {
          console.warn(
            `Reference '${refId}' is not a valid cell object, skipping in planning context`,
          );
          console.warn(
            `Type of reference: ${typeof charm}, isObj: ${isObj(charm)}`,
          );
          continue;
        }

        // Verify we can access cell data before proceeding
        try {
          // This will throw if the cell cannot be accessed properly
          const testAccess = charm.get();
          if (!testAccess) {
            console.warn(
              `Reference '${refId}' returned empty data, but continuing as the cell is valid`,
            );
          }
        } catch (accessError) {
          console.error(
            `Cannot access data for reference '${refId}':`,
            accessError,
          );
          referencesContext +=
            `\n- Reference '${refId}': Error accessing data - ${
              accessError instanceof Error
                ? accessError.message
                : String(accessError)
            }\n`;
          continue;
        }

        // Get spec and schema from the charm with improved error handling
        let iframeRecipe;
        try {
          iframeRecipe = getIframeRecipe(charm as Cell<Charm>);
        } catch (recipeError) {
          console.error(
            `Failed to get iframe recipe for reference '${refId}':`,
            recipeError,
          );
          referencesContext +=
            `\n- Reference '${refId}': Error getting recipe - ${
              recipeError instanceof Error
                ? recipeError.message
                : String(recipeError)
            }\n`;
          continue;
        }

        // Check if we have recipe information
        if (iframeRecipe && iframeRecipe.iframe) {
          // Get charm data for more context
          let charmData;
          let name = "Untitled";

          try {
            charmData = charm.get();
            name = charmData["NAME"] || "Untitled";
            console.log(
              `Successfully retrieved data for reference '${refId}' (${name})`,
            );
          } catch (dataError) {
            console.warn(
              `Error getting data for reference '${refId}':`,
              dataError,
            );
            // Continue with default name since we already know the cell is valid
          }

          // Add detailed information about this reference with clear structure
          referencesContext += `\n- Reference '${refId}' (${name}):\n`;

          // Include spec if available
          if (iframeRecipe.iframe.spec) {
            // Provide a clean spec summary
            const specSummary = iframeRecipe.iframe.spec
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
              .join(" ")
              .substring(0, 300);

            referencesContext += `  Spec: ${specSummary}...\n`;
          }

          // Include schema details with enhanced formatting
          if (iframeRecipe.iframe.argumentSchema) {
            // Format the schema in a more readable way with additional information
            const schema = iframeRecipe.iframe.argumentSchema;
            referencesContext += `  Schema Title: ${
              schema.title || "Untitled"
            }\n`;
            referencesContext += `  Schema Type: ${schema.type || "unknown"}\n`;

            if (schema.description) {
              referencesContext += `  Description: ${schema.description}\n`;
            }

            // List schema properties with more detailed type information
            if (schema.type === "object" && schema.properties) {
              referencesContext += `  Properties:\n`;

              for (
                const [propName, propDef] of Object.entries(schema.properties)
              ) {
                // Skip internal properties
                if (propName.startsWith("$")) continue;

                // Extract property type with more detail
                let propType = "any";
                let propDescription = "";
                let propFormat = "";
                let propRequired = false;

                if (typeof propDef === "object") {
                  propType = propDef.type || "any";

                  // Add array item types if applicable
                  if (propType === "array" && propDef.items) {
                    const itemType =
                      typeof propDef.items === "object" && propDef.items.type
                        ? propDef.items.type
                        : "any";
                    propType = `array<${itemType}>`;
                  }

                  // Add property description if available
                  if (propDef.description) {
                    propDescription = propDef.description;
                  }

                  // Check for format property which may exist in some JSON schema implementations
                  if (typeof propDef === "object" && "format" in propDef) {
                    propFormat = (propDef as any).format;
                  }
                }

                // Check if property is required
                if (schema.required && Array.isArray(schema.required)) {
                  propRequired = schema.required.includes(propName);
                }

                // Format the property information
                let propInfo = `    - ${propName}: ${propType}`;
                if (propRequired) propInfo += " (required)";
                if (propFormat) propInfo += ` (format: ${propFormat})`;

                referencesContext += propInfo + "\n";

                // Add description on a new line if available
                if (propDescription) {
                  referencesContext +=
                    `      Description: ${propDescription}\n`;
                }
              }
            }
          }

          // Include sample data from the charm to help with planning
          if (charmData) {
            try {
              // Format the data for better readability
              // Remove any internal properties starting with $ and any functions
              const cleanedData = Object.fromEntries(
                Object.entries(charmData)
                  .filter(([key]) => !key.startsWith("$"))
                  .map(([key, value]) => {
                    // Handle functions or complex objects
                    if (typeof value === "function") {
                      return [key, "[Function]"];
                    } else if (isStream(value)) {
                      return [key, "[Stream]"];
                    } else if (isCell(value)) {
                      return [key, "[Cell]"];
                    } else {
                      return [key, value];
                    }
                  }),
              );

              const sampleData = JSON.stringify(cleanedData, null, 2);
              if (sampleData && sampleData.length > 2) { // Not empty object
                // For large objects, just show the keys
                if (sampleData.length > 500) {
                  referencesContext += `  Data Keys: ${
                    Object.keys(cleanedData).join(", ")
                  }\n`;
                  // Include a small data preview with the first few values
                  const previewObject = Object.fromEntries(
                    Object.entries(cleanedData).slice(0, 3),
                  );
                  referencesContext += `  Data Preview: ${
                    JSON.stringify(previewObject)
                  }\n`;
                } else {
                  referencesContext += `  Sample Data: ${sampleData}\n`;
                }
              }
            } catch (err) {
              console.warn(
                `Could not format sample data for reference '${refId}':`,
                err,
              );
            }
          }
        } else {
          referencesContext +=
            `\n- Reference '${refId}': Could not get recipe information. This charm may not be an iframe charm.\n`;
        }
      } catch (e) {
        console.warn(`Failed to process reference ${refId}:`, e);
        referencesContext += `\n- Reference '${refId}': Error processing - ${
          e instanceof Error ? e.message : String(e)
        }\n`;
      }
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
        enhancedPrompt: processedInput,
      };
    }

    // If no other charm references, use our LLM-based classification function
    const enhancedInput = referencesContext
      ? `${processedInput}\n\n${referencesContext}`
      : processedInput;

    const result = await classifyWorkflow(
      enhancedInput,
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
      existingCode = extractUserCode(iframeRecipe.iframe.src || "") ||
        undefined;
    }
  }

  // Process any referenced charms to include their context
  // This information is crucial for planning how to use the referenced data
  if (dataReferences && Object.keys(dataReferences).length > 0) {
    referencesContext = "Referenced Charms:\n";

    for (const [refId, charm] of Object.entries(dataReferences)) {
      if (refId === "currentCharm") continue; // Skip current charm as it's already included

      try {
        // Validate the charm is a cell with improved error handling
        if (!charm) {
          console.warn(
            `Reference '${refId}' is undefined or null, skipping in planning context`,
          );
          continue;
        }

        if (!isCell(charm)) {
          console.warn(
            `Reference '${refId}' is not a valid cell object, skipping in planning context`,
          );
          console.warn(
            `Type of reference: ${typeof charm}, isObj: ${isObj(charm)}`,
          );
          continue;
        }

        // Verify we can access cell data before proceeding
        try {
          // This will throw if the cell cannot be accessed properly
          const testAccess = charm.get();
          if (!testAccess) {
            console.warn(
              `Reference '${refId}' returned empty data, but continuing as the cell is valid`,
            );
          }
        } catch (accessError) {
          console.error(
            `Cannot access data for reference '${refId}':`,
            accessError,
          );
          referencesContext +=
            `\n- Reference '${refId}': Error accessing data - ${
              accessError instanceof Error
                ? accessError.message
                : String(accessError)
            }\n`;
          continue;
        }

        // Get spec and schema from the charm with improved error handling
        let iframeRecipe;
        try {
          iframeRecipe = getIframeRecipe(charm as Cell<Charm>);
        } catch (recipeError) {
          console.error(
            `Failed to get iframe recipe for reference '${refId}':`,
            recipeError,
          );
          referencesContext +=
            `\n- Reference '${refId}': Error getting recipe - ${
              recipeError instanceof Error
                ? recipeError.message
                : String(recipeError)
            }\n`;
          continue;
        }

        // Check if we have recipe information
        if (iframeRecipe && iframeRecipe.iframe) {
          // Get charm data for more context
          let charmData;
          let name = "Untitled";

          try {
            charmData = charm.get();
            name = charmData["NAME"] || "Untitled";
            console.log(
              `Successfully retrieved data for reference '${refId}' (${name})`,
            );
          } catch (dataError) {
            console.warn(
              `Error getting data for reference '${refId}':`,
              dataError,
            );
            // Continue with default name since we already know the cell is valid
          }

          // Add detailed information about this reference with clear structure
          referencesContext += `\n- Reference '${refId}' (${name}):\n`;

          // Include spec if available
          if (iframeRecipe.iframe.spec) {
            // Provide a clean spec summary
            const specSummary = iframeRecipe.iframe.spec
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
              .join(" ")
              .substring(0, 300);

            referencesContext += `  Spec: ${specSummary}...\n`;
          }

          // Include schema details with enhanced formatting
          if (iframeRecipe.iframe.argumentSchema) {
            // Format the schema in a more readable way with additional information
            const schema = iframeRecipe.iframe.argumentSchema;
            referencesContext += `  Schema Title: ${
              schema.title || "Untitled"
            }\n`;
            referencesContext += `  Schema Type: ${schema.type || "unknown"}\n`;

            if (schema.description) {
              referencesContext += `  Description: ${schema.description}\n`;
            }

            // List schema properties with more detailed type information
            if (schema.type === "object" && schema.properties) {
              referencesContext += `  Properties:\n`;

              for (
                const [propName, propDef] of Object.entries(schema.properties)
              ) {
                // Skip internal properties
                if (propName.startsWith("$")) continue;

                // Extract property type with more detail
                let propType = "any";
                let propDescription = "";
                let propFormat = "";
                let propRequired = false;

                if (typeof propDef === "object") {
                  propType = propDef.type || "any";

                  // Add array item types if applicable
                  if (propType === "array" && propDef.items) {
                    const itemType =
                      typeof propDef.items === "object" && propDef.items.type
                        ? propDef.items.type
                        : "any";
                    propType = `array<${itemType}>`;
                  }

                  // Add property description if available
                  if (propDef.description) {
                    propDescription = propDef.description;
                  }

                  // Check for format property which may exist in some JSON schema implementations
                  if (typeof propDef === "object" && "format" in propDef) {
                    propFormat = (propDef as any).format;
                  }
                }

                // Check if property is required
                if (schema.required && Array.isArray(schema.required)) {
                  propRequired = schema.required.includes(propName);
                }

                // Format the property information
                let propInfo = `    - ${propName}: ${propType}`;
                if (propRequired) propInfo += " (required)";
                if (propFormat) propInfo += ` (format: ${propFormat})`;

                referencesContext += propInfo + "\n";

                // Add description on a new line if available
                if (propDescription) {
                  referencesContext +=
                    `      Description: ${propDescription}\n`;
                }
              }
            }
          }

          // Include sample data from the charm to help with planning
          if (charmData) {
            try {
              // Format the data for better readability
              // Remove any internal properties starting with $ and any functions
              const cleanedData = Object.fromEntries(
                Object.entries(charmData)
                  .filter(([key]) => !key.startsWith("$"))
                  .map(([key, value]) => {
                    // Handle functions or complex objects
                    if (typeof value === "function") {
                      return [key, "[Function]"];
                    } else if (isStream(value)) {
                      return [key, "[Stream]"];
                    } else if (isCell(value)) {
                      return [key, "[Cell]"];
                    } else {
                      return [key, value];
                    }
                  }),
              );

              const sampleData = JSON.stringify(cleanedData, null, 2);
              if (sampleData && sampleData.length > 2) { // Not empty object
                // For large objects, just show the keys
                if (sampleData.length > 500) {
                  referencesContext += `  Data Keys: ${
                    Object.keys(cleanedData).join(", ")
                  }\n`;
                  // Include a small data preview with the first few values
                  const previewObject = Object.fromEntries(
                    Object.entries(cleanedData).slice(0, 3),
                  );
                  referencesContext += `  Data Preview: ${
                    JSON.stringify(previewObject)
                  }\n`;
                } else {
                  referencesContext += `  Sample Data: ${sampleData}\n`;
                }
              }
            } catch (err) {
              console.warn(
                `Could not format sample data for reference '${refId}':`,
                err,
              );
            }
          }
        } else {
          referencesContext +=
            `\n- Reference '${refId}': Could not get recipe information. This charm may not be an iframe charm.\n`;
        }
      } catch (e) {
        console.warn(`Failed to process reference ${refId}:`, e);
        referencesContext += `\n- Reference '${refId}': Error processing - ${
          e instanceof Error ? e.message : String(e)
        }\n`;
      }
    }
  }

  try {
    // Use our LLM-based plan generation with the processed input that has mentions replaced
    // And include references context in the input
    const enhancedInput = referencesContext
      ? `${processedInput}\n\n${referencesContext}`
      : processedInput;

    const result = await generateWorkflowPlan(
      enhancedInput,
      workflowType,
      existingSpec,
      existingSchema,
      existingCode,
      model,
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

  debugger;
  try {
    const processed = await formatPromptWithMentions(input, charmManager);
    processedInput = processed.text;

    // Merge mentioned charms into dataReferences
    for (const [mentionId, charm] of Object.entries(processed.mentions)) {
      if (!dataReferences[mentionId]) {
        dataReferences = {
          ...dataReferences,
          [mentionId]: charm,
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
    dataReferences,
  );

  // Use the overridden workflow type or the classified one
  const workflowType = workflowOverride || classification.workflowType;

  // 2. Generate plan and spec, but for "fix" workflow, keep the existing spec
  let executionPlan;
  let existingSpec: string | undefined;

  // Check if we have a pre-generated plan from context
  const hasPregeneratedPlan = context.previewPlan &&
    context.previewPlan.length > 0;

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

      console.log(
        "Using pre-generated plan for fix workflow:",
        executionPlan.steps,
      );
    } else {
      // Otherwise generate the plan normally
      executionPlan = await generatePlan(
        processedInput, // Use processed input with mentions replaced
        workflowType,
        context.currentCharm,
        model,
        dataReferences,
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
        ? context.previewPlan.join("\n")
        : "Generate implementation based on specification";

      const quickSpec = await generateSpecAndSchema(
        `${processedInput}\n\nFollow this plan:\n${planText}`,
        undefined,
        model,
      );

      executionPlan = {
        workflowType,
        steps: context.previewPlan,
        updatedSpec: quickSpec.spec,
        updatedSchema: quickSpec.resultSchema,
      };

      console.log(
        "Using pre-generated plan for edit/rework:",
        executionPlan.steps,
      );
    } else {
      // Otherwise generate both plan and spec normally
      try {
        try {
          // Generate plan - this will throw if schema extraction fails for rework
          executionPlan = await generatePlan(
            processedInput,
            workflowType,
            context.currentCharm,
            model,
            dataReferences,
          );
        } catch (error) {
          console.error(`Plan generation failed: ${error.message}`);
          throw new Error(`Could not generate a plan for the ${workflowType} workflow. ${
            workflowType === 'rework' ? 
            'This workflow requires generating valid schemas, which failed.' : 
            'Please try again with a different prompt or workflow.'
          }`);
        }
      } catch (error) {
        console.error("Error generating plan:", error);
        throw new Error(`Failed to generate plan for ${workflowType} workflow: ${error.message}`);
      }
    }
  }

  // 3. Execute plan based on workflow type with the appropriate spec
  if (workflowType === "fix" && context.currentCharm) {
    // For fix, we use the existing iterate function but pass the unchanged spec
    // existingSpec was already retrieved above
    
    console.log("DEBUG: Executing FIX workflow with existing spec and current charm");

    // Pass the existing spec directly to prevent regeneration, but also include plan
    return iterate(
      charmManager,
      context.currentCharm,
      processedInput,
      false,
      model,
      existingSpec,
      executionPlan.steps, // Pass the plan to preserve it in the spec
    );
  } else if (workflowType === "edit" && context.currentCharm) {
    // For edit, use iterate with the updated spec from our execution plan
    
    console.log("DEBUG: Executing EDIT workflow with updated spec and current charm");
    // Check what sourceCell and argument look like
    try {
      const sourceCell = context.currentCharm.getSourceCell();
      const argument = sourceCell?.key("argument");
      
      console.log("DEBUG: Source cell details:", {
        hasSourceCell: Boolean(sourceCell),
        hasArgument: Boolean(argument),
        argumentHasData: argument ? Boolean(argument.get()) : false
      });
    } catch (e) {
      console.error("DEBUG: Error checking sourceCell/argument:", e);
    }
    
    return iterate(
      charmManager,
      context.currentCharm,
      processedInput,
      true,
      model,
      executionPlan.updatedSpec,
      executionPlan.steps, // Pass the plan to preserve it in the spec
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
        executionPlan.steps,
      );
    }
    
    // Check if we have a schema from the plan
    let updatedSchema = executionPlan.updatedSchema;
    
    // If we don't have a schema from the plan, generate one properly
    if (!updatedSchema || 
        !updatedSchema.properties || 
        Object.keys(updatedSchema.properties).length === 0) {
      console.log("No valid schema from executionPlan, generating a proper schema using generateSpecAndSchema");
      
      // Use the more reliable generateSpecAndSchema function directly
      const generated = await generateSpecAndSchema(
        processedInput, 
        undefined, // Don't use existing schema to ensure we get a fresh one
        model
      );
      
      // Use the schemas from the direct generation which are more reliable
      updatedSchema = generated.resultSchema;
      console.log("Generated schema details:", {
        hasResultSchema: Boolean(updatedSchema),
        resultSchemaType: updatedSchema?.type,
        resultSchemaPropertyCount: updatedSchema?.properties ? Object.keys(updatedSchema.properties).length : 0,
        argumentSchemaPropertyCount: generated.argumentSchema?.properties ? 
          Object.keys(generated.argumentSchema.properties).length : 0
      });
      
      // If we still don't have a good schema, create a minimal valid one
      if (!updatedSchema || !updatedSchema.properties || Object.keys(updatedSchema.properties).length === 0) {
        console.log("Still no valid schema, creating a minimal schema");
        updatedSchema = {
          type: "object",
          title: "Generated Charm",
          description: "Generated from user request: " + processedInput.substring(0, 100),
          properties: {
            result: {
              type: "string",
              title: "Result",
              description: "Output generated by the charm"
            }
          }
        };
      }
    }
    
    // Process references to ensure consistent naming and proper cell handling
    // This is crucial for properly accessing data from referenced charms
    let allReferences: Record<string, Cell<any>> = {};

    // Add all external references first with improved validation and logging
    if (dataReferences && Object.keys(dataReferences).length > 0) {
      // Process each reference to ensure consistent naming
      for (const [id, cell] of Object.entries(dataReferences)) {
        // Skip the special "currentCharm" key if it exists
        if (id === "currentCharm") continue;

        // Basic validation with detailed logging
        if (!cell) {
          console.warn(`Reference "${id}" is undefined or null, skipping`);
          continue;
        }

        if (typeof cell !== "object") {
          console.warn(
            `Reference "${id}" is not an object (type: ${typeof cell}), skipping`,
          );
          continue;
        }

        // Verify this is actually a Cell object
        if (!isCell(cell)) {
          console.warn(
            `Reference "${id}" is not a valid cell object, skipping`,
          );
          console.warn(
            `Type of reference: ${typeof cell}, isObj: ${isObj(cell)}`,
          );
          console.warn(`Keys on reference: ${Object.keys(cell).join(", ")}`);
          continue;
        }

        // Verify cell can be accessed properly
        let charmData;
        let charmName = id;
        let camelCaseId;

        try {
          // Attempt to get cell data and validate
          try {
            charmData = cell.get();
            if (!charmData) {
              console.warn(
                `Reference "${id}" returned empty data, but continuing as the cell is valid`,
              );
            }
          } catch (getError) {
            console.error(
              `Cannot access data for reference "${id}":`,
              getError,
            );
            console.warn(`Skipping reference "${id}" due to data access error`);
            continue;
          }

          // Extract a proper name with fallbacks
          try {
            charmName = charmData && charmData["NAME"] ? charmData["NAME"] : id;
          } catch (nameError) {
            console.warn(
              `Error getting name for reference "${id}":`,
              nameError,
            );
            charmName = id; // Fallback to the reference ID
          }

          // Create a valid camelCase identifier
          camelCaseId = toCamelCase(charmName);
          if (!camelCaseId || camelCaseId.length === 0) {
            camelCaseId = toCamelCase(id) ||
              `reference${Object.keys(allReferences).length + 1}`;
          }

          // Make sure the ID is unique with counter suffix if needed
          let uniqueId = camelCaseId;
          let counter = 1;
          while (uniqueId in allReferences) {
            uniqueId = `${camelCaseId}${counter++}`;
          }

          // Verify cell has required methods before adding
          if (typeof cell.getAsCellLink !== "function") {
            console.warn(
              `Reference "${id}" (${charmName}) is missing required cell methods, skipping`,
            );
            continue;
          }

          // Add to processed references with consistent naming
          allReferences[uniqueId] = cell;
          console.log(
            `Added reference "${id}" as "${uniqueId}" (${charmName})`,
          );

          // Debug logging for reference data
          try {
            const cellSchema = cell.schema;
            if (cellSchema) {
              console.log(
                `Reference "${uniqueId}" schema type: ${
                  cellSchema.type || "unknown"
                }`,
              );
              if (cellSchema.properties) {
                const propertyNames = Object.keys(cellSchema.properties).filter(
                  (k) => !k.startsWith("$")
                );
                console.log(
                  `Reference "${uniqueId}" schema properties: ${
                    propertyNames.join(", ")
                  }`,
                );
              }
            } else {
              console.log(`Reference "${uniqueId}" has no schema`);
            }
          } catch (schemaErr) {
            console.warn(
              `Could not get schema for reference "${id}":`,
              schemaErr,
            );
          }

          // Try to get entity ID for additional logging
          try {
            const entityId = getEntityId(cell);
            if (entityId) {
              console.log(
                `Reference "${uniqueId}" entity ID: ${
                  entityId["/"] || "unknown"
                }`,
              );
            }
          } catch (idErr) {
            console.warn(
              `Could not get entity ID for reference "${id}":`,
              idErr,
            );
          }
        } catch (error) {
          console.error(`Error processing reference "${id}":`, error);
          continue;
        }
      }
    }

    // Always add the current charm with a consistent name if available
    if (context.currentCharm) {
      try {
        // Verify current charm is a valid cell
        if (!isCell(context.currentCharm)) {
          console.warn(
            "Current charm is not a valid cell object, skipping in references",
          );
        } else {
          // Get data with error handling
          let charmData;
          let charmName = "currentCharm";

          try {
            charmData = context.currentCharm.get();
            charmName = charmData && charmData["NAME"]
              ? charmData["NAME"]
              : "currentCharm";
          } catch (dataError) {
            console.warn(`Error getting data for current charm:`, dataError);
            // Continue with default name
          }

          // Create a proper camelCase identifier
          const camelCaseId = toCamelCase(charmName);

          // Make sure the ID is unique
          let uniqueId = camelCaseId;
          let counter = 1;
          while (uniqueId in allReferences) {
            uniqueId = `${camelCaseId}${counter++}`;
          }

          // Add current charm to references
          allReferences[uniqueId] = context.currentCharm;
          console.log(`Added current charm as "${uniqueId}" (${charmName})`);
          
          // IMPORTANT: Remove any "currentCharm" entry - we want to ensure
          // the charm is explicitly named with a proper camelCase ID, not a generic key
          if (allReferences["currentCharm"]) {
            console.log("Removing generic 'currentCharm' entry in favor of named reference");
            delete allReferences["currentCharm"];
          }

          // Debug logging for current charm data
          try {
            const cellSchema = context.currentCharm.schema;
            if (cellSchema) {
              console.log(
                `Current charm schema type: ${cellSchema.type || "unknown"}`,
              );
              if (cellSchema.properties) {
                const propertyNames = Object.keys(cellSchema.properties).filter(
                  (k) => !k.startsWith("$")
                );
                console.log(
                  `Current charm schema properties: ${
                    propertyNames.join(", ")
                  }`,
                );
              }
            } else {
              console.log(`Current charm has no schema`);
            }
          } catch (err) {
            console.warn(`Could not get schema for current charm:`, err);
          }

          // Try to get entity ID for additional logging
          try {
            const entityId = getEntityId(context.currentCharm);
            if (entityId) {
              console.log(
                `Current charm entity ID: ${entityId["/"] || "unknown"}`,
              );
            }
          } catch (idErr) {
            console.warn(`Could not get entity ID for current charm:`, idErr);
          }
        }
      } catch (error) {
        console.error(`Error processing current charm:`, error);
      }
    }

    // Use debug logging to see what's actually being passed to castNewRecipe
    console.log(
      `Passing ${
        Object.keys(allReferences).length
      } references to castNewRecipe`,
    );
    for (const [id, cell] of Object.entries(allReferences)) {
      // Additional validation before passing references
      if (!isCell(cell)) {
        console.error(
          `CRITICAL: Reference "${id}" is not a valid cell just before being passed to castNewRecipe!`,
        );
        delete allReferences[id]; // Remove invalid references
      } else {
        console.log(
          `  - ${id}: Valid Cell (${
            typeof cell.get === "function" ? "has get()" : "MISSING get()!"
          })`,
        );
      }
    }

    // Final verification that we have valid references
    if (Object.keys(allReferences).length === 0) {
      console.warn("No valid references to pass to castNewRecipe");
    }

    return castNewRecipe(
      charmManager,
      processedInput, // Already processed for mentions
      allReferences, // Pass all references including current charm
      formattedSpec, // Use the formatted spec with plan and prompt
      executionPlan.updatedSchema,
    );
  }
}

/**
 * Adds schema information to the references context
 * Used to include schema information in LLM prompts for better planning
 */
function addSchemaToReferencesContext(
  referencesContext: string, 
  existingSchema?: JSONSchema, 
  prefix: string = "Current Charm"
): string {
  if (existingSchema) {
    // Include the argument schema in the context
    return referencesContext + `\n${prefix} Schema:\n\`\`\`json\n${
      JSON.stringify(existingSchema, null, 2)
    }\n\`\`\`\n`;
  }
  return referencesContext;
}

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
 * Formats a spec to include the user prompt and execution plan
 * This ensures the full context is preserved in the recipe even for "fix" workflows
 * where we preserve the original spec
 */
function formatSpecWithPlanAndPrompt(
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

  // Check if we have any mentions of other charms (except the current charm)
  // which would force the workflow to be "rework"
  const hasOtherCharmReferences = dataReferences &&
    Object.keys(dataReferences).filter((key) => key !== "currentCharm").length >
      0;

  // 1. Classify intent (or use the forced workflow type if provided)
  let classification;
  if (forcedWorkflowType) {
    // If a specific workflow type is forced, use it but still run classification to get a reason
    const tempClassification = await classifyIntent(
      processedInput, // Use the processed input with mentions replaced
      existingCharm,
      model,
      dataReferences,
      charmManager, // Pass CharmManager to handle nested mentions
    );

    // Create a classification result with the forced workflow type
    classification = {
      workflowType: forcedWorkflowType,
      confidence: 1.0, // Max confidence since it's explicitly chosen
      reasoning:
        `User explicitly selected ${forcedWorkflowType} workflow. Original classification: ${tempClassification.workflowType} (${
          Math.round(tempClassification.confidence * 100)
        }%). ${tempClassification.reasoning}`,
    };

    // However, if we have other charm references and the user is trying to force "fix" or "edit"
    // we need to warn them and stick with "rework"
    if (
      hasOtherCharmReferences &&
      (forcedWorkflowType === "fix" || forcedWorkflowType === "edit")
    ) {
      classification = {
        workflowType: "rework",
        confidence: 1.0,
        reasoning:
          `The workflow must be "rework" when referencing other charms. You selected "${forcedWorkflowType}" ` +
          `but this is not possible when using references to other charms as it requires creating a new argument cell ` +
          `that can access data from all references with a combined schema.`,
      };
    }
  } else {
    // Otherwise run normal classification
    const result = await classifyIntent(
      processedInput, // Use the processed input with mentions replaced
      existingCharm,
      model,
      dataReferences,
      charmManager, // Pass CharmManager to handle nested mentions
    );

    // Ensure workflowType is a valid WorkflowType before assigning
    classification = {
      workflowType: result.workflowType as WorkflowType,
      confidence: result.confidence,
      reasoning: result.reasoning,
      enhancedPrompt: result.enhancedPrompt,
    };
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
      charmManager, // Pass CharmManager to handle nested mentions
    );

    updatedSchema = executionPlan.updatedSchema;
    steps = executionPlan.steps;

    // In this case, updatedSpec should be undefined since we're keeping the existing spec
  } else {
    // For edit/rework, generate both plan and spec
    // Ensure we pass a valid WorkflowType to generatePlan
    const typedWorkflowType = classification.workflowType as WorkflowType;
    const executionPlan = await generatePlan(
      processedInput, // Use the processed input with mentions replaced
      typedWorkflowType,
      existingCharm,
      model,
      dataReferences,
      charmManager, // Pass CharmManager to handle nested mentions
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
  if (
    !updatedSchema && classification.workflowType === "rework" && existingCharm
  ) {
    const iframeRecipe = getIframeRecipe(existingCharm);

    if (iframeRecipe && iframeRecipe.iframe) {
      updatedSchema = iframeRecipe.iframe.argumentSchema;
    }
  }

  // Ensure we return a valid WorkflowType
  const workflowType = classification.workflowType as WorkflowType;

  return {
    workflowType,
    confidence: classification.confidence,
    plan: steps,
    spec,
    updatedSchema,
    reasoning: classification.reasoning,
    processedInput, // Return the processed input with mentions replaced
    mentionedCharms, // Return the mentioned charms for UI display or other purposes
  };
}
