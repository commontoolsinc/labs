import { Cell, getEntityId, isCell, isStream } from "@commontools/runner";
import { isObj } from "@commontools/utils";
import { JSONSchema } from "@commontools/builder";
import { Charm, CharmManager } from "./charm.ts";
import { getIframeRecipe } from "./iframe/recipe.ts";
import { extractUserCode } from "./iframe/static.ts";

// Re-export workflow types and functions from workflow module
export type { WorkflowConfig, WorkflowType } from "./workflow.ts";

/**
 * Structure representing a successfully parsed mention in a prompt
 */
export interface ParsedMention {
  id: string;
  name: string;
  originalText: string;
  startIndex: number;
  endIndex: number;
  charm: Cell<Charm>;
}

/**
 * Result of processing a prompt with mentions
 */
export interface ProcessedPrompt {
  text: string; // Processed text with mentions replaced by readable names
  mentions: Record<string, Cell<Charm>>; // Map of mention IDs to charm cells
}
