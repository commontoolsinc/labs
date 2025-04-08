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

/**
 * Generate source code for a charm based on its specification, schema, and optional existing source
 */
export const genSrc = async ({
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
 * Iterate on an existing charm by generating new source code based on a new specification
 * This is a core function used by various workflows
 */
export async function iterate(
  charmManager: CharmManager,
  charm: Cell<Charm>,
  spec: string,
  shiftKey: boolean,
  model?: string,
  existingSpec?: string,
  executionPlan?: string[],
): Promise<Cell<Charm>> {
  const { iframe } = getIframeRecipe(charm);
  if (!iframe) {
    throw new Error("Cannot iterate on a non-iframe. Must extend instead.");
  }

  // If an existing spec is provided, use it directly
  // This is used by the Fix workflow where we preserve the original spec
  const iframeSpec = existingSpec || iframe.spec;
  const newSpec = shiftKey ? iframeSpec + "\n" + spec : spec;

  const newIFrameSrc = await genSrc({
    src: iframe.src,
    spec: iframeSpec,
    newSpec,
    schema: iframe.argumentSchema,
    model: model,
  });

  return generateNewRecipeVersion(charmManager, charm, newIFrameSrc, newSpec);
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
          !key.startsWith("$") && (!isObj(value) || !value.asStream)
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
            Object.keys(value).filter(([key, value]) =>
              !key.startsWith("$") && !isStream(value)
            ).map(
              (key) => [key, {}],
            ),
          ),
        } as JSONSchema;
        console.log("scrubbed generated schema", scrubbed);
        // Only if we found any properties, return the scrubbed schema
        return Object.keys(scrubbed).length > 0
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
 * @param data Data passed to the recipe, can be a combination of data and cells
 * @returns A new recipe cell
 */
export async function castNewRecipe(
  charmManager: CharmManager,
  goal: string,
  cells?: any,
): Promise<Cell<Charm>> {
  console.log("Processing goal:", goal, cells);

  // Remove $UI, $NAME, and any streams from the cells
  const scrubbed = scrub(cells);

  // First, extract any existing schema if we have data
  const existingSchema = createJsonSchema(scrubbed);

  // Phase 1: Generate spec/plan and schema based on goal and possibly existing schema
  const {
    spec,
    resultSchema,
    title,
    description,
    plan,
  } = await generateSpecAndSchema(goal, existingSchema);

  console.log("resultSchema", resultSchema);

  // TODO(bf): this doesn't seem like it should be needed, or it's named poorly
  // we seem to be regenerating our plan and spec just before generating the code
  const newSpec =
    `<GOAL>${goal}</GOAL>\n<PLAN>${plan}</PLAN>\n<SPEC>${spec}</SPEC>`;

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
  if (schema.type === "object") {
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
    resultSchema,
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
