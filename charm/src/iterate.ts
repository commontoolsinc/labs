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

  // Pass the newSpec so it's properly persisted and can be displayed/edited
  const newCharm = await compileAndRunRecipe(
    charmManager,
    newRecipeSrc,
    newSpec,
    parent.getSourceCell()?.key("argument"),
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
  console.log("Processing goal:", goal, cells);

  // Remove $UI, $NAME, and any streams from the cells
  const scrubbed = scrub(cells);

  // First, extract any existing schema if we have data and no pre-generated schema
  const existingSchema = preGeneratedSchema || createJsonSchema(scrubbed);

  let spec, resultSchema, title, description, plan;
  let newSpec;

  // If we have a pre-generated spec, use it
  if (preGeneratedSpec) {
    // Try to extract structured information from the pre-generated spec
    const specMatch = preGeneratedSpec.match(/<SPEC>([\s\S]*?)<\/SPEC>/);
    const planMatch = preGeneratedSpec.match(/<PLAN>([\s\S]*?)<\/PLAN>/);
    const goalMatch = preGeneratedSpec.match(/<GOAL>([\s\S]*?)<\/GOAL>/);
    
    spec = specMatch ? specMatch[1] : preGeneratedSpec;
    plan = planMatch ? planMatch[1] : "";
    
    // If the spec doesn't already have the XML structure, add it
    if (!preGeneratedSpec.includes("<SPEC>")) {
      newSpec = `<GOAL>${goal}</GOAL>\n<PLAN>${plan || ""}</PLAN>\n<SPEC>${spec}</SPEC>`;
    } else {
      newSpec = preGeneratedSpec;
    }
    
    // Use existing schema as the result schema initially
    resultSchema = existingSchema;
    title = existingSchema.title || "New Charm";
    description = existingSchema.description || "";
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
    
    newSpec = `<GOAL>${goal}</GOAL>\n<PLAN>${plan}</PLAN>\n<SPEC>${spec}</SPEC>`;
  }

  console.log("resultSchema", resultSchema);
  console.log("newSpec", newSpec);

  // NOTE(ja): we put the result schema in the argument schema
  // as a hack to work around iframes not supporting results schemas
  const schema = {
    ...existingSchema,
    title,
    description,
  } as Writable<JSONSchema>;

  if (!schema.type) {
    schema.type = "object";
  }

  if (schema.type === "object" && !schema.properties) {
    schema.properties = {};
  }

  // FIXME(ja): we shouldn't just throw results into the argument schema
  // as this is a hack...
  if (schema.type === "object" && resultSchema?.properties) {
    const props = resultSchema.properties ?? {};
    Object.keys(props).forEach((key) => {
      if (schema.properties && schema.properties[key]) {
        console.error(`skipping ${key} already in the argument schema`);
      } else {
        (schema.properties as Record<string, JSONSchema>)[key] = props[key];
      }
    });
  }

  // Phase 2: Generate UI code using the schema and enhanced spec
  const newIFrameSrc = await genSrc({ newSpec, schema });
  const name = extractTitle(newIFrameSrc, title); // Use the generated title as fallback
  const newRecipeSrc = buildFullRecipe({
    src: newIFrameSrc,
    spec,
    plan,
    goal,
    argumentSchema: schema,
    resultSchema: resultSchema || schema,
    name,
  });

  const input = turnCellsIntoAliases(scrubbed);

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
