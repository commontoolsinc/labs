export {
  charmId,
  charmListSchema,
  CharmManager,
  getRecipeIdFromCharm,
  type NameSchema,
  nameSchema,
  processSchema,
  type UISchema,
  uiSchema,
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
export {
  buildFullRecipe,
  getIframeRecipe,
  type IFrameRecipe,
} from "./iframe/recipe.ts";
export { type ParsedMention, type ProcessedPrompt } from "./imagine.ts";
export { formatPromptWithMentions, parseComposerDocument } from "./format.ts";

export const DEFAULT_MODEL = [
  "anthropic:claude-sonnet-4-5",
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
