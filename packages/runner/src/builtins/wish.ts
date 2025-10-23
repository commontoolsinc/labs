import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../storage/interface.ts";
import type { EntityId } from "../create-ref.ts";
import { ALL_CHARMS_ID, DEFAULT_PATTERN_ID } from "./well-known.ts";
import type { JSONSchema } from "../builder/types.ts";

type WishResolution = {
  entityId: EntityId;
  path?: readonly string[];
};

const WISH_TARGETS: Record<string, WishResolution> = {
  "#allCharms": { entityId: { "/": ALL_CHARMS_ID } },
};

function resolveWishTarget(
  resolution: WishResolution,
  runtime: IRuntime,
  space: MemorySpace,
  tx: IExtendedStorageTransaction,
): Cell<unknown> | undefined {
  const path = resolution.path ? [...resolution.path] : [];
  return runtime.getCellFromEntityId(
    space,
    resolution.entityId,
    path,
    undefined,
    tx,
  );
}

type ParsedWishTarget = {
  key: string;
  path: string[];
};

function parseWishTarget(target: string): ParsedWishTarget | undefined {
  const trimmed = target.trim();
  if (trimmed === "") return undefined;

  if (trimmed.startsWith("#")) {
    const rest = trimmed.slice(1);
    const segments = rest.split("/").filter((segment) => segment.length > 0);

    // Check if it's a well-known target like #allCharms
    if (segments.length > 0) {
      const baseSegment = segments[0];
      const key = `#${baseSegment}`;
      // If it's a known well-known target, use it with remaining path
      if (key === "#allCharms") {
        return { key, path: segments.slice(1) };
      }
    }

    // Otherwise, # refers to default pattern (child of space cell)
    // All segments become the path within the default pattern
    return { key: "#", path: segments };
  }

  if (trimmed.startsWith("/")) {
    const segments = trimmed.split("/").filter((segment) => segment.length > 0);
    // "/" refers to the space cell, segments are the path within it
    return { key: "/", path: segments };
  }

  return undefined;
}

function segmentToPropertyKey(segment: string): PropertyKey {
  return /^\d+$/.test(segment) ? Number(segment) : segment;
}

const TARGET_SCHEMA = {
  type: "string",
  default: "",
} as const satisfies JSONSchema;

export function wish(
  inputsCell: Cell<[unknown, unknown]>,
  sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
  _addCancel: (cancel: () => void) => void,
  _cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: IRuntime,
): Action {
  return (tx: IExtendedStorageTransaction) => {
    const inputsWithTx = inputsCell.withTx(tx);
    const values = inputsWithTx.get() ?? [];
    const targetValue = inputsWithTx.key(0).asSchema(TARGET_SCHEMA).get();
    const hasDefault = values.length >= 2 && values[1] !== null &&
      values[1] !== undefined;
    const defaultCell = hasDefault ? inputsWithTx.key(1) : undefined;

    const wishTarget = typeof targetValue === "string"
      ? targetValue.trim()
      : "";

    if (wishTarget === "") {
      sendResult(tx, hasDefault ? defaultCell : undefined);
      return;
    }

    const parsed = parseWishTarget(wishTarget);
    if (!parsed) {
      console.error(`Wish target "${wishTarget}" is not recognized.`);
      sendResult(tx, hasDefault ? defaultCell : undefined);
      return;
    }

    let baseCell: Cell<unknown> | undefined;

    // Check if it's a well-known entity ID target (#allCharms)
    const resolution = WISH_TARGETS[parsed.key];
    if (resolution) {
      baseCell = resolveWishTarget(
        resolution,
        runtime,
        parentCell.space,
        tx,
      );
    } else if (parsed.key === "/") {
      // "/" refers to the space cell - use the space DID as the cause
      const spaceCell = runtime.getCell(
        parentCell.space,
        parentCell.space, // Use the space DID as the cause
        undefined,
      ).withTx(tx);

      // If there's a path, resolve the first segment as a cell reference
      if (parsed.path.length > 0) {
        const firstSegment = parsed.path[0];
        const fieldCell = (spaceCell as any).key(firstSegment);
        // Resolve the cell reference to get the actual linked cell
        baseCell = fieldCell.resolveAsCell();
        // Remove the first segment since we've resolved it
        parsed.path = parsed.path.slice(1);
      } else {
        // No path, just return the space cell itself
        baseCell = spaceCell;
      }
    } else if (parsed.key === "#") {
      // "#" refers to the default pattern - get it from the space cell
      const spaceCell = runtime.getCell(
        parentCell.space,
        parentCell.space,
        undefined,
      ).withTx(tx);
      // Access defaultPattern field and resolve it as a cell
      const defaultPatternField = (spaceCell as any).key("defaultPattern");
      baseCell = defaultPatternField.resolveAsCell();
    }

    if (!baseCell) {
      console.error(`Wish target "${wishTarget}" is not recognized.`);
      sendResult(tx, hasDefault ? defaultCell : undefined);
      return;
    }

    let resolvedCell = baseCell;
    for (const segment of parsed.path) {
      resolvedCell = resolvedCell.withTx(tx).key(
        segmentToPropertyKey(segment) as never,
      );
    }

    // If the resolved value is undefined and we have a default, use the default
    if (hasDefault && resolvedCell.withTx(tx).get() === undefined) {
      sendResult(tx, defaultCell);
    } else {
      sendResult(tx, resolvedCell.withTx(tx));
    }
  };
}
