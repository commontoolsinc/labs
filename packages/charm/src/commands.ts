import { DEFAULT_MODEL_NAME, fixRecipePrompt } from "@commontools/llm";
import { Cell, recipeManager } from "@commontools/runner";
import { Charm, CharmManager } from "./manager.ts";
import { getIframeRecipe } from "./iframe/recipe.ts";
import { extractUserCode, injectUserCode } from "./iframe/static.ts";
import { compileAndRunRecipe, generateNewRecipeVersion } from "./iterate.ts";
import { NAME } from "@commontools/builder";
import { WorkflowForm } from "./index.ts";
import { createJsonSchema, type JSONSchema } from "@commontools/builder";
import { processWorkflow, ProcessWorkflowOptions } from "./workflow.ts";

export const castSpellAsCharm = async (
  charmManager: CharmManager,
  recipeKey: string,
  argument: Cell<any>,
) => {
  if (recipeKey && argument) {
    console.log("Syncing...");
    const recipeId = recipeKey.replace("spell-", "");
    const recipe = await charmManager.syncRecipeById(recipeId);
    if (!recipe) return;

    console.log("Casting...");
    const charm: Cell<Charm> = await charmManager.runPersistent(
      recipe,
      argument,
    );
    return charm;
  }
  console.log("Failed to cast");
  return null;
};

export const createDataCharm = (
  charmManager: CharmManager,
  data: Record<string, any>,
  schema?: JSONSchema,
  name?: string,
) => {
  const argumentSchema = schema ?? createJsonSchema(data);

  const schemaString = JSON.stringify(argumentSchema, null, 2);
  const result = Object.keys(argumentSchema.properties ?? {}).map((key) =>
    `    ${key}: data.${key},\n`
  ).join("\n");

  const dataRecipeSrc = `import { h } from "@commontools/html";
  import { recipe, UI, NAME, derive, type JSONSchema } from "@commontools/builder";

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
    charmManager,
    dataRecipeSrc,
    name ?? "Data Import",
    data,
  );
};

export async function fixItCharm(
  charmManager: CharmManager,
  charm: Cell<Charm>,
  error: Error,
  model = DEFAULT_MODEL_NAME,
): Promise<Cell<Charm>> {
  const iframeRecipe = getIframeRecipe(charm);
  if (!iframeRecipe.iframe) {
    throw new Error("Fixit only works for iframe charms");
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
    charmManager,
    charm,
    { src: fixedFullCode, spec: iframeRecipe.iframe.spec },
  );
}

export async function renameCharm(
  charmManager: CharmManager,
  charmId: string,
  newName: string,
): Promise<void> {
  const charm = await charmManager.get(charmId);
  if (!charm) return;
  charm.key(NAME).set(newName);
}

export async function addGithubRecipe(
  charmManager: CharmManager,
  filename: string,
  spec: string,
  runOptions: any,
): Promise<Cell<Charm>> {
  const response = await fetch(
    `https://raw.githubusercontent.com/commontoolsinc/labs/refs/heads/main/recipes/${filename}?${Date.now()}`,
  );
  const src = await response.text();
  return await compileAndRunRecipe(
    charmManager,
    src,
    spec,
    runOptions,
  );
}

/**
 * Modify a charm with the given prompt. This replaces the separate Etherate/Extend functionality.
 * The prompt will be processed for mentions and the current charm will be included in the context.
 * The workflow (edit, rework, fix) will be automatically determined based on the prompt.
 *
 * @param charmManager The CharmManager instance
 * @param promptText The user's input describing what they want to do
 * @param currentCharm The charm being modified
 * @param model Optional LLM model to use
 * @param workflowType Optional: Allow specifying workflow type (will be overridden to "rework" if references exist)
 * @param previewPlan Optional: Pass through a pre-generated plan
 * @returns A new or modified charm
 */
export async function modifyCharm(
  charmManager: CharmManager,
  promptText: string,
  currentCharm: Cell<Charm>,
  prefill?: Partial<WorkflowForm>,
  model?: string,
): Promise<Cell<Charm>> {
  // Include the current charm in the context
  const context: ProcessWorkflowOptions = {
    existingCharm: currentCharm,
    prefill,
    model,
    permittedWorkflows: ["edit"], // only edit is allowed here
  };

  const form = await processWorkflow(
    promptText,
    charmManager,
    context,
  );

  if (!form.generation) {
    throw new Error("Modify charm failed");
  }

  return form.generation?.charm;
}
