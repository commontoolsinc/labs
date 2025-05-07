import { Cell } from "../../runner/src/index.ts";
import { Charm } from "./manager.ts";

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
