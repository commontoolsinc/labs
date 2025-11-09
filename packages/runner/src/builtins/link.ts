import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { type JSONSchema, NAME } from "../builder/types.ts";

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

  for (let i = 0; i < charms.length; i++) {
    const charmCell = charmsCell.key(i);
    const charmName = charmCell.get()?.[NAME];
    if (charmName === name) return charmCell;
  }

  return undefined;
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
  sendResult: (
    tx: IExtendedStorageTransaction,
    result: {
      success: Cell<string | undefined>;
      error: Cell<string | undefined>;
    },
  ) => void,
  _addCancel: (cancel: () => void) => void,
  cause: any,
  parentCell: Cell<any>,
  runtime: IRuntime,
): Action {
  let cellsInitialized = false;
  let successCell: Cell<string | undefined>;
  let errorCell: Cell<string | undefined>;

  return (tx: IExtendedStorageTransaction) => {
    // Initialize cells on first run - INSIDE the transaction for concurrency safety
    if (!cellsInitialized) {
      successCell = runtime.getCell<string | undefined>(
        parentCell.space,
        { link: { success: cause } },
        undefined,
        tx,
      );
      errorCell = runtime.getCell<string | undefined>(
        parentCell.space,
        { link: { error: cause } },
        undefined,
        tx,
      );
      sendResult(tx, { success: successCell, error: errorCell });
      cellsInitialized = true;
    }

    try {
      const inputsWithTx = inputsCell.withTx(tx);
      const sourceValue = inputsWithTx.key(0).asSchema(SOURCE_SCHEMA).get();
      const targetValue = inputsWithTx.key(1).asSchema(TARGET_SCHEMA).get();

      const source = typeof sourceValue === "string" ? sourceValue.trim() : "";
      const target = typeof targetValue === "string" ? targetValue.trim() : "";

      if (!source || !target) {
        const errorMsg = "Both source and target paths are required";
        console.error("Link error:", errorMsg);
        errorCell.withTx(tx).set(errorMsg);
        successCell.withTx(tx).set(undefined);
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
        const errorMsg =
          `Source charm "${sourceParsed.charmName}" not found. Available charms: ${
            charmNames || "none"
          }`;
        console.error("Link error:", errorMsg);
        errorCell.withTx(tx).set(errorMsg);
        successCell.withTx(tx).set(undefined);
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
        const errorMsg =
          `Target charm "${targetParsed.charmName}" not found. Available charms: ${
            charmNames || "none"
          }`;
        console.error("Link error:", errorMsg);
        errorCell.withTx(tx).set(errorMsg);
        successCell.withTx(tx).set(undefined);
        return;
      }

      // Build full paths including cell type if specified
      const sourceFullPath = sourceParsed.cellType
        ? [sourceParsed.cellType, ...sourceParsed.path]
        : sourceParsed.path;
      const targetFullPath = targetParsed.cellType
        ? [targetParsed.cellType, ...targetParsed.path]
        : targetParsed.path;

      // Navigate to the source cell
      const sourceCell = navigateToCell(sourceCharm, sourceFullPath).withTx(tx);

      // Navigate to the target path, popping the last segment as the key to set
      const targetKey = targetFullPath.pop();
      if (targetKey === undefined) {
        throw new Error("Target path cannot be empty");
      }

      // Navigate to the parent of where we want to set the link
      const targetParentCell = navigateToCell(targetCharm, targetFullPath)
        .withTx(
          tx,
        );

      // Create link by setting the source cell as the value
      // This is the same approach used in CharmManager.link()
      targetParentCell.key(targetKey).set(sourceCell);

      const successMsg = `Successfully linked ${target} → ${source}`;
      console.log("Link created:", successMsg);
      successCell.withTx(tx).set(successMsg);
      errorCell.withTx(tx).set(undefined);
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error("Link creation failed:", errorMsg);
      errorCell.withTx(tx).set(errorMsg);
      successCell.withTx(tx).set(undefined);
    }
  };
}
