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

type WishContext = {
  runtime: IRuntime;
  tx: IExtendedStorageTransaction;
  parentCell: Cell<any>;
  spaceCell?: Cell<unknown>;
};

type BaseResolution = {
  cell: Cell<unknown>;
  pathPrefix?: readonly string[];
};

function getSpaceCell(ctx: WishContext): Cell<unknown> {
  if (!ctx.spaceCell) {
    ctx.spaceCell = ctx.runtime.getCell(
      ctx.parentCell.space,
      ctx.parentCell.space,
      undefined,
      ctx.tx,
    );
  }
  return ctx.spaceCell;
}

function resolvePath(
  base: Cell<any>,
  path: readonly string[],
): Cell<unknown> {
  let current = base;
  for (const segment of path) {
    current = current.key(segment);
  }
  return current.resolveAsCell();
}

function resolveBase(
  parsed: ParsedWishTarget,
  ctx: WishContext,
  wishTarget: string,
): BaseResolution | undefined {
  switch (parsed.key) {
    case "/":
      return { cell: getSpaceCell(ctx) };
    case "#default": {
      return { cell: getSpaceCell(ctx), pathPrefix: ["defaultPattern"] };
    }
    case "#mentionable": {
      return {
        cell: getSpaceCell(ctx),
        pathPrefix: ["defaultPattern", "backlinksIndex", "mentionable"],
      };
    }
    case "#recent": {
      return { cell: getSpaceCell(ctx), pathPrefix: ["recentCharms"] };
    }
    case "#now": {
      if (parsed.path.length > 0) {
        console.error(`Wish target "${wishTarget}" is not recognized.`);
        return undefined;
      }
      const nowCell = ctx.runtime.getImmutableCell(
        ctx.parentCell.space,
        Date.now(),
        undefined,
        ctx.tx,
      );
      return { cell: nowCell };
    }
    default: {
      const resolution = WISH_TARGETS[parsed.key];
      if (!resolution) {
        console.error(`Wish target "${wishTarget}" is not recognized.`);
        return undefined;
      }

      const baseCell = resolveWishTarget(
        resolution,
        ctx.runtime,
        ctx.parentCell.space,
        ctx.tx,
      );

      if (!baseCell) {
        console.error(`Wish target "${wishTarget}" is not recognized.`);
        return undefined;
      }

      return { cell: baseCell };
    }
  }
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
    const targetValue = inputsWithTx.asSchema(TARGET_SCHEMA).get();

    const wishTarget = targetValue?.trim();

    if (!wishTarget) {
      sendResult(tx, undefined);
      return;
    }

    const parsed = parseWishTarget(wishTarget);
    if (!parsed) {
      console.error(`Wish target "${wishTarget}" is not recognized.`);
      sendResult(tx, undefined);
      return;
    }

    const ctx: WishContext = { runtime, tx, parentCell };
    const baseResolution = resolveBase(parsed, ctx, wishTarget);
    if (!baseResolution) {
      sendResult(tx, undefined);
      return;
    }

    const combinedPath = baseResolution.pathPrefix
      ? [...baseResolution.pathPrefix, ...parsed.path]
      : parsed.path;
    const resolvedCell = resolvePath(baseResolution.cell, combinedPath);

    sendResult(tx, resolvedCell);
  };
}
