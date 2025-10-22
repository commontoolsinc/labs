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
  "/": { entityId: { "/": DEFAULT_PATTERN_ID } },
};

function resolveWishTarget(
  resolution: WishResolution,
  runtime: IRuntime,
  space: MemorySpace,
  tx: IExtendedStorageTransaction,
): Cell<any> | undefined {
  return runtime.getCellFromEntityId(
    space,
    resolution.entityId,
    resolution.path,
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
    const baseSegment = segments.shift();
    if (!baseSegment) return undefined;
    const key = `#${baseSegment}`;
    return { key, path: segments };
  }

  if (trimmed.startsWith("/")) {
    const segments = trimmed.split("/").filter((segment) => segment.length > 0);
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

    const resolution = WISH_TARGETS[parsed.key];
    if (!resolution) {
      console.error(`Wish target "${wishTarget}" is not recognized.`);
      sendResult(tx, hasDefault ? defaultCell : undefined);
      return;
    }

    const baseCell = resolveWishTarget(
      resolution,
      runtime,
      parentCell.space,
      tx,
    );

    if (!baseCell) {
      console.error(`Wish target "${wishTarget}" is not recognized.`);
      sendResult(tx, hasDefault ? defaultCell : undefined);
      return;
    }

    let resolvedCell = baseCell.withTx(tx);
    for (const segment of parsed.path) {
      resolvedCell = resolvedCell.key(segmentToPropertyKey(segment));
    }
    resolvedCell = resolvedCell.resolveAsCell();

    sendResult(tx, resolvedCell);
  };
}
