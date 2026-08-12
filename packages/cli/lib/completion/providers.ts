/**
 * Live candidate providers — the half of completion that reads real state.
 *
 * Every provider resolves its fabric context from the half-typed line first and
 * the environment second, which is what lets
 * `cf piece call -s other-space --piece <TAB>` list the pieces of `other-space`
 * rather than whatever `CF_SPACE`-shaped default the shell happens to carry.
 *
 * Failure is always silent and always empty. A completion request runs while
 * the user is mid-keystroke: an unreachable server, an expired key, or a
 * malformed piece id must produce no candidates, never a stack trace pasted
 * into the command line.
 */

import type { Candidate } from "./static.ts";
import type { CompletionLine } from "./line.ts";
import { longName } from "./line.ts";
import { absPath } from "../utils.ts";
import type { PieceConfig, SpaceConfig } from "../piece.ts";

/** A directive tells the shell to complete something only it can do well. */
export type Directive =
  /** Hand off to the shell's own file completion, filtered by glob. */
  | { readonly kind: "files"; readonly glob?: string }
  /** Hand off to the shell's directory completion. */
  | { readonly kind: "dirs" }
  /** Suppress the trailing space, so a path can be continued with `/`. */
  | { readonly kind: "nospace" };

export interface ProviderResult {
  readonly candidates: readonly Candidate[];
  readonly directives: readonly Directive[];
}

const NOTHING: ProviderResult = { candidates: [], directives: [] };

function values(candidates: readonly Candidate[]): ProviderResult {
  return { candidates, directives: [] };
}

function directive(...directives: Directive[]): ProviderResult {
  return { candidates: [], directives };
}

/**
 * Resolve the fabric connection the half-typed line refers to.
 *
 * Mirrors the precedence `parseSpaceOptions` applies at execution time — line
 * options beat environment, and `--url` supplies api-url plus space together —
 * but never throws: an incomplete line yields `null`, meaning "no live
 * candidates", not an error.
 */
export function resolveSpaceContext(
  line: CompletionLine,
): SpaceConfig | null {
  const url = line.options.get("url");
  const identity = line.options.get("identity") ??
    Deno.env.get("CF_IDENTITY");
  if (!identity) return null;

  let apiUrl = line.options.get("api-url") ?? Deno.env.get("CF_API_URL");
  let space = line.options.get("space");

  if (url) {
    try {
      const parsed = new URL(url);
      apiUrl = `${parsed.protocol}//${parsed.host}`;
      space = parsed.pathname.split("/").filter(Boolean)[0];
    } catch {
      return null;
    }
  }

  if (!apiUrl || !space) return null;

  try {
    return {
      apiUrl,
      space,
      identity: absPath(identity),
      // Completion reserves stdout for candidates. `jsonOutput` is how the
      // runtime is told stdout is machine-readable: it routes status lines
      // that would otherwise `console.log` (the navigateTo notice in
      // `loadPieces`) to stderr, where the shell function discards them.
      // Without it such a line would be offered to the user as a candidate.
      jsonOutput: true,
    };
  } catch {
    return null;
  }
}

/** Same as `resolveSpaceContext`, plus the `--piece` the line already names. */
function resolvePieceContext(line: CompletionLine): PieceConfig | null {
  const space = resolveSpaceContext(line);
  if (!space) return null;
  const piece = line.options.get("piece") ??
    (line.options.get("url")
      ? new URL(line.options.get("url")!).pathname.split("/").filter(Boolean)[1]
      : undefined);
  if (!piece) return null;
  return { ...space, piece };
}

/**
 * Pieces in the line's space, as `id` with the piece's name as annotation.
 *
 * A piece that failed to load still lists — its id is exactly what an operator
 * reaches for completion to recover.
 */
async function pieceCandidates(line: CompletionLine): Promise<ProviderResult> {
  const config = resolveSpaceContext(line);
  if (!config) return NOTHING;
  const { listPieces } = await import("../piece.ts");
  return values(shapePieceCandidates(await listPieces(config)));
}

/** Listing shape used by `shapePieceCandidates`, structural so tests need no runtime. */
export interface PieceListingLike {
  readonly id: string;
  readonly name?: string;
  readonly patternRef?: { readonly symbol?: string } | null;
}

/**
 * Label pieces for the annotation column: the piece's own name reads best, and
 * the pattern symbol is the fallback for a piece never given one. A piece that
 * failed to load still lists — its id is exactly what an operator reaches for
 * completion to recover.
 */
export function shapePieceCandidates(
  pieces: readonly PieceListingLike[],
): Candidate[] {
  return pieces.map((piece) => ({
    value: piece.id,
    description: piece.name ?? piece.patternRef?.symbol ?? undefined,
  }));
}

/** Callables (handlers and streams) exposed by the line's `--piece`. */
async function callableCandidates(
  line: CompletionLine,
): Promise<ProviderResult> {
  const config = resolvePieceContext(line);
  if (!config) return NOTHING;
  const { listPieceCallables } = await import("../piece.ts");
  const listing = await listPieceCallables(config);
  return values(shapeVerbCandidates(listing.verbs));
}

/** Verb shape used by `shapeVerbCandidates`, structural so tests need no runtime. */
export interface VerbListingLike {
  readonly name: string;
  readonly kind: string;
}

/** Callables annotated by kind, matching what `cf piece verbs` reports. */
export function shapeVerbCandidates(
  verbs: readonly VerbListingLike[],
): Candidate[] {
  return verbs.map((verb) => ({ value: verb.name, description: verb.kind }));
}

/**
 * Keys reachable one level below the path already typed.
 *
 * Completion happens per path segment: `items/<TAB>` reads `items` and offers
 * its keys, so a deep path is walked rather than guessed. `nospace` keeps the
 * cursor attached to the value so the next `/` continues the same word.
 */
async function cellPathCandidates(
  line: CompletionLine,
): Promise<ProviderResult> {
  const config = resolvePieceContext(line);
  if (!config) return NOTHING;

  const { parentPath, prefix } = splitPathPrefix(line.word);
  const keys = await childKeys(config, parentPath, {
    input: line.flags.has("input"),
  });
  if (keys.length === 0) return NOTHING;

  return {
    candidates: keys.map((key) => ({ value: `${prefix}${key}` })),
    directives: [{ kind: "nospace" }],
  };
}

/**
 * Keys directly under `path` on a piece's cell. An array yields its indices, an
 * object its property names, and a leaf yields nothing — which is the correct
 * signal that the path is already complete.
 */
async function childKeys(
  config: PieceConfig,
  path: string,
  options: { input?: boolean } = {},
): Promise<string[]> {
  const { getCellValue } = await import("../piece.ts");
  const { parseCellPath } = await import("@commonfabric/runner");
  const segments = path ? parseCellPath(path) : [];
  return keysOf(await getCellValue(config, segments, options));
}

/**
 * The completable keys of one cell value: an array yields its indices, an
 * object its property names, and a leaf yields nothing — which is the correct
 * signal that the path already names a value rather than a container.
 */
export function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((_, index) => String(index));
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>);
  }
  return [];
}

/**
 * Split the word being typed into the parent path to read and the prefix each
 * candidate must carry, so the shell replaces the whole token.
 *
 * `items/0/ti` reads `items/0` and offers `items/0/title`: the prefix is what
 * keeps a completed deep path from collapsing to its last segment.
 */
export function splitPathPrefix(
  typed: string,
): { parentPath: string; prefix: string } {
  const cut = typed.lastIndexOf("/");
  if (cut === -1) return { parentPath: "", prefix: "" };
  const parentPath = typed.slice(0, cut);
  return { parentPath, prefix: `${parentPath}/` };
}

/**
 * `pieceId/path/to/field` endpoints for `cf piece link`.
 *
 * Before the `/` the candidates are piece ids; after it they are that piece's
 * cell keys, so both halves of a link reference complete.
 */
async function linkEndpointCandidates(
  line: CompletionLine,
): Promise<ProviderResult> {
  const typed = line.word;
  const cut = typed.indexOf("/");
  if (cut === -1) {
    const pieces = await pieceCandidates(line);
    // A link endpoint continues with `/`, so hold the cursor in place.
    return { candidates: pieces.candidates, directives: [{ kind: "nospace" }] };
  }

  const config = resolveSpaceContext(line);
  if (!config) return NOTHING;
  const pieceId = typed.slice(0, cut);
  const { parentPath } = splitPathPrefix(typed.slice(cut + 1));

  const keys = await childKeys({ ...config, piece: pieceId }, parentPath);
  if (keys.length === 0) return NOTHING;

  const prefix = linkEndpointPrefix(pieceId, parentPath);
  return {
    candidates: keys.map((key) => ({ value: `${prefix}${key}` })),
    directives: [{ kind: "nospace" }],
  };
}

/**
 * Prefix for a `piece link` endpoint candidate. The empty parent path is the
 * case that matters: `id//key` would be a different, invalid reference.
 */
export function linkEndpointPrefix(
  pieceId: string,
  parentPath: string,
): string {
  return parentPath ? `${pieceId}/${parentPath}/` : `${pieceId}/`;
}

/**
 * Spaces this machine already knows about, discovered from the local memory-v2
 * SQLite stores that `cf inspect` reads. There is no server-side space index to
 * query, so an operator who has touched a space locally gets its DID completed
 * and everyone else gets nothing rather than a wrong guess.
 *
 * `--space` accepts a name or a DID, and the DB basename is the DID, so these
 * candidates are directly usable.
 */
async function spaceCandidates(): Promise<ProviderResult> {
  const { discoverSpaceDbs } = await import("@commonfabric/state-inspector");
  const spaces = discoverSpaceDbs()
    // Most-recently written first: the space being worked on ranks top.
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  // One space can have a DB under more than one cache root (a worktree's and
  // the checkout's). They are distinct files but the same space, and a
  // repeated DID in the candidate list is pure noise.
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const space of spaces) {
    if (seen.has(space.did)) continue;
    seen.add(space.did);
    candidates.push({ value: space.did, description: "local space db" });
  }
  return values(candidates);
}

/** API URLs worth offering: the environment's, plus the local dev server. */
async function apiUrlCandidates(): Promise<ProviderResult> {
  const ports = (await import("@commonfabric/ports", {
    with: { type: "json" },
  })).default;
  const candidates: Candidate[] = [];
  const fromEnv = Deno.env.get("CF_API_URL");
  if (fromEnv) candidates.push({ value: fromEnv, description: "CF_API_URL" });
  const local = `http://localhost:${ports.toolshed}`;
  if (local !== fromEnv) {
    candidates.push({ value: local, description: "local toolshed" });
  }
  return values(candidates);
}

/** Pattern sources are `.tsx`; the shell filters and handles directories. */
function patternFiles(): Promise<ProviderResult> {
  return Promise.resolve(directive({ kind: "files", glob: "*.tsx" }));
}

/**
 * Option values by long name. A name absent here falls through to the shell's
 * own file completion only when the option is path-shaped.
 */
const OPTION_VALUE_PROVIDERS: Readonly<
  Record<string, (line: CompletionLine) => Promise<ProviderResult>>
> = {
  piece: pieceCandidates,
  space: () => spaceCandidates(),
  "api-url": () => apiUrlCandidates(),
  identity: () => Promise.resolve(directive({ kind: "files", glob: "*.key" })),
  root: () => Promise.resolve(directive({ kind: "dirs" })),
  test: patternFiles,
  // `cf space clone --to <dir>` builds a clone directory.
  to: () => Promise.resolve(directive({ kind: "dirs" })),
  "log-file": () => Promise.resolve(directive({ kind: "files" })),
  "state-path": () => Promise.resolve(directive({ kind: "files" })),
};

/**
 * Positional providers, keyed by `<command path>:<argument name>`. The command
 * path disambiguates arguments that share a name across commands — `path` means
 * a cell path under `piece get` but a filesystem path elsewhere.
 */
const ARGUMENT_PROVIDERS: Readonly<
  Record<string, (line: CompletionLine) => Promise<ProviderResult>>
> = {
  "piece call:callable": callableCandidates,
  "piece get:path": cellPathCandidates,
  "piece get-label:path": cellPathCandidates,
  "piece set:path": cellPathCandidates,
  "piece set-label:path": cellPathCandidates,
  "piece link:source": linkEndpointCandidates,
  "piece link:target": linkEndpointCandidates,
  "piece new:main": patternFiles,
  "piece setsrc:main": patternFiles,
  "check:files": patternFiles,
  "test:paths": patternFiles,
  "view:file": () => Promise.resolve(directive({ kind: "files" })),
  "exec:mountedFile": () => Promise.resolve(directive({ kind: "files" })),
  "id did:keypath": () =>
    Promise.resolve(directive({ kind: "files", glob: "*.key" })),
  // `cf space` names a space positionally rather than through `--space`.
  "space clone:space": () => spaceCandidates(),
  "space fingerprint:space": () => spaceCandidates(),
  // `verify`/`reset` take a clone directory built by `space clone`.
  "space verify:dir": () => Promise.resolve(directive({ kind: "dirs" })),
  "space reset:dir": () => Promise.resolve(directive({ kind: "dirs" })),
};

/**
 * Run the provider for the line's slot.
 *
 * Any provider failure degrades to no candidates: completion must never
 * interrupt typing with an error, and a silent empty list is the honest signal
 * that live data was unavailable.
 */
export async function liveCandidates(
  line: CompletionLine,
): Promise<ProviderResult> {
  const slot = line.slot;
  if (!slot) return NOTHING;

  let provider:
    | ((line: CompletionLine) => Promise<ProviderResult>)
    | undefined;

  if (slot.kind === "option-value") {
    provider = OPTION_VALUE_PROVIDERS[longName(slot.option)];
  } else if (slot.kind === "argument") {
    provider = ARGUMENT_PROVIDERS[
      `${line.path.join(" ")}:${slot.argument.name}`
    ];
  }

  if (!provider) return NOTHING;

  try {
    return await provider(line);
  } catch {
    return NOTHING;
  }
}
