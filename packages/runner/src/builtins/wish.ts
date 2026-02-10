import {
  type VNode,
  type WishParams,
  type WishState,
  type WishTag,
} from "@commontools/api";
import { h } from "@commontools/html";
import { favoriteListSchema } from "@commontools/home-schemas";
import { HttpProgramResolver } from "@commontools/js-compiler";
import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type Runtime, spaceCellSchema } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { type JSONSchema, NAME, type Recipe, UI } from "../builder/types.ts";
import { getRecipeEnvironment } from "../env.ts";

const SUGGESTION_TSX_PATH = getRecipeEnvironment().apiUrl +
  "api/patterns/system/suggestion.tsx";

// Schema for mentionable array - items are cell references (asCell: true)
// Don't restrict properties so .get() returns full cell data
const mentionableListSchema = {
  type: "array",
  items: { asCell: true },
} as const satisfies JSONSchema;

class WishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WishError";
  }
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

/**
 * Check if a tag string contains a hashtag matching the search term.
 * Extracts all #hashtags from the tag and checks for exact match.
 */
export function tagMatchesHashtag(
  tag: string | undefined,
  searchTermWithoutHash: string,
): boolean {
  const hashtags = tag?.toLowerCase().matchAll(/#([a-z0-9-]+)/g) ?? [];
  return [...hashtags].some((m) => m[1] === searchTermWithoutHash);
}

type WishContext = {
  runtime: Runtime;
  tx: IExtendedStorageTransaction;
  parentCell: Cell<any>;
  spaceCell?: Cell<unknown>;
  scope?: ("~" | "." | string)[];
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
      spaceCellSchema,
      ctx.tx,
    );
  }
  return ctx.spaceCell;
}

function getSpaceCellForDID(
  runtime: Runtime,
  did: string,
  tx: IExtendedStorageTransaction,
): Cell<unknown> {
  return runtime.getCell(
    did as `did:${string}:${string}`,
    did,
    spaceCellSchema,
    tx,
  );
}

function getArbitraryDIDs(scope?: string[]): string[] {
  return (scope ?? []).filter((s) => s !== "~" && s !== ".");
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
 * Search favorites in home space for pieces matching a hashtag.
 */
function searchFavoritesForHashtag(
  ctx: WishContext,
  searchTermWithoutHash: string,
  pathPrefix: string[],
): BaseResolution[] {
  const userDID = ctx.runtime.userIdentityDID;
  if (!userDID) return [];

  const homeSpaceCell = ctx.runtime.getHomeSpaceCell(ctx.tx);
  const favoritesCell = homeSpaceCell
    .key("defaultPattern")
    .key("favorites")
    .asSchema(favoriteListSchema);
  const favorites = favoritesCell.get() || [];

  const matches = favorites.filter((entry) => {
    // Check userTags first (stored without # prefix)
    const userTags = entry.userTags ?? [];
    for (const t of userTags) {
      if (t.toLowerCase() === searchTermWithoutHash) return true;
    }
    // Search schema tag for hashtags
    return tagMatchesHashtag(entry.tag, searchTermWithoutHash);
  });

  return matches.map((match) => ({ cell: match.cell, pathPrefix }));
}

/**
 * Search mentionables in current space for pieces matching a hashtag.
 */
async function searchMentionablesForHashtag(
  ctx: WishContext,
  searchTermWithoutHash: string,
  pathPrefix: string[],
  spaceCell?: Cell<unknown>,
): Promise<BaseResolution[]> {
  const mentionableCell = (spaceCell ?? getSpaceCell(ctx))
    .key("defaultPattern")
    .key("backlinksIndex")
    .key("mentionable")
    .resolveAsCell()
    .asSchema(mentionableListSchema);
  // Sync to ensure data is loaded
  await mentionableCell.sync();
  const mentionables = (mentionableCell.get() || []) as Cell<any>[];

  const matches = mentionables.filter((pieceCell: Cell<any>) => {
    if (!pieceCell) return false;

    const piece = pieceCell.get();
    if (!piece) return false;

    // Check [NAME] field for exact match
    const name = piece[NAME]?.toLowerCase() ?? "";
    if (name === searchTermWithoutHash) return true;

    // Compute schema tag lazily from the cell
    let tag: string | undefined;
    try {
      const schema = (pieceCell as any)?.resolveAsCell()?.asSchema(undefined)
        .asSchemaFromLinks?.()?.schema;
      if (typeof schema === "object") {
        tag = JSON.stringify(schema);
      }
    } catch {
      // Schema not available yet
    }

    return tagMatchesHashtag(tag, searchTermWithoutHash);
  });

  return matches.map((match) => ({ cell: match, pathPrefix }));
}

/**
 * Search for pieces by hashtag across favorites and/or mentionables based on scope.
 */
async function searchByHashtag(
  parsed: ParsedWishTarget,
  ctx: WishContext,
): Promise<BaseResolution[]> {
  const searchTerm = parsed.key.toLowerCase();
  const searchTermWithoutHash = searchTerm.slice(1);

  // Determine what to search based on scope
  // Default (no scope) = favorites only for backward compatibility
  const searchFavorites = !ctx.scope || ctx.scope.includes("~");
  const searchMentionables = ctx.scope?.includes(".");

  const allMatches: BaseResolution[] = [];

  if (searchFavorites) {
    allMatches.push(
      ...searchFavoritesForHashtag(ctx, searchTermWithoutHash, parsed.path),
    );
  }

  if (searchMentionables) {
    allMatches.push(
      ...(await searchMentionablesForHashtag(
        ctx,
        searchTermWithoutHash,
        parsed.path,
      )),
    );
  }

  // Search mentionables in arbitrary DID spaces
  const arbitraryDIDs = getArbitraryDIDs(ctx.scope);
  for (const did of arbitraryDIDs) {
    const didSpaceCell = getSpaceCellForDID(ctx.runtime, did, ctx.tx);
    allMatches.push(
      ...(await searchMentionablesForHashtag(
        ctx,
        searchTermWithoutHash,
        parsed.path,
        didSpaceCell,
      )),
    );
  }

  if (allMatches.length === 0) {
    const parts: string[] = [];
    if (searchFavorites) parts.push("favorites");
    if (searchMentionables) parts.push("mentionables");
    if (arbitraryDIDs.length > 0) {
      parts.push(`${arbitraryDIDs.length} space(s)`);
    }
    const scopeDesc = parts.join(" or ") || "favorites";
    throw new WishError(`No ${scopeDesc} found matching "${searchTerm}"`);
  }

  return allMatches;
}

/**
 * Resolve well-known targets that map to home space paths.
 */
function resolveHomeSpaceTarget(
  parsed: ParsedWishTarget,
  ctx: WishContext,
): BaseResolution[] | null {
  switch (parsed.key) {
    case "#favorites": {
      const userDID = ctx.runtime.userIdentityDID;
      if (!userDID) {
        throw new WishError("User identity DID not available for #favorites");
      }
      const homeSpaceCell = ctx.runtime.getHomeSpaceCell(ctx.tx);

      // No path = return favorites list
      if (parsed.path.length === 0) {
        return [{
          cell: homeSpaceCell,
          pathPrefix: ["defaultPattern", "favorites"],
        }];
      }

      // Path provided = search by tag (legacy behavior)
      const searchTerm = parsed.path[0].toLowerCase();
      const favoritesCell = homeSpaceCell
        .key("defaultPattern")
        .key("favorites")
        .asSchema(favoriteListSchema);
      const favorites = favoritesCell.get() || [];

      const match = favorites.find((entry) => {
        const userTags = entry.userTags ?? [];
        for (const t of userTags) {
          if (t.toLowerCase().includes(searchTerm)) return true;
        }

        let tag = entry.tag;
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
        pathPrefix: parsed.path.slice(1),
      }];
    }

    case "#journal": {
      const userDID = ctx.runtime.userIdentityDID;
      if (!userDID) {
        throw new WishError("User identity DID not available for #journal");
      }
      return [{
        cell: ctx.runtime.getHomeSpaceCell(ctx.tx),
        pathPrefix: ["defaultPattern", "journal"],
      }];
    }

    case "#learned": {
      const userDID = ctx.runtime.userIdentityDID;
      if (!userDID) {
        throw new WishError("User identity DID not available for #learned");
      }
      return [{
        cell: ctx.runtime.getHomeSpaceCell(ctx.tx),
        pathPrefix: ["defaultPattern", "learned"],
      }];
    }

    case "#profile": {
      const userDID = ctx.runtime.userIdentityDID;
      if (!userDID) {
        throw new WishError("User identity DID not available for #profile");
      }
      const learnedCell = ctx.runtime.getHomeSpaceCell(ctx.tx)
        .key("defaultPattern")
        .key("learned")
        .resolveAsCell();
      return [{
        cell: learnedCell,
        pathPrefix: ["summary"],
      }];
    }

    default:
      return null;
  }
}

/**
 * Resolve well-known targets that map to current space paths.
 */
function resolveSpaceTarget(
  parsed: ParsedWishTarget,
  ctx: WishContext,
): BaseResolution[] | null {
  // #now is special — not scope-dependent
  if (parsed.key === "#now") {
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

  const pathForKey: Record<string, readonly string[]> = {
    "/": [],
    "#default": ["defaultPattern"],
    "#mentionable": ["defaultPattern", "backlinksIndex", "mentionable"],
    "#allPieces": ["defaultPattern", "allPieces"],
    "#recent": ["defaultPattern", "recentPieces"],
  };

  const pathPrefix = pathForKey[parsed.key];
  if (!pathPrefix) return null;

  const results: BaseResolution[] = [];

  // "." or no scope → include current space (backward compat)
  if (!ctx.scope || ctx.scope.includes(".")) {
    results.push({ cell: getSpaceCell(ctx), pathPrefix: [...pathPrefix] });
  }

  // "~" → include home space
  if (ctx.scope?.includes("~") && ctx.runtime.userIdentityDID) {
    const homeSpaceCell = ctx.runtime.getHomeSpaceCell(ctx.tx);
    results.push({ cell: homeSpaceCell, pathPrefix: [...pathPrefix] });
  }

  // Arbitrary DIDs → include each space
  for (const did of getArbitraryDIDs(ctx.scope)) {
    const didSpaceCell = getSpaceCellForDID(ctx.runtime, did, ctx.tx);
    results.push({ cell: didSpaceCell, pathPrefix: [...pathPrefix] });
  }

  if (results.length === 0) {
    console.warn(
      `[wish] Target "${parsed.key}" cannot resolve with scope: [${
        ctx.scope?.join(", ")
      }]`,
    );
    return null;
  }

  return results;
}

/**
 * Main resolution function - dispatches to appropriate resolver based on target type.
 *
 * Resolution paths:
 * 1. Well-known space targets (/, #default, #mentionable, #allPieces, #recent, #now)
 * 2. Well-known home space targets (#favorites, #journal, #learned, #profile)
 * 3. Hashtag search (arbitrary #tags in favorites/mentionables)
 */
async function resolveBase(
  parsed: ParsedWishTarget,
  ctx: WishContext,
): Promise<BaseResolution[]> {
  // Try space targets first (most common)
  const spaceResult = resolveSpaceTarget(parsed, ctx);
  if (spaceResult) return spaceResult;

  // Try home space targets
  const homeResult = resolveHomeSpaceTarget(parsed, ctx);
  if (homeResult) return homeResult;

  // Hashtag search
  if (parsed.key.startsWith("#")) {
    return await searchByHashtag(parsed, ctx);
  }

  throw new WishError(`Wish target "${parsed.key}" is not recognized.`);
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

function cellLinkUI(cell: Cell<unknown>): VNode {
  return h("ct-cell-link", { $cell: cell });
}

const TARGET_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string" },
    path: { type: "array", items: { type: "string" } },
    context: { type: "object", additionalProperties: { asCell: true } },
    scope: { type: "array", items: { type: "string" } },
  },
  required: ["query"],
} as const satisfies JSONSchema;

export function wish(
  inputsCell: Cell<[unknown, unknown]>,
  sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
  addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  // Per-instance suggestion pattern result cell
  let suggestionPatternInput:
    | {
      situation: string;
      context: Record<string, any>;
      initialResults?: unknown;
    }
    | undefined;
  let suggestionPatternResultCell: Cell<WishState<any>> | undefined;

  function launchSuggestionPattern(
    input: {
      situation: string;
      context: Record<string, any>;
      initialResults?: unknown;
    },
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
      suggestionPatternFetchPromise.then(async (pattern) => {
        if (pattern) {
          try {
            await runtime.runSynced(
              suggestionPatternResultCell!,
              pattern,
              suggestionPatternInput,
            );
          } catch (e) {
            console.error("[wish] Failed to run suggestion pattern", e);
          }
        }
      });
    } else {
      runtime.runSynced(
        suggestionPatternResultCell,
        suggestionPattern,
        suggestionPatternInput,
      ).catch((e: unknown) => {
        console.error("[wish] Failed to run suggestion pattern", e);
      });
    }

    if (!providedTx) tx.commit();

    return suggestionPatternResultCell;
  }

  // Wish action, reactive to changes in inputsCell and any cell we read during
  // initial resolution
  return async (tx: IExtendedStorageTransaction) => {
    const inputsWithTx = inputsCell.withTx(tx);
    const targetValue = inputsWithTx.asSchema(TARGET_SCHEMA).get();

    if (typeof targetValue === "object") {
      const { query, path, schema, context, scope } = targetValue as WishParams;

      if (query === undefined || query === null || query === "") {
        const errorMsg = `Wish target "${
          JSON.stringify(targetValue)
        }" has no query.`;
        sendResult(
          tx,
          {
            result: undefined,
            candidates: [],
            error: errorMsg,
            [UI]: errorUI(errorMsg),
          } satisfies WishState<any>,
        );
        return;
      }

      // If the query is a path or a hash tag, resolve it directly
      if (query.startsWith("/") || /^#[a-zA-Z0-9-]+/.test(query)) {
        try {
          const parsed = parseWishTarget(query);
          parsed.path = [...parsed.path, ...(path ?? [])];
          const ctx: WishContext = { runtime, tx, parentCell, scope };
          const baseResolutions = await resolveBase(parsed, ctx);
          const resultCells = baseResolutions.map((baseResolution) => {
            const combinedPath = baseResolution.pathPrefix
              ? [...baseResolution.pathPrefix, ...parsed.path]
              : parsed.path;
            const resolvedCell = resolvePath(baseResolution.cell, combinedPath);
            return schema ? resolvedCell.asSchema(schema) : resolvedCell;
          });

          // Deduplicate result cells using Cell.equals()
          const uniqueResultCells = resultCells.filter(
            (cell, index) =>
              resultCells.findIndex((c) => c.equals(cell)) === index,
          );

          // Sync all result cells to ensure data is loaded
          await Promise.all(uniqueResultCells.map((cell) => cell.sync()));

          // Unified shape: always return { result, candidates, [UI] }
          // For single result, use fast path (no picker needed)
          // For multiple results, launch wish pattern for picker
          const candidatesCell = runtime.getImmutableCell(
            parentCell.space,
            uniqueResultCells,
            undefined,
            tx,
          );

          if (uniqueResultCells.length === 1) {
            // Single result - fast path with unified shape
            // Prefer the result cell's own [UI]; fall back to ct-cell-link
            const resultUI = resultCells[0].key(UI).get();
            sendResult(tx, {
              result: uniqueResultCells[0],
              candidates: candidatesCell,
              [UI]: resultUI ?? cellLinkUI(uniqueResultCells[0]),
            });
          } else {
            // Multiple results — await pattern load + run (like the old
            // launchWishPattern). Fall back to first result on failure.
            if (!suggestionPatternFetchPromise) {
              suggestionPatternFetchPromise = fetchSuggestionPattern(
                runtime,
              ).then((p) => {
                suggestionPattern = p;
                return p;
              });
            }
            await suggestionPatternFetchPromise;

            let pickerReady = false;
            if (suggestionPattern) {
              if (!suggestionPatternResultCell) {
                suggestionPatternResultCell = runtime.getCell(
                  parentCell.space,
                  {
                    wish: {
                      suggestionPattern: cause,
                      situation: query,
                    },
                  },
                  undefined,
                  tx,
                );
                addCancel(
                  () => runtime.runner.stop(suggestionPatternResultCell!),
                );
              }
              suggestionPatternInput = {
                situation: query,
                context: context ?? {},
                initialResults: candidatesCell,
              };
              try {
                await runtime.runSynced(
                  suggestionPatternResultCell,
                  suggestionPattern,
                  suggestionPatternInput,
                );
                pickerReady = true;
              } catch (e) {
                console.warn(
                  "[wish] Failed to run suggestion pattern for picker:",
                  e,
                );
              }
            }

            if (pickerReady) {
              sendResult(tx, suggestionPatternResultCell);
            } else {
              // Pattern unavailable or failed — fall back to first result
              const fallbackUI = uniqueResultCells[0].key(UI).get() ??
                cellLinkUI(uniqueResultCells[0]);
              sendResult(tx, {
                result: uniqueResultCells[0],
                candidates: candidatesCell,
                [UI]: fallbackUI,
              });
            }
          }
        } catch (e) {
          const errorMsg = e instanceof WishError ? e.message : String(e);
          sendResult(
            tx,
            {
              result: undefined,
              candidates: [],
              error: errorMsg,
              [UI]: errorUI(errorMsg),
            } satisfies WishState<any>,
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
        {
          result: undefined,
          candidates: [],
          error: errorMsg,
          [UI]: errorUI(errorMsg),
        } satisfies WishState<any>,
      );
      return;
    }
  };
}
