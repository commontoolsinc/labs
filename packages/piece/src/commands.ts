import { createJsonSchema, type JSONSchema, NAME } from "@commontools/runner";
import { DEFAULT_MODEL_NAME, fixRecipePrompt } from "@commontools/llm";
import { Cell } from "@commontools/runner";

import { getIframeRecipe } from "./iframe/recipe.ts";
import { extractUserCode, injectUserCode } from "./iframe/static.ts";
import { WorkflowForm } from "./index.ts";
import { compileAndRunRecipe, generateNewRecipeVersion } from "./iterate.ts";
import { PieceManager } from "./manager.ts";
import { nameSchema } from "@commontools/runner/schemas";
import { processWorkflow, ProcessWorkflowOptions } from "./workflow.ts";

export const castSpellAsPiece = async (
  pieceManager: PieceManager,
  recipeKey: string,
  argument: Cell<unknown>,
) => {
  if (recipeKey && argument) {
    console.log("Syncing...");
    const recipeId = recipeKey.replace("spell-", "");
    const recipe = await pieceManager.syncRecipeById(recipeId);
    if (!recipe) return;

    console.log("Casting...");
    return await pieceManager.runPersistent(
      recipe,
      argument,
    );
  }
  console.log("Failed to cast");
  return null;
};

export const createDataPiece = (
  pieceManager: PieceManager,
  data: Record<string, unknown>,
  schema?: JSONSchema,
  name?: string,
) => {
  const argumentSchema = schema ?? createJsonSchema(data);

  const schemaString = JSON.stringify(argumentSchema, null, 2);
  const properties = typeof argumentSchema === "boolean"
    ? undefined
    : argumentSchema.properties;
  const result = Object.keys(properties ?? {}).map((key) =>
    `    ${key}: data.${key},\n`
  ).join("\n");

  const dataRecipeSrc = `import { h } from "@commontools/html";
  import { recipe, UI, NAME, derive, type JSONSchema } from "@commontools/runner";

  const schema = ${schemaString};

  export default recipe(schema, schema, (data) => ({
    [NAME]: "${name ?? "Data Import"}",
    [UI]: <div><h2>Your data has this schema</h2><pre>${
    schemaString.replaceAll("{", "&#123;")
      .replaceAll("}", "&#125;")
      .replaceAll("\n", "<br/>")
  }</pre></div>,
    ${result}
  }));`;

  return compileAndRunRecipe(
    pieceManager,
    dataRecipeSrc,
    name ?? "Data Import",
    data,
  );
};

export async function fixItPiece(
  pieceManager: PieceManager,
  piece: Cell<unknown>,
  error: Error,
  model = DEFAULT_MODEL_NAME,
): Promise<Cell<unknown>> {
  const iframeRecipe = getIframeRecipe(piece, pieceManager.runtime);
  if (!iframeRecipe.iframe) {
    throw new Error("Fixit only works for iframe pieces");
  }

  // Extract just the user code portion instead of using the full source
  const userCode = extractUserCode(iframeRecipe.iframe.src);
  if (!userCode) {
    throw new Error("Could not extract user code from iframe source");
  }

  const fixedUserCode = await fixRecipePrompt(
    iframeRecipe.iframe.spec,
    userCode, // Send only the user code portion
    JSON.stringify(iframeRecipe.iframe.argumentSchema),
    error.message,
    {
      model,
      cache: true,
    },
  );

  // Inject the fixed user code back into the template
  const fixedFullCode = injectUserCode(fixedUserCode);

  return generateNewRecipeVersion(
    pieceManager,
    piece,
    { src: fixedFullCode, spec: iframeRecipe.iframe.spec },
  );
}

export async function renamePiece(
  pieceManager: PieceManager,
  pieceId: string,
  newName: string,
): Promise<void> {
  const piece = await pieceManager.get(pieceId, false, nameSchema);
  piece.key(NAME).set(newName);
}

export async function addGithubRecipe(
  pieceManager: PieceManager,
  filename: string,
  spec: string,
  runOptions: unknown,
): Promise<Cell<unknown>> {
  const response = await fetch(
    `https://raw.githubusercontent.com/commontoolsinc/labs/refs/heads/main/recipes/${filename}?${Date.now()}`,
  );
  if (!response.ok) {
    throw new Error(
      `Failed to fetch recipe from GitHub: ${response.status} ${response.statusText}`,
    );
  }
  const src = await response.text();
  return await compileAndRunRecipe(
    pieceManager,
    src,
    spec,
    runOptions,
  );
}

/**
 * Modify a piece with the given prompt. This replaces the separate Etherate/Extend functionality.
 * The prompt will be processed for mentions and the current piece will be included in the context.
 * The workflow (edit, rework, fix) will be automatically determined based on the prompt.
 *
 * @param pieceManager The PieceManager instance
 * @param promptText The user's input describing what they want to do
 * @param currentPiece The piece being modified
 * @param model Optional LLM model to use
 * @param workflowType Optional: Allow specifying workflow type (will be overridden to "rework" if references exist)
 * @param previewPlan Optional: Pass through a pre-generated plan
 * @returns A new or modified piece
 */
export async function modifyPiece(
  pieceManager: PieceManager,
  promptText: string,
  currentPiece: Cell<unknown>,
  prefill?: Partial<WorkflowForm>,
  model?: string,
): Promise<Cell<unknown>> {
  // Include the current piece in the context
  const context: ProcessWorkflowOptions = {
    existingPiece: currentPiece,
    prefill,
    model,
    permittedWorkflows: ["edit"], // only edit is allowed here
  };

  const form = await processWorkflow(
    promptText,
    pieceManager,
    context,
  );

  if (!form.generation) {
    throw new Error("Modify piece failed");
  }

  return form.generation?.piece;
}
