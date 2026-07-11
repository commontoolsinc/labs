import {
  type VNode,
  type WishParams,
  type WishState,
  type WishTag,
} from "@commonfabric/api";
import { h } from "@commonfabric/html";
import { favoriteListSchema } from "@commonfabric/home-schemas";
import { HttpProgramResolver } from "@commonfabric/js-compiler/program";
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
import { extractHashtags } from "@commonfabric/data-model/schema-tags";
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
import { wishStateSchemaForResult } from "./wish-schema.ts";

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

// Schema for a list of profile links (the home `profiles` and `mru` lists). Each
// element is read as a cell *reference* (`asCell`), NOT its inlined value, so the
// list can be enumerated without deep-resolving every profile's own space. A
// plain `.get()` inlines each element and returns `undefined` for the whole list
// whenever any element is a link into a space not yet loaded in the reading
// context — e.g. a shared piece resolving `#profile` right after a profile was
// created in its own (`inSpace`) space. That collapsed the list to length 0 and
// hid the just-created profile behind the "No profile" / create surface.
//
// The item type is `unknown` (not `object`) on purpose: with `asCell`, an
// `object` item schema would trigger a *deep* sync of each linked profile —
// fetching its entire object graph and everything it transitively links, across
// space boundaries — just to count the list. `unknown` keeps the sync shallow
// (we only need the links here). The default profile's name is loaded lazily and
// targeted via `subscribeProfileName` once a candidate is selected.
const profileLinkListSchema = internSchema(
  {
    type: "array",
    items: { type: "unknown", asCell: ["cell"] },
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
    case "#learnedSummary":
    case "#profile":
    case "#profileName":
    case "#profileAvatar":
    case "#profileBio":
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
  if (tag === undefined) return false;
  return extractHashtags(tag).includes(searchTermWithoutHash);
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
  // When true, pathPrefix is the full path to resolve from cell.
  pathConsumed?: boolean;
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

function buildResolutionPath(
  baseResolution: BaseResolution,
  parsedPath: readonly string[],
): readonly string[] {
  if (baseResolution.pathConsumed) {
    return baseResolution.pathPrefix ?? [];
  }
  return baseResolution.pathPrefix
    ? [...baseResolution.pathPrefix, ...parsedPath]
    : parsedPath;
}

function getHomeSpaceCell(ctx: WishContext): Cell<unknown> {
  ctx.usedHomeSpace = true;
  return ctx.runtime.getHomeSpaceCell(ctx.tx);
}

/**
 * A profile link is valid when it resolves to a cell in another space (the
 * profile's own `inSpace` space) with an empty path. An unset link, or one that
 * still points into the home space, means the profile does not exist yet.
 */
function profileCellIsValid(
  cell: Cell<unknown>,
  rawIsSet: boolean,
  homeSpace: Cell<unknown>["space"],
): boolean {
  if (!rawIsSet) return false;
  const link = cell.getAsNormalizedFullLink();
  return link.space !== homeSpace && link.path.length === 0;
}

/**
 * Whether a `mru` / `defaultProfile` entry names the SAME profile as a candidate
 * from the home `profiles` list — compared by the profile's own SPACE, NOT by
 * `Cell.equals` or by entity id.
 *
 * CT-1842: the `#profile` ordering matches candidates (from `profiles`) against
 * the `defaultProfile` link and the `mru` list. Those name the same profiles but
 * reach them through DIFFERENT links. Two distinct differences defeat a naive
 * comparison, both observed on live data:
 *   - `scope` skew — `Cell.equals` (`areNormalizedLinksSame`) compares `scope`,
 *     which the two sides don't always agree on; and
 *   - DIFFERENT entity `id` — the `mru`/`defaultProfile` link and the `profiles`
 *     link for the SAME profile point at different cells WITHIN that profile's
 *     space (e.g. the picker stores the profile pattern's result cell while the
 *     list stores the pattern cell). So even id+space+path comparison fails.
 *
 * The stable per-profile identity is the profile's own SPACE. Each profile is a
 * distinct anonymous `ProfileHome.inSpace()` (see submitProfileCreation), whose
 * DID is unique per user AND per creation event, and `profileCellIsValid`
 * guarantees every valid candidate lives in its OWN non-home space. No two
 * distinct valid profiles ever share a space, so equal space ⇒ same profile.
 * Reading each cell's normalized link keeps the ordering reactive to
 * `mru`/`defaultProfile` changes.
 *
 * `homeSpace` guards the degenerate case: a `mru`/`defaultProfile` entry that
 * still resolves into the home space (an unmaterialized / invalid link) must
 * never match — candidates are never in the home space, but the guard makes the
 * intent explicit and defends against a future home-space candidate slipping in.
 */
function sameProfileCell(
  a: Cell<unknown>,
  b: Cell<unknown>,
  homeSpace: Cell<unknown>["space"],
): boolean {
  const spaceA = a.getAsNormalizedFullLink().space;
  const spaceB = b.getAsNormalizedFullLink().space;
  if (spaceA === homeSpace || spaceB === homeSpace) return false;
  return spaceA === spaceB;
}

/**
 * Subscribe to a profile cell's live name so the wish re-runs once a
 * freshly-created profile's name materializes across the space boundary.
 */
function subscribeProfileName(cell: Cell<unknown>): void {
  void cell.pull().catch((error) => {
    wishFlowLogger.warn("profile-pull", () => [
      "Failed to pull profile pattern",
      error,
    ]);
  });
  void cell.key("initialNameApplied").pull().catch((error) => {
    wishFlowLogger.warn("profile-name-pull", () => [
      "Failed to pull profile name",
      error,
    ]);
  });
  cell.key("initialNameApplied").get();
}

/**
 * Enumerate the user's profile candidate cells from the home `profiles` list,
 * ordered: default first, then by most-recently-used (MRU), then remaining list
 * order. Identity is by the profile's own SPACE — each profile is a distinct
 * `ProfileHome.inSpace()` space, so the `defaultProfile` / `mru` links are
 * matched to candidates by space, not `Cell.equals` (see `sameProfileCell`;
 * CT-1842). There is no synthetic key. Returns [] when no valid profile exists
 * yet.
 */
function getProfileCandidateCells(
  ctx: WishContext,
): { ordered: Cell<unknown>[]; defaultValid: boolean } {
  const homeSpaceCell = getHomeSpaceCell(ctx);
  const defaultPattern = homeSpaceCell.key("defaultPattern").resolveAsCell();
  const profilesCell = defaultPattern.key("profiles");
  // Read the list as cell references so a freshly-created profile (a link into
  // its own space, not yet loaded here) is still counted rather than collapsing
  // the whole list to `undefined`. See profileLinkListSchema.
  const rawList = profilesCell.asSchema(profileLinkListSchema).get();
  const length = Array.isArray(rawList) ? rawList.length : 0;

  const candidates: Cell<unknown>[] = [];
  for (let i = 0; i < length; i++) {
    const entry = profilesCell.key(i);
    const cell = entry.resolveAsCell();
    if (
      !profileCellIsValid(
        cell,
        entry.getRaw() !== undefined,
        homeSpaceCell.space,
      )
    ) {
      continue;
    }
    subscribeProfileName(cell);
    candidates.push(cell);
  }
  if (candidates.length === 0) return { ordered: [], defaultValid: false };

  // Ordering inputs: the default link and the MRU list.
  const defaultEntry = defaultPattern.key("defaultProfile");
  const defaultCell = defaultEntry.resolveAsCell();
  const defaultValid = profileCellIsValid(
    defaultCell,
    defaultEntry.getRaw() !== undefined,
    homeSpaceCell.space,
  );

  const mruCell = defaultPattern.key("mru");
  const mruRaw = mruCell.asSchema(profileLinkListSchema).get();
  const mruLength = Array.isArray(mruRaw) ? mruRaw.length : 0;
  const mruCells: Cell<unknown>[] = [];
  for (let j = 0; j < mruLength; j++) {
    mruCells.push(mruCell.key(j).resolveAsCell());
  }
  // Match by the profile's own space, not `Cell.equals` — see sameProfileCell.
  const homeSpace = homeSpaceCell.space;
  const mruRank = (cell: Cell<unknown>): number => {
    const idx = mruCells.findIndex((m) => sameProfileCell(m, cell, homeSpace));
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  };

  const ordered = [...candidates];
  ordered.sort((a, b) => {
    if (defaultValid) {
      const aDef = sameProfileCell(defaultCell, a, homeSpace);
      const bDef = sameProfileCell(defaultCell, b, homeSpace);
      if (aDef && !bDef) return -1;
      if (bDef && !aDef) return 1;
    }
    return mruRank(a) - mruRank(b);
  });
  return { ordered, defaultValid };
}

/**
 * The user's default profile cell: the first ordered candidate (default link
 * when valid, else the most-recently-used / first profile). Throws when no
 * profile exists yet so callers can fall back to the create surface.
 */
function getDefaultProfileCell(ctx: WishContext): Cell<unknown> {
  const { ordered } = getProfileCandidateCells(ctx);
  if (ordered.length === 0) {
    throw new WishError("No profile exists yet");
  }
  return ordered[0];
}

function getProfileSpaceCell(ctx: WishContext): Cell<unknown> {
  const profileDefaultCell = getDefaultProfileCell(ctx);
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
        // Match the discovery tags snapshotted when favorited.
        return (entry.tags ?? []).includes(searchTermWithoutHash);
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
      getDefaultProfileCell(ctx)
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

        // Match the discovery tags snapshotted when favorited.
        return (entry.tags ?? []).some((t) => t.includes(searchTerm));
      });

      if (!match) {
        throw new WishError(`No favorite found matching "${searchTerm}"`);
      }

      return [{
        cell: match.cell,
        pathPrefix: parsed.path.slice(1),
        pathConsumed: true,
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

    case "#learnedSummary": {
      // The free-form learned summary string (home `learned.summary`). This is
      // what `#profile` used to resolve to before it was repurposed for the
      // profile default pattern object; summary consumers wish for this instead.
      const userDID = ctx.runtime.userIdentityDID;
      if (!userDID) {
        throw new WishError(
          "User identity DID not available for #learnedSummary",
        );
      }
      return [{
        cell: getHomeSpaceCell(ctx),
        pathPrefix: ["defaultPattern", "learned", "summary"],
      }];
    }

    case "#profile": {
      const userDID = ctx.runtime.userIdentityDID;
      if (!userDID) {
        throw new WishError("User identity DID not available for #profile");
      }
      const { ordered, defaultValid } = getProfileCandidateCells(ctx);
      if (ordered.length === 0) {
        // No profile yet — throw so the #profile error path falls back to the
        // create surface (see profileCreateUI).
        throw new WishError("No profile exists yet");
      }
      // When the viewer has a valid DEFAULT profile, `#profile` resolves to it
      // directly (single result) — the picker disambiguates *which* profile when
      // there is no default, it does not re-confirm an explicit default on every
      // read. Without this short-circuit, any viewer with 2+ profiles gets the
      // multi-candidate picker and `.result` stays `undefined` until a selection,
      // dead-locking every pattern that wishes for "the viewer's active profile"
      // (e.g. profile-group-chat's send guard). Only genuine ambiguity (no
      // default chosen yet) drives the picker.
      if (defaultValid) {
        return [{ cell: ordered[0], pathPrefix: [] }];
      }
      // Ordered default-first, then by MRU. Headless / single-result callers
      // take the first; multiple candidates with no default drive the picker.
      return ordered.map((cell) => ({ cell, pathPrefix: [] }));
    }

    case "#profileName": {
      // The live name (`initialNameApplied`) of the default profile. Tracks
      // edits made via the profile's setName handler.
      const profileDefault = getDefaultProfileCell(ctx);
      return [{ cell: profileDefault, pathPrefix: ["initialNameApplied"] }];
    }

    case "#profileAvatar": {
      return [{
        cell: getDefaultProfileCell(ctx),
        pathPrefix: ["avatar"],
      }];
    }

    case "#profileBio": {
      // The owner-authored free-text bio of the default profile (CT-1648).
      // Tracks edits made via the profile's setBio handler.
      return [{
        cell: getDefaultProfileCell(ctx),
        pathPrefix: ["bio"],
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
            const combinedPath = buildResolutionPath(
              baseResolution,
              sharedParsed.path,
            );
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

// Fetch-and-compile cache for one sidecar pattern (suggestion /
// profile-create / profile-picker), shared across all wish invocations. The
// cache tracks the URL each fetch was started for: `setPatternEnvironment`
// can change the apiUrl while a fetch is in flight, so a launch for a
// different URL starts a fresh fetch, and a superseded fetch leaves the cache
// untouched and resolves to undefined when it settles.
//
// The cache is keyed only on the URL, not the user identity, even with
// `compileInUserSpace`. A same-apiUrl identity switch reuses the prior user's
// compiled pattern, which is intended: these system patterns are
// space-independent and run against the current runtime.
export function createSidecarPatternCache(options: {
  // File name under `api/patterns/system/`. Also labels errors.
  name: string;
  // Compile with the user's home space as cache context, so the
  // (space-independent) system pattern is reused across reloads for this
  // user (CT-1623, per-space cache).
  compileInUserSpace?: boolean;
  // Drop a failed fetch from the cache so a later launch retries it.
  retryOnFailure?: boolean;
}) {
  let fetchPromise: Promise<Pattern | undefined> | undefined;
  let fetchUrl: string | undefined;
  let pattern: Pattern | undefined;

  // Resolved lazily (not at module load): in the browser worker this module
  // is imported before the runtime calls `setPatternEnvironment` with the
  // real API URL, so a module-load-time const would capture the default — the
  // worker's own origin, i.e. the frontend server. That is only correct when
  // the shell is served by the API host (as in CI); against a separate
  // frontend the fetch gets the SPA index.html fallback and pattern
  // compilation fails.
  const patternUrl = () =>
    getPatternEnvironment().apiUrl + `api/patterns/system/${options.name}`;

  async function fetchPattern(
    runtime: Runtime,
    url: string,
  ): Promise<Pattern | undefined> {
    try {
      const program = await runtime.harness.resolve(
        new HttpProgramResolver(url),
      );

      if (!program) {
        throw new WishError(`Can't load ${options.name}`);
      }
      const compiled = await runtime.patternManager.compilePattern(
        program,
        options.compileInUserSpace
          ? { space: runtime.userIdentityDID }
          : undefined,
      );

      if (!compiled) throw new WishError(`Can't compile ${options.name}`);

      return compiled;
    } catch (e) {
      console.error(`Can't load ${options.name}`, e);
      return undefined;
    }
  }

  return {
    // Pattern from a completed fetch for the current environment's URL.
    cached(): Pattern | undefined {
      return fetchUrl === patternUrl() ? pattern : undefined;
    },
    // Memoized fetch for the current environment's URL, started by this call
    // when none is in flight for that URL. When this call starts the fetch,
    // `onSuccess` runs once it resolves with a pattern, unless a later fetch
    // superseded it. A superseded fetch resolves to undefined.
    fetch(
      runtime: Runtime,
      onSuccess?: (pattern: Pattern) => void,
    ): Promise<Pattern | undefined> {
      const url = patternUrl();
      if (!fetchPromise || fetchUrl !== url) {
        fetchUrl = url;
        pattern = undefined;
        const started: Promise<Pattern | undefined> = fetchPattern(
          runtime,
          url,
        ).then((fetched) => {
          // Only the fetch the cache currently points to records and reports
          // its result; launches chained on a superseded fetch get undefined
          // so a stale pattern is never run.
          if (fetchPromise !== started) return undefined;
          pattern = fetched;
          if (fetched) {
            onSuccess?.(fetched);
          } else if (options.retryOnFailure) {
            fetchPromise = undefined;
          }
          return fetched;
        });
        fetchPromise = started;
      }
      return fetchPromise;
    },
  };
}

const suggestionPatternCache = createSidecarPatternCache({
  name: "suggestion.tsx",
  compileInUserSpace: true,
});
const profileCreatePatternCache = createSidecarPatternCache({
  name: "profile-create.tsx",
  compileInUserSpace: true,
  retryOnFailure: true,
});
const profilePickerPatternCache = createSidecarPatternCache({
  name: "profile-picker.tsx",
  retryOnFailure: true,
});

function errorUI(message: string): VNode {
  return h("span", { style: "color: red" }, `⚠️ ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      profiles: unknown;
      inputId: string;
      buttonId: string;
    }
    | undefined;
  let profileCreatePatternResultCell: Cell<any> | undefined;
  let profileCreatePatternReadyCell: Cell<boolean> | undefined;
  let profilePickerPatternInput:
    | {
      profiles: unknown;
      defaultProfile: unknown;
      mru: unknown;
    }
    | undefined;
  let profilePickerPatternResultCell: Cell<any> | undefined;

  addCancel(() => {
    cancelled = true;
    releaseCurrentSharedHashtagResolver();
    if (suggestionPatternResultCell) {
      runtime.runner.stop(suggestionPatternResultCell);
    }
    if (profileCreatePatternResultCell) {
      runtime.runner.stop(profileCreatePatternResultCell);
    }
    if (profilePickerPatternResultCell) {
      runtime.runner.stop(profilePickerPatternResultCell);
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

    const cachedSuggestionPattern = suggestionPatternCache.cached();
    if (!cachedSuggestionPattern) {
      // Once fetch completes, run the pattern without a tx (it creates its own)
      void suggestionPatternCache.fetch(runtime).then(
        (pattern) => {
          if (!cancelled && pattern && suggestionPatternResultCell) {
            runtime.run(
              undefined,
              pattern,
              suggestionPatternInput,
              suggestionPatternResultCell!,
            );
          }
        },
      );
    } else {
      if (!cancelled && suggestionPatternResultCell) {
        runtime.run(
          tx,
          cachedSuggestionPattern,
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

  // Renders an error message into a pattern result cell in its own committed
  // transaction. Used when a deferred system-pattern run fails after the
  // originating wish transaction has already gone.
  function commitPatternErrorUI(
    resultCell: Cell<any>,
    message: string,
  ): void {
    const errorTx = runtime.edit();
    resultCell.withTx(errorTx).set({ [UI]: errorUI(message) });
    runtime.prepareTxForCommit(errorTx);
    errorTx.commit();
  }

  // Run a just-fetched sidecar pattern (profile create / picker) into its result
  // cell on its own committed transaction, surfacing any commit failure as an
  // error UI in that cell. Shared by launchProfileCreatePattern and
  // launchProfilePickerPattern so the commit/error lifecycle lives in one place.
  function runSidecarInOwnTx(
    resultCell: Cell<any>,
    pattern: Pattern,
    inputForTx: (tx: IExtendedStorageTransaction) => unknown,
  ): void {
    try {
      const runTx = runtime.edit();
      runtime.run(runTx, pattern, inputForTx(runTx), resultCell.withTx(runTx));
      runtime.prepareTxForCommit(runTx);
      runTx.commit().then(({ error }) => {
        if (error) {
          commitPatternErrorUI(resultCell, toCompactDebugString(error));
        }
      }).catch((error) => {
        commitPatternErrorUI(resultCell, errorMessage(error));
      });
    } catch (error) {
      commitPatternErrorUI(resultCell, errorMessage(error));
    }
  }

  function launchProfileCreatePattern(
    ctx: WishContext,
    providedTx?: IExtendedStorageTransaction,
  ): Cell<any> {
    const homeDefaultPattern = getHomeSpaceCell(ctx).key("defaultPattern")
      .resolveAsCell();
    profileCreatePatternInput = {
      profiles: createSigilLinkFromParsedLink(
        homeDefaultPattern.key("profiles").getAsNormalizedFullLink(),
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

    const profileCreateInputForTx = (tx: IExtendedStorageTransaction) => {
      const bindInputCell = (cell: unknown) =>
        cell && typeof (cell as { withTx?: unknown }).withTx === "function"
          ? (cell as Cell<unknown>).withTx(tx)
          : cell;
      return profileCreatePatternInput && {
        ...profileCreatePatternInput,
        profiles: bindInputCell(profileCreatePatternInput.profiles),
      };
    };

    const cachedProfileCreatePattern = profileCreatePatternCache.cached();
    if (!cachedProfileCreatePattern) {
      void profileCreatePatternCache.fetch(runtime, () => {
        if (profileCreatePatternReadyCell) {
          const readyTx = runtime.edit();
          profileCreatePatternReadyCell.withTx(readyTx).set(true);
          runtime.prepareTxForCommit(readyTx);
          readyTx.commit();
        }
      }).then((pattern) => {
        if (!cancelled && pattern && profileCreatePatternResultCell) {
          runSidecarInOwnTx(
            profileCreatePatternResultCell,
            pattern,
            profileCreateInputForTx,
          );
        }
      });
    } else if (!cancelled && profileCreatePatternResultCell) {
      runtime.run(
        tx,
        cachedProfileCreatePattern,
        profileCreateInputForTx(tx),
        profileCreatePatternResultCell.withTx(tx),
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

  // The profile-picker sidecar rendered as a VNode, for the `[UI]` slot of a
  // #profile wish with 2+ candidates and no valid default. `.result` rides the
  // main wish state (ordered[0]) — the picker is only the switching affordance
  // (CT-1829); its "Use" / "Set default" writes reorder candidates so the
  // builtin's ordered[0] — and thus `.result` — flips reactively.
  function profilePickerUI(ctx: WishContext): VNode {
    return h("cf-render", {
      "data-profile-picker-ui": "wish",
      $cell: launchProfilePickerPattern(ctx, ctx.tx),
    });
  }

  // Launch the profile picker for #profile wishes with multiple profiles. Feeds
  // the home `profiles`/`defaultProfile`/`mru` cells (as sigil links) so the
  // picker can render natively, select (stamp MRU), set the default, and create
  // another — all as trusted picker-surface writes. Mirrors
  // launchProfileCreatePattern's deferred-fetch/run handling.
  function launchProfilePickerPattern(
    ctx: WishContext,
    providedTx?: IExtendedStorageTransaction,
  ): Cell<any> {
    const homeDefaultPattern = getHomeSpaceCell(ctx).key("defaultPattern")
      .resolveAsCell();
    profilePickerPatternInput = {
      profiles: createSigilLinkFromParsedLink(
        homeDefaultPattern.key("profiles").getAsNormalizedFullLink(),
      ),
      defaultProfile: createSigilLinkFromParsedLink(
        homeDefaultPattern.key("defaultProfile").getAsNormalizedFullLink(),
      ),
      mru: createSigilLinkFromParsedLink(
        homeDefaultPattern.key("mru").getAsNormalizedFullLink(),
      ),
    };
    const tx = providedTx || runtime.edit();

    if (!profilePickerPatternResultCell) {
      profilePickerPatternResultCell = runtime.getCell(
        parentCell.space,
        {
          wish: {
            profilePickerPattern: cause,
            user: runtime.userIdentityDID,
          },
        },
        undefined,
        tx,
      );
    }

    const pickerInputForTx = (tx: IExtendedStorageTransaction) => {
      const bindInputCell = (cell: unknown) =>
        cell && typeof (cell as { withTx?: unknown }).withTx === "function"
          ? (cell as Cell<unknown>).withTx(tx)
          : cell;
      return profilePickerPatternInput && {
        profiles: bindInputCell(profilePickerPatternInput.profiles),
        defaultProfile: bindInputCell(profilePickerPatternInput.defaultProfile),
        mru: bindInputCell(profilePickerPatternInput.mru),
      };
    };

    const cachedProfilePickerPattern = profilePickerPatternCache.cached();
    if (!cachedProfilePickerPattern) {
      void profilePickerPatternCache.fetch(runtime).then(
        (pattern) => {
          if (cancelled || !profilePickerPatternResultCell) return;
          if (pattern) {
            runSidecarInOwnTx(
              profilePickerPatternResultCell,
              pattern,
              pickerInputForTx,
            );
          } else {
            // Fetch/compile failed (createSidecarPatternCache swallows the
            // error and resolves to undefined). Surface it as an error UI in the
            // picker sidecar cell so the picker slot doesn't stay blank forever.
            // `.result` is unaffected: under CT-1829 it rides the main wish state
            // (ordered[0]), not this sidecar (a superseded fetch also resolves
            // to undefined — a benign extra error UI on a since-replaced cell).
            commitPatternErrorUI(
              profilePickerPatternResultCell,
              `Can't load profile-picker.tsx`,
            );
          }
        },
      ).catch((error) => {
        // Defensive: a throw inside the `.then` body (or a truly-rejecting
        // fetch) would otherwise be an unhandled rejection. Surface it too.
        if (!cancelled && profilePickerPatternResultCell) {
          commitPatternErrorUI(
            profilePickerPatternResultCell,
            errorMessage(error),
          );
        }
      });
    } else if (!cancelled && profilePickerPatternResultCell) {
      runtime.run(
        tx,
        cachedProfilePickerPattern,
        pickerInputForTx(tx),
        profilePickerPatternResultCell.withTx(tx),
      );
    }

    if (!providedTx) {
      runtime.prepareTxForCommit(tx);
      tx.commit();
    }

    return profilePickerPatternResultCell;
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
                  const combinedPath = buildResolutionPath(
                    baseResolution,
                    activeParsed.path,
                  );
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

            // #profile with 2+ candidates and no valid default (the only case
            // that reaches here interactively; a valid default short-circuits to
            // a single candidate in resolveWishTarget) → CT-1829: `.result` is
            // always the single best profile (ordered default → MRU → first, i.e.
            // uniqueResultCells[0]), sent eagerly on the main wish state exactly
            // like the generic multi-match path does at wish.ts:2052. The picker
            // sidecar becomes the `[UI]` switching affordance: its "Use" (MRU)
            // and "Set default" writes reorder candidates so `.result` follows
            // reactively. This removes the orphan-second-profile deadlock where
            // the wish output was replaced by the picker's initially-empty (and
            // forever-empty on fetch failure) result cell.
            if (
              isProfilePersonaTarget(activeParsed) &&
              !headless &&
              uniqueResultCells.length > 1
            ) {
              measureWishPhase(
                "send-profile-picker",
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
                      [UI]: profilePickerUI(ctx),
                    },
                    outputScope,
                    schema,
                  ),
              );
              return;
            }

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
              if (suggestionPatternCache.cached()) {
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
