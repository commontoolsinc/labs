import {
  type VNode,
  type WishParams,
  type WishScope,
  type WishState,
  type WishTag,
} from "@commontools/api";
import { h } from "@commontools/html";
import { favoriteListSchema, journalSchema } from "@commontools/home-schemas";
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
import { getRecipeEnvironment } from "../env.ts";
import {
  collectMatches,
  findMatchingCells,
  schemaMatchesTag,
  traverseForTag,
  type TraversalMatch,
  type TraversalOptions,
} from "./wish-traversal.ts";

const WISH_TSX_PATH = getRecipeEnvironment().apiUrl +
  "api/patterns/system/wish.tsx";
const SUGGESTION_TSX_PATH = getRecipeEnvironment().apiUrl +
  "api/patterns/system/suggestion.tsx";

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

export type ParsedWishTarget = {
  key: "/" | WishTag;
  path: string[];
};

export function parseWishTarget(target: string): ParsedWishTarget {
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
  /** Search scope - undefined means search favorites (default) */
  scope?: WishScope;
  /** Max traversal depth. 0 = only root level (backward compat), 10 = default for scoped */
  maxDepth: number;
  /** Max results to return. 1 = default, 0 = unlimited */
  limit: number;
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

/**
 * Search for a tag in favorites.
 * This is the default/backward-compatible search mode.
 *
 * When maxDepth > 0, also traverses into each favorite's subtree.
 */
function searchFavorites(
  ctx: WishContext,
  tag: string,
  parsed: ParsedWishTarget,
): BaseResolution[] {
  const userDID = ctx.runtime.userIdentityDID;
  if (!userDID) {
    throw new WishError("User identity DID not available for favorites search");
  }

  const homeSpaceCell = ctx.runtime.getHomeSpaceCell(ctx.tx);
  const favoritesCell = homeSpaceCell.key("favorites").asSchema(
    favoriteListSchema,
  );
  const favorites = favoritesCell.get() || [];

  // First: find favorites that match the tag directly (depth 0)
  const searchTermWithoutHash = tag.toLowerCase();
  const directMatches = favorites.filter((entry) => {
    // Check userTags first (stored without # prefix)
    const userTags = entry.userTags ?? [];
    for (const t of userTags) {
      if (t.toLowerCase() === searchTermWithoutHash) return true;
    }

    // Fall back to schema-based hashtag search
    let schemaTag = entry.tag;

    // Fallback: compute tag lazily if not stored
    if (!schemaTag) {
      try {
        const { schema } = entry.cell.asSchemaFromLinks()
          .getAsNormalizedFullLink();
        if (schema !== undefined) {
          schemaTag = JSON.stringify(schema);
        }
      } catch {
        // Schema not available yet
      }
    }

    const hashtags = schemaTag?.toLowerCase().matchAll(/#([a-z0-9-]+)/g) ?? [];
    return [...hashtags].some((m) => m[1] === searchTermWithoutHash);
  });

  // If maxDepth is 0 (backward compat), only return direct matches
  if (ctx.maxDepth === 0) {
    if (directMatches.length === 0) {
      throw new WishError(`No favorite found matching "#${tag}"`);
    }
    return directMatches.map((match) => ({
      cell: match.cell,
      pathPrefix: parsed.path,
    }));
  }

  // With maxDepth > 0, traverse into favorites to find nested matches
  const favoriteCells = favorites.map((entry) => entry.cell as Cell<unknown>);
  const options: TraversalOptions = {
    tag: searchTermWithoutHash,
    maxDepth: ctx.maxDepth,
    limit: ctx.limit,
    runtime: ctx.runtime,
    tx: ctx.tx,
  };

  const matches = findMatchingCells(favoriteCells, options);

  if (matches.length === 0 && directMatches.length === 0) {
    throw new WishError(`No favorite found matching "#${tag}"`);
  }

  // Combine direct matches and traversal matches
  // Direct matches come first, then traversal results
  const results: BaseResolution[] = directMatches.map((match) => ({
    cell: match.cell,
    pathPrefix: parsed.path,
  }));

  for (const match of matches) {
    // Skip if already in direct matches (avoid duplicates)
    const isDuplicate = results.some((r) =>
      r.cell.sourceURI === match.cell.sourceURI
    );
    if (!isDuplicate) {
      results.push({
        cell: match.cell,
        pathPrefix: [...match.path, ...parsed.path],
      });
    }
  }

  return results;
}

/**
 * Search for a tag in allCharms of specified spaces + subtree.
 */
function searchSpaces(
  ctx: WishContext,
  spaces: (string)[],
  tag: string,
  parsed: ParsedWishTarget,
): BaseResolution[] {
  const searchTermWithoutHash = tag.toLowerCase();
  const allCells: Cell<unknown>[] = [];

  for (const spaceSpec of spaces) {
    let spaceId: MemorySpace;

    if (spaceSpec === "~") {
      // Home space
      const userDID = ctx.runtime.userIdentityDID;
      if (!userDID) {
        throw new WishError("User identity DID not available for ~ space");
      }
      spaceId = userDID;
    } else if (spaceSpec === ".") {
      // Current space
      spaceId = ctx.parentCell.space;
    } else {
      // Explicit DID
      spaceId = spaceSpec as MemorySpace;
    }

    // Get allCharms for this space
    const allCharmsCell = ctx.runtime.getCellFromEntityId(
      spaceId,
      { "/": ALL_CHARMS_ID },
      undefined,
      undefined,
      ctx.tx,
    );

    if (allCharmsCell) {
      const allCharms = allCharmsCell.get();
      if (Array.isArray(allCharms)) {
        for (let i = 0; i < allCharms.length; i++) {
          const charmCell = allCharmsCell.key(i) as Cell<unknown>;
          allCells.push(charmCell);
        }
      }
    }
  }

  if (allCells.length === 0) {
    throw new WishError("No charms found in specified spaces");
  }

  const options: TraversalOptions = {
    tag: searchTermWithoutHash,
    maxDepth: ctx.maxDepth,
    limit: ctx.limit,
    runtime: ctx.runtime,
    tx: ctx.tx,
  };

  const matches = findMatchingCells(allCells, options);

  if (matches.length === 0) {
    throw new WishError(`No cell found matching "#${tag}" in specified spaces`);
  }

  return matches.map((match) => ({
    cell: match.cell,
    pathPrefix: [...match.path, ...parsed.path],
  }));
}

/**
 * Search for a tag in specific cells + subtree.
 */
function searchCells(
  ctx: WishContext,
  cells: Cell<unknown>[],
  tag: string,
  parsed: ParsedWishTarget,
): BaseResolution[] {
  const searchTermWithoutHash = tag.toLowerCase();

  if (cells.length === 0) {
    throw new WishError("No cells provided for search");
  }

  const options: TraversalOptions = {
    tag: searchTermWithoutHash,
    maxDepth: ctx.maxDepth,
    limit: ctx.limit,
    runtime: ctx.runtime,
    tx: ctx.tx,
  };

  const matches = findMatchingCells(cells, options);

  if (matches.length === 0) {
    throw new WishError(`No cell found matching "#${tag}" in provided cells`);
  }

  return matches.map((match) => ({
    cell: match.cell,
    pathPrefix: [...match.path, ...parsed.path],
  }));
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

      // Case-insensitive search in userTags or tag field.
      // If tag is empty, try to compute it lazily from the cell's schema.
      const match = favorites.find((entry) => {
        // Check userTags first
        const userTags = entry.userTags ?? [];
        for (const t of userTags) {
          if (t.toLowerCase().includes(searchTerm)) return true;
        }

        // Fall back to tag field
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
    case "#journal": {
      // Journal always comes from the HOME space (user identity DID)
      const userDID = ctx.runtime.userIdentityDID;
      if (!userDID) {
        throw new WishError("User identity DID not available for #journal");
      }

      const journal = ctx.runtime.getHomeSpaceCell(ctx.tx).key("journal")
        .asSchema(journalSchema);
      journal.sync();

      return [{ cell: journal }];
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

      // Hash tag: dispatch based on scope
      if (parsed.key.startsWith("#")) {
        const tag = parsed.key.slice(1); // Remove # prefix
        const scope = ctx.scope;

        // No scope = search favorites (default/backward-compatible)
        if (!scope) {
          return searchFavorites(ctx, tag, parsed);
        }

        // Scope with spaces = search allCharms in those spaces
        if ("spaces" in scope) {
          return searchSpaces(ctx, scope.spaces, tag, parsed);
        }

        // Scope with cells = search those specific cells
        // Cast through unknown since asCell: true in schema gives us Cell at runtime
        if ("cells" in scope) {
          return searchCells(ctx, scope.cells as unknown as Cell<unknown>[], tag, parsed);
        }
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
    console.error("[wish] fetchWishPattern: Failed to load wish.tsx", e);
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
      schema: { type: "object" },
      scope: {
        anyOf: [
          {
            type: "object",
            properties: {
              spaces: { type: "array", items: { type: "string" } },
            },
            required: ["spaces"],
          },
          {
            type: "object",
            properties: {
              cells: { type: "array", items: { asCell: true } },
            },
            required: ["cells"],
          },
        ],
      },
      maxDepth: { type: "number" },
      limit: { type: "number" },
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

  async function launchWishPattern(
    input?: WishParams & { candidates?: Cell<unknown>[] },
    providedTx?: IExtendedStorageTransaction,
  ): Promise<Cell<WishState<any>>> {
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

    // Wait for pattern to be loaded
    if (!wishPattern) {
      if (!wishPatternFetchPromise) {
        wishPatternFetchPromise = fetchWishPattern(runtime).then((pattern) => {
          wishPattern = pattern;
          return pattern;
        });
      }
      await wishPatternFetchPromise;
    }

    // Now run the pattern - await to ensure it's set up before returning
    if (wishPattern) {
      await runtime.runSynced(
        wishPatternResultCell,
        wishPattern,
        wishPatternInput,
      );
    } else {
      console.error("[wish] launchWishPattern: Pattern failed to load!");
    }

    if (!providedTx) await tx.commit();

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
  return async (tx: IExtendedStorageTransaction) => {
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
        // Legacy string mode: no scope, maxDepth=0 for backward compat
        const ctx: WishContext = { runtime, tx, parentCell, maxDepth: 0, limit: 1 };
        const baseResolutions = resolveBase(parsed, ctx);

        // Just use the first result (if there aren't any, the above throws)
        const combinedPath = baseResolutions[0].pathPrefix
          ? [...baseResolutions[0].pathPrefix, ...parsed.path]
          : parsed.path;
        const resolvedCell = resolvePath(baseResolutions[0].cell, combinedPath);
        // Sync the cell to ensure data is loaded (required for pull-based scheduler)
        await resolvedCell.sync();
        sendResult(tx, resolvedCell);
      } catch (e) {
        // Provide helpful feedback for common defaultPattern issues
        if (
          wishTarget.startsWith("#mentionable") ||
          wishTarget.startsWith("#default")
        ) {
          const errorMsg =
            `${wishTarget} failed: ${
              e instanceof Error ? e.message : String(e)
            }. This usually means the space's defaultPattern is not initialized. ` +
            `Visit the space in browser first, or ensure ensureDefaultPattern() is called.`;
          console.warn(errorMsg);
          // Return error state instead of undefined for better UX
          sendResult(
            tx,
            { error: errorMsg, [UI]: errorUI(errorMsg) } satisfies WishState<
              any
            >,
          );
          return;
        }

        // For other errors, also return error state
        const errorMsg = e instanceof Error ? e.message : String(e);
        sendResult(
          tx,
          { error: errorMsg, [UI]: errorUI(errorMsg) } satisfies WishState<any>,
        );
      }
      return;
    } else if (typeof targetValue === "object") {
      const {
        query,
        path,
        schema,
        context,
        scope,
        maxDepth: maxDepthParam,
        limit: limitParam,
      } = targetValue as WishParams;

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

      // Determine maxDepth: use provided value, or default based on scope
      // - If scope is undefined (favorites): maxDepth defaults to 0 (backward compat)
      // - If scope is provided: maxDepth defaults to 10
      const maxDepth = maxDepthParam ?? (scope ? 10 : 0);
      const limit = limitParam ?? 1;

      // If the query is a path or a hash tag, resolve it directly
      if (query.startsWith("/") || /^#[a-zA-Z0-9-]+$/.test(query)) {
        try {
          const parsed: ParsedWishTarget = {
            key: query as WishTag,
            path: path ?? [],
          };
          const ctx: WishContext = { runtime, tx, parentCell, scope, maxDepth, limit };
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
            const resolvedCell = resultCells[0];

            // Sync the resolved cell to ensure data is loaded
            await resolvedCell.sync();
            sendResult(tx, {
              result: resolvedCell,
              [UI]: cellLinkUI(resolvedCell),
            });
          } else {
            // If it's multiple results, launch the wish pattern for the user
            // to pick from. Navigation goes to the picker charm.
            const wishResultCell = await launchWishPattern({
              ...targetValue as WishParams,
              candidates: resultCells,
            }, tx);
            sendResult(tx, {
              result: wishResultCell,
              [UI]: wishResultCell.get()[UI],
            });
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
