/**
 * Reading the source facts a piece records: the pattern it runs, the origin it
 * tracks, the history metadata it carries, and its authored source files.
 *
 * An origin is the source URL a piece remembers: either an external web URL or
 * a fabric `cf:` URL. `docs/specs/piece-source-lifecycle.md` is the design of
 * record.
 */

import {
  type Cell,
  type FabricRef,
  getPatternIdentityRef,
  getPatternRepository,
  getPatternSource,
  type MemorySpace,
  NAME,
  parseFabricRef,
  type Runtime,
} from "@commonfabric/runner";
import { nameSchema } from "@commonfabric/runner/schemas";

/**
 * How an origin URL resolves.
 *
 * - `web`: an external program endpoint that can return new source later.
 * - `fabric-piece`: a stable, mutable fabric entity whose current pattern the
 *   origin names.
 * - `fabric-pattern`: exact content-addressed pattern source, either named
 *   directly or fixed by a trailing pin.
 */
export type PieceOriginKind = "web" | "fabric-piece" | "fabric-pattern";

export interface PieceOrigin {
  /** The canonical origin URL. */
  url: string;
  kind: PieceOriginKind;
  /**
   * The URL as it was recorded on the piece, when normalization changed it. A
   * legacy toolshed-relative path becomes an absolute web URL, so the recorded
   * form is kept for display.
   */
  recorded?: string;
}

/** Everything the source surfaces read off one piece. */
export interface PieceSourceState {
  space: MemorySpace;
  pieceId: string;
  name?: string;
  /** The exact executable export the piece runs. */
  pattern?: { identity: string; symbol: string };
  /** The identity whose complete setup state was installed. */
  setupPattern?: { identity: string; symbol: string };
  /** The pattern identity an in-place update replaced, when one did. */
  displacedPattern?: { identity: string; symbol: string; displacedAt?: number };
  /** The active origin, absent when the piece is detached. */
  origin?: PieceOrigin;
  /** Descriptive repository locator; never followed. */
  repository?: string;
  /** The canonical entry filename of the retained source, when readable. */
  entry?: string;
  /** The authored source files of the current pattern, when readable. */
  files: { name: string; contents: string }[];
}

export class PieceOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PieceOriginError";
  }
}

/** The identity a fabric ref pins, when the ref is immutable. */
function pinnedPatternIdentity(ref: FabricRef): string | undefined {
  if (ref.pin !== undefined) return ref.pin;
  return ref.ref.kind === "uri" && ref.ref.scheme === "pattern"
    ? ref.ref.hash
    : undefined;
}

/**
 * Classify a recorded source string as an origin.
 *
 * A toolshed-relative path — the legacy shape system roots are stamped with —
 * resolves against the host accepted for `space`, so the origin that leaves
 * this function is always absolute. An unusable string throws rather than
 * becoming a silently inert origin.
 */
export function classifyOrigin(
  runtime: Runtime,
  space: MemorySpace,
  recorded: string,
): PieceOrigin {
  const source = recorded.trim();
  if (source.length === 0) {
    throw new PieceOriginError("origin is empty");
  }

  // The fabric parser decides whether this is a fabric URL: it returns undefined
  // for anything that is not one, and throws for a fabric URL it cannot read. A
  // malformed one reports as an unusable origin like any other unusable string,
  // rather than as a parser error from a layer below.
  let ref;
  try {
    ref = parseFabricRef(source);
  } catch (cause) {
    throw new PieceOriginError(
      `${source} is not a usable fabric URL: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  if (ref !== undefined) {
    return {
      url: source,
      kind: pinnedPatternIdentity(ref) === undefined
        ? "fabric-piece"
        : "fabric-pattern",
    };
  }

  if (source.startsWith("/")) {
    const host = runtime.hostForSpace(space);
    return {
      url: new URL(source, host).href,
      kind: "web",
      recorded: source,
    };
  }

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new PieceOriginError(`${source} is not an absolute URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PieceOriginError(`${source} is not a web URL`);
  }
  return { url: url.href, kind: "web" };
}

/**
 * The active origin recorded on `piece`, or undefined when it is detached.
 * A recorded string this runtime cannot classify is reported as detached: it
 * names no place the source can be resolved from.
 */
export function readPieceOrigin(
  runtime: Runtime,
  piece: Cell<unknown>,
): PieceOrigin | undefined {
  const recorded = getPatternSource(piece);
  if (recorded === undefined) return undefined;
  try {
    return classifyOrigin(runtime, piece.space, recorded);
  } catch {
    return undefined;
  }
}

/** Read every source fact a piece carries, with its authored source files. */
export async function readPieceSourceState(
  runtime: Runtime,
  piece: Cell<unknown>,
): Promise<PieceSourceState> {
  await piece.sync();
  const pattern = getPatternIdentityRef(piece);
  const state: PieceSourceState = {
    space: piece.space,
    pieceId: piece.getAsNormalizedFullLink().id,
    files: [],
  };
  const name = piece.asSchema(nameSchema).get()?.[NAME];
  if (typeof name === "string") state.name = name;
  if (pattern !== undefined) state.pattern = pattern;
  const setupPattern = piece.getMetaRaw("patternSetupIdentity");
  if (isPatternRef(setupPattern)) state.setupPattern = setupPattern;
  const displaced = readDisplacedPattern(piece.getMetaRaw("displacedPattern"));
  if (displaced !== undefined) state.displacedPattern = displaced;
  const origin = readPieceOrigin(runtime, piece);
  if (origin !== undefined) state.origin = origin;
  const repository = getPatternRepository(piece);
  if (repository !== undefined) state.repository = repository;

  if (pattern !== undefined) {
    const program = await runtime.patternManager
      .getPatternSourceProgramByIdentity(pattern.identity, piece.space);
    if (program !== undefined) {
      state.entry = program.main;
      state.files = sortSourceFiles(program.files, program.main);
    }
  }
  return state;
}

function isPatternRef(
  value: unknown,
): value is { identity: string; symbol: string } {
  return typeof value === "object" && value !== null &&
    typeof (value as { identity?: unknown }).identity === "string" &&
    typeof (value as { symbol?: unknown }).symbol === "string";
}

/**
 * The pattern an in-place update replaced, from the `displacedPattern` meta the
 * pattern updater writes. Its timestamp is optional.
 */
function readDisplacedPattern(
  value: unknown,
): PieceSourceState["displacedPattern"] {
  if (!isPatternRef(value)) return undefined;
  const displacedAt = (value as { displacedAt?: unknown }).displacedAt;
  return {
    identity: value.identity,
    symbol: value.symbol,
    ...(typeof displacedAt === "number" ? { displacedAt } : {}),
  };
}

/** Entry file first, then the rest by filename. */
function sortSourceFiles(
  files: { name: string; contents: string }[],
  entry: string,
): { name: string; contents: string }[] {
  return [...files].sort((a, b) => {
    if (a.name === entry) return -1;
    if (b.name === entry) return 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}
