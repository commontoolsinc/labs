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
import { type Action, type ReactivityLog } from "../scheduler.ts";
import { type Runtime, spaceCellSchema } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  type CellScope,
  type JSONSchema,
  NAME,
  type Pattern,
  UI,
} from "../builder/types.ts";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";
import { getPatternEnvironment } from "../env.ts";
import { getLogger } from "@commonfabric/utils/logger";
import {
  createSigilLinkFromParsedLink,
  getMetaLink,
  toMemorySpaceAddress,
} from "../link-utils.ts";
import { setRunnableName } from "../runner-utils.ts";
import { isCellScope, narrowestScope } from "../scope.ts";
import { scopedCell } from "./scope-policy.ts";

const SUGGESTION_TSX_PATH = getPatternEnvironment().apiUrl +
  "api/patterns/system/suggestion.tsx";
const PROFILE_CREATE_TSX_PATH = getPatternEnvironment().apiUrl +
  "api/patterns/system/profile-create.tsx";
const wishFlowLogger = getLogger("runner.wish-flow", {
  enabled: true,
  level: "warn",
  logCountEvery: 0,
});

// Schema for mentionable array - items are cell references (asCell: ["cell"])
// Don't restrict properties so .get() returns full cell data
const mentionableListSchema = internSchema(
  {
    type: "array",
    items: {
      type: "object",
      properties: { [NAME]: { type: "string" } },
      asCell: ["cell"],
    },
  },
);

const profileElementListSchema = internSchema(
  {
    type: "array",
    items: {
      type: "object",
      properties: {
        cell: { type: "object", asCell: ["cell"] },
        tag: { type: "string" },
        userTags: {
          type: "array",
          items: { type: "string" },
        },
        title: { type: "string" },
        source: { type: "string" },
      },
    },
  },
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

function sanitizeQueryKey(query: string): string {
  const normalized = query.trim().replace(/[^a-zA-Z0-9#/_:-]+/g, "_");
  if (!normalized) return "empty";
  return normalized.slice(0, 80);
}

function recordWishPhaseTiming(
  startedAt: number,
  phase: string,
  queryKey?: string,
): number {
  const endedAt = performance.now();
  wishFlowLogger.time(startedAt, endedAt, "wish", "phase", phase);
  if (queryKey) {
    wishFlowLogger.time(
      startedAt,
      endedAt,
      "wish",
      "phase-query",
      phase,
      queryKey,
    );
  }
  return endedAt - startedAt;
}

function measureWishPhase<T>(
  phase: string,
  queryKey: string | undefined,
  fn: () => T,
): T {
  const startedAt = performance.now();
  try {
    return fn();
  } finally {
    recordWishPhaseTiming(startedAt, phase, queryKey);
  }
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
    case "#profileName":
    case "#profileAvatar":
    case "#profileSpace":
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
  scope?: ("~" | "." | "profile" | string)[];
  /** Cached #now cell to avoid non-idempotent re-runs from Date.now() */
  nowCell?: Cell<unknown>;
  usedHomeSpace?: boolean;
};

type BaseResolution = {
  cell: Cell<unknown>;
  pathPrefix?: readonly string[];
};

type SharedHashtagState = {
  result?: Cell<unknown>;
  candidates: Cell<unknown>[];
  error?: unknown;
  [UI]?: VNode;
};

type SharedHashtagResolver = {
  cell: Cell<SharedHashtagState>;
  cancel: () => void;
  refCount: number;
};

const sharedHashtagResolvers = new WeakMap<
  Runtime,
  Map<string, SharedHashtagResolver>
>();

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
  return (scope ?? []).filter((s) => s !== "~" && s !== "." && s !== "profile");
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

function getHomeSpaceCell(ctx: WishContext): Cell<unknown> {
  ctx.usedHomeSpace = true;
  return ctx.runtime.getHomeSpaceCell(ctx.tx);
}

function getProfileDefaultCell(ctx: WishContext): Cell<unknown> {
  const homeSpaceCell = getHomeSpaceCell(ctx);
  const profileField = homeSpaceCell.key("defaultPattern").key(
    "profile",
  );
  const profileRaw = profileField.getRaw();
  const profileDefault = profileField.resolveAsCell();
  const profileLink = profileDefault.getAsNormalizedFullLink();
  if (
    profileRaw === undefined ||
    profileLink.space === homeSpaceCell.space ||
    profileLink.path.length > 0
  ) {
    throw new WishError("homeSpaceCell.defaultPattern.profile is not set");
  }
  void profileDefault.pull().catch((error) => {
    wishFlowLogger.warn("profile-pull", () => [
      "Failed to pull profile default pattern",
      error,
    ]);
  });
  void profileDefault.key("initialNameApplied").pull().catch((error) => {
    wishFlowLogger.warn("profile-name-pull", () => [
      "Failed to pull profile default name",
      error,
    ]);
  });
  profileDefault.key("initialNameApplied").get();
  return profileDefault;
}

function getProfileSpaceCell(ctx: WishContext): Cell<unknown> {
  const profileDefaultCell = getProfileDefaultCell(ctx);
  const { space } = profileDefaultCell.getAsNormalizedFullLink();
  return getSpaceCellForDID(ctx.runtime, space, ctx.tx);
}

function isProfilePersonaTarget(parsed: ParsedWishTarget): boolean {
  return parsed.key === "#profile" && parsed.path.length === 0;
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
  const queryKey = sanitizeQueryKey(`#${searchTermWithoutHash}`);
  const userDID = ctx.runtime.userIdentityDID;
  if (!userDID) return [];

  const favoritesCell = measureWishPhase(
    "favorites-cell",
    queryKey,
    () => {
      const homeSpaceCell = getHomeSpaceCell(ctx);
      return homeSpaceCell
        .key("defaultPattern")
        .key("favorites")
        .asSchema(favoriteListSchema);
    },
  );
  const favorites = measureWishPhase(
    "favorites-get",
    queryKey,
    () => favoritesCell.get() || [],
  );

  const matches = measureWishPhase(
    "favorites-filter",
    queryKey,
    () =>
      favorites.filter((entry) => {
        // Check userTags first (stored without # prefix)
        const userTags = entry.userTags ?? [];
        for (const t of userTags) {
          if (t.toLowerCase() === searchTermWithoutHash) return true;
        }
        // Search schema tag for hashtags
        return tagMatchesHashtag(entry.tag, searchTermWithoutHash);
      }),
  );

  return measureWishPhase(
    "favorites-result-map",
    queryKey,
    () => matches.map((match) => ({ cell: match.cell, pathPrefix })),
  );
}

type HashtagSearchResult = {
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
): HashtagSearchResult {
  const queryKey = sanitizeQueryKey(`#${searchTermWithoutHash}`);
  const mentionableCell = measureWishPhase(
    "mentionable-cell",
    queryKey,
    () =>
      (spaceCell ?? getSpaceCell(ctx))
        .key("defaultPattern")
        .key("backlinksIndex")
        .key("mentionable")
        .resolveAsCell()
        .asSchema(mentionableListSchema),
  );
  const raw = measureWishPhase(
    "mentionable-get",
    queryKey,
    () => mentionableCell.get(),
  );
  if (raw === undefined || raw === null) {
    // Data not loaded yet — reactive system will re-trigger when it arrives
    return { matches: [], loaded: false };
  }
  const mentionables = (raw || []) as Cell<any>[];

  const matches = measureWishPhase(
    "mentionable-filter",
    queryKey,
    () =>
      mentionables.filter((pieceCell: Cell<any>) => {
        if (!pieceCell) return false;

        const piece = measureWishPhase(
          "mentionable-piece-get",
          queryKey,
          () => pieceCell.get(),
        );
        if (!piece) return false;

        // Check [NAME] field for exact match
        const nameMatches = measureWishPhase(
          "mentionable-name-check",
          queryKey,
          () => {
            const name = piece[NAME]?.toLowerCase() ?? "";
            return name === searchTermWithoutHash;
          },
        );
        if (nameMatches) return true;

        // Compute schema tag lazily from the cell
        let tag: string | undefined;
        try {
          const schema = measureWishPhase(
            "mentionable-schema",
            queryKey,
            () =>
              pieceCell.resolveAsCell()?.asSchema(undefined)
                .asSchemaFromLinks?.()?.schema,
          );
          if (typeof schema === "object") {
            tag = measureWishPhase(
              "mentionable-schema-stringify",
              queryKey,
              () => JSON.stringify(schema),
            );
          }
        } catch {
          // Schema not available yet
        }

        return measureWishPhase(
          "mentionable-tag-match",
          queryKey,
          () => tagMatchesHashtag(tag, searchTermWithoutHash),
        );
      }),
  );

  return {
    matches: measureWishPhase(
      "mentionable-result-map",
      queryKey,
      () => matches.map((match) => ({ cell: match, pathPrefix })),
    ),
    loaded: true,
  };
}

function searchProfileForHashtag(
  ctx: WishContext,
  searchTermWithoutHash: string,
  pathPrefix: string[],
): HashtagSearchResult {
  const queryKey = sanitizeQueryKey(`#${searchTermWithoutHash}`);
  const elementsCell = measureWishPhase(
    "profile-elements-cell",
    queryKey,
    () =>
      getProfileDefaultCell(ctx)
        .key("elements")
        .asSchema(profileElementListSchema),
  );
  const elements = measureWishPhase(
    "profile-elements-get",
    queryKey,
    () => elementsCell.get(),
  );
  if (elements === undefined || elements === null) {
    return { matches: [], loaded: false };
  }

  const profileElements = elements as Array<{
    cell?: Cell<unknown>;
    tag?: string;
    userTags?: string[];
  }>;

  const matches = measureWishPhase(
    "profile-elements-filter",
    queryKey,
    () =>
      profileElements.filter((entry) => {
        const userTags = entry.userTags ?? [];
        for (const t of userTags) {
          if (t.toLowerCase() === searchTermWithoutHash) return true;
        }
        return tagMatchesHashtag(entry.tag, searchTermWithoutHash);
      }),
  );

  return {
    matches: measureWishPhase(
      "profile-elements-result-map",
      queryKey,
      () =>
        matches.flatMap((match) =>
          match.cell ? [{ cell: match.cell, pathPrefix }] : []
        ),
    ),
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
  const searchProfile = ctx.scope?.includes("profile");

  const allMatches: BaseResolution[] = [];
  let allScopedDataLoaded = true;

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
    if (!loaded) allScopedDataLoaded = false;
  }

  if (searchProfile) {
    const { matches, loaded } = searchProfileForHashtag(
      ctx,
      searchTermWithoutHash,
      parsed.path,
    );
    allMatches.push(...matches);
    if (!loaded) allScopedDataLoaded = false;
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
    if (!loaded) allScopedDataLoaded = false;
  }

  if (allMatches.length === 0) {
    if (!allScopedDataLoaded) {
      // Some scoped data not loaded yet — return empty so the reactive
      // system re-triggers wish when cell data arrives.
      return [];
    }
    const parts: string[] = [];
    if (searchFavorites) parts.push("favorites");
    if (searchMentionables) parts.push("mentionables");
    if (searchProfile) parts.push("profile");
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
      const homeSpaceCell = getHomeSpaceCell(ctx);

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
        cell: getHomeSpaceCell(ctx),
        pathPrefix: ["defaultPattern", "journal"],
      }];
    }

    case "#learned": {
      const userDID = ctx.runtime.userIdentityDID;
      if (!userDID) {
        throw new WishError("User identity DID not available for #learned");
      }
      return [{
        cell: getHomeSpaceCell(ctx),
        pathPrefix: ["defaultPattern", "learned"],
      }];
    }

    case "#profile": {
      const userDID = ctx.runtime.userIdentityDID;
      if (!userDID) {
        throw new WishError("User identity DID not available for #profile");
      }
      return [{
        cell: getProfileDefaultCell(ctx),
        pathPrefix: [],
      }];
    }

    case "#profileName": {
      const profileName = getHomeSpaceCell(ctx).key("defaultPattern")
        .resolveAsCell()
        .key("profileName");
      const profileNameValue = profileName.get() as unknown;
      if (
        typeof profileNameValue === "string" && profileNameValue.length > 0
      ) {
        return [{
          cell: profileName,
          pathPrefix: [],
        }];
      }
      return [{
        cell: getProfileDefaultCell(ctx),
        pathPrefix: ["initialNameApplied"],
      }];
    }

    case "#profileAvatar": {
      return [{
        cell: getProfileDefaultCell(ctx),
        pathPrefix: ["avatar"],
      }];
    }

    case "#profileSpace": {
      return [{
        cell: getProfileSpaceCell(ctx),
        pathPrefix: [],
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
    const homeSpaceCell = getHomeSpaceCell(ctx);
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

function isSharedHashtagSearchTarget(parsed: ParsedWishTarget): boolean {
  if (!parsed.key.startsWith("#")) return false;
  return getResolutionKind(parsed) === "hashtag-search";
}

function canUseSharedHashtagResult(
  parsed: ParsedWishTarget,
  options: { headless?: boolean },
): boolean {
  return isSharedHashtagSearchTarget(parsed) &&
    options.headless === true;
}

function sharedHashtagResolverKey(
  parentSpace: string,
  parsed: ParsedWishTarget,
  scope?: ("~" | "." | "profile" | string)[],
): string {
  return JSON.stringify({
    space: parentSpace,
    query: formatTarget(parsed),
    scope: scope ?? null,
  });
}

function getRuntimeSharedHashtagResolvers(
  runtime: Runtime,
): Map<string, SharedHashtagResolver> {
  let resolvers = sharedHashtagResolvers.get(runtime);
  if (!resolvers) {
    resolvers = new Map();
    sharedHashtagResolvers.set(runtime, resolvers);
  }
  return resolvers;
}

function createSharedHashtagResolver(
  ctx: WishContext,
  parsed: ParsedWishTarget,
): SharedHashtagResolver {
  const sharedParsed: ParsedWishTarget = {
    key: parsed.key,
    path: [...parsed.path],
  };
  const sharedScope = ctx.scope ? [...ctx.scope] : undefined;
  const query = formatTarget(sharedParsed);
  const sharedCell = ctx.runtime.getCell<SharedHashtagState>(
    ctx.parentCell.space,
    {
      wish: {
        kind: "hashtag",
        space: ctx.parentCell.space,
        scope: sharedScope ?? null,
        query,
      },
    },
    undefined,
    ctx.tx,
  );

  const action: Action = (tx: IExtendedStorageTransaction) => {
    const actionStartedAt = performance.now();
    const stateCell = sharedCell.withTx(tx);
    const queryKey = sanitizeQueryKey(query);
    try {
      const baseResolutions = searchByHashtag(sharedParsed, {
        runtime: ctx.runtime,
        tx,
        parentCell: ctx.parentCell,
        scope: sharedScope,
      });
      if (baseResolutions.length === 0) {
        stateCell.set({
          result: undefined,
          candidates: [],
          [UI]: undefined,
        });
        return;
      }

      const resultCells = measureWishPhase(
        "shared-resolve-paths",
        queryKey,
        () =>
          baseResolutions.map((baseResolution) => {
            const combinedPath = baseResolution.pathPrefix
              ? [...baseResolution.pathPrefix, ...sharedParsed.path]
              : sharedParsed.path;
            return resolvePath(baseResolution.cell, combinedPath);
          }),
      );
      const uniqueResultCells = measureWishPhase(
        "shared-dedupe-results",
        queryKey,
        () =>
          resultCells.filter(
            (cell, index) =>
              resultCells.findIndex((candidate) => candidate.equals(cell)) ===
                index,
          ),
      );
      const resultUI = measureWishPhase(
        "shared-result-ui-get",
        queryKey,
        () => uniqueResultCells[0].key(UI).get(),
      ) as VNode | undefined;

      stateCell.set({
        result: uniqueResultCells[0],
        candidates: uniqueResultCells,
        [UI]: resultUI ?? cellLinkUI(uniqueResultCells[0]),
      });
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      stateCell.set({
        result: undefined,
        candidates: [],
        error: errorMessage,
        [UI]: errorUI(errorMessage),
      });
    } finally {
      recordWishPhaseTiming(
        actionStartedAt,
        "shared-action-total",
        queryKey,
      );
    }
  };
  const actionName = `wish:hashtag:${ctx.parentCell.space}:${query}`;
  setRunnableName(action, actionName, { setSrc: true });
  Object.assign(action, {
    writes: [sharedCell.getAsNormalizedFullLink()],
  });

  const initialLog: ReactivityLog = {
    reads: [],
    shallowReads: [],
    writes: [toMemorySpaceAddress(sharedCell.getAsNormalizedFullLink())],
  };
  const cancel = ctx.runtime.scheduler.subscribe(action, initialLog);

  return { cell: sharedCell, cancel, refCount: 0 };
}

function acquireSharedHashtagResolver(
  ctx: WishContext,
  parsed: ParsedWishTarget,
): SharedHashtagResolver {
  const key = sharedHashtagResolverKey(ctx.parentCell.space, parsed, ctx.scope);
  const resolvers = getRuntimeSharedHashtagResolvers(ctx.runtime);
  let resolver = resolvers.get(key);
  if (!resolver) {
    resolver = createSharedHashtagResolver(ctx, parsed);
    resolvers.set(key, resolver);
  }
  resolver.refCount++;
  return resolver;
}

function releaseSharedHashtagResolver(runtime: Runtime, key: string): void {
  const resolvers = sharedHashtagResolvers.get(runtime);
  const resolver = resolvers?.get(key);
  if (!resolver) return;

  resolver.refCount--;
  if (resolver.refCount > 0) return;

  resolver.cancel();
  resolvers?.delete(key);
}

// fetchSuggestionPattern runs at runtime scope, shared across all wish invocations
let suggestionPatternFetchPromise: Promise<Pattern | undefined> | undefined;
let suggestionPattern: Pattern | undefined;
let profileCreatePatternFetchPromise: Promise<Pattern | undefined> | undefined;
let profileCreatePattern: Pattern | undefined;

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

async function fetchProfileCreatePattern(
  runtime: Runtime,
): Promise<Pattern | undefined> {
  try {
    const program = await runtime.harness.resolve(
      new HttpProgramResolver(PROFILE_CREATE_TSX_PATH),
    );

    if (!program) {
      throw new WishError("Can't load profile-create.tsx");
    }
    const pattern = await runtime.patternManager.compilePattern(program);

    if (!pattern) throw new WishError("Can't compile profile-create.tsx");

    return pattern;
  } catch (e) {
    console.error("Can't load profile-create.tsx", e);
    return undefined;
  }
}

function errorUI(message: string): VNode {
  return h("span", { style: "color: red" }, `⚠️ ${message}`);
}

function cellLinkUI(cell: Cell<unknown>): VNode {
  return h("cf-cell-link", { $cell: cell });
}

function wishResultUI(
  parsed: ParsedWishTarget,
  resultCell: Cell<unknown>,
): VNode | undefined {
  if (isProfilePersonaTarget(parsed)) {
    return cellLinkUI(resultCell);
  }
  return resultCell.key(UI).get() as VNode | undefined;
}

function projectWishCellValue(
  cell: Cell<unknown>,
  schema: unknown,
): unknown {
  if (schema === undefined) return cell;
  return cell.asSchema(schema as JSONSchema).getAsLink({ includeSchema: true });
}

function createWishCandidatesCell(
  runtime: Runtime,
  space: Cell<unknown>["space"],
  candidates: Cell<unknown>[],
  schema: unknown,
  tx: IExtendedStorageTransaction,
): Cell<unknown> {
  const values = schema === undefined
    ? candidates
    : candidates.map((candidate) => projectWishCellValue(candidate, schema));
  return runtime.getImmutableCell(space, values, undefined, tx);
}

function schemaAsCell(schema: unknown): JSONSchema {
  if (schema && typeof schema === "object") {
    return {
      ...(JSON.parse(JSON.stringify(schema)) as Record<string, unknown>),
      asCell: ["cell"],
    };
  }
  return { asCell: ["cell"] };
}

function wishStateSchemaForResult(schema: unknown): JSONSchema | undefined {
  if (schema === undefined) return undefined;
  const resultSchema = schemaAsCell(schema);
  const candidateSchema = schemaAsCell(schema);
  return internSchema({
    type: "object",
    properties: {
      result: {
        anyOf: [
          { type: "undefined" },
          resultSchema,
        ],
      },
      candidates: {
        type: "array",
        items: candidateSchema,
      },
      error: true,
      [UI]: true,
    },
    required: ["result", "candidates"],
  });
}

function explicitWishSchemaScope(schema: unknown): CellScope | undefined {
  if (
    schema &&
    typeof schema === "object" &&
    "scope" in schema &&
    isCellScope((schema as { scope?: unknown }).scope)
  ) {
    return (schema as { scope: CellScope }).scope;
  }
  return undefined;
}

function wishOutputScope(
  schema: unknown,
  inputScope: CellScope,
  usesHomeSpace: boolean,
): CellScope {
  const explicitScope = explicitWishSchemaScope(schema);
  if (explicitScope) return explicitScope;
  if (usesHomeSpace) {
    return narrowestScope([inputScope, "user"]);
  }
  return inputScope;
}

export function wishTargetMayUseHomeSpace(
  query: unknown,
  scope?: ("~" | "." | "profile" | string)[],
): boolean {
  if (typeof query !== "string") {
    return scope?.includes("~") === true ||
      scope?.includes("profile") === true;
  }

  let parsed: ParsedWishTarget;
  try {
    parsed = parseWishTarget(query);
  } catch {
    return false;
  }

  const kind = getResolutionKind(parsed);
  if (kind === "home-target") return true;
  if (scope?.includes("~") || scope?.includes("profile")) return true;
  return kind === "hashtag-search" && scope === undefined;
}

function sharedWishCellValue(
  cell: Cell<SharedHashtagState>,
  schema: unknown,
): unknown {
  const wishStateSchema = wishStateSchemaForResult(schema);
  if (!wishStateSchema) return cell;
  return cell.asSchema(wishStateSchema).getAsLink({ includeSchema: true });
}

const TARGET_SCHEMA = internSchema(
  {
    type: "object",
    properties: {
      query: { type: "string" },
      path: { type: "array", items: { type: "string" } },
      schema: true,
      context: { type: "object", additionalProperties: { asCell: ["cell"] } },
      scope: { type: "array", items: { type: "string" } },
      headless: { type: "boolean" },
    },
    required: ["query"],
  },
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
  let sharedHashtagKey: string | undefined;

  // Per-instance suggestion pattern result cell
  let suggestionPatternInput:
    | {
      situation: string;
      context: Record<string, any>;
      initialResults?: unknown;
    }
    | undefined;
  let suggestionPatternResultCell: Cell<WishState<any>> | undefined;
  let profileCreatePatternInput:
    | {
      profile: unknown;
      profileName: unknown;
      inputId: string;
      buttonId: string;
    }
    | undefined;
  let profileCreatePatternResultCell: Cell<any> | undefined;
  let profileCreatePatternReadyCell: Cell<boolean> | undefined;

  addCancel(() => {
    cancelled = true;
    releaseCurrentSharedHashtagResolver();
    if (suggestionPatternResultCell) {
      runtime.runner.stop(suggestionPatternResultCell);
    }
    if (profileCreatePatternResultCell) {
      runtime.runner.stop(profileCreatePatternResultCell);
    }
  });

  function releaseCurrentSharedHashtagResolver(): void {
    if (!sharedHashtagKey) return;
    releaseSharedHashtagResolver(runtime, sharedHashtagKey);
    sharedHashtagKey = undefined;
  }

  function getCurrentSharedHashtagResolver(
    ctx: WishContext,
    parsed: ParsedWishTarget,
  ): SharedHashtagResolver {
    const nextKey = sharedHashtagResolverKey(
      ctx.parentCell.space,
      parsed,
      ctx.scope,
    );
    const existing = sharedHashtagResolvers.get(runtime)?.get(nextKey);
    if (nextKey === sharedHashtagKey && existing) return existing;

    releaseCurrentSharedHashtagResolver();
    const resolver = acquireSharedHashtagResolver(ctx, parsed);
    sharedHashtagKey = nextKey;
    return resolver;
  }

  function sendWishState(
    tx: IExtendedStorageTransaction,
    value: unknown,
    outputScope: CellScope,
    schema: unknown,
  ): void {
    const baseCell = runtime.getCell(
      parentCell.space,
      { wish: { state: cause } },
      wishStateSchemaForResult(schema),
      tx,
    );
    const scoped = scopedCell(runtime, tx, baseCell, outputScope);
    if (scoped !== baseCell) {
      // Copy the meta result link from the base cell into our new scoped cell
      const resultLink = getMetaLink(baseCell.withTx(tx), "result");
      if (resultLink !== undefined) {
        scoped.setMetaRaw(
          "result",
          createSigilLinkFromParsedLink(resultLink, {
            base: scoped,
            includeSchema: true,
          }),
        );
      }
    }
    scoped.set(value);
    sendResult(tx, scoped);
  }

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
        runtime.run(
          tx,
          suggestionPattern,
          suggestionPatternInput,
          suggestionPatternResultCell,
        );
      }
    }

    if (!providedTx) {
      runtime.prepareTxForCommit(tx);
      tx.commit();
    }

    return suggestionPatternResultCell;
  }

  function launchProfileCreatePattern(
    ctx: WishContext,
    providedTx?: IExtendedStorageTransaction,
  ): Cell<any> {
    const homeDefaultPattern = getHomeSpaceCell(ctx).key("defaultPattern")
      .resolveAsCell();
    profileCreatePatternInput = {
      profile: createSigilLinkFromParsedLink(
        homeDefaultPattern.key("profile").getAsNormalizedFullLink(),
      ),
      profileName: createSigilLinkFromParsedLink(
        homeDefaultPattern.key("profileName").getAsNormalizedFullLink(),
      ),
      inputId: "wish-profile-name-input",
      buttonId: "wish-profile-create-button",
    };
    const tx = providedTx || runtime.edit();

    if (!profileCreatePatternResultCell) {
      profileCreatePatternResultCell = runtime.getCell(
        parentCell.space,
        {
          wish: {
            profileCreatePattern: cause,
            user: runtime.userIdentityDID,
          },
        },
        undefined,
        tx,
      );
    }
    if (!profileCreatePatternReadyCell) {
      profileCreatePatternReadyCell = runtime.getCell<boolean>(
        parentCell.space,
        {
          wish: {
            profileCreatePatternReady: cause,
            user: runtime.userIdentityDID,
          },
        },
        undefined,
        tx,
      );
    }
    profileCreatePatternReadyCell.get();

    if (!profileCreatePattern) {
      if (!profileCreatePatternFetchPromise) {
        profileCreatePatternFetchPromise = fetchProfileCreatePattern(runtime)
          .then((pattern) => {
            profileCreatePattern = pattern;
            if (pattern && profileCreatePatternReadyCell) {
              const readyTx = runtime.edit();
              profileCreatePatternReadyCell.withTx(readyTx).set(true);
              runtime.prepareTxForCommit(readyTx);
              readyTx.commit();
            }
            if (!pattern) {
              profileCreatePatternFetchPromise = undefined;
            }
            return pattern;
          });
      }
      void profileCreatePatternFetchPromise.then((pattern) => {
        if (!cancelled && pattern && profileCreatePatternResultCell) {
          try {
            const runTx = runtime.edit();
            const resultCell = profileCreatePatternResultCell.withTx(runTx);
            const input = profileCreatePatternInput && {
              ...profileCreatePatternInput,
              profile: typeof (profileCreatePatternInput.profile as {
                  withTx?: unknown;
                }).withTx === "function"
                ? (profileCreatePatternInput.profile as Cell<unknown>).withTx(
                  runTx,
                )
                : profileCreatePatternInput.profile,
            };
            runtime.run(
              runTx,
              pattern,
              input,
              resultCell,
            );
            runtime.prepareTxForCommit(runTx);
            runTx.commit().then(({ error }) => {
              if (error) {
                const errorTx = runtime.edit();
                profileCreatePatternResultCell!.withTx(errorTx).set({
                  [UI]: errorUI(toCompactDebugString(error)),
                });
                runtime.prepareTxForCommit(errorTx);
                errorTx.commit();
              }
            }).catch((error) => {
              const errorTx = runtime.edit();
              profileCreatePatternResultCell!.withTx(errorTx).set({
                [UI]: errorUI(
                  error instanceof Error ? error.message : String(error),
                ),
              });
              runtime.prepareTxForCommit(errorTx);
              errorTx.commit();
            });
          } catch (error) {
            const errorTx = runtime.edit();
            profileCreatePatternResultCell.withTx(errorTx).set({
              [UI]: errorUI(
                error instanceof Error ? error.message : String(error),
              ),
            });
            runtime.prepareTxForCommit(errorTx);
            errorTx.commit();
          }
        }
      });
    } else if (!cancelled && profileCreatePatternResultCell) {
      runtime.run(
        tx,
        profileCreatePattern,
        profileCreatePatternInput,
        profileCreatePatternResultCell,
      );
    }

    if (!providedTx) {
      runtime.prepareTxForCommit(tx);
      tx.commit();
    }

    return profileCreatePatternResultCell;
  }

  function profileCreateUI(ctx: WishContext): VNode {
    return h("cf-render", {
      "data-profile-create-ui": "wish",
      $cell: launchProfileCreatePattern(ctx, ctx.tx),
    });
  }

  // Wish action, reactive to changes in inputsCell and any cell we read during
  // initial resolution. Synchronous: reads cell.get() which triggers sync and
  // returns undefined if data isn't loaded yet. The reactive system re-triggers
  // wish when the data arrives.
  return (tx: IExtendedStorageTransaction) => {
    const actionStartedAt = performance.now();
    let actionQueryKey: string | undefined;
    let usedSharedHashtagResolver = false;

    try {
      tx.resetNarrowestReadScope();
      const targetValue = measureWishPhase(
        "input-get",
        undefined,
        () => {
          const inputsWithTx = inputsCell.withTx(tx);
          return inputsWithTx.asSchema(TARGET_SCHEMA).get();
        },
      );

      if (typeof targetValue === "object") {
        const { query, path, schema, context, scope, headless } =
          targetValue as WishParams;
        const queryKey = sanitizeQueryKey(String(query ?? ""));
        actionQueryKey = queryKey;
        const inputScope = tx.getNarrowestReadScope();
        const targetMayUseHomeSpace = wishTargetMayUseHomeSpace(query, scope);

        if (query === undefined || query === null || query === "") {
          const errorMsg = `Wish target "${
            toCompactDebugString(targetValue)
          }" has no query.`;
          const outputScope = wishOutputScope(
            schema,
            inputScope,
            targetMayUseHomeSpace,
          );
          measureWishPhase(
            "send-error",
            queryKey,
            () =>
              sendWishState(
                tx,
                {
                  result: undefined,
                  candidates: [],
                  error: errorMsg,
                  [UI]: errorUI(errorMsg),
                } satisfies WishState<any>,
                outputScope,
                schema,
              ),
          );
          return;
        }

        // If the query is a path or a hash tag, resolve it directly
        if (query.startsWith("/") || /^#[a-zA-Z0-9-]+/.test(query)) {
          const ctx: WishContext = {
            runtime,
            tx,
            parentCell,
            scope,
            nowCell,
          };
          let parsed: ParsedWishTarget | undefined;
          try {
            const resolveStartedAt = performance.now();
            const activeParsed = parsed = measureWishPhase(
              "parse-target",
              queryKey,
              () => {
                const nextParsed = parseWishTarget(query);
                nextParsed.path = [...nextParsed.path, ...(path ?? [])];
                return nextParsed;
              },
            );
            if (canUseSharedHashtagResult(activeParsed, { headless })) {
              const shared = getCurrentSharedHashtagResolver(ctx, activeParsed);
              usedSharedHashtagResolver = true;
              measureWishPhase(
                "send-shared-hashtag",
                queryKey,
                () =>
                  sendResult(
                    tx,
                    sharedWishCellValue(shared.cell, schema),
                  ),
              );
              return;
            }

            const baseResolutions = measureWishPhase(
              "resolve-base",
              queryKey,
              () => resolveBase(activeParsed, ctx),
            );
            const outputScope = wishOutputScope(
              schema,
              inputScope,
              targetMayUseHomeSpace || ctx.usedHomeSpace === true,
            );
            // Persist #now cell across re-runs to avoid non-idempotent loops
            if (ctx.nowCell) nowCell = ctx.nowCell;

            if (baseResolutions.length === 0) {
              // No matches yet — data may still be loading. Send a pending
              // result; the reactive system will re-trigger when cells update
              // (dependencies were registered by the cell.get() calls in the
              // search functions).
              measureWishPhase(
                "send-pending",
                queryKey,
                () =>
                  sendWishState(
                    tx,
                    {
                      result: undefined,
                      candidates: [],
                      [UI]: undefined,
                    } satisfies WishState<any>,
                    outputScope,
                    schema,
                  ),
              );
              return;
            }

            const resultCells = measureWishPhase(
              "resolve-paths",
              queryKey,
              () =>
                baseResolutions.map((baseResolution) => {
                  const combinedPath = baseResolution.pathPrefix
                    ? [...baseResolution.pathPrefix, ...activeParsed.path]
                    : activeParsed.path;
                  const resolvedCell = resolvePath(
                    baseResolution.cell,
                    combinedPath,
                  );
                  return schema ? resolvedCell.asSchema(schema) : resolvedCell;
                }),
            );

            // Deduplicate result cells using Cell.equals()
            const uniqueResultCells = measureWishPhase(
              "dedupe-results",
              queryKey,
              () =>
                resultCells.filter(
                  (cell, index) =>
                    resultCells.findIndex((c) => c.equals(cell)) === index,
                ),
            );
            wishFlowLogger.time(
              resolveStartedAt,
              "wish",
              "resolve",
              queryKey,
            );

            // Unified shape: always return { result, candidates, [UI] }
            // For single result, use fast path (no picker needed)
            // For multiple results, launch suggestion pattern for picker
            const candidatesCell = measureWishPhase(
              "candidates-cell",
              queryKey,
              () =>
                createWishCandidatesCell(
                  runtime,
                  parentCell.space,
                  uniqueResultCells,
                  schema,
                  tx,
                ),
            );

            if (uniqueResultCells.length === 1 || headless) {
              // Single result or headless mode - fast path with unified shape
              // Prefer the result cell's own [UI]; fall back to cf-cell-link
              const resultUI = measureWishPhase(
                "result-ui-get",
                queryKey,
                () => wishResultUI(activeParsed, uniqueResultCells[0]),
              );
              measureWishPhase(
                "send-fast",
                queryKey,
                () =>
                  sendWishState(
                    tx,
                    {
                      result: projectWishCellValue(
                        uniqueResultCells[0],
                        schema,
                      ),
                      candidates: candidatesCell,
                      [UI]: resultUI ?? cellLinkUI(uniqueResultCells[0]),
                    },
                    outputScope,
                    schema,
                  ),
              );
            } else {
              // Multiple results — if suggestion pattern is already loaded,
              // launch it and send its result cell so the picker's output
              // flows through. Otherwise fall back to first result and kick
              // off the fetch for next time.
              if (suggestionPattern) {
                measureWishPhase(
                  "send-suggestion",
                  queryKey,
                  () =>
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
                    ),
                );
              } else {
                // Pattern not loaded yet — send first result, start fetch
                const resultUI = measureWishPhase(
                  "result-ui-get",
                  queryKey,
                  () => wishResultUI(activeParsed, uniqueResultCells[0]),
                );
                measureWishPhase(
                  "send-fast-before-suggestion",
                  queryKey,
                  () =>
                    sendWishState(
                      tx,
                      {
                        result: projectWishCellValue(
                          uniqueResultCells[0],
                          schema,
                        ),
                        candidates: candidatesCell,
                        [UI]: resultUI ?? cellLinkUI(uniqueResultCells[0]),
                      },
                      outputScope,
                      schema,
                    ),
                );
                measureWishPhase(
                  "launch-suggestion",
                  queryKey,
                  () =>
                    launchSuggestionPattern(
                      {
                        situation: query,
                        context: context ?? {},
                        initialResults: candidatesCell,
                      },
                      tx,
                    ),
                );
              }
            }
          } catch (e) {
            const errorMsg = e instanceof WishError ? e.message : String(e);
            const ui = parsed && isProfilePersonaTarget(parsed)
              ? profileCreateUI(ctx)
              : errorUI(errorMsg);
            measureWishPhase(
              "send-error",
              queryKey,
              () =>
                sendWishState(
                  tx,
                  {
                    result: undefined,
                    candidates: [],
                    error: errorMsg,
                    [UI]: ui,
                  } satisfies WishState<any>,
                  wishOutputScope(
                    schema,
                    inputScope,
                    targetMayUseHomeSpace || ctx.usedHomeSpace === true,
                  ),
                  schema,
                ),
            );
          }
        } else if (headless) {
          // Headless mode with freeform query — no suggestion pattern
          measureWishPhase(
            "send-freeform",
            queryKey,
            () =>
              sendWishState(
                tx,
                {
                  result: undefined,
                  candidates: [],
                  [UI]: undefined,
                } satisfies WishState<any>,
                wishOutputScope(schema, inputScope, false),
                schema,
              ),
          );
        } else {
          // Otherwise it's a generic query, instantiate suggestion.tsx
          measureWishPhase(
            "send-suggestion",
            queryKey,
            () =>
              sendResult(
                tx,
                launchSuggestionPattern(
                  { situation: query, context: context ?? {} },
                  tx,
                ),
              ),
          );
        }
        return;
      } else {
        const errorMsg = `Wish target is not recognized: ${
          toCompactDebugString(targetValue)
        }`;
        const inputScope = tx.getNarrowestReadScope();
        measureWishPhase(
          "send-error",
          undefined,
          () =>
            sendWishState(
              tx,
              {
                result: undefined,
                candidates: [],
                error: errorMsg,
                [UI]: errorUI(errorMsg),
              } satisfies WishState<any>,
              inputScope,
              undefined,
            ),
        );
        return;
      }
    } finally {
      if (!usedSharedHashtagResolver) {
        releaseCurrentSharedHashtagResolver();
      }
      recordWishPhaseTiming(
        actionStartedAt,
        "action-total",
        actionQueryKey,
      );
    }
  };
}
