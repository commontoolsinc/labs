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
import { generateSpecAndSchema, parseTagFromResponse } from "@commontools/llm";
import { injectUserCode } from "./iframe/static.ts";

const genSrc = async ({
  src,
  spec,
  newSpec,
  schema,
  model,
}: {
  src?: string;
  spec?: string;
  newSpec: string;
  schema: JSONSchema;
  model?: string;
}) => {
  const request = buildPrompt({ src, spec, newSpec, schema, model });

  let response = await llm.sendRequest(request);

  // FIXME(ja): this is a hack to get the prefill to work
  if (!response.startsWith(RESPONSE_PREFILL)) {
    response = RESPONSE_PREFILL + response;
  }

  const source = injectUserCode(
    response.split(RESPONSE_PREFILL)[1].split("\n```")[0],
  );
  return source;
};

/**
 * Iterate on an existing charm by generating a new version with updated specification
 * 
 * @param charmManager Charm manager representing the space this will be generated in
 * @param charm The existing charm to iterate on
 * @param spec User input or specification text
 * @param shiftKey Whether to append to the existing spec (true) or replace it (false)
 * @param model Optional LLM model to use
 * @param preGeneratedSpec Optional pre-generated specification to use instead of generating a new one
 * @returns A new charm cell that is an iteration of the original
 */
export async function iterate(
  charmManager: CharmManager,
  charm: Cell<Charm>,
  spec: string,
  shiftKey: boolean,
  model?: string,
  preGeneratedSpec?: string,
  plan?: string[] | string, // Added parameter for the execution plan
): Promise<Cell<Charm>> {
  const { iframe } = getIframeRecipe(charm);
  if (!iframe) {
    throw new Error("Cannot iterate on a non-iframe. Must extend instead.");
  }

  // Use the pre-generated spec if provided, otherwise combine as before
  const newSpec = preGeneratedSpec || (shiftKey ? iframe.spec + "\n" + spec : spec);
  
  // For cases where we're fixing but keeping the original spec,
  // We still want to create a formatted version that preserves information
  const formattedSpec = plan ? 
    formatSpecWithPlanAndPrompt(newSpec, spec, plan) : newSpec;

  const newIFrameSrc = await genSrc({
    src: iframe.src,
    spec: iframe.spec,
    newSpec: formattedSpec, // Use the formatted spec with full context
    schema: iframe.argumentSchema,
    model: model,
  });

  // Pass the formatted spec to be stored in the recipe
  return generateNewRecipeVersion(charmManager, charm, newIFrameSrc, formattedSpec);
}

/**
 * Standardized tag names used in XML structures throughout the codebase
 */
export const TAGS = {
  TITLE: "title",
  DESCRIPTION: "description",
  SPEC: "spec",
  PLAN: "plan",
  GOAL: "goal",
  ARGUMENT_SCHEMA: "argument_schema",
  RESULT_SCHEMA: "result_schema",
  EXAMPLE_DATA: "example_data",
  ORIGINAL_SPEC: "original_spec",
  USER_PROMPT: "user_prompt",
  EXECUTION_PLAN: "execution_plan"
} as const;

/**
 * Wraps content in XML tags
 */
export function wrapInTag(content: string, tag: string): string {
  return `<${tag}>\n${content}\n</${tag}>`;
}

/**
 * Extracts content from XML tags
 * Uses the same implementation as parseTagFromResponse but returns undefined instead of throwing
 */
export function extractFromTag(content: string, tag: string): string | undefined {
  try {
    return parseTagFromResponse(content, tag);
  } catch (e) {
    return undefined;
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
  return [
    wrapInTag(originalSpec, TAGS.ORIGINAL_SPEC),
    wrapInTag(userPrompt, TAGS.USER_PROMPT),
    wrapInTag(`- ${planText}`, TAGS.EXECUTION_PLAN)
  ].join("\n\n");
}

export function extractTitle(src: string, defaultTitle: string): string {
  const htmlTitleMatch = src.match(/<title>(.*?)<\/title>/)?.[1];
  const jsTitleMatch = src.match(/const title = ['"](.*)['"];?/)?.[1];
  return htmlTitleMatch || jsTitleMatch || defaultTitle;
}

export const generateNewRecipeVersion = async (
  charmManager: CharmManager,
  parent: Cell<Charm>,
  newIFrameSrc: string,
  newSpec: string,
) => {
  const { recipeId, iframe } = getIframeRecipe(parent);

  if (!recipeId || !iframe) {
    throw new Error("FIXME, no recipeId or iframe, what should we do?");
  }

  const name = extractTitle(newIFrameSrc, "<unknown>");
  const newRecipeSrc = buildFullRecipe({
    ...iframe,
    src: newIFrameSrc,
    spec: newSpec,
    name,
  });

  // IMPORTANT: For debugging - see what's in the source cell's argument
  const sourceCell = parent.getSourceCell();
  const argument = sourceCell?.key("argument");
  
  if (argument) {
    try {
      console.log("DEBUG: Parent charm argument cell found. Details:", {
        hasCellMethods: typeof argument.get === 'function',
        hasData: argument.get() !== undefined
      });
      
      // More detailed debugging to see what's actually in the argument
      try {
        const argumentValue = argument.get();
        if (argumentValue) {
          console.log("DEBUG: Argument value type:", typeof argumentValue);
          if (typeof argumentValue === 'object') {
            const keys = Object.keys(argumentValue);
            console.log("DEBUG: Argument keys:", keys);
            
            // Check if there are any cell references or aliases
            const hasAliases = keys.some(k => argumentValue[k] && argumentValue[k].$alias);
            console.log("DEBUG: Argument has aliases:", hasAliases);
          }
        }
      } catch (e) {
        console.error("DEBUG: Error examining argument value:", e);
      }
    } catch (e) {
      console.error("DEBUG: Error accessing parent argument cell:", e);
    }
  } else {
    console.warn("DEBUG: Parent charm has no argument in source cell");
  }

  // IMPORTANT: When creating a new version of a charm in the edit workflow,
  // we need to reuse the EXACT SAME argument data from the parent charm.
  // This ensures references to other charms are preserved.
  const parentArgument = parent.getSourceCell()?.key("argument");
  
  if (!parentArgument) {
    console.warn("Parent charm has no argument in source cell");
  } else {
    console.log("Using parent charm's argument for continuity in edit workflow");
  }

  // Pass the newSpec so it's properly persisted and can be displayed/edited
  const newCharm = await compileAndRunRecipe(
    charmManager,
    newRecipeSrc,
    newSpec,
    parentArgument, // Pass the exact same argument cell from the parent charm
    recipeId ? [recipeId] : undefined,
  );

  newCharm.getSourceCell(charmSourceCellSchema)?.key("lineage").push({
    charm: parent,
    relation: "iterate",
    timestamp: Date.now(),
  });

  return newCharm;
};

// FIXME(ja): this should handle multiple depths and/or
// a single depth - eg if you send { calendar: result1, email: result2 }
// it should scrub the result1 and result2 and
// return { calendar: scrub(result1), email: scrub(result2) }
// FIXME(seefeld): might be able to use asSchema here...
export function scrub(data: any): any {
  console.log("scrubbing", data);
  if (isCell(data)) {
    if (data.schema?.type === "object" && data.schema.properties) {
      // If there are properties, remove $UI and $NAME and any streams
      const scrubbed = Object.fromEntries(
        Object.entries(data.schema.properties).filter(([key, value]) =>
          !key.startsWith("$") && (!isObj(value) || !('asStream' in value))
        ),
      );
      console.log("scrubbed modified schema", scrubbed, data.schema);
      // If this resulted in an empty schema, return without a schema
      return data.asSchema(
        Object.keys(scrubbed).length > 0
          ? { ...data.schema, properties: scrubbed }
          : undefined,
      );
    } else {
      const value = data.asSchema().get();
      if (isObj(value)) {
        // Generate a new schema for all properties except $UI and $NAME and streams
        const scrubbed = {
          type: "object",
          properties: Object.fromEntries(
            Object.keys(value).filter(key =>
              !key.startsWith("$") && !isStream(value[key])
            ).map(
              (key) => [key, {}],
            ),
          ),
        } as JSONSchema;
        console.log("scrubbed generated schema", scrubbed);
        // Only if we found any properties, return the scrubbed schema
        return scrubbed.properties && Object.keys(scrubbed.properties).length > 0
          ? data.asSchema(scrubbed)
          : data;
      } else return data;
    }
  } else if (Array.isArray(data)) {
    return data.map((value) => scrub(value));
  } else if (isObj(data)) {
    return Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, scrub(value)]),
    );
  } else return data;
}

/**
 * Turn cells references into aliases, this forces writes to go back
 * to the original cell.
 */
function turnCellsIntoAliases(data: any): any {
  if (isCell(data)) {
    return { $alias: data.getAsCellLink() };
  } else if (Array.isArray(data)) {
    return data.map((value) => turnCellsIntoAliases(value));
  } else if (isObj(data)) {
    return Object.fromEntries(
      Object.entries(data).map((
        [key, value],
      ) => [key, turnCellsIntoAliases(value)]),
    );
  } else return data;
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
    const lastBrace = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
    if (lastBrace > 0 && lastBrace < cleaned.length - 1) {
      // There's text after the JSON ends
      cleaned = cleaned.substring(0, lastBrace + 1);
      console.log("Trimmed text after JSON ends");
    }
    
    // Validate JSON by parsing it
    JSON.parse(cleaned);
  } catch (e) {
    console.warn("Could not automatically fix JSON, returning cleaned string as-is");
  }
  
  return cleaned;
}

/**
 * Creates a structured specification with goal, plan, and spec
 */
export function createStructuredSpec(goal: string, plan: string | undefined, spec: string): string {
  const sections = [
    wrapInTag(goal, TAGS.GOAL)
  ];
  
  if (plan) {
    sections.push(wrapInTag(plan, TAGS.PLAN));
  }
  
  sections.push(wrapInTag(spec, TAGS.SPEC));
  
  return sections.join("\n\n");
}

/**
 * Cast a new recipe from a goal and data
 *
 * @param charmManager Charm manager representing the space this will be generated in
 * @param goal A user level goal for the new recipe, can reference specific data via `key`
 *        This goal should already have had mentions processed by formatPromptWithMentions
 * @param cells Data passed to the recipe, can be a combination of data and cells
 * @param preGeneratedSpec Optional pre-generated specification to use instead of generating a new one
 * @param preGeneratedSchema Optional pre-generated schema to use instead of generating a new one
 * @returns A new recipe cell
 */
export async function castNewRecipe(
  charmManager: CharmManager,
  goal: string,
  cells?: any,
  preGeneratedSpec?: string,
  preGeneratedSchema?: JSONSchema
): Promise<Cell<Charm>> {
  console.log("Processing goal:", goal);
  console.log("Raw cells provided:", cells);

  // DEBUGGING: Add more logging about cells
  if (cells) {
    try {
      const cellsEntries = Object.entries(cells);
      console.log(`DEBUG: Processing ${cellsEntries.length} cells/references:`);
      
      for (const [key, value] of cellsEntries) {
        console.log(`  - ${key}: ${isCell(value) ? 'Is a Cell' : 'Not a Cell'}`);
        if (isCell(value)) {
          try {
            console.log(`    * Has data: ${Boolean(value.get())}`);
            // For the case of currentCharm explicitly
            if (key === "currentCharm") {
              const sourceCell = value.getSourceCell();
              if (sourceCell) {
                const argument = sourceCell.key("argument");
                console.log(`    * Has source cell with argument: ${Boolean(argument)}`);
                if (argument) {
                  console.log(`    * Argument has data: ${Boolean(argument.get())}`);
                }
              }
            }
          } catch (e) {
            console.log(`    * Error getting cell data: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    } catch (e) {
      console.error("DEBUG: Error examining cells:", e);
    }
  }

  // Remove $UI, $NAME, and any streams from the cells
  const scrubbed = scrub(cells);
  console.log("Cells after scrubbing:", scrubbed);

  // First, extract any existing schema if we have data and no pre-generated schema
  const existingSchema = preGeneratedSchema || createJsonSchema(scrubbed);

  let spec, resultSchema, title, description, plan;
  let newSpec;

  // If we have a pre-generated spec, use it
  if (preGeneratedSpec) {
    // Try to extract structured information from the pre-generated spec
    spec = extractFromTag(preGeneratedSpec, TAGS.SPEC) || preGeneratedSpec;
    plan = extractFromTag(preGeneratedSpec, TAGS.PLAN) || "";
    const extractedGoal = extractFromTag(preGeneratedSpec, TAGS.GOAL);
    
    // If the spec doesn't already have the XML structure, add it
    if (!preGeneratedSpec.includes(`<${TAGS.SPEC}>`)) {
      newSpec = createStructuredSpec(goal, plan, spec);
    } else {
      newSpec = preGeneratedSpec;
    }
    
    // Simple schema handling - for pregenerated workflows
    if (preGeneratedSchema) {
      // For pre-generated schemas, we expect a valid argument schema
      if (!preGeneratedSchema.type || preGeneratedSchema.type !== 'object' || !preGeneratedSchema.properties) {
        throw new Error("Invalid argument schema: must be an object type with properties");
      }

      // Check for attached result schema (from workflow classification)
      if ((preGeneratedSchema as any).resultSchema) {
        resultSchema = (preGeneratedSchema as any).resultSchema;
        delete (preGeneratedSchema as any).resultSchema;
      } else {
        // No separate result schema, use argument schema
        resultSchema = preGeneratedSchema;
      }
    } else {
      // Default case - use existing schema
      resultSchema = existingSchema;
    }
    
    // Set title and description
    title = (preGeneratedSchema?.title || resultSchema?.title || existingSchema.title || "New Charm");
    description = (preGeneratedSchema?.description || resultSchema?.description || existingSchema.description || "");
  } else {
    // Phase 1: Generate spec/plan and schema based on goal and possibly existing schema
    // NOTE: We're passing goal directly here, which should already have mentions processed
    // by the imagine function before it reaches this point
    const generated = await generateSpecAndSchema(goal, existingSchema);
    
    spec = generated.spec;
    resultSchema = generated.resultSchema;
    title = generated.title;
    description = generated.description;
    plan = generated.plan;
    
    newSpec = createStructuredSpec(goal, plan, spec);
  }

  console.log("resultSchema", resultSchema);
  console.log("newSpec", newSpec);

  // Simplify schema handling
  // For argument schema, prioritize preGeneratedSchema (from workflow) over existingSchema
  const argumentSchema = preGeneratedSchema || existingSchema;
  
  // Ensure minimum structure for result schema (default to argument schema if none available)
  if (!resultSchema) {
    resultSchema = argumentSchema;
  }
  
  // Generate the UI code
  const newIFrameSrc = await genSrc({ newSpec, schema: argumentSchema });
  const name = extractTitle(newIFrameSrc, title || "New Charm");
  
  // Build the recipe
  const newRecipeSrc = buildFullRecipe({
    src: newIFrameSrc,
    spec,
    plan,
    goal,
    argumentSchema,
    resultSchema,
    name,
  });

  const input = turnCellsIntoAliases(scrubbed);
  console.log("Final input after turnCellsIntoAliases:", input);

  return compileAndRunRecipe(charmManager, newRecipeSrc, newSpec, input);
}

export async function compileRecipe(
  recipeSrc: string,
  spec: string,
  parents?: string[],
) {
  const { exports, errors } = await tsToExports(recipeSrc);
  if (errors) {
    console.error(errors);
    throw new Error("Compilation errors in recipe");
  }
  const recipe = exports.default;
  if (!recipe) {
    throw new Error("No default recipe found in the compiled exports.");
  }
  const parentsIds = parents?.map((id) => id.toString());
  registerNewRecipe(recipe, recipeSrc, spec, parentsIds);
  return recipe;
}

export async function compileAndRunRecipe(
  charmManager: CharmManager,
  recipeSrc: string,
  spec: string,
  runOptions: any,
  parents?: string[],
): Promise<Cell<Charm>> {
  const recipe = await compileRecipe(recipeSrc, spec, parents);
  if (!recipe) {
    throw new Error("Failed to compile recipe");
  }

  return charmManager.runPersistent(recipe, runOptions);
}
