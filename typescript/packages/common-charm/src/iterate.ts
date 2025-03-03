import { addRecipe, Cell, EntityId } from "@commontools/runner";
import { LLMClient } from "@commontools/llm-client";
import { createJsonSchema, JSONSchema } from "@commontools/builder";

import { tsToExports } from "./localBuild.ts";
import { Charm, CharmManager } from "./charm.ts";
import { buildFullRecipe, getIframeRecipe, getRecipeFrom } from "./iframe/recipe.ts";
import { buildPrompt } from "./iframe/prompt.ts";

const llmUrl = typeof globalThis.location !== "undefined"
  ? globalThis.location.protocol + "//" + globalThis.location.host +
  "/api/ai/llm"
  : "//api/ai/llm";

const llm = new LLMClient(llmUrl);

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
  const responsePrefill = request.messages[request.messages.length - 1];
  if (!response.startsWith("```html\n")) {
    response = responsePrefill + response;
  }

  return response.split("```html\n")[1].split("\n```")[0];
};

export async function iterate(
  charmManager: CharmManager,
  charm: Cell<Charm> | null,
  value: string,
  shiftKey: boolean,
  model?: string,
): Promise<EntityId | undefined> {
  if (!charm) {
    console.error("FIXME, no charm, what should we do?");
    return;
  }

  const { iframe } = getIframeRecipe(charm);
  if (!iframe) {
    console.error(
      "Cannot iterate on a non-iframe. Must extend instead.",
    );
    return;
  }

  const newSpec = shiftKey ? iframe.spec + "\n" + value : value;

  const newIFrameSrc = await genSrc({
    src: iframe.src,
    spec: iframe.spec,
    newSpec,
    schema: iframe.argumentSchema,
    model: model,
  });

  return saveNewRecipeVersion(charmManager, charm, newIFrameSrc, newSpec);
}

export async function extend(
  charmManager: CharmManager,
  charm: Cell<Charm> | null,
  value: string,
  model?: string,
): Promise<EntityId | undefined> {
  if (!charm) {
    console.error("FIXME, no charm, what should we do?");
    return;
  }

  return await castRecipeOnCell(charmManager, charm, value);
}

export const saveNewRecipeVersion = async (
  charmManager: CharmManager,
  charm: Cell<Charm>,
  newIFrameSrc: string,
  newSpec: string,
) => {
  const { recipeId, iframe } = getIframeRecipe(charm);

  if (!recipeId || !iframe) {
    console.error("FIXME, no recipeId or iframe, what should we do?");
    return;
  }

  const name = newIFrameSrc.match(/<title>(.*?)<\/title>/)?.[1] ?? newSpec;
  const newRecipeSrc = buildFullRecipe({
    ...iframe,
    src: newIFrameSrc,
    spec: newSpec,
    name,
  });

  return await compileAndRunRecipe(
    charmManager,
    newRecipeSrc,
    newSpec,
    charm.getSourceCell()?.key("argument"),
    recipeId ? [recipeId] : undefined,
  );
};

export async function castRecipeOnCell(
  charmManager: CharmManager,
  cell: Cell<any>,
  newSpec: string,
): Promise<EntityId | undefined> {
  const schema = cell.schema || {};
  schema.description = newSpec;
  console.log("schema", schema);

  const newIFrameSrc = await genSrc({ newSpec, schema });
  const name = newIFrameSrc.match(/<title>(.*?)<\/title>/)?.[1] ?? newSpec;
  const newRecipeSrc = buildFullRecipe({
    src: newIFrameSrc,
    spec: newSpec,
    argumentSchema: schema,
    resultSchema: {},
    name,
  });

  return await compileAndRunRecipe(charmManager, newRecipeSrc, newSpec, cell);
}

export async function castNewRecipe(
  charmManager: CharmManager,
  data: any,
  newSpec: string,
): Promise<EntityId | undefined> {
  const schema = createJsonSchema({}, data);
  schema.description = newSpec;
  console.log("schema", schema);

  const newIFrameSrc = await genSrc({ newSpec, schema });
  const name = newIFrameSrc.match(/<title>(.*?)<\/title>/)?.[1] ?? newSpec;
  const newRecipeSrc = buildFullRecipe({
    src: newIFrameSrc,
    spec: newSpec,
    argumentSchema: schema,
    resultSchema: {},
    name,
  });

  return await compileAndRunRecipe(charmManager, newRecipeSrc, newSpec, data);
}

export async function compileRecipe(
  recipeSrc: string,
  spec: string,
  parents?: string[],
) {
  const { exports, errors } = await tsToExports(recipeSrc);
  if (errors) {
    console.error("Compilation errors in recipe:", errors);
    return;
  }
  const recipe = exports.default;
  if (!recipe) {
    console.error("No default recipe found in the compiled exports.");
    return;
  }
  const parentsIds = parents?.map((id) => id.toString());
  addRecipe(recipe, recipeSrc, spec, parentsIds);
  return recipe;
}

export async function compileAndRunRecipe(
  charmManager: CharmManager,
  recipeSrc: string,
  spec: string,
  runOptions: any,
  parents?: string[],
): Promise<EntityId | undefined> {
  const recipe = await compileRecipe(recipeSrc, spec, parents);
  if (!recipe) {
    return;
  }

  const newCharm = await charmManager.runPersistent(recipe, runOptions);
  await charmManager.add([newCharm]);
  await charmManager.syncRecipe(newCharm);

  return newCharm.entityId;
}
