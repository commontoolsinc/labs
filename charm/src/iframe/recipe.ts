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

  const inst: IFrameRecipe = /* IFRAME-V0 */ ${
    JSON.stringify(iframe, null, 2)
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

function parseIframeRecipe(source: string): IFrameRecipe {
  // Extract content between IFRAME-V0 comments
  const match = source.match(
    /\/\* IFRAME-V0 \*\/([\s\S]*?)\/\* IFRAME-V0 \*\//,
  );

  if (!match || !match[1]) {
    throw new Error("Could not find IFRAME-V0 recipe content in source");
  }

  return JSON.parse(match[1]) as IFrameRecipe;
}

export const getIframeRecipe = (charm: Cell<Charm>) => {
  const { src, recipeId } = getRecipeFrom(charm);

  return { recipeId, iframe: parseIframeRecipe(src) };
};

export const getRecipeFrom = (charm: Cell<Charm>) => {
  const recipeId = charm.getSourceCell(processSchema)?.get()?.[TYPE];
  const recipe = getRecipe(recipeId)!;
  const src = getRecipeSrc(recipeId)!;

  return { recipeId, recipe, src };
};
