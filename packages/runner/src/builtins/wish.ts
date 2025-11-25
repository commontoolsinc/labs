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
    case "#favorites": {
      // Favorites always come from the HOME space (user identity DID)
      const userDID = ctx.runtime.userIdentityDID;
      if (!userDID) {
        console.error("User identity DID not available for #favorites");
        return undefined;
      }
      const homeSpaceCell = ctx.runtime.getCell(
        userDID,
        userDID,
        undefined,
        ctx.tx,
      );
      return { cell: homeSpaceCell, pathPrefix: ["favorites"] };
    }
    case "#now": {
      if (parsed.path.length > 0) {
        console.error(
          `Wish target "${
            parsed.key +
            (parsed.path.length > 0 ? "/" + parsed.path.join("/") : "")
          }" is not recognized.`,
        );
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
        console.error(
          `Wish target "${
            parsed.key +
            (parsed.path.length > 0 ? "/" + parsed.path.join("/") : "")
          }" is not recognized.`,
        );
        return undefined;
      }

      const baseCell = resolveWishTarget(
        resolution,
        ctx.runtime,
        ctx.parentCell.space,
        ctx.tx,
      );

      if (!baseCell) {
        console.error(
          `Wish target "${
            parsed.key +
            (parsed.path.length > 0 ? "/" + parsed.path.join("/") : "")
          }" is not recognized.`,
        );
        return undefined;
      }

      return { cell: baseCell };
    }
  }
}

const TARGET_SCHEMA = {
  anyOf: [{
    type: "string",
    default: "",
  }, {
    type: "object",
    properties: {
      tag: { type: "string" },
      path: { type: "array", items: { type: "string" } },
      context: { type: "object", additionalProperties: { asCell: true } },
      scope: { type: "array", items: { type: "string" } },
    },
  }],
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

    // TODO(seefeld): Remove legacy wish string support mid December 2025
    if (typeof targetValue === "string") {
      const wishTarget = targetValue.trim();
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
      const baseResolution = resolveBase(parsed, ctx);
      if (!baseResolution) {
        sendResult(tx, undefined);
        return;
      }
      const combinedPath = baseResolution.pathPrefix
        ? [...baseResolution.pathPrefix, ...parsed.path]
        : parsed.path;
      const resolvedCell = resolvePath(baseResolution.cell, combinedPath);
      sendResult(tx, resolvedCell);
      return;
    } else if (typeof targetValue === "object") {
      const { tag, path, context: _context, scope: _scope } = targetValue;

      if (!tag) {
        console.error(
          `Wish target "${JSON.stringify(targetValue)}" is not recognized.`,
        );
        sendResult(tx, {});
        return;
      }

      const ctx: WishContext = { runtime, tx, parentCell };
      const baseResolution = resolveBase(
        { key: tag as WishKey, path: path ?? [] },
        ctx,
      );
      if (!baseResolution) {
        sendResult(tx, {});
        return;
      }

      const combinedPath = baseResolution.pathPrefix
        ? [...baseResolution.pathPrefix, ...(path ?? [])]
        : path ?? [];
      const resolvedCell = resolvePath(baseResolution.cell, combinedPath);
      sendResult(tx, { result: resolvedCell });
      return;
    } else {
      console.error("Wish target is not recognized:", targetValue);
      sendResult(tx, {});
      return;
    }
  };
}
