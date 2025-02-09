import { addRecipe, EntityId } from "@commontools/runner";
import { LLMClient } from "@commontools/llm-client";
import { createJsonSchema, JSONSchema } from "@commontools/builder";
import { type DocImpl } from "@commontools/runner";

import { tsToExports } from "./localBuild.js";
import { Charm, CharmManager } from "./charm.js";
import { buildFullRecipe, getIframeRecipe } from "./iframe/recipe.js";
import { buildPrompt } from "./iframe/prompt.js";


const llmUrl =
  typeof window !== "undefined"
    ? window.location.protocol + "//" + window.location.host + "/api/ai/llm"
    : "//api/ai/llm";

const llm = new LLMClient(llmUrl);

const genSrc = async ({
  src,
  spec,
  newSpec,
  schema,
}: {
  src?: string;
  spec?: string;
  newSpec: string;
  schema: JSONSchema;
}) => {
  const request = buildPrompt({ src, spec, newSpec, schema });

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
  charm: DocImpl<Charm> | null,
  value: string,
  shiftKey: boolean,
): Promise<EntityId | undefined> {
  if (!charm) {
    console.error("FIXME, no charm, what should we do?");
    return;
  }

  const { recipeId, iframe } = getIframeRecipe(charm);
  if (!iframe) {
    console.error("FIXME, no compatible iframe found in charm, what should we do?");
    return;
  }

  const newSpec = shiftKey ? iframe.spec + "\n" + value : value;

  const newIFrameSrc = await genSrc({
    src: iframe.src,
    spec: iframe.spec,
    newSpec,
    schema: iframe.argumentSchema,
  });
  const name = newIFrameSrc.match(/<title>(.*?)<\/title>/)?.[1] ?? newSpec;
  const newRecipeSrc = buildFullRecipe({
    ...iframe,
    src: newIFrameSrc,
    spec: newSpec,
    name,
  });

  const { exports, errors } = await tsToExports(newRecipeSrc);

  if (errors) {
    console.error("errors", errors);
    return;
  }

  let { default: recipe } = exports;

  if (recipe) {
    // NOTE(ja): adding a recipe triggers saving to blobby
    const parents = recipeId ? [recipeId] : undefined;
    addRecipe(recipe, newRecipeSrc, newSpec, parents);

    // FIXME(ja): get the data from the charm
    // const data = charm.getAsQueryResult();

    // if you want to replace the running charm:
    // const newCharm = run(recipe, undefined, charm);

    // if you want to run a new charm:
    const newCharm = await charmManager.runPersistent(recipe, {
      cell: charm.sourceCell,
      path: ["argument"],
    });

    charmManager.add([newCharm]);
    await charmManager.syncRecipe(newCharm);

    return newCharm.entityId;
  }

  return;
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

  const { exports, errors } = await tsToExports(newRecipeSrc);

  if (errors) {
    console.error("errors", errors);
    return;
  }

  let { default: recipe } = exports;

  if (recipe) {
    const parents = undefined;

    // NOTE(ja): adding a recipe triggers saving to blobby
    addRecipe(recipe, newRecipeSrc, newSpec, parents);
    const newCharm = await charmManager.runPersistent(recipe, data);

    charmManager.add([newCharm]);
    await charmManager.syncRecipe(newCharm);

    return newCharm.entityId;
  }

  return;
}
