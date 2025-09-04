import { Cell, type JSONSchema, type Runtime } from "@commontools/runner";
import { Charm, getRecipeIdFromCharm } from "../manager.ts";

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

  return `import { h, recipe, type JSONSchema, UI, NAME } from "commontools";

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

export const getIframeRecipe = (
  charm: Cell<Charm>,
  runtime: Runtime,
): {
  recipeId: string;
  // `src` is either a single file string source, or the entry
  // file source code in a recipe.
  src?: string;
  iframe?: IFrameRecipe;
} => {
  const recipeId = getRecipeIdFromCharm(charm);
  if (!recipeId) {
    console.warn("No recipeId found for charm", charm.entityId);
    return { recipeId, src: "", iframe: undefined };
  }
  const meta = runtime.recipeManager.getRecipeMeta({ recipeId });
  const src = meta
    ? (meta.src ??
      meta.program?.files.find((file) => file.name === meta.program?.main)
        ?.contents)
    : undefined;
  if (!src) {
    return { recipeId };
  }
  try {
    return { recipeId, src, iframe: parseIframeRecipe(src) };
  } catch (error) {
    return { recipeId, src };
  }
};
