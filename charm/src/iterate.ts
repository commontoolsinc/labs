import {
  Cell,
  isCell,
  isStream,
  registerNewRecipe,
  tsToExports,
} from "@commontools/runner";
import { client as llm } from "@commontools/llm";
import { createJsonSchema, JSONSchema } from "@commontools/builder";
import { Charm, CharmManager } from "./charm.ts";
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

export async function iterate(
  charmManager: CharmManager,
  charm: Cell<Charm>,
  spec: string,
  shiftKey: boolean,
  model?: string,
): Promise<Cell<Charm>> {
  const { iframe } = getIframeRecipe(charm);
  if (!iframe) {
    throw new Error("Cannot iterate on a non-iframe. Must extend instead.");
  }

  const newSpec = shiftKey ? iframe.spec + "\n" + spec : spec;

  const newIFrameSrc = await genSrc({
    src: iframe.src,
    spec: iframe.spec,
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

export const generateNewRecipeVersion = (
  charmManager: CharmManager,
  charm: Cell<Charm>,
  newIFrameSrc: string,
  newSpec: string,
) => {
  const { recipeId, iframe } = getIframeRecipe(charm);

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

  return compileAndRunRecipe(
    charmManager,
    newRecipeSrc,
    newSpec,
    charm.getSourceCell()?.key("argument"),
    recipeId ? [recipeId] : undefined,
  );
};

// FIXME(ja): this should handle multiple depths and/or
// a single depth - eg if you send { calendar: result1, email: result2 }
// it should scrub the result1 and result2 and
// return { calendar: scrub(result1), email: scrub(result2) }
// FIXME(seefeld): might be able to use asSchema here...
const scrub = (data: any) => {
  if (!data || !isCell(data)) return data;

  const rv: any = {};
  Object.keys(data.get()).forEach((key) => {
    const value = data.key(key);
    if (!key.startsWith("$") && !isStream(value)) {
      rv[key] = value;
    }
  });

  return rv;
};

export async function castNewRecipe(
  charmManager: CharmManager,
  goal: string,
  data?: any,
): Promise<Cell<Charm>> {
  console.log("Processing goal:", goal);

  const scrubbed = scrub(data);

  // First, extract any existing schema if we have data
  const existingSchema = createJsonSchema(scrubbed);

  // Phase 1: Generate spec/plan and schema based on goal and possibly existing schema
  const {
    spec: enhancedSpec,
    title,
    description,
    schema: generatedSchema,
    plan,
  } = await generateSpecAndSchema(goal, existingSchema);

  // FIXME(ja): why do we use title and description here only when existing schema?
  const schema = existingSchema
    ? {
      ...existingSchema,
      title: title,
      description: description,
    }
    : generatedSchema;

  console.log("schema", schema);

  const newSpec =
    `<GOAL>${goal}</GOAL>\n<PLAN>${plan}</PLAN>\n<SPEC>${enhancedSpec}</SPEC>`;

  console.log("newSpec", newSpec);

  // Phase 2: Generate UI code using the schema and enhanced spec
  const newIFrameSrc = await genSrc({ newSpec, schema });
  const name = extractTitle(newIFrameSrc, title); // Use the generated title as fallback
  const newRecipeSrc = buildFullRecipe({
    src: newIFrameSrc,
    spec: enhancedSpec,
    plan: plan,
    goal: goal,
    argumentSchema: schema,
    resultSchema: {},
    name,
  });

  // FIXME(ja): we should send the scrubbed data here - otherwise you
  // will get $UI $NAME and any streams in the inputs...
  return compileAndRunRecipe(charmManager, newRecipeSrc, goal, data);
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
