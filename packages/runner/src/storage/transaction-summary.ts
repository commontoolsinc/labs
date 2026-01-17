/**
 * Transaction Summary - Condense transaction details for LLM consumption
 *
 * This module provides functions to extract and condense transaction information
 * into concise summaries suitable for LLMs to help humans debug software behavior.
 */

import type {
  Activity,
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  StorageTransactionStatus,
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
    reads: number;
    writes: number;
  };

  /** Actual writes with values */
  writes: WriteDetail[];
}

/**
 * Details of what was actually written
 */
export interface WriteDetail {
  /** Object ID (shortened) */
  objectId: string;

  /** Full object ID */
  fullObjectId: string;

  /** Path that was written to */
  path: string;

  /** The value that was written */
  value: unknown;

  /** The previous value (if available) */
  previousValue?: unknown;

  /** Whether this was a deletion */
  isDeleted: boolean;
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

  // Summarize activity
  const activity = summarizeActivity(status.activity);

  // Extract actual writes with values
  const writes = space ? extractWrites(status, space) : [];

  // Generate summary
  const summary = generateSummary(activity, writes, status.status);

  return {
    summary,
    activity,
    writes,
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

  // If there are detailed writes, format them grouped by object
  if (summary.writes.length > 0) {
    // Group writes by object
    const byObject = new Map<string, WriteDetail[]>();
    for (const write of summary.writes) {
      const existing = byObject.get(write.fullObjectId) || [];
      existing.push(write);
      byObject.set(write.fullObjectId, existing);
    }

    const objectIds = Array.from(byObject.keys());

    // If single object, skip the header
    if (objectIds.length === 1) {
      const writes = byObject.get(objectIds[0])!;
      for (const write of writes) {
        parts.push(formatWrite(write));
      }
    } else {
      // Multiple objects, show headers
      for (const objectId of objectIds) {
        const writes = byObject.get(objectId)!;
        parts.push(`Object ${shortenId(objectId)}:`);
        for (const write of writes) {
          parts.push(`  ${formatWrite(write)}`);
        }
      }
    }
  } else if (summary.activity.writes > 0 && !space) {
    // Hint that we need the space parameter
    parts.push("(pass space parameter to see what was written)");
  } else {
    // No writes or writes occurred elsewhere - show generic summary
    parts.push(summary.summary);
  }

  // Add read count if significant
  if (summary.activity.reads > 10) {
    parts.push(`(${summary.activity.reads} reads for context)`);
  }

  return parts.join("\n");
}

/**
 * Format a single write as "path: old → new" or "path = value"
 */
function formatWrite(write: WriteDetail): string {
  if (write.isDeleted) {
    return `${write.path}: deleted`;
  }

  const newVal = formatValueForSummary(write.value);

  // If we have previous value, show before → after
  if (write.previousValue !== undefined) {
    const oldVal = formatValueForSummary(write.previousValue);
    return `${write.path}: ${oldVal} → ${newVal}`;
  }

  // No previous value, just show assignment
  return `${write.path} = ${newVal}`;
}

/**
 * Debug helper to see all write operations regardless of space
 * Useful for understanding what's happening when writes aren't showing up
 */
export function debugTransactionWrites(
  tx: IExtendedStorageTransaction,
): string {
  const status = tx.status();

  const parts: string[] = [];
  parts.push("=== Transaction Debug ===");

  // List all write operations from activity
  const writes: IMemorySpaceAddress[] = [];
  for (const activity of status.activity) {
    if ("write" in activity && activity.write) {
      writes.push(activity.write);
    }
  }

  parts.push(`Total writes in activity: ${writes.length}`);

  for (const write of writes) {
    const pathStr = write.path.join(".");
    parts.push(`  Write to: ${write.id}/${pathStr} (space: ${write.space})`);
  }

  // List all spaces that have novelty
  parts.push("\nSpaces with novelty:");
  const spaces = new Set<MemorySpace>();
  for (const write of writes) {
    spaces.add(write.space);
  }

  for (const space of spaces) {
    const chronicle = status.branches.get(space);
    const noveltyCount = chronicle ? Array.from(chronicle.novelty()).length : 0;
    parts.push(`  ${space}: ${noveltyCount} attestation(s)`);
  }

  return parts.join("\n");
}

/**
 * Summarize activity from transaction activity log
 */
function summarizeActivity(activity: Activity[]): {
  reads: number;
  writes: number;
} {
  let reads = 0;
  let writes = 0;

  for (const act of activity) {
    if ("read" in act) {
      reads++;
    } else if ("write" in act) {
      writes++;
    }
  }

  return { reads, writes };
}

/**
 * Extract actual writes with their values from novelty attestations
 */
function extractWrites(
  status: StorageTransactionStatus,
  space: MemorySpace,
): WriteDetail[] {
  const chronicle = status.branches.get(space);
  if (!chronicle) {
    return [];
  }

  // Build a map of previous values from history
  const previousValues = new Map<string, unknown>();
  for (const attestation of chronicle.history()) {
    const key = `${attestation.address.id}:${
      attestation.address.path.join(".")
    }`;
    previousValues.set(key, attestation.value);
  }

  const writes: WriteDetail[] = [];

  for (const attestation of chronicle.novelty()) {
    const fullObjectId = attestation.address.id;
    const path = attestation.address.path.join(".");
    const value = attestation.value;
    const isDeleted = value === undefined;

    const key = `${fullObjectId}:${path}`;
    const previousValue = previousValues.get(key);

    writes.push({
      objectId: shortenId(fullObjectId),
      fullObjectId,
      path,
      value: truncateValue(value, 100),
      previousValue: truncateValue(previousValue, 100),
      isDeleted,
    });
  }

  return writes;
}

/**
 * Truncate a value for display
 */
function truncateValue(value: unknown, maxLength: number): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;

  if (typeof value === "string") {
    return value.length > maxLength
      ? value.substring(0, maxLength) + "..."
      : value;
  }

  if (Array.isArray(value)) {
    return `[Array: ${value.length} items]`;
  }

  if (typeof value === "object") {
    const str = JSON.stringify(value);
    return str.length > maxLength ? str.substring(0, maxLength) + "..." : value;
  }

  return value;
}

/**
 * Generate a human-readable summary
 */
function generateSummary(
  activity: { writes: number; reads: number },
  writes: WriteDetail[],
  status: string,
): string {
  if (status === "error") {
    return "Transaction failed";
  }

  if (activity.writes === 0 && activity.reads === 0) {
    return "Empty transaction";
  }

  if (activity.writes === 0) {
    return "Read-only transaction";
  }

  if (writes.length === 0) {
    return `${activity.writes} write(s) (details unavailable without space parameter)`;
  }

  // Describe the actual writes
  const parts: string[] = [];

  for (const write of writes.slice(0, 3)) {
    if (write.isDeleted) {
      parts.push(`Deleted ${write.path}`);
    } else {
      const valueStr = formatValueForSummary(write.value);
      parts.push(`${write.path} = ${valueStr}`);
    }
  }

  if (writes.length > 3) {
    parts.push(`... and ${writes.length - 3} more`);
  }

  return parts.join("; ");
}

/**
 * Format a value for the summary line
 */
function formatValueForSummary(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") {
    const truncated = value.length > 50
      ? value.substring(0, 50) + "..."
      : value;
    return `"${truncated}"`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
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
