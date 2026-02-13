export {
  getPatternIdFromPiece,
  getRecipeIdFromPiece,
  pieceId,
  PieceManager,
} from "./manager.ts";
export {
  addFavorite,
  getHomeFavorites,
  isFavorite,
  removeFavorite,
} from "./favorites.ts";
export {
  addJournalEntry,
  getHomeJournal,
  getRecentEntries,
  type Journal,
  type JournalEntry,
  type JournalEventType,
  type JournalSnapshot,
  searchJournalByTag,
} from "./journal.ts";
export { searchPieces } from "./search.ts";
export {
  castNewPattern,
  castNewRecipe,
  compileAndRunPattern,
  compileAndRunRecipe,
  compilePattern,
  compileRecipe,
  generateNewPatternVersion,
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
  addGithubPattern,
  addGithubRecipe,
  castSpellAsPiece,
  createDataPiece,
  fixItPiece,
  modifyPiece,
  renamePiece,
} from "./commands.ts";
export {
  buildFullPattern,
  buildFullRecipe,
  getIframePattern,
  getIframeRecipe,
  type IFramePattern,
  type IFrameRecipe,
} from "./iframe/pattern.ts";
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
