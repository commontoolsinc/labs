import { fixRecipePrompt } from "@commontools/llm";
import { Cell, getRecipe } from "@commontools/runner";
import { Charm, CharmManager } from "./charm.ts";
import { getIframeRecipe } from "./iframe/recipe.ts";
import { extractUserCode, injectUserCode } from "./iframe/static.ts";
import { compileAndRunRecipe, generateNewRecipeVersion, castNewRecipe } from "./iterate.ts";
import { NAME } from "@commontools/builder";
import { imagine, formatPromptWithMentions, generateWorkflowPreview, WorkflowType } from "./imagine.ts";

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
 * @returns A new or modified charm
 */
export async function modifyCharm(
  charmManager: CharmManager,
  promptText: string,
  currentCharm: Cell<Charm>,
  model?: string,
  workflowType?: WorkflowType, // Optional: Allow specifying workflow type
  previewPlan?: string[], // Optional: Pass through a pre-generated plan
): Promise<Cell<Charm>> {
  // Process the prompt to handle @mentions
  const { text, mentions } = await formatPromptWithMentions(promptText, charmManager);
  
  // Include the current charm in the context
  const context = {
    currentCharm: currentCharm,
    dataReferences: mentions,
    previewPlan: previewPlan, // Pass through the pre-generated plan if available
  };
  
  // Use the imagine workflow which will classify and handle the operation
  // Pass the workflow type if specified (overrides classification)
  return imagine(charmManager, text, context, workflowType, model);
}

/**
 * Generate a preview for modifying a charm showing the workflow type and plan
 * 
 * @param charmManager The CharmManager instance
 * @param promptText The user's prompt text describing the desired changes
 * @param currentCharm The charm to be modified
 * @param model Optional LLM model to use
 * @returns Preview with classified workflow, plan, and spec
 */
export async function previewModifyCharm(
  charmManager: CharmManager,
  promptText: string,
  currentCharm: Cell<Charm>,
  model?: string,
) {
  // Process the prompt to handle @mentions
  const { text, mentions } = await formatPromptWithMentions(promptText, charmManager);

  // Generate a workflow preview
  return generateWorkflowPreview(
    text,          // Use the processed text with mentions replaced
    currentCharm,  // The current charm being modified
    model,         // The model to use
    mentions,      // All mentions found in the text
    charmManager   // Pass CharmManager to handle any nested mentions
  );
}

/**
 * Create a fresh charm with the given prompt text
 * 
 * @param charmManager The CharmManager instance
 * @param promptText The user's prompt text describing the charm to create
 * @param model Optional LLM model to use
 * @returns A new charm
 */
export async function createCharm(
  charmManager: CharmManager,
  promptText: string,
  model?: string,
): Promise<Cell<Charm>> {
  // Process the prompt to handle @mentions
  const { text, mentions } = await formatPromptWithMentions(promptText, charmManager);
  
  // Use castNewRecipe directly, passing the processed text and mentions
  return castNewRecipe(charmManager, text, mentions);
}
