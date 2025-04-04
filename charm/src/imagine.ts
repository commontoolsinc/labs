import {
  Cell,
  getEntityId,
  isCell,
  isStream,
} from "@commontools/runner";
import { isObj } from "@commontools/utils";
import { JSONSchema } from "@commontools/builder";
import { Charm, CharmManager } from "./charm.ts";
import { getIframeRecipe } from "./iframe/recipe.ts";
import { extractUserCode } from "./iframe/static.ts";

// Re-export workflow types and functions from workflow module
export type { 
  WorkflowType,
  WorkflowConfig,
} from "./workflow.ts";

export { 
  WORKFLOWS,
  generateWorkflowPreview,
  executeWorkflow as imagine,
} from "./workflow.ts";

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

/**
 * Formats a prompt with @mentions by replacing them with their readable names
 * and extracting the referenced Charm cells.
 *
 * @param rawPrompt The original prompt text that may contain @mentions
 * @param charmManager CharmManager instance to look up charms
 * @returns Processed prompt with mentions replaced and a mapping of mention IDs to Charm cells
 */
export async function formatPromptWithMentions(
  rawPrompt: string,
  charmManager: CharmManager,
): Promise<ProcessedPrompt> {
  // Regular expression to find @mentions in text
  // Matches @word where word contains letters, numbers, hyphens, or underscores
  const mentionRegex = /@([a-zA-Z0-9\-_]+)/g;

  const mentions: Record<string, Cell<Charm>> = {};
  const parsedMentions: ParsedMention[] = [];

  // First pass: Find all mentions and retrieve the charm cells
  let match;
  while ((match = mentionRegex.exec(rawPrompt)) !== null) {
    const mentionText = match[0]; // The full mention text (e.g., @charm-name)
    const mentionId = match[1]; // Just the identifier (e.g., charm-name)
    const startIndex = match.index;
    const endIndex = startIndex + mentionText.length;

    try {
      // Get all charms
      const allCharms = charmManager.getCharms().get();

      // Find the charm that matches this mention ID
      // First look for exact match with charm docId
      let matchingCharm = allCharms.find((charm) => {
        const id = getEntityId(charm);
        return id && id["/"] === mentionId;
      });

      // If no exact match, try matching by name
      if (!matchingCharm) {
        matchingCharm = allCharms.find((charm) => {
          const charmName = charm.get()["NAME"]?.toLowerCase();
          return charmName === mentionId.toLowerCase();
        });
      }

      if (matchingCharm) {
        try {
          // Verify we can actually access the charm data
          const charmData = matchingCharm.get();
          const charmName = charmData["NAME"] || "Untitled";

          // Additional logging for debugging
          console.log(
            `Found matching charm for @${mentionId}: ${charmName} (entity ID: ${
              getEntityId(matchingCharm)?.["/"] || "unknown"
            })`,
          );

          // Store and validate the parsed mention
          parsedMentions.push({
            id: mentionId,
            name: charmName,
            originalText: mentionText,
            startIndex,
            endIndex,
            charm: matchingCharm,
          });

          // Store the mention mapping with validation
          if (isCell(matchingCharm)) {
            mentions[mentionId] = matchingCharm;
            console.log(
              `Successfully mapped mention @${mentionId} to charm ${charmName}`,
            );
          } else {
            console.warn(
              `Found matching charm for @${mentionId} but it's not a valid Cell object`,
            );
          }
        } catch (err) {
          console.error(
            `Error processing matching charm for @${mentionId}:`,
            err,
          );
        }
      } else {
        console.warn(`No matching charm found for mention @${mentionId}`);
      }
    } catch (error) {
      console.warn(`Failed to resolve mention ${mentionText}:`, error);
    }
  }

  // Second pass: Replace mentions with their readable names
  // Sort in reverse order to avoid messing up indices when replacing
  parsedMentions.sort((a, b) => b.startIndex - a.startIndex);

  let processedText = rawPrompt;
  for (const mention of parsedMentions) {
    processedText = processedText.substring(0, mention.startIndex) +
      `${mention.name} (referenced as @${mention.id})` +
      processedText.substring(mention.endIndex);
  }

  return {
    text: processedText,
    mentions,
  };
}
