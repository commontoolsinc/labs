import { type WishKey } from "@commontools/api";
import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../storage/interface.ts";
import type { EntityId } from "../create-ref.ts";
import { ALL_CHARMS_ID } from "./well-known.ts";
import type { JSONSchema } from "../builder/types.ts";

type WishResolution = {
  entityId: EntityId;
  path?: readonly string[];
};

const WISH_TARGETS: Partial<Record<WishKey, WishResolution>> = {
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
  key: "/" | WishKey;
  path: string[];
};

function parseWishTarget(target: string): ParsedWishTarget | undefined {
  const trimmed = target.trim();
  if (trimmed === "") return undefined;

  if (trimmed.startsWith("#")) {
    const segments = trimmed.slice(1).split("/").filter((segment) =>
      segment.length > 0
    );
    if (segments.length === 0) return undefined;
    const key = `#${segments[0]}` as WishKey;
    return { key, path: segments.slice(1) };
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

    const getSpaceCellWithTx = () =>
      runtime
        .getCell(
          parentCell.space,
          parentCell.space, // Use the space DID as the cause
          undefined,
        )
        .withTx(tx);

    const followPath = (
      start: Cell<unknown>,
      segments: string[],
    ): Cell<unknown> => {
      let current = start.withTx(tx);

      for (const segment of segments) {
        const keyed = current.key(
          segmentToPropertyKey(segment) as never,
        );
        let nextCell: Cell<unknown>;
        try {
          nextCell = keyed.resolveAsCell().withTx(tx);
        } catch {
          nextCell = keyed.withTx(tx);
        }
        current = nextCell;
      }

      return current;
    };

    const safeResolve = (cell: Cell<unknown>) => {
      try {
        return cell.resolveAsCell();
      } catch {
        return cell;
      }
    };

    let resolvedCell: Cell<unknown> | undefined;

    const needsSpaceCell = parsed.key === "/" ||
      parsed.key === "#default" ||
      parsed.key === "#mentionable" ||
      parsed.key === "#recent";
    const spaceCell = needsSpaceCell ? getSpaceCellWithTx() : undefined;

    const resolveDefaultPattern = () => {
      if (!spaceCell) return undefined;
      const defaultPatternField = (spaceCell as any).key("defaultPattern");
      try {
        return defaultPatternField.resolveAsCell();
      } catch {
        return undefined;
      }
    };

    if (parsed.key === "/") {
      resolvedCell = followPath(spaceCell!, parsed.path);
    } else if (parsed.key === "#default") {
      const defaultPatternCell = resolveDefaultPattern();
      if (!defaultPatternCell) {
        console.error(
          `Wish target "${wishTarget}" is not recognized (missing default pattern).`,
        );
        sendResult(tx, hasDefault ? defaultCell : undefined);
        return;
      }
      resolvedCell = followPath(defaultPatternCell, parsed.path);
    } else if (parsed.key === "#mentionable") {
      const defaultPatternCell = resolveDefaultPattern();
      if (!defaultPatternCell) {
        console.error(
          `Wish target "${wishTarget}" is not recognized (missing default pattern).`,
        );
        sendResult(tx, hasDefault ? defaultCell : undefined);
        return;
      }
      resolvedCell = followPath(defaultPatternCell, [
        "backlinksIndex",
        "mentionable",
        ...parsed.path,
      ]);
    } else if (parsed.key === "#recent") {
      if (!spaceCell) {
        console.error(`Wish target "${wishTarget}" is not recognized.`);
        sendResult(tx, hasDefault ? defaultCell : undefined);
        return;
      }
      const recentField = (spaceCell as any).key("recentCharms");
      const recentCell = safeResolve(recentField);
      resolvedCell = followPath(recentCell, parsed.path);
    } else if (parsed.key === "#now") {
      if (parsed.path.length > 0) {
        console.error(`Wish target "${wishTarget}" is not recognized.`);
        sendResult(tx, hasDefault ? defaultCell : undefined);
        return;
      }
      const nowCell = runtime.getImmutableCell(
        parentCell.space,
        Date.now(),
        undefined,
        tx,
      );
      sendResult(tx, nowCell.withTx(tx));
      return;
    } else {
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

      resolvedCell = followPath(baseCell, parsed.path);
    }

    if (!resolvedCell) {
      console.error(`Wish target "${wishTarget}" is not recognized.`);
      sendResult(tx, hasDefault ? defaultCell : undefined);
      return;
    }

    // If the resolved value is undefined and we have a default, use the default
    if (hasDefault && resolvedCell.withTx(tx).get() === undefined) {
      sendResult(tx, defaultCell);
    } else {
      sendResult(tx, resolvedCell.withTx(tx));
    }
  };
}
