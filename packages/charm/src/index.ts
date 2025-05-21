export {
  type Charm,
  type CharmPreview,
  charmId,
  charmPreviewListSchema,
  CharmManager,
  charmPreviewSchema,
  charmSchema,
  charmListSchema,
  processSchema,
} from "./manager.ts";
export { searchCharms } from "./search.ts";
export {
  castNewRecipe,
  compileAndRunRecipe,
  compileRecipe,
  generateNewRecipeVersion,
  genSrc,
  iterate,
} from "./iterate.ts";
export {
  extractUserCode,
  extractVersionTag,
  injectUserCode,
} from "./iframe/static.ts";
export {
  addGithubRecipe,
  castSpellAsCharm,
  createDataCharm,
  fixItCharm,
  modifyCharm,
  renameCharm,
} from "./commands.ts";
export { getIframeRecipe, type IFrameRecipe } from "./iframe/recipe.ts";
export { type ParsedMention, type ProcessedPrompt } from "./imagine.ts";
export { formatPromptWithMentions, parseComposerDocument } from "./format.ts";

export const DEFAULT_MODEL = [
  // "groq:llama-3.3-70b-specdec",
  // "cerebras:llama-3.3-70b",
  // "anthropic:claude-3-5-sonnet-latest",
  "anthropic:claude-3-7-sonnet-latest",
  // "gemini-2.0-flash",
  // "gemini-2.0-flash-thinking",
  // "gemini-2.0-pro",
  // "o3-mini-low",
  // "o3-mini-medium",
  // "o3-mini-high",
][0];

// Export workflow module
export {
  classifyIntent,
  createWorkflowForm,
  executeEditWorkflow,
  executeFixWorkflow,
  executeImagineWorkflow,
  type ExecutionPlan,
  fillClassificationSection,
  fillPlanningSection,
  formatSpecWithPlanAndPrompt,
  generateCode,
  generatePlan,
  type IntentClassificationResult,
  processInputSection,
  processWorkflow,
  type WorkflowConfig,
  type WorkflowForm,
  WORKFLOWS,
  type WorkflowType,
} from "./workflow.ts";
export * from "./spellbook.ts";
