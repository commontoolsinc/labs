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
import type { Runtime } from "../runtime.ts";
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

const WISH_TSX_PATH = getRecipeEnvironment().apiUrl + "api/patterns/wish.tsx";
const SUGGESTION_TSX_PATH = getRecipeEnvironment().apiUrl +
  "api/patterns/suggestion.tsx";

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
  runtime: Runtime,
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
  runtime: Runtime;
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
): BaseResolution[] {
  switch (parsed.key) {
    case "/":
      return [{ cell: getSpaceCell(ctx) }];
    case "#default":
      return [{ cell: getSpaceCell(ctx), pathPrefix: ["defaultPattern"] }];
    case "#mentionable":
      return [{
        cell: getSpaceCell(ctx),
        pathPrefix: ["defaultPattern", "backlinksIndex", "mentionable"],
      }];
    case "#recent":
      return [{ cell: getSpaceCell(ctx), pathPrefix: ["recentCharms"] }];
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
        return [{ cell: homeSpaceCell, pathPrefix: ["favorites"] }];
      }

      // Path provided = search by tag
      const searchTerm = parsed.path[0].toLowerCase();
      const favoritesCell = homeSpaceCell.key("favorites").asSchema(
        favoriteListSchema,
      );
      const favorites = favoritesCell.get() || [];

      // Case-insensitive search in tag.
      // If tag is empty, try to compute it lazily from the cell's schema.
      const match = favorites.find((entry) => {
        let tag = entry.tag;

        // Fallback: compute tag lazily if not stored
        if (!tag) {
          try {
            const { schema } = entry.cell.asSchemaFromLinks()
              .getAsNormalizedFullLink();
            if (schema !== undefined) {
              tag = JSON.stringify(schema);
            }
          } catch {
            // Schema not available yet
          }
        }

        return tag?.toLowerCase().includes(searchTerm);
      });

      if (!match) {
        throw new WishError(`No favorite found matching "${searchTerm}"`);
      }

      return [{
        cell: match.cell,
        pathPrefix: parsed.path.slice(1), // remaining path after search term
      }];
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
      return [{ cell: nowCell }];
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
        return [{ cell: baseCell }];
      }

      // Hash tag: Look for exact matches in favorites.
      if (parsed.key.startsWith("#")) {
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

        // Match hash tags in tag field (the schema), all lowercase.
        // If tag is empty, try to compute it lazily from the cell's schema.
        // This handles existing favorites that were saved before schema was synced.
        const searchTerm = parsed.key.toLowerCase();
        const matches = favorites.filter((entry) => {
          let tag = entry.tag;

          // Fallback: compute tag lazily if not stored
          if (!tag) {
            try {
              const { schema } = entry.cell.asSchemaFromLinks()
                .getAsNormalizedFullLink();
              if (schema !== undefined) {
                tag = JSON.stringify(schema);
              }
            } catch {
              // Schema not available yet
            }
          }

          const hashtags = tag?.toLowerCase().matchAll(/#([a-z0-9-]+)/g) ?? [];
          return [...hashtags].some((m) => m[0] === searchTerm);
        });

        if (matches.length === 0) {
          throw new WishError(`No favorite found matching "${searchTerm}"`);
        }

        return matches.map((match) => ({
          cell: match.cell,
          pathPrefix: parsed.path,
        }));
      }

      throw new WishError(`Wish target "${parsed.key}" is not recognized.`);
    }
  }
}

// fetchWishPattern runs at runtime scope, shared across all wish invocations
let wishPatternFetchPromise: Promise<Recipe | undefined> | undefined;
let wishPattern: Recipe | undefined;

async function fetchWishPattern(
  runtime: Runtime,
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

// fetchSuggestionPattern runs at runtime scope, shared across all wish invocations
let suggestionPatternFetchPromise: Promise<Recipe | undefined> | undefined;
let suggestionPattern: Recipe | undefined;

async function fetchSuggestionPattern(
  runtime: Runtime,
): Promise<Recipe | undefined> {
  try {
    const program = await runtime.harness.resolve(
      new HttpProgramResolver(SUGGESTION_TSX_PATH),
    );

    if (!program) {
      throw new WishError("Can't load suggestion.tsx");
    }
    const pattern = await runtime.recipeManager.compileRecipe(program);

    if (!pattern) throw new WishError("Can't compile suggestion.tsx");

    return pattern;
  } catch (e) {
    console.error("Can't load suggestion.tsx", e);
    return undefined;
  }
}

function errorUI(message: string): VNode {
  return h("span", { style: "color: red" }, `⚠️ ${message}`);
}

// TODO(seefeld): Add button to replace this with wish.tsx getting more options
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
  runtime: Runtime,
): Action {
  // Per-instance wish pattern loading.
  let wishPatternInput: WishParams | undefined;
  let wishPatternResultCell: Cell<WishState<any>> | undefined;

  function launchWishPattern(
    input?: WishParams & { candidates?: Cell<unknown>[] },
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

  // Per-instance suggestion pattern result cell
  let suggestionPatternInput:
    | { situation: string; context: Record<string, any> }
    | undefined;
  let suggestionPatternResultCell: Cell<WishState<any>> | undefined;

  function launchSuggestionPattern(
    input: { situation: string; context: Record<string, any> },
    providedTx?: IExtendedStorageTransaction,
  ) {
    suggestionPatternInput = input;

    const tx = providedTx || runtime.edit();

    if (!suggestionPatternResultCell) {
      suggestionPatternResultCell = runtime.getCell(
        parentCell.space,
        { wish: { suggestionPattern: cause, situation: input.situation } },
        undefined,
        tx,
      );

      addCancel(() => runtime.runner.stop(suggestionPatternResultCell!));
    }

    if (!suggestionPattern) {
      if (!suggestionPatternFetchPromise) {
        suggestionPatternFetchPromise = fetchSuggestionPattern(runtime).then(
          (pattern) => {
            suggestionPattern = pattern;
            return pattern;
          },
        );
      }
      suggestionPatternFetchPromise.then((pattern) => {
        if (pattern) {
          runtime.runSynced(
            suggestionPatternResultCell!,
            pattern,
            suggestionPatternInput,
          );
        }
      });
    } else {
      runtime.runSynced(
        suggestionPatternResultCell,
        suggestionPattern,
        suggestionPatternInput,
      );
    }

    if (!providedTx) tx.commit();

    return suggestionPatternResultCell;
  }

  // Wish action, reactive to changes in inputsCell and any cell we read during
  // initial resolution
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
        const baseResolutions = resolveBase(parsed, ctx);

        // Just use the first result (if there aren't any, the above throws)
        const combinedPath = baseResolutions[0].pathPrefix
          ? [...baseResolutions[0].pathPrefix, ...parsed.path]
          : parsed.path;
        const resolvedCell = resolvePath(baseResolutions[0].cell, combinedPath);
        sendResult(tx, resolvedCell);
      } catch (_e) {
        sendResult(tx, undefined);
      }
      return;
    } else if (typeof targetValue === "object") {
      const { query, path, schema, context, scope: _scope } =
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
          const baseResolutions = resolveBase(parsed, ctx);
          const resultCells = baseResolutions.map((baseResolution) => {
            const combinedPath = baseResolution.pathPrefix
              ? [...baseResolution.pathPrefix, ...(path ?? [])]
              : path ?? [];
            const resolvedCell = resolvePath(baseResolution.cell, combinedPath);
            return schema ? resolvedCell.asSchema(schema) : resolvedCell;
          });
          if (resultCells.length === 1) {
            // If it's one result, just return it directly
            sendResult(tx, {
              result: resultCells[0],
              [UI]: cellLinkUI(resultCells[0]),
            });
          } else {
            // If it's multiple result, launch the wish pattern, which will
            // immediately return the first candidate as result
            sendResult(
              tx,
              launchWishPattern({
                ...targetValue as WishParams,
                candidates: resultCells,
              }, tx),
            );
          }
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
        // Otherwise it's a generic query, instantiate suggestion.tsx
        sendResult(
          tx,
          launchSuggestionPattern(
            { situation: query, context: context ?? {} },
            tx,
          ),
        );
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
