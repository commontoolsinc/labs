import {
  type VNode,
  type WishParams,
  type WishState,
  type WishTag,
} from "@commonfabric/api";
import { h } from "@commonfabric/html";
import { favoriteListSchema } from "@commonfabric/home-schemas";
import { HttpProgramResolver } from "@commonfabric/js-compiler";
import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type Runtime, spaceCellSchema } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { NAME, type Pattern, UI } from "../builder/types.ts";
import { toDeepFrozenSchema } from "@commonfabric/data-model/schema-utils";
import { getPatternEnvironment } from "../env.ts";
import { getLogger } from "@commonfabric/utils/logger";

const SUGGESTION_TSX_PATH = getPatternEnvironment().apiUrl +
  "api/patterns/system/suggestion.tsx";
const wishFlowLogger = getLogger("runner.wish-flow", {
  enabled: true,
  level: "warn",
  logCountEvery: 0,
});

// Schema for mentionable array - items are cell references (asCell: true)
// Don't restrict properties so .get() returns full cell data
const mentionableListSchema = toDeepFrozenSchema(
  {
    type: "array",
    items: { asCell: true },
  },
  true,
);

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

function getTxDebugActionId(
  tx?: IExtendedStorageTransaction,
): string | undefined {
  return tx ? (tx.tx as { debugActionId?: string }).debugActionId : undefined;
}

function sanitizeQueryKey(query: string): string {
  const normalized = query.trim().replace(/[^a-zA-Z0-9#/_:-]+/g, "_");
  if (!normalized) return "empty";
  return normalized.slice(0, 80);
}

function sanitizeSourceKey(sourceKey: string): string {
  const normalized = sourceKey.trim().replace(/[^a-zA-Z0-9#/_:-]+/g, "_");
  if (!normalized) return "none";
  return normalized.slice(0, 80);
}

function formatScope(scope?: string[]): string {
  return scope && scope.length > 0 ? scope.join(",") : "(default)";
}

function describeCell(cell: Cell<unknown>): string {
  const link = cell.getAsNormalizedFullLink();
  const path = link.path.length > 0 ? `/${link.path.join("/")}` : "";
  return `${link.space}/${link.id}${path}`;
}

function bucketDuration(ms: number): string {
  if (ms < 1) return "lt1ms";
  if (ms < 5) return "1to5ms";
  if (ms < 20) return "5to20ms";
  if (ms < 100) return "20to100ms";
  return "gte100ms";
}

function getResolutionKind(parsed: ParsedWishTarget): string {
  switch (parsed.key) {
    case "/":
    case "#default":
    case "#mentionable":
    case "#summaryIndex":
    case "#knowledgeGraph":
    case "#allPieces":
    case "#recent":
    case "#now":
      return "space-target";
    case "#favorites":
    case "#journal":
    case "#learned":
    case "#profile":
      return "home-target";
    default:
      return "hashtag-search";
  }
}

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
  /** Cached #now cell to avoid non-idempotent re-runs from Date.now() */
  nowCell?: Cell<unknown>;
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

type MentionableSearchResult = {
  matches: BaseResolution[];
  /** true when cell data has loaded (even if empty); false when still pending */
  loaded: boolean;
};

/**
 * Search mentionables in current space for pieces matching a hashtag.
 * Synchronous: reads cell.get() which returns undefined if data isn't loaded
 * yet. The reactive system will re-trigger wish when the data arrives.
 */
function searchMentionablesForHashtag(
  ctx: WishContext,
  searchTermWithoutHash: string,
  pathPrefix: string[],
  spaceCell?: Cell<unknown>,
): MentionableSearchResult {
  const mentionableCell = (spaceCell ?? getSpaceCell(ctx))
    .key("defaultPattern")
    .key("backlinksIndex")
    .key("mentionable")
    .resolveAsCell()
    .asSchema(mentionableListSchema);
  const raw = mentionableCell.get();
  if (raw === undefined || raw === null) {
    // Data not loaded yet — reactive system will re-trigger when it arrives
    return { matches: [], loaded: false };
  }
  const mentionables = (raw || []) as Cell<any>[];

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

  const sourceKey = getTxDebugActionId(ctx.tx) ?? "none";
  const query = `#${searchTermWithoutHash}`;
  wishFlowLogger.debug(`wish/search-hashtag/${sanitizeQueryKey(query)}`, () =>
    [
      `[WISH SEARCH] source=${sourceKey}`,
      `query=${query}`,
      `scope=${formatScope(ctx.scope)}`,
      `space=${describeCell(spaceCell ?? getSpaceCell(ctx))}`,
      `mentionableCount=${mentionables.length}`,
      `matchCount=${matches.length}`,
      matches.length > 0
        ? `matches=${
          matches.slice(0, 5).map((cell) => describeCell(cell)).join(", ")
        }`
        : undefined,
    ].filter(Boolean));

  return {
    matches: matches.map((match) => ({ cell: match, pathPrefix })),
    loaded: true,
  };
}

/**
 * Search for pieces by hashtag across favorites and/or mentionables based on scope.
 * Synchronous: relies on cell.get() returning undefined for unloaded data;
 * the reactive system will re-trigger wish when data arrives.
 */
function searchByHashtag(
  parsed: ParsedWishTarget,
  ctx: WishContext,
): BaseResolution[] {
  const searchTerm = parsed.key.toLowerCase();
  const searchTermWithoutHash = searchTerm.slice(1);

  // Determine what to search based on scope
  // Default (no scope) = favorites only for backward compatibility
  const searchFavorites = !ctx.scope || ctx.scope.includes("~");
  const searchMentionables = ctx.scope?.includes(".");

  const allMatches: BaseResolution[] = [];
  let allMentionablesLoaded = true;

  if (searchFavorites) {
    allMatches.push(
      ...searchFavoritesForHashtag(ctx, searchTermWithoutHash, parsed.path),
    );
  }

  if (searchMentionables) {
    const { matches, loaded } = searchMentionablesForHashtag(
      ctx,
      searchTermWithoutHash,
      parsed.path,
    );
    allMatches.push(...matches);
    if (!loaded) allMentionablesLoaded = false;
  }

  // Search mentionables in arbitrary DID spaces
  const arbitraryDIDs = getArbitraryDIDs(ctx.scope);
  for (const did of arbitraryDIDs) {
    const didSpaceCell = getSpaceCellForDID(ctx.runtime, did, ctx.tx);
    const { matches, loaded } = searchMentionablesForHashtag(
      ctx,
      searchTermWithoutHash,
      parsed.path,
      didSpaceCell,
    );
    allMatches.push(...matches);
    if (!loaded) allMentionablesLoaded = false;
  }

  if (allMatches.length === 0) {
    if (!allMentionablesLoaded) {
      // Some mentionable data not loaded yet — return empty so the reactive
      // system re-triggers wish when cell data arrives.
      return [];
    }
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
    // Cache the #now cell per wish instance so that sync re-runs don't
    // create a new immutable cell each time (Date.now() changes each call).
    if (!ctx.nowCell) {
      ctx.nowCell = ctx.runtime.getImmutableCell(
        ctx.parentCell.space,
        Date.now(),
        undefined,
        ctx.tx,
      );
    }
    return [{ cell: ctx.nowCell }];
  }

  const pathForKey: Record<string, readonly string[]> = {
    "/": [],
    "#default": ["defaultPattern"],
    "#mentionable": ["defaultPattern", "backlinksIndex", "mentionable"],
    "#summaryIndex": ["defaultPattern", "summaryIndex"],
    "#knowledgeGraph": ["defaultPattern", "knowledgeGraph"],

    "#allPieces": ["defaultPattern", "allPieces"],
    "#recent": ["defaultPattern", "recentPieces"],
    "#suggestions": ["defaultPattern", "suggestionHistory"],
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
function resolveBase(
  parsed: ParsedWishTarget,
  ctx: WishContext,
): BaseResolution[] {
  // Try space targets first (most common)
  const spaceResult = resolveSpaceTarget(parsed, ctx);
  if (spaceResult) return spaceResult;

  // Try home space targets
  const homeResult = resolveHomeSpaceTarget(parsed, ctx);
  if (homeResult) return homeResult;

  // Hashtag search
  if (parsed.key.startsWith("#")) {
    return searchByHashtag(parsed, ctx);
  }

  throw new WishError(`Wish target "${parsed.key}" is not recognized.`);
}

// fetchSuggestionPattern runs at runtime scope, shared across all wish invocations
let suggestionPatternFetchPromise: Promise<Pattern | undefined> | undefined;
let suggestionPattern: Pattern | undefined;

async function fetchSuggestionPattern(
  runtime: Runtime,
): Promise<Pattern | undefined> {
  try {
    const program = await runtime.harness.resolve(
      new HttpProgramResolver(SUGGESTION_TSX_PATH),
    );

    if (!program) {
      throw new WishError("Can't load suggestion.tsx");
    }
    const pattern = await runtime.patternManager.compilePattern(program);

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
  return h("cf-cell-link", { $cell: cell });
}

const TARGET_SCHEMA = toDeepFrozenSchema(
  {
    type: "object",
    properties: {
      query: { type: "string" },
      path: { type: "array", items: { type: "string" } },
      context: { type: "object", additionalProperties: { asCell: true } },
      scope: { type: "array", items: { type: "string" } },
      headless: { type: "boolean" },
    },
    required: ["query"],
  },
  true,
);

export function wish(
  inputsCell: Cell<[unknown, unknown]>,
  sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
  addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  let cancelled = false;
  // Per-instance cached #now cell — prevents non-idempotent re-runs from
  // Date.now() producing a different value each time the sync action fires.
  let nowCell: Cell<unknown> | undefined;

  // Per-instance suggestion pattern result cell
  let suggestionPatternInput:
    | {
      situation: string;
      context: Record<string, any>;
      initialResults?: unknown;
    }
    | undefined;
  let suggestionPatternResultCell: Cell<WishState<any>> | undefined;

  addCancel(() => {
    cancelled = true;
    if (suggestionPatternResultCell) {
      runtime.runner.stop(suggestionPatternResultCell);
    }
  });

  function launchSuggestionPattern(
    input: {
      situation: string;
      context: Record<string, any>;
      initialResults?: unknown;
    },
    providedTx?: IExtendedStorageTransaction,
  ) {
    suggestionPatternInput = input;
    const sourceKey = getTxDebugActionId(providedTx) ?? "none";
    const queryKey = sanitizeQueryKey(input.situation);
    const sourceBucket = sanitizeSourceKey(sourceKey);

    const tx = providedTx || runtime.edit();

    if (!suggestionPatternResultCell) {
      suggestionPatternResultCell = runtime.getCell(
        parentCell.space,
        { wish: { suggestionPattern: cause, situation: input.situation } },
        undefined,
        tx,
      );
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
      // Once fetch completes, run the pattern without a tx (it creates its own)
      void suggestionPatternFetchPromise.then((pattern) => {
        if (!cancelled && pattern && suggestionPatternResultCell) {
          wishFlowLogger.debug(`wish/run-suggestion/${queryKey}`, () => [
            `[WISH RUN SUGGESTION] source=${sourceKey}`,
            `query=${input.situation}`,
            `mode=fetch-then-run`,
            `result=${
              suggestionPatternResultCell
                ? describeCell(suggestionPatternResultCell)
                : "unknown"
            }`,
          ]);
          wishFlowLogger.debug(
            `wish/run-suggestion-source/${queryKey}/${sourceBucket}`,
            () => [`source=${sourceKey}`],
          );
          runtime.run(
            undefined,
            pattern,
            suggestionPatternInput,
            suggestionPatternResultCell!,
          );
        }
      });
    } else {
      if (!cancelled && suggestionPatternResultCell) {
        wishFlowLogger.debug(`wish/run-suggestion/${queryKey}`, () => [
          `[WISH RUN SUGGESTION] source=${sourceKey}`,
          `query=${input.situation}`,
          `mode=reuse-pattern`,
          `result=${
            suggestionPatternResultCell
              ? describeCell(suggestionPatternResultCell)
              : "unknown"
          }`,
        ]);
        wishFlowLogger.debug(
          `wish/run-suggestion-source/${queryKey}/${sourceBucket}`,
          () => [`source=${sourceKey}`],
        );
        runtime.run(
          tx,
          suggestionPattern,
          suggestionPatternInput,
          suggestionPatternResultCell,
        );
      }
    }

    if (!providedTx) tx.commit();

    return suggestionPatternResultCell;
  }

  // Wish action, reactive to changes in inputsCell and any cell we read during
  // initial resolution. Synchronous: reads cell.get() which triggers sync and
  // returns undefined if data isn't loaded yet. The reactive system re-triggers
  // wish when the data arrives.
  return (tx: IExtendedStorageTransaction) => {
    const inputsWithTx = inputsCell.withTx(tx);
    const targetValue = inputsWithTx.asSchema(TARGET_SCHEMA).get();
    const sourceKey = getTxDebugActionId(tx) ?? "none";
    const sourceBucket = sanitizeSourceKey(sourceKey);

    if (typeof targetValue === "object") {
      const { query, path, schema, context, scope, headless } =
        targetValue as WishParams;
      const queryKey = sanitizeQueryKey(String(query ?? ""));

      if (query === undefined || query === null || query === "") {
        const errorMsg = `Wish target "${
          JSON.stringify(targetValue)
        }" has no query.`;
        wishFlowLogger.debug(`wish/error/${queryKey}`, () => [
          `[WISH ERROR] source=${sourceKey}`,
          `query=${String(query ?? "")}`,
          `error=${errorMsg}`,
        ]);
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
        wishFlowLogger.debug(`wish/start/${queryKey}`, () => [
          `[WISH START] source=${sourceKey}`,
          `query=${query}`,
          `scope=${formatScope(scope)}`,
          `headless=${Boolean(headless)}`,
          `path=${JSON.stringify(path ?? [])}`,
          `parent=${describeCell(parentCell)}`,
        ]);
        wishFlowLogger.debug(
          `wish/start-source/${queryKey}/${sourceBucket}`,
          () => [`source=${sourceKey}`],
        );
        try {
          const resolveStartedAt = performance.now();
          const parsed = parseWishTarget(query);
          parsed.path = [...parsed.path, ...(path ?? [])];
          const ctx: WishContext = { runtime, tx, parentCell, scope, nowCell };
          const baseResolutions = resolveBase(parsed, ctx);
          // Persist #now cell across re-runs to avoid non-idempotent loops
          if (ctx.nowCell) nowCell = ctx.nowCell;

          if (baseResolutions.length === 0) {
            // No matches yet — data may still be loading. Send a pending
            // result; the reactive system will re-trigger when cells update
            // (dependencies were registered by the cell.get() calls in the
            // search functions).
            sendResult(
              tx,
              {
                result: undefined,
                candidates: [],
                [UI]: undefined,
              } satisfies WishState<any>,
            );
            return;
          }

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
          const resolveMs = Number(
            (performance.now() - resolveStartedAt).toFixed(3),
          );

          wishFlowLogger.debug(`wish/resolve/${queryKey}`, () =>
            [
              `[WISH RESOLVE] source=${sourceKey}`,
              `query=${query}`,
              `kind=${getResolutionKind(parsed)}`,
              `baseResolutions=${baseResolutions.length}`,
              `uniqueResults=${uniqueResultCells.length}`,
              `resolveMs=${resolveMs}`,
              uniqueResultCells.length > 0
                ? `results=${
                  uniqueResultCells.slice(0, 5).map((cell) =>
                    describeCell(cell)
                  ).join(", ")
                }`
                : undefined,
            ].filter(Boolean));
          wishFlowLogger.debug(
            `wish/resolve-source/${queryKey}/${sourceBucket}`,
            () => [`source=${sourceKey}`, `resolveMs=${resolveMs}`],
          );
          wishFlowLogger.debug(
            `wish/resolve-ms/${queryKey}/${bucketDuration(resolveMs)}`,
            () => [`source=${sourceKey}`, `resolveMs=${resolveMs}`],
          );
          wishFlowLogger.time(
            resolveStartedAt,
            "wish",
            "resolve",
            queryKey,
          );
          wishFlowLogger.time(
            resolveStartedAt,
            "wish",
            "resolve-source",
            queryKey,
            sourceBucket,
          );

          // Unified shape: always return { result, candidates, [UI] }
          // For single result, use fast path (no picker needed)
          // For multiple results, launch suggestion pattern for picker
          const candidatesCell = runtime.getImmutableCell(
            parentCell.space,
            uniqueResultCells,
            undefined,
            tx,
          );

          if (uniqueResultCells.length === 1 || headless) {
            // Single result or headless mode - fast path with unified shape
            // Prefer the result cell's own [UI]; fall back to cf-cell-link
            const resultUI = uniqueResultCells[0].key(UI).get();
            wishFlowLogger.debug(`wish/send-fast/${queryKey}`, () => [
              `[WISH FAST PATH] source=${sourceKey}`,
              `query=${query}`,
              `mode=${headless ? "headless" : "single-result"}`,
              `result=${describeCell(uniqueResultCells[0])}`,
            ]);
            wishFlowLogger.debug(
              `wish/send-fast-source/${queryKey}/${sourceBucket}`,
              () => [`source=${sourceKey}`],
            );
            sendResult(tx, {
              result: uniqueResultCells[0],
              candidates: candidatesCell,
              [UI]: resultUI ?? cellLinkUI(uniqueResultCells[0]),
            });
          } else {
            // Multiple results — if suggestion pattern is already loaded,
            // launch it and send its result cell so the picker's output
            // flows through. Otherwise fall back to first result and kick
            // off the fetch for next time.
            if (suggestionPattern) {
              sendResult(
                tx,
                launchSuggestionPattern(
                  {
                    situation: query,
                    context: context ?? {},
                    initialResults: candidatesCell,
                  },
                  tx,
                ),
              );
            } else {
              // Pattern not loaded yet — send first result, start fetch
              const resultUI = uniqueResultCells[0].key(UI).get();
              sendResult(tx, {
                result: uniqueResultCells[0],
                candidates: candidatesCell,
                [UI]: resultUI ?? cellLinkUI(uniqueResultCells[0]),
              });
              launchSuggestionPattern(
                {
                  situation: query,
                  context: context ?? {},
                  initialResults: candidatesCell,
                },
                tx,
              );
            }
          }
        } catch (e) {
          const errorMsg = e instanceof WishError ? e.message : String(e);
          wishFlowLogger.debug(`wish/error/${queryKey}`, () => [
            `[WISH ERROR] source=${sourceKey}`,
            `query=${query}`,
            `error=${errorMsg}`,
          ]);
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
      } else if (headless) {
        // Headless mode with freeform query — no suggestion pattern
        wishFlowLogger.debug(`wish/freeform/${queryKey}`, () => [
          `[WISH FREEFORM] source=${sourceKey}`,
          `query=${query}`,
          `mode=headless`,
        ]);
        sendResult(
          tx,
          {
            result: undefined,
            candidates: [],
            [UI]: undefined,
          } satisfies WishState<any>,
        );
      } else {
        // Otherwise it's a generic query, instantiate suggestion.tsx
        wishFlowLogger.debug(`wish/launch-suggestion/${queryKey}`, () => [
          `[WISH LAUNCH SUGGESTION] source=${sourceKey}`,
          `query=${query}`,
          `mode=freeform`,
        ]);
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
