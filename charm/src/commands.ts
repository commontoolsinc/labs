import { fixRecipePrompt } from "@commontools/llm";
import { Cell, getRecipe } from "@commontools/runner";
import { Charm, CharmManager } from "./charm.ts";
import { getIframeRecipe } from "./iframe/recipe.ts";
import { extractUserCode, injectUserCode } from "./iframe/static.ts";
import {
  castNewRecipe,
  compileAndRunRecipe,
  generateNewRecipeVersion,
} from "./iterate.ts";
import { NAME } from "@commontools/builder";
import { executeWorkflow } from "./imagine.ts";
import {
  ExecutionPlan,
  formatPromptWithMentions,
  WorkflowForm,
} from "./index.ts";

export const castSpellAsCharm = async (
  charmManager: CharmManager,
  recipeKey: string,
  argument: Cell<any>,
) => {
  if (recipeKey && argument) {
    console.log("Syncing...");
    const recipeId = recipeKey.replace("spell-", "");
    await charmManager.syncRecipeBlobby(recipeId);

    const recipe = getRecipe(recipeId);
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

export async function fixItCharm(
  charmManager: CharmManager,
  charm: Cell<Charm>,
  error: Error,
  model = "anthropic:claude-3-7-sonnet-20250219-thinking",
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
    model,
  );

  // Inject the fixed user code back into the template
  const fixedFullCode = injectUserCode(fixedUserCode);

  return generateNewRecipeVersion(
    charmManager,
    charm,
    fixedFullCode,
    iframeRecipe.iframe.spec,
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
export function modifyCharm(
  charmManager: CharmManager,
  promptText: string,
  currentCharm: Cell<Charm>,
  prefill?: Partial<WorkflowForm>,
  model?: string,
): Promise<Cell<Charm>> {
  // Include the current charm in the context
  const context = {
    currentCharm: currentCharm,
    prefill,
    model,
  };

  return executeWorkflow(
    charmManager,
    promptText,
    context,
  );
}

/**
 * This function is equivalent to calling modifyCharm with workflowType="rework"
 * It exists for backward compatibility and clarity in code
 *
 * @param charmManager CharmManager instance
 * @param currentCharmId ID of the charm to extend from
 * @param goal The prompt text describing what to create
 * @param cells Optional additional data references to include
 * @returns A new charm that extends from the current charm
 */
export async function extendCharm(
  charmManager: CharmManager,
  currentCharmId: string,
  goal: string,
  cells?: Record<string, Cell<any>>,
): Promise<Cell<Charm>> {
  const charm = (await charmManager.get(currentCharmId, false))!;

  // Process any cells to include as references
  const additionalReferences: Record<string, Cell<any>> = {};

  if (cells && Object.keys(cells).length > 0) {
    // Add cells to additionalReferences
    for (const [id, cell] of Object.entries(cells)) {
      additionalReferences[id] = cell;
    }
  }

  const classification: WorkflowForm["classification"] = {
    confidence: 1.0,
    workflowType: "imagine",
    reasoning: "Extend is always imagining since it changes argument schema",
  };

  const context = {
    currentCharm: charm,
    dataReferences: additionalReferences,
    prefill: {
      classification,
    },
  };

  return executeWorkflow(charmManager, goal, context);
}
