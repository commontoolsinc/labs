/**
 * Transaction Rollup - Condense transaction details for LLM consumption
 *
 * This module provides functions to parse large transaction journal and result files
 * and produce concise summaries suitable for LLMs to help humans debug software behavior.
 */

// Types for the transaction data structures
export interface JournalData {
  activity: Activity[];
  branches: Record<string, unknown>;
  reason: { ok: Record<string, unknown> };
  status: string;
}

export interface ResultData {
  ok: Record<string, SpaceData>;
}

export interface SpaceData {
  "application/commit+json": Record<string, CommitData>;
}

export interface CommitData {
  is: {
    since?: number;
    transaction: {
      cmd: string;
      sub: string;
      args: {
        changes: Record<string, ChangeData>;
      };
      exp?: number;
      iat?: number;
      iss?: string;
      prf?: unknown[];
    };
  };
}

export interface ChangeData {
  "application/json": Record<string, VersionData>;
}

export interface VersionData {
  is: {
    value: unknown;
    $TYPE?: string;
    argument?: Record<string, unknown>;
    internal?: Record<string, unknown>;
    resultRef?: unknown;
    spell?: unknown;
  };
}

export type Activity = ReadActivity | WriteActivity;

export interface ReadActivity {
  read: {
    path: (string | number)[];
    id: string;
    type: string;
    space: string;
    meta: Record<string, unknown>;
    schema?: unknown;
    rootSchema?: unknown;
  };
}

export interface WriteActivity {
  write: {
    id: string;
    path: (string | number)[];
    type: string;
    space: string;
    schema?: unknown;
    rootSchema?: unknown;
  };
}

// Condensed output types
export interface TransactionRollup {
  summary: string;
  command: string;
  changes: ChangesSummary[];
  activity: ActivitySummary;
  objectsChanged: number;
  includesHandlerCall: boolean;
  userFacingCharm?: string;
  linkResolutions?: LinkResolution[];
}

export interface ChangesSummary {
  objectId: string;
  objectIdShort: string;
  changedFields: FieldChange[];
  hasSpell: boolean;
  type?: string;
  resultRef?: string;
  resultRefShort?: string;
  isDeleted?: boolean;
}

export interface LinkResolution {
  from: string;
  to: string;
  path: string[];
}

export interface FieldChange {
  path: string;
  newValue: unknown;
  valueType: string;
  isComplex: boolean;
}

export interface ActivitySummary {
  totalOperations: number;
  reads: number;
  writes: number;
  writeDetails?: WriteDetail[];
  uniquePathsRead: string[];
}

export interface WriteDetail {
  path: string;
  objectId: string;
  objectIdShort: string;
}

/**
 * Main function to create a transaction rollup from journal and result data
 */
export function createTransactionRollup(
  journal: JournalData,
  result: ResultData,
  options: RollupOptions = {}
): TransactionRollup {
  const {
    includeReads = true,
    includeComplexValues = false,
    maxValueLength = 100,
    includeLinkResolutions = false,
  } = options;

  // Extract activity summary
  const activitySummary = summarizeActivity(journal.activity, includeReads);

  // Extract changes from result
  const changesSummaries = summarizeChanges(
    result,
    includeComplexValues,
    maxValueLength
  );

  // Extract link resolutions if requested
  const linkResolutions = includeLinkResolutions
    ? extractLinkResolutions(journal.activity)
    : undefined;

  // Determine if a handler was called
  const includesHandlerCall = detectHandlerCall(journal.activity, result);

  // Get command from transaction
  const command = extractCommand(result);

  // Extract user-facing charm ID
  const userFacingCharm = extractUserFacingCharm(result);

  // Create human-readable summary
  const summary = generateSummary(
    command,
    changesSummaries,
    activitySummary,
    includesHandlerCall,
    userFacingCharm
  );

  return {
    summary,
    command,
    changes: changesSummaries,
    activity: activitySummary,
    objectsChanged: changesSummaries.length,
    includesHandlerCall,
    userFacingCharm,
    linkResolutions,
  };
}

export interface RollupOptions {
  includeReads?: boolean;
  includeComplexValues?: boolean;
  maxValueLength?: number;
  includeLinkResolutions?: boolean;
}

/**
 * Summarize the activity log (reads and writes)
 */
function summarizeActivity(
  activity: Activity[],
  includeReads: boolean
): ActivitySummary {
  const reads: ReadActivity[] = [];
  const writes: WriteActivity[] = [];

  for (const act of activity) {
    if ("read" in act) {
      reads.push(act);
    } else if ("write" in act) {
      writes.push(act);
    }
  }

  const uniquePathsRead = includeReads
    ? Array.from(
        new Set(reads.map((r) => pathToString(r.read.path)))
      )
    : [];

  const writeDetails: WriteDetail[] = writes.map((w) => ({
    path: pathToString(w.write.path),
    objectId: w.write.id,
    objectIdShort: shortenId(w.write.id),
  }));

  return {
    totalOperations: activity.length,
    reads: reads.length,
    writes: writes.length,
    writeDetails,
    uniquePathsRead: includeReads ? uniquePathsRead : [],
  };
}

/**
 * Summarize changes from the result data
 */
function summarizeChanges(
  result: ResultData,
  includeComplexValues: boolean,
  maxValueLength: number
): ChangesSummary[] {
  const summaries: ChangesSummary[] = [];

  for (const spaceData of Object.values(result.ok)) {
    const commitData = spaceData["application/commit+json"];
    if (!commitData) continue;

    for (const commit of Object.values(commitData)) {
      const changes = commit.is?.transaction?.args?.changes;
      if (!changes) continue;

      for (const [objectId, changeData] of Object.entries(changes)) {
        const jsonData = changeData["application/json"];
        if (!jsonData) continue;

        for (const versionData of Object.values(jsonData)) {
          // Handle boolean tombstones (deletions)
          if (typeof versionData === "boolean") {
            summaries.push({
              objectId,
              objectIdShort: shortenId(objectId),
              changedFields: [],
              hasSpell: false,
              type: "deletion",
              isDeleted: versionData,
            });
            continue;
          }

          // Handle regular version data with 'is' field
          if (!versionData.is) continue;

          const changedFields = extractFieldChanges(
            versionData.is,
            includeComplexValues,
            maxValueLength
          );

          // Extract resultRef if present
          const resultRef = extractResultRef(versionData.is);

          summaries.push({
            objectId,
            objectIdShort: shortenId(objectId),
            changedFields,
            hasSpell: !!versionData.is.spell,
            type: versionData.is.$TYPE,
            resultRef,
            resultRefShort: resultRef ? shortenId(resultRef) : undefined,
          });
        }
      }
    }
  }

  return summaries;
}

/**
 * Extract field changes from a version's "is" state
 */
function extractFieldChanges(
  isState: VersionData["is"],
  includeComplexValues: boolean,
  maxValueLength: number
): FieldChange[] {
  const fields: FieldChange[] = [];

  // The data structure has value.argument, not just argument
  const valueObj = isState.value as any;

  // Handle direct value (not nested in argument)
  if (typeof valueObj === "string" || typeof valueObj === "number" || typeof valueObj === "boolean") {
    fields.push({
      path: "value",
      newValue: truncateValue(valueObj, maxValueLength),
      valueType: typeof valueObj,
      isComplex: false,
    });
    return fields;
  }

  // Handle null or undefined
  if (!valueObj) {
    return fields;
  }

  // Check argument fields (common place for user-facing data)
  const argumentObj = valueObj?.argument || isState.argument;
  if (argumentObj && typeof argumentObj === "object") {
    for (const [key, value] of Object.entries(argumentObj)) {
      const valueType = typeof value;
      const isComplex = valueType === "object" || Array.isArray(value);

      if (!isComplex) {
        // Simple scalar values
        fields.push({
          path: `argument.${key}`,
          newValue: truncateValue(value, maxValueLength),
          valueType,
          isComplex: false,
        });
      } else if (Array.isArray(value)) {
        // Arrays: show length and type info
        fields.push({
          path: `argument.${key}`,
          newValue: `[Array with ${value.length} items]`,
          valueType: "array",
          isComplex: true,
        });
      } else if (includeComplexValues) {
        // Other complex objects
        fields.push({
          path: `argument.${key}`,
          newValue: truncateValue(value, maxValueLength),
          valueType,
          isComplex: true,
        });
      }
    }
  }

  // Add other notable changes (e.g., internal state changes)
  const internalObj = valueObj?.internal || isState.internal;
  if (internalObj && includeComplexValues) {
    fields.push({
      path: "internal",
      newValue: "[Internal state object]",
      valueType: "object",
      isComplex: true,
    });
  }

  return fields;
}

/**
 * Detect if a handler was called based on activity patterns
 */
function detectHandlerCall(
  activity: Activity[],
  _result: ResultData
): boolean {
  // Look for handler-specific patterns
  // Handlers typically involve:
  // 1. Event streams ($event, $stream)
  // 2. Write operations
  // 3. Specific path patterns

  const hasEventStream = activity.some((act) => {
    if ("read" in act) {
      const pathStr = pathToString(act.read.path);
      return pathStr.includes("$event") || pathStr.includes("$stream");
    }
    return false;
  });

  const hasWrite = activity.some((act) => "write" in act);

  return hasEventStream && hasWrite;
}

/**
 * Extract the command from the result data
 */
function extractCommand(result: ResultData): string {
  for (const spaceData of Object.values(result.ok)) {
    const commitData = spaceData["application/commit+json"];
    if (!commitData) continue;

    for (const commit of Object.values(commitData)) {
      return commit.is?.transaction?.cmd || "unknown";
    }
  }
  return "unknown";
}

/**
 * Extract the user-facing charm ID from resultRef
 */
function extractUserFacingCharm(result: ResultData): string | undefined {
  for (const spaceData of Object.values(result.ok)) {
    const commitData = spaceData["application/commit+json"];
    if (!commitData) continue;

    for (const commit of Object.values(commitData)) {
      const changes = commit.is?.transaction?.args?.changes;
      if (!changes) continue;

      for (const changeData of Object.values(changes)) {
        const jsonData = changeData["application/json"];
        if (!jsonData) continue;

        for (const versionData of Object.values(jsonData)) {
          const resultRef = extractResultRef(versionData.is);
          if (resultRef) return resultRef;
        }
      }
    }
  }
  return undefined;
}

/**
 * Extract resultRef from a version's "is" state
 */
function extractResultRef(isState: VersionData["is"]): string | undefined {
  if (!isState) return undefined;

  const valueObj = (isState as any).value;

  // Only check for resultRef if value is an object
  if (valueObj && typeof valueObj === "object" && !Array.isArray(valueObj)) {
    const resultRef = valueObj.resultRef || (isState as any).resultRef;
    if (resultRef && typeof resultRef === "object") {
      const link = resultRef["/"]?.["link@1"];
      if (link && link.id) {
        return link.id;
      }
    }
  }

  return undefined;
}

/**
 * Extract link resolutions from activity
 */
function extractLinkResolutions(activity: Activity[]): LinkResolution[] {
  const resolutions: LinkResolution[] = [];

  for (const act of activity) {
    if ("read" in act && act.read.path.includes("link@1")) {
      // This is a link resolution
      const id = act.read.id;
      const path = act.read.path;

      resolutions.push({
        from: "context",
        to: id,
        path: path.map(String),
      });
    }
  }

  return resolutions;
}

/**
 * Generate a human-readable summary
 */
function generateSummary(
  command: string,
  changes: ChangesSummary[],
  activity: ActivitySummary,
  includesHandlerCall: boolean,
  userFacingCharm?: string
): string {
  const parts: string[] = [];

  if (includesHandlerCall) {
    parts.push("Handler was called");
  }

  parts.push(`Command: ${command}`);

  if (userFacingCharm) {
    parts.push(`User charm: ${shortenId(userFacingCharm)}`);
  }

  if (changes.length > 0) {
    const deletions = changes.filter((c) => c.isDeleted);
    const updates = changes.filter((c) => !c.isDeleted && c.changedFields.length > 0);

    if (deletions.length > 0) {
      parts.push(`Deleted ${deletions.length} object(s)`);
    }

    if (updates.length > 0) {
      const fieldChanges = updates.flatMap((c) => c.changedFields);
      const changeDesc = fieldChanges
        .map((f) => {
          const valueStr =
            typeof f.newValue === "string"
              ? `"${f.newValue}"`
              : JSON.stringify(f.newValue);
          return `${f.path} → ${valueStr}`;
        })
        .join(", ");
      parts.push(`Changed: ${changeDesc}`);
    }
  }

  parts.push(
    `Activity: ${activity.writes} write(s), ${activity.reads} read(s)`
  );

  return parts.join(". ");
}

/**
 * Helper functions
 */

function pathToString(path: (string | number)[]): string {
  return path.join(".");
}

function shortenId(id: string): string {
  if (id.startsWith("of:")) {
    return id.substring(3, 15) + "...";
  }
  if (id.length > 20) {
    return id.substring(0, 20) + "...";
  }
  return id;
}

function truncateValue(value: unknown, maxLength: number): unknown {
  if (typeof value === "string" && value.length > maxLength) {
    return value.substring(0, maxLength) + "...";
  }
  if (typeof value === "object" && value !== null) {
    return "[object]";
  }
  return value;
}

/**
 * Load and parse JSON files
 */
export async function loadTransactionDetails(
  journalPath: string,
  resultPath: string
): Promise<{ journal: JournalData; result: ResultData }> {
  const journalText = await Deno.readTextFile(journalPath);
  const resultText = await Deno.readTextFile(resultPath);

  const journal = JSON.parse(journalText) as JournalData;
  const result = JSON.parse(resultText) as ResultData;

  return { journal, result };
}

/**
 * Example usage function
 */
export async function rollupTransactionFiles(
  journalPath: string,
  resultPath: string,
  options?: RollupOptions
): Promise<TransactionRollup> {
  const { journal, result } = await loadTransactionDetails(
    journalPath,
    resultPath
  );
  return createTransactionRollup(journal, result, options);
}

// CLI usage example
if (import.meta.main) {
  const journalPath = Deno.args[0] || "./tx-details/journal.json";
  const resultPath = Deno.args[1] || "./tx-details/result.json";

  try {
    const rollup = await rollupTransactionFiles(journalPath, resultPath, {
      includeReads: true,
      includeComplexValues: false,
      maxValueLength: 100,
    });

    console.log("Transaction Rollup:");
    console.log("=".repeat(60));
    console.log(rollup.summary);
    console.log();
    console.log("Details:");
    console.log(JSON.stringify(rollup, null, 2));
  } catch (error) {
    console.error("Error:", error.message);
    Deno.exit(1);
  }
}
