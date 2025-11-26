import {
  type VNode,
  type WishParams,
  type WishState,
  type WishTag,
} from "@commontools/api";
import { h } from "@commontools/html";
import { HttpProgramResolver } from "@commontools/js-compiler";
import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../storage/interface.ts";
import type { EntityId } from "../create-ref.ts";
import { ALL_CHARMS_ID } from "./well-known.ts";
import { type JSONSchema, type Recipe, UI } from "../builder/types.ts";

// Define locally to avoid circular dependency with @commontools/charm
const favoriteEntrySchema = {
  type: "object",
  properties: {
    cell: { not: true, asCell: true },
    tag: { type: "string", default: "" },
  },
  required: ["cell"],
} as const satisfies JSONSchema;

const favoriteListSchema = {
  type: "array",
  items: favoriteEntrySchema,
} as const satisfies JSONSchema;
import { getRecipeEnvironment } from "../env.ts";

const WISH_TSX_PATH = getRecipeEnvironment().apiUrl + "/api/patterns/wish.tsx";

class WishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WishError";
  }
}

type WishResolution = {
  entityId: EntityId;
  path?: readonly string[];
};

const WISH_TARGETS: Partial<Record<WishTag, WishResolution>> = {
  "#allCharms": { entityId: { "/": ALL_CHARMS_ID } },
};

function resolveWishTarget(
  resolution: WishResolution,
  runtime: IRuntime,
  space: MemorySpace,
  tx: IExtendedStorageTransaction,
): Cell<any> {
  const cell = runtime.getCellFromEntityId(
    space,
    resolution.entityId,
    resolution.path,
    undefined,
    tx,
  );
  if (!cell) {
    throw new WishError("Failed to resolve wish target");
  }
  return cell;
}

type ParsedWishTarget = {
  key: "/" | WishTag;
  path: string[];
};

function parseWishTarget(target: string): ParsedWishTarget {
  const trimmed = target.trim();
  if (trimmed === "") {
    throw new WishError(`Wish target "${target}" is empty.`);
  }

  if (trimmed.startsWith("#")) {
    const segments = trimmed.slice(1).split("/").filter((segment) =>
      segment.length > 0
    );
    if (segments.length === 0) {
      throw new WishError(`Wish tag target "${target}" is not recognized.`);
    }
    const key = `#${segments[0]}` as WishTag;
    return { key, path: segments.slice(1) };
  }

  if (trimmed.startsWith("/")) {
    const segments = trimmed.split("/").filter((segment) => segment.length > 0);
    return { key: "/", path: segments };
  }

  throw new WishError(`Wish path target "${target}" is not recognized.`);
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

function formatTarget(parsed: ParsedWishTarget): string {
  return parsed.key +
    (parsed.path.length > 0 ? "/" + parsed.path.join("/") : "");
}

function resolveBase(
  parsed: ParsedWishTarget,
  ctx: WishContext,
): BaseResolution {
  switch (parsed.key) {
    case "/":
      return { cell: getSpaceCell(ctx) };
    case "#default":
      return { cell: getSpaceCell(ctx), pathPrefix: ["defaultPattern"] };
    case "#mentionable":
      return {
        cell: getSpaceCell(ctx),
        pathPrefix: ["defaultPattern", "backlinksIndex", "mentionable"],
      };
    case "#recent":
      return { cell: getSpaceCell(ctx), pathPrefix: ["recentCharms"] };
    case "#favorites": {
      // Favorites always come from the HOME space (user identity DID)
      const userDID = ctx.runtime.userIdentityDID;
      if (!userDID) {
        throw new WishError("User identity DID not available for #favorites");
      }
      const homeSpaceCell = ctx.runtime.getCell(
        userDID,
        userDID,
        undefined,
        ctx.tx,
      );

      // No path = return favorites list
      if (parsed.path.length === 0) {
        return { cell: homeSpaceCell, pathPrefix: ["favorites"] };
      }

      // Path provided = search by tag
      const searchTerm = parsed.path[0].toLowerCase();
      const favoritesCell = homeSpaceCell.key("favorites").asSchema(
        favoriteListSchema,
      );
      const favorites = favoritesCell.get() || [];

      // Case-insensitive search in tag
      const match = favorites.find((entry) =>
        entry.tag?.toLowerCase().includes(searchTerm)
      );

      if (!match) {
        throw new WishError(`No favorite found matching "${searchTerm}"`);
      }

      return {
        cell: match.cell,
        pathPrefix: parsed.path.slice(1), // remaining path after search term
      };
    }
    case "#now": {
      if (parsed.path.length > 0) {
        throw new WishError(
          `Wish now target "${formatTarget(parsed)}" is not recognized.`,
        );
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
      // Check if it's a well-known target
      const resolution = WISH_TARGETS[parsed.key];
      if (resolution) {
        const baseCell = resolveWishTarget(
          resolution,
          ctx.runtime,
          ctx.parentCell.space,
          ctx.tx,
        );
        return { cell: baseCell };
      }

      // Unknown tag = search favorites by tag
      const userDID = ctx.runtime.userIdentityDID;
      if (!userDID) {
        throw new WishError(
          "User identity DID not available for favorites search",
        );
      }

      const homeSpaceCell = ctx.runtime.getHomeSpaceCell(ctx.tx);
      const favoritesCell = homeSpaceCell.key("favorites").asSchema(
        favoriteListSchema,
      );
      const favorites = favoritesCell.get() || [];

      // Search term is the tag without the # prefix
      const searchTerm = parsed.key.slice(1).toLowerCase();
      const match = favorites.find((entry) =>
        entry.tag?.toLowerCase().includes(searchTerm)
      );

      if (!match) {
        throw new WishError(`No favorite found matching "${searchTerm}"`);
      }

      return {
        cell: match.cell,
        pathPrefix: parsed.path,
      };
    }
  }
}

async function fetchWishPattern(
  runtime: IRuntime,
): Promise<Recipe | undefined> {
  try {
    const program = await runtime.harness.resolve(
      new HttpProgramResolver(WISH_TSX_PATH),
    );

    if (!program) {
      throw new WishError("Can't load wish.tsx");
    }
    const pattern = await runtime.recipeManager.compileRecipe(program);

    if (!pattern) throw new WishError("Can't compile wish.tsx");

    return pattern;
  } catch (e) {
    console.error("Can't load wish.tsx", e);
    return undefined;
  }
}

let wishPatternFetchPromise: Promise<Recipe | undefined> | undefined;
let wishPattern: Recipe | undefined;

function errorUI(message: string): VNode {
  return h("span", { style: "color: red" }, `⚠️ ${message}`);
}

function cellLinkUI(cell: Cell<unknown>): VNode {
  return h("ct-cell-link", { $cell: cell });
}

const TARGET_SCHEMA = {
  anyOf: [{
    type: "string",
    default: "",
  }, {
    type: "object",
    properties: {
      query: { type: "string" },
      path: { type: "array", items: { type: "string" } },
      context: { type: "object", additionalProperties: { asCell: true } },
      scope: { type: "array", items: { type: "string" } },
    },
    required: ["query"],
  }],
} as const satisfies JSONSchema;

export function wish(
  inputsCell: Cell<[unknown, unknown]>,
  sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
  addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: IRuntime,
): Action {
  // Per-instance wish pattern loading.

  let wishPatternInput: WishParams | undefined;
  let wishPatternResultCell: Cell<WishState<any>> | undefined;

  function launchWishPattern(
    input?: WishParams,
    providedTx?: IExtendedStorageTransaction,
  ) {
    if (input) wishPatternInput = input;

    const tx = providedTx || runtime.edit();

    if (!wishPatternResultCell) {
      wishPatternResultCell = runtime.getCell(
        parentCell.space,
        { wish: { wishPattern: cause } },
        undefined,
        tx,
      );

      addCancel(() => runtime.runner.stop(wishPatternResultCell!));
    }

    if (!wishPattern) {
      if (!wishPatternFetchPromise) {
        wishPatternFetchPromise = fetchWishPattern(runtime).then((pattern) => {
          wishPattern = pattern;
          return pattern;
        });
      }
      wishPatternFetchPromise.then((pattern) => {
        if (pattern) {
          launchWishPattern();
        }
      });
    } else {
      runtime.runSynced(wishPatternResultCell, wishPattern, wishPatternInput);
    }

    if (!providedTx) tx.commit();

    return wishPatternResultCell;
  }

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
      try {
        const parsed = parseWishTarget(wishTarget);
        const ctx: WishContext = { runtime, tx, parentCell };
        const baseResolution = resolveBase(parsed, ctx);
        const combinedPath = baseResolution.pathPrefix
          ? [...baseResolution.pathPrefix, ...parsed.path]
          : parsed.path;
        const resolvedCell = resolvePath(baseResolution.cell, combinedPath);
        sendResult(tx, resolvedCell);
      } catch (e) {
        sendResult(tx, undefined);
      }
      return;
    } else if (typeof targetValue === "object") {
      const { query, path, schema, context: _context, scope: _scope } =
        targetValue as WishParams;

      if (query === undefined || query === null || query === "") {
        const errorMsg = `Wish target "${
          JSON.stringify(targetValue)
        }" has no query.`;
        sendResult(
          tx,
          { error: errorMsg, [UI]: errorUI(errorMsg) } satisfies WishState<any>,
        );
        return;
      }

      // If the query is a path or a hash tag, resolve it directly
      if (query.startsWith("/") || /^#[a-zA-Z0-9-]+$/.test(query)) {
        try {
          const parsed: ParsedWishTarget = {
            key: query as WishTag,
            path: path ?? [],
          };
          const ctx: WishContext = { runtime, tx, parentCell };
          const baseResolution = resolveBase(parsed, ctx);
          const combinedPath = baseResolution.pathPrefix
            ? [...baseResolution.pathPrefix, ...(path ?? [])]
            : path ?? [];
          const resolvedCell = resolvePath(baseResolution.cell, combinedPath);
          const resultCell = schema
            ? resolvedCell.asSchema(schema)
            : resolvedCell;
          sendResult(tx, {
            result: resultCell,
            [UI]: cellLinkUI(resultCell),
          });
        } catch (e) {
          const errorMsg = e instanceof WishError ? e.message : String(e);
          sendResult(
            tx,
            { error: errorMsg, [UI]: errorUI(errorMsg) } satisfies WishState<
              any
            >,
          );
        }
      } else {
        // Otherwise it's a generic query and we need to launch the wish pattern
        sendResult(tx, launchWishPattern(targetValue as WishParams, tx));
      }
      return;
    } else {
      const errorMsg = `Wish target is not recognized: ${targetValue}`;
      sendResult(
        tx,
        { error: errorMsg, [UI]: errorUI(errorMsg) } satisfies WishState<any>,
      );
      return;
    }
  };
}
