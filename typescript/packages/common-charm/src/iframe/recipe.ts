import { JSONSchema, TYPE } from "@commontools/builder";
import { Charm, processSchema } from "../charm.ts";
import { Cell, getRecipe, getRecipeSrc } from "@commontools/runner";

export type IFrameRecipe = {
  src: string;
  argumentSchema: JSONSchema;
  resultSchema: JSONSchema;
  spec: string;
  name: string;
};

export const buildFullRecipe = (iframe: IFrameRecipe) => {
  return `import { h } from "@commontools/html";
  import { recipe, UI, NAME } from "@commontools/builder";
  import type { JSONSchema } from "@commontools/builder";

  type IFrameRecipe = {
    src: string,
    argumentSchema: JSONSchema,
    resultSchema: JSONSchema,
    spec: string,
    name: string,
  }

  const inst: IFrameRecipe = /* IFRAME-V0 */ ${JSON.stringify(iframe, null, 2)
    } /* IFRAME-V0 */


  const runIframeRecipe = ({ argumentSchema, resultSchema, src, name }: IFrameRecipe) =>
  recipe(argumentSchema, resultSchema, (data) => ({
    [NAME]: name,
    [UI]: (
      <common-iframe src={src} $context={data}></common-iframe>
    ),
    // FIXME: add resultSchema to the result
  }));

  export default runIframeRecipe(inst);
  `;
};

function parseIframeRecipe(source: string): IFrameRecipe | undefined {
  // Extract content between IFRAME-V0 comments
  const match = source.match(
    /\/\* IFRAME-V0 \*\/([\s\S]*?)\/\* IFRAME-V0 \*\//,
  );
  if (!match) {
    console.warn("no IFRAME-V0 section in source");
    return undefined;
  }

  return JSON.parse(match[1]) as IFrameRecipe;
}

export const getIframeRecipe = (charm: Cell<Charm>) => {
  const recipeId = charm.getSourceCell(processSchema)?.get()?.[TYPE];
  if (!recipeId) {
    console.error("FIXME, no recipeId, what should we do?");
    return {};
  }

  const recipe = getRecipe(recipeId);
  if (!recipe) {
    console.error("FIXME, no recipe, what should we do?");
    return {};
  }
  const src = getRecipeSrc(recipeId);
  if (!src) {
    console.error("FIXME, no src, what should we do?");
    return {};
  }

  return { recipeId, iframe: parseIframeRecipe(src) };
};

export const getRecipeFrom = (charm: Cell<Charm>) => {
  const recipeId = charm.getSourceCell(processSchema)?.get()?.[TYPE];
  if (!recipeId) {
    throw new Error("No recipeId found");
  }

  const recipe = getRecipe(recipeId);
  if (!recipe) {
    throw new Error("No recipe found for recipeId");
  }
  const src = getRecipeSrc(recipeId);
  if (!src) {
    throw new Error("No source found for recipeId");
  }

  return { recipeId, recipe, src };
};
