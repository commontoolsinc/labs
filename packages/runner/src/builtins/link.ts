import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { JSONSchema } from "../builder/types.ts";

const SOURCE_SCHEMA = {
  type: "string",
  default: "",
} as const satisfies JSONSchema;

const TARGET_SCHEMA = {
  type: "string",
  default: "",
} as const satisfies JSONSchema;

/**
 * Parse a slash-separated path into components
 * Supports formats like:
 * - "CharmName/result/field"
 * - "CharmName/input/field"
 * - "CharmName/field" (no cellType specified)
 */
function parsePath(pathString: string): {
  charmName: string;
  cellType?: "result" | "input";
  path: string[];
} {
  const trimmed = pathString.trim();
  if (!trimmed) {
    throw new Error("Path cannot be empty");
  }

  // Remove leading slash if present
  const normalized = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const segments = normalized.split("/").filter((s) => s.length > 0);

  if (segments.length === 0) {
    throw new Error("Path must have at least one segment (charm name)");
  }

  const charmName = segments[0];
  let cellType: "result" | "input" | undefined;
  let path: string[];

  // Check if second segment is a cell type keyword
  if (
    segments.length > 1 &&
    (segments[1] === "result" || segments[1] === "input")
  ) {
    cellType = segments[1];
    path = segments.slice(2);
  } else {
    // No explicit cell type, use remaining segments as path
    path = segments.slice(1);
  }

  return { charmName, cellType, path };
}

/**
 * Find a charm by name with fuzzy matching
 */
function findCharmByName(
  charmsCell: Cell<any>,
  name: string,
): Cell<any> | undefined {
  const charms = charmsCell.get();
  if (!Array.isArray(charms) || charms.length === 0) {
    return undefined;
  }

  // Try exact match first
  const exactMatch = charms.find((c: any) => {
    const charmName = c?.["[NAME]"];
    return charmName === name;
  });
  if (exactMatch) return exactMatch;

  // Case-insensitive match
  const lowerName = name.toLowerCase();
  const caseInsensitive = charms.find((c: any) => {
    const charmName = c?.["[NAME]"];
    return charmName?.toLowerCase() === lowerName;
  });
  if (caseInsensitive) return caseInsensitive;

  // Partial match (contains)
  const partial = charms.find((c: any) => {
    const charmName = c?.["[NAME]"];
    return charmName?.toLowerCase().includes(lowerName);
  });
  return partial;
}

/**
 * Navigate to a cell given a charm and path segments
 */
function navigateToCell(charm: Cell<any>, segments: string[]): Cell<any> {
  let current: Cell<any> = charm;
  for (const segment of segments) {
    current = current.key(segment);
  }
  return current;
}

/**
 * Get list of all charms from the space
 */
function getAllCharms(
  runtime: IRuntime,
  parentCell: Cell<any>,
  tx: IExtendedStorageTransaction,
): Cell<any> {
  // Get mentionable charms
  const spaceCell = runtime.getCell(
    parentCell.space,
    parentCell.space,
    undefined,
    tx,
  );
  const mentionableCell = spaceCell
    .key("defaultPattern")
    .key("backlinksIndex")
    .key("mentionable")
    .resolveAsCell();

  return mentionableCell;
}

/**
 * Built-in link function
 * Creates a write redirect link from source to target
 *
 * Input format:
 * {
 *   source: "CharmName/result/field",
 *   target: "OtherCharm/input/field"
 * }
 */
export function link(
  inputsCell: Cell<[unknown, unknown]>,
  sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
  _addCancel: (cancel: () => void) => void,
  _cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: IRuntime,
): Action {
  return (tx: IExtendedStorageTransaction) => {
    try {
      const inputsWithTx = inputsCell.withTx(tx);
      const sourceValue = inputsWithTx.key(0).asSchema(SOURCE_SCHEMA).get();
      const targetValue = inputsWithTx.key(1).asSchema(TARGET_SCHEMA).get();

      const source = typeof sourceValue === "string" ? sourceValue.trim() : "";
      const target = typeof targetValue === "string" ? targetValue.trim() : "";

      if (!source || !target) {
        const error = "Both source and target paths are required";
        console.error("Link error:", error);
        sendResult(tx, { error });
        return;
      }

      // Parse both paths
      const sourceParsed = parsePath(source);
      const targetParsed = parsePath(target);

      // Get all charms
      const charmsCell = getAllCharms(runtime, parentCell, tx);

      // Find source charm
      const sourceCharm = findCharmByName(charmsCell, sourceParsed.charmName);
      if (!sourceCharm) {
        const allCharms = charmsCell.get() || [];
        const charmNames = allCharms
          .map((c: any) => c?.["[NAME]"])
          .filter(Boolean)
          .join(", ");
        const error =
          `Source charm "${sourceParsed.charmName}" not found. Available charms: ${charmNames || "none"}`;
        console.error("Link error:", error);
        sendResult(tx, { error });
        return;
      }

      // Find target charm
      const targetCharm = findCharmByName(charmsCell, targetParsed.charmName);
      if (!targetCharm) {
        const allCharms = charmsCell.get() || [];
        const charmNames = allCharms
          .map((c: any) => c?.["[NAME]"])
          .filter(Boolean)
          .join(", ");
        const error =
          `Target charm "${targetParsed.charmName}" not found. Available charms: ${charmNames || "none"}`;
        console.error("Link error:", error);
        sendResult(tx, { error });
        return;
      }

      // Build full paths including cell type if specified
      const sourceFullPath = sourceParsed.cellType
        ? [sourceParsed.cellType, ...sourceParsed.path]
        : sourceParsed.path;
      const targetFullPath = targetParsed.cellType
        ? [targetParsed.cellType, ...targetParsed.path]
        : targetParsed.path;

      // Navigate to cells
      const sourceCell = navigateToCell(sourceCharm, sourceFullPath).withTx(tx);
      const targetCell = navigateToCell(targetCharm, targetFullPath).withTx(tx);

      // Create write redirect link (alias)
      // This makes targetCell an alias of sourceCell:
      // - Reading targetCell shows sourceCell's value
      // - Writing to targetCell writes to sourceCell
      const writeRedirectLink = sourceCell.getAsWriteRedirectLink();
      targetCell.setRaw(writeRedirectLink);

      const success = `Successfully linked ${target} → ${source}`;
      console.log("Link created:", success);
      sendResult(tx, { success });
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error("Link creation failed:", errorMsg);
      sendResult(tx, { error: errorMsg });
    }
  };
}
