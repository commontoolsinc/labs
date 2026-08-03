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
  getPieceSourceRevisions,
  type MemorySpace,
  NAME,
  parseFabricRef,
  resolveSystemPatternSource,
  type Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { nameSchema } from "@commonfabric/runner/schemas";
import { HttpProgramResolver } from "@commonfabric/js-compiler/program";

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
  /** Ordered, append-only source and origin states accepted by the piece. */
  history: PieceSourceRevisionState[];
  currentRevisionId?: string;
}

export interface PieceSourceRevisionState {
  revisionId: string;
  timestamp: number;
  pattern: { identity: string; symbol: string };
  origin?: PieceOrigin;
  operation:
    | "baseline"
    | "create"
    | "edit"
    | "origin-update"
    | "detach"
    | "revert"
    | "follow"
    | "repoint";
  selectedRevisionId?: string;
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

export interface ResolvedPieceOriginSource {
  program: RuntimeProgram;
  pattern: { identity?: string; symbol: string };
}

type StableFabricRef = FabricRef & {
  ref: Extract<FabricRef["ref"], { kind: "uri" }>;
};

/**
 * Resolve an origin now, returning the authored program and selected export a
 * repoint transition should apply.
 */
export async function resolvePieceOriginSource(
  runtime: Runtime,
  destinationSpace: MemorySpace,
  recorded: string,
  historicalSymbol: string,
): Promise<ResolvedPieceOriginSource> {
  const origin = classifyOrigin(runtime, destinationSpace, recorded);
  if (origin.kind === "web") {
    const program = await runtime.harness.resolve(
      new HttpProgramResolver(
        origin.url,
        (input, init) =>
          runtime.fetch(input, {
            ...init,
            cache: "no-cache",
          }),
      ),
    );
    return {
      program: { ...program, mainExport: historicalSymbol },
      pattern: { symbol: historicalSymbol },
    };
  }

  const ref = parseFabricRef(origin.url)!;
  if (ref.subpath !== undefined) {
    throw new PieceOriginError("piece source subpaths are not supported");
  }
  if (ref.ref.kind === "slug") {
    throw new PieceOriginError(
      "piece origins require a stable fabric entity or pattern reference",
    );
  }
  const stableRef = ref as StableFabricRef;
  if (ref.space !== undefined && !ref.space.startsWith("did:")) {
    throw new PieceOriginError(
      "piece origins require an explicit space DID",
    );
  }
  const sourceSpace = ref.space === undefined
    ? destinationSpace
    : ref.space as MemorySpace;
  if (sourceSpace !== destinationSpace) {
    throw new PieceOriginError(
      "following a source from another space requires checked source replication",
    );
  }
  if (ref.host !== undefined) {
    const routedUrl = new URL(
      runtime.mappedHostFor(sourceSpace) ??
        runtime.hostForSpace(sourceSpace),
    );
    const explicitHost = new URL(`${routedUrl.protocol}//${ref.host}`).host;
    if (routedUrl.host !== explicitHost) {
      const scheme = fabricHostScheme(ref.host);
      if (!runtime.registerSpaceHost(sourceSpace, `${scheme}//${ref.host}`)) {
        throw new PieceOriginError(
          `the host ${ref.host} is not available for ${sourceSpace}`,
        );
      }
    }
  }

  const pinned = pinnedPatternIdentity(stableRef);
  const pattern = pinned === undefined
    ? await mutableFabricOriginPattern(runtime, sourceSpace, stableRef)
    : { identity: pinned, symbol: historicalSymbol };
  if (pattern === undefined) {
    throw new PieceOriginError(
      `${origin.url} does not currently resolve to a piece pattern`,
    );
  }

  const program = await runtime.patternManager
    .getPatternSourceProgramByIdentity(
      pattern.identity,
      destinationSpace,
    );
  if (program === undefined) {
    throw new PieceOriginError(
      `source for ${pattern.identity} is not available`,
    );
  }
  return {
    program: { ...program, mainExport: pattern.symbol },
    pattern,
  };
}

async function mutableFabricOriginPattern(
  runtime: Runtime,
  sourceSpace: MemorySpace,
  ref: StableFabricRef,
): Promise<{ identity: string; symbol: string } | undefined> {
  const target: Cell<unknown> = runtime.getCellFromEntityId(
    sourceSpace,
    `${ref.ref.scheme}:fid1:${ref.ref.hash}`,
  );
  await target.sync();
  return getPatternIdentityRef(target);
}

function fabricHostScheme(host: string): "http:" | "https:" {
  const hostname = new URL(`https://${host}`).hostname;
  const loopback = hostname === "localhost" || hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
  return loopback ? "http:" : "https:";
}

/**
 * Classify a recorded source string as an origin.
 *
 * A `system:` ref, and the toolshed-relative path that is the legacy shape
 * system roots were stamped with, both resolve against the host accepted for
 * `space`, so the origin that leaves this function is always absolute. An
 * unusable string throws rather than becoming a silently inert origin.
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

  // A `system:` ref names a pattern this deployment's toolshed serves; it
  // classifies as the web origin it resolves to, keeping the ref itself as the
  // recorded form so the panel shows what the piece actually stores.
  const systemRoute = resolveSystemPatternSource(source);
  if (systemRoute !== undefined) {
    return webOrigin(
      new URL(systemRoute, runtime.hostForSpace(space)),
      source,
    );
  }

  if (source.startsWith("/")) {
    const host = runtime.hostForSpace(space);
    return webOrigin(new URL(source, host), source);
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
  return webOrigin(url, source);
}

/**
 * A web origin at its canonical URL, keeping the recorded string whenever
 * canonicalizing changed it — a relative path resolved against a host, but also
 * an absolute URL the URL parser rewrote, such as one with no path or a default
 * port. The panel shows the recorded form beside the canonical one, so what a
 * piece stores stays visible.
 */
function webOrigin(url: URL, recorded: string): PieceOrigin {
  return {
    url: url.href,
    kind: "web",
    ...(url.href === recorded ? {} : { recorded }),
  };
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

/** Read source metadata already present in the local replica. */
export function readPieceSourceMetadata(
  runtime: Runtime,
  piece: Cell<unknown>,
): PieceSourceState {
  const pattern = getPatternIdentityRef(piece);
  const state: PieceSourceState = {
    space: piece.space,
    pieceId: piece.getAsNormalizedFullLink().id,
    files: [],
    history: [],
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
  const revisions = getPieceSourceRevisions(piece);
  state.history = revisions.map((revision) => {
    const historyOrigin = revision.origin === undefined
      ? undefined
      : tryClassifyOrigin(runtime, piece.space, revision.origin);
    if (
      historyOrigin !== undefined &&
      revision.recordedOrigin !== undefined
    ) {
      historyOrigin.recorded = revision.recordedOrigin;
    }
    return {
      revisionId: revision.revisionId,
      timestamp: revision.timestamp,
      pattern: revision.pattern,
      ...(historyOrigin === undefined ? {} : { origin: historyOrigin }),
      operation: revision.operation,
      ...(revision.selectedRevisionId === undefined
        ? {}
        : { selectedRevisionId: revision.selectedRevisionId }),
    };
  });
  const currentRevisionId = revisions.at(-1)?.revisionId;
  if (currentRevisionId !== undefined) {
    state.currentRevisionId = currentRevisionId;
  }
  const currentRevision = revisions.at(-1);
  if (
    state.origin !== undefined &&
    currentRevision?.origin === state.origin.url &&
    currentRevision.recordedOrigin !== undefined
  ) {
    state.origin.recorded = currentRevision.recordedOrigin;
  }
  return state;
}

/** Read every source fact a piece carries, with its authored source files. */
export async function readPieceSourceState(
  runtime: Runtime,
  piece: Cell<unknown>,
): Promise<PieceSourceState> {
  await piece.sync();
  const state = readPieceSourceMetadata(runtime, piece);
  const pattern = state.pattern;
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

function tryClassifyOrigin(
  runtime: Runtime,
  space: MemorySpace,
  recorded: string,
): PieceOrigin | undefined {
  try {
    return classifyOrigin(runtime, space, recorded);
  } catch {
    return undefined;
  }
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
