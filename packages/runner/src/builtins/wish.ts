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

function getSpaceField(
  ctx: WishContext,
  key: string,
): Cell<unknown> {
  return (getSpaceCell(ctx) as Cell<Record<string, unknown>>).key(
    key as never,
  ) as Cell<unknown>;
}

function resolveMaybeLinkedCell(
  cell: Cell<unknown>,
  ctx: WishContext,
): Cell<unknown> {
  try {
    return cell.resolveAsCell().withTx(ctx.tx);
  } catch {
    return cell.withTx(ctx.tx);
  }
}

function resolvePath(
  base: Cell<unknown>,
  path: readonly string[],
  ctx: WishContext,
): Cell<unknown> {
  let current = base.withTx(ctx.tx);
  for (const segment of path) {
    const keyed = current.key(segmentToPropertyKey(segment) as never);
    current = resolveMaybeLinkedCell(keyed, ctx);
  }
  return current;
}

function getDefaultPatternCell(
  ctx: WishContext,
): Cell<unknown> | undefined {
  const field = getSpaceField(ctx, "defaultPattern");
  try {
    return field.resolveAsCell().withTx(ctx.tx);
  } catch {
    return undefined;
  }
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
      const defaultPattern = getDefaultPatternCell(ctx);
      if (!defaultPattern) {
        console.error(
          `Wish target "${wishTarget}" is not recognized (missing default pattern).`,
        );
        return undefined;
      }
      return { cell: defaultPattern };
    }
    case "#mentionable": {
      const defaultPattern = getDefaultPatternCell(ctx);
      if (!defaultPattern) {
        console.error(
          `Wish target "${wishTarget}" is not recognized (missing default pattern).`,
        );
        return undefined;
      }
      return {
        cell: defaultPattern,
        pathPrefix: ["backlinksIndex", "mentionable"],
      };
    }
    case "#recent": {
      const recent = resolveMaybeLinkedCell(
        getSpaceField(ctx, "recentCharms"),
        ctx,
      );
      return { cell: recent };
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

    const ctx: WishContext = { runtime, tx, parentCell };
    const baseResolution = resolveBase(parsed, ctx, wishTarget);
    if (!baseResolution) {
      sendResult(tx, hasDefault ? defaultCell : undefined);
      return;
    }

    const combinedPath = baseResolution.pathPrefix
      ? [...baseResolution.pathPrefix, ...parsed.path]
      : parsed.path;
    const resolvedCell = resolvePath(baseResolution.cell, combinedPath, ctx);
    const resolvedWithTx = resolvedCell.withTx(tx);

    if (hasDefault && resolvedWithTx.get() === undefined) {
      sendResult(tx, defaultCell);
    } else {
      sendResult(tx, resolvedWithTx);
    }
  };
}
