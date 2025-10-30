/**
 * Transaction Summary - Condense transaction details for LLM consumption
 *
 * This module provides functions to extract and condense transaction information
 * into concise summaries suitable for LLMs to help humans debug software behavior.
 */

import type {
  IExtendedStorageTransaction,
  ITransactionJournal,
  Activity,
  IMemorySpaceAddress,
  IAttestation,
} from "./interface.ts";
import type { MemorySpace } from "../runtime.ts";

/**
 * Condensed summary of a transaction suitable for LLM consumption
 */
export interface TransactionSummary {
  /** Human-readable one-line summary */
  summary: string;

  /** Activity statistics */
  activity: {
    totalOperations: number;
    reads: number;
    writes: number;
  };

  /** Changed object IDs (shortened) */
  changedObjects: string[];

  /** Number of novelty (new) attestations */
  noveltyCount: number;

  /** Transaction status */
  status: "ready" | "pending" | "done" | "error";
}

/**
 * Create a condensed transaction summary from an IExtendedStorageTransaction
 *
 * @param tx - The completed transaction
 * @param space - Optional memory space to filter changes (defaults to first space found)
 * @returns Condensed summary for LLM consumption
 */
export function summarizeTransaction(
  tx: IExtendedStorageTransaction,
  space?: MemorySpace,
): TransactionSummary {
  const status = tx.status();
  const journal = status.journal;

  // Summarize activity
  const activity = summarizeActivity(journal);

  // Get changed objects
  const changedObjects = extractChangedObjects(journal);

  // Count novelty
  let noveltyCount = 0;
  if (space) {
    noveltyCount = Array.from(journal.novelty(space)).length;
  }

  // Generate summary
  const summary = generateSummary(activity, changedObjects.length, status.status);

  return {
    summary,
    activity,
    changedObjects,
    noveltyCount,
    status: status.status,
  };
}

/**
 * Format transaction summary as a string for LLM consumption
 *
 * @param tx - The completed transaction
 * @param space - Optional memory space to filter changes
 * @returns Formatted string summary
 */
export function formatTransactionSummary(
  tx: IExtendedStorageTransaction,
  space?: MemorySpace,
): string {
  const summary = summarizeTransaction(tx, space);

  const parts: string[] = [];

  // Status
  parts.push(`Status: ${summary.status}`);

  // Main summary
  parts.push(summary.summary);

  // Activity details
  if (summary.activity.writes > 0 || summary.activity.reads > 0) {
    parts.push(
      `Activity: ${summary.activity.writes} write(s), ${summary.activity.reads} read(s)`,
    );
  }

  // Changed objects
  if (summary.changedObjects.length > 0) {
    const objectList = summary.changedObjects
      .slice(0, 3)
      .map((id) => shortenId(id))
      .join(", ");
    const more = summary.changedObjects.length > 3
      ? ` and ${summary.changedObjects.length - 3} more`
      : "";
    parts.push(`Modified: ${objectList}${more}`);
  }

  // Novelty
  if (summary.noveltyCount > 0) {
    parts.push(`New attestations: ${summary.noveltyCount}`);
  }

  return parts.join(". ");
}

/**
 * Summarize activity from transaction journal
 */
function summarizeActivity(journal: ITransactionJournal): {
  totalOperations: number;
  reads: number;
  writes: number;
} {
  let reads = 0;
  let writes = 0;

  for (const activity of journal.activity()) {
    if ("read" in activity) {
      reads++;
    } else if ("write" in activity) {
      writes++;
    }
  }

  return {
    totalOperations: reads + writes,
    reads,
    writes,
  };
}

/**
 * Extract unique object IDs that were written to
 */
function extractChangedObjects(journal: ITransactionJournal): string[] {
  const objectIds = new Set<string>();

  for (const activity of journal.activity()) {
    if ("write" in activity && activity.write) {
      objectIds.add(activity.write.id);
    }
  }

  return Array.from(objectIds);
}

/**
 * Generate a human-readable summary
 */
function generateSummary(
  activity: { writes: number; reads: number },
  objectsChanged: number,
  status: string,
): string {
  if (status === "error") {
    return "Transaction failed";
  }

  if (activity.writes === 0 && activity.reads === 0) {
    return "No objects modified";
  }

  if (activity.writes === 0) {
    return "Read-only transaction";
  }

  if (objectsChanged === 0) {
    return "No objects modified";
  }

  if (objectsChanged === 1) {
    return "Modified 1 object";
  }

  return `Modified ${objectsChanged} objects`;
}

/**
 * Shorten an ID for display
 */
function shortenId(id: string): string {
  if (id.startsWith("of:")) {
    return id.substring(3, 15) + "...";
  }
  if (id.length > 20) {
    return id.substring(0, 20) + "...";
  }
  return id;
}
