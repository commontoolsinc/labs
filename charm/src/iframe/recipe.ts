import { JSONSchema } from "@commontools/builder";
import { Charm, getRecipeIdFromCharm, processSchema } from "../manager.ts";
import { Cell, recipeManager } from "@commontools/runner";

export type IFrameRecipe = {
  src: string;
  argumentSchema: JSONSchema;
  resultSchema: JSONSchema;
  spec: string;
  plan?: string;
  goal?: string;
  name: string;
};

export const buildFullRecipe = (iframe: IFrameRecipe) => {
  const result = Object.keys(iframe.resultSchema.properties ?? {}).map((key) =>
    `    ${key}: data.${key},\n`
  ).join("\n");

  return `import { h } from "@commontools/html";
  import { recipe, UI, NAME } from "@commontools/builder";
  import type { JSONSchema } from "@commontools/builder";

  type IFrameRecipe = {
    src: string,
    argumentSchema: JSONSchema,
    resultSchema: JSONSchema,
    spec: string,
    plan?: string,
    goal?: string,
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
${result}
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

export const getIframeRecipe = (charm: Cell<Charm>): {
  recipeId: string;
  src: string;
  iframe: IFrameRecipe;
} => {
  const recipeId = getRecipeIdFromCharm(charm);
  const src = recipeManager.getRecipeMeta({ recipeId })?.src;
  if (!src) {
    throw new Error("Could not find src in charm");
  }
  return { recipeId, src, iframe: parseIframeRecipe(src) };
};
