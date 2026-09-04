import {
  createSession,
  DID,
  Identity,
  isDID,
  Session,
} from "@commonfabric/identity";
import { CFC_CONCEPT_KIND, cfcAtom } from "@commonfabric/api/cfc";
import type { FabricPlainObject } from "@commonfabric/data-model";
import { entityRefFromString } from "@commonfabric/data-model/cell-rep";
import { navigate } from "@commonfabric/navigation";
import { slugIdForSpace } from "@commonfabric/runner/slugs";
import { NameSchema } from "@commonfabric/runner/schemas";
import {
  attachOptionsFrom,
  CellHandle,
  FavoritesManager,
  PieceHandle,
  type PieceSourceView,
  Program,
  RuntimeClient,
  RuntimeClientEvents,
  RuntimeClientOptions,
  RuntimeTelemetryMarkerResult,
  type RuntimeTransport,
} from "@commonfabric/runtime-client";
import { WebWorkerRuntimeTransport } from "@commonfabric/runtime-client/transports/web-worker";
import { getLogger } from "@commonfabric/utils/logger";

const logger = getLogger("lib-shell.runtime", {
  enabled: false,
  level: "debug",
});

const identityLogger = getLogger("lib-shell.identity", {
  enabled: false,
  level: "debug",
});

/**
 * The worker's experimental-flag declaration — the runtime-client protocol's
 * own record, not a copy: a host-side copy that lagged the protocol silently
 * dropped whichever flag it omitted, reverting the worker to that flag's
 * default while the host ran the other arm.
 */
export type ExperimentalRuntimeFlags = NonNullable<
  RuntimeClientOptions["experimental"]
>;

export type RuntimeCfcEnforcementMode = NonNullable<
  RuntimeClientOptions["cfcEnforcementMode"]
>;

export type RuntimeCfcFlowLabelsMode = NonNullable<
  RuntimeClientOptions["cfcFlowLabels"]
>;

export type RuntimeTrustSnapshot = NonNullable<
  RuntimeClientOptions["trustSnapshot"]
>;

export type RuntimeRenderConfidentialityCeiling = NonNullable<
  RuntimeClientOptions["renderConfidentialityCeiling"]
>;

/**
 * The §8.10.6 initial display-sink release ceiling (Epic H3a/H3b,
 * docs/history/plans/cfc-future-work-implementation.md): what a display surface
 * admits when no authored policy covers it. The audience of a display sink
 * is the acting user, so the identity/personal-space principal forms naming
 * exactly that audience are admissible by construction. Shared `Space(...)`
 * principals are NOT listed here — they resolve to the acting user via the
 * verified `HasRole` exchange rules at the render boundary (H3b), so the
 * runner-side resolver admits them without widening this static ceiling.
 *
 * Tighten-only evolution (spec §8.10.6): removing an entry needs no
 * ceremony; admitting a new atom family or caveat kind is a release
 * decision that needs authored policy or verified authority.
 */
export function defaultRenderConfidentialityCeiling(
  actingUser: DID,
): RuntimeRenderConfidentialityCeiling {
  return {
    // Acting-user identity atoms: the audience of a display sink is the
    // acting user, so atoms naming exactly that audience are admissible by
    // construction (spec §8.10.6). Both the §15.2 principal atom objects
    // (`User`, `PersonalSpace`) and the legacy DID-string form are listed —
    // the ceiling is a set, and every entry names exactly this audience.
    atoms: [
      cfcAtom.user(actingUser),
      cfcAtom.personalSpace(actingUser),
      actingUser,
    ],
    // Influence-class caveat kinds, whose canonical display release is the
    // rendered-disclosure rule (§8.10.5). Deliberately excludes
    // PromptInjectionRiskUnscreened: a material-risk kind that keeps its
    // ordinary discharge evidence (screening), not display disclosure.
    caveatKinds: [
      // The canonical influence-class concept id.
      CFC_CONCEPT_KIND.PromptInfluence,
      // Short-form alias minted by shipped example patterns
      // (cfc-spec-gallery, cfc-trusted-component-examples) and matched by
      // the cf-cfc-label disclosure UI.
      "prompt-influence",
    ],
  };
}

export type RuntimeNavigationTarget = { spaceDid: DID; pieceId: string };

export type RuntimeInternalsCallbacks = {
  navigate?: (target: RuntimeNavigationTarget) => void;
  onConsole?: (event: RuntimeClientEvents["console"][0]) => void;
  onError?: (event: RuntimeClientEvents["error"][0]) => void;
};

/**
 * Optional telemetry sink for the client marker stream. When provided (browser
 * OTel enabled), each marker is forwarded here IN ADDITION to the existing debug
 * handling. Structurally matches the browser OTel bridge returned by
 * packages/shell/src/lib/otel.ts, so this package pulls in no OTel code — the
 * embedder owns SDK setup and passes the sink in. Absent = zero added work.
 */
export interface RuntimeTelemetrySink {
  handleMarker(marker: RuntimeTelemetryMarkerResult): void;
  shutdown(): void | Promise<void>;
}

export type RuntimeInternalsCreateOptions = RuntimeInternalsCallbacks & {
  identity: Identity;
  apiUrl: URL;

  /**
   * Optional map from space DIDs to HTTP or HTTPS origins, forwarded to the
   * worker. Spaces absent from the map resolve to `apiUrl`, the default host.
   */
  spaceHostMap?: Record<string, string>;

  experimental?: ExperimentalRuntimeFlags;
  cfcEnforcementMode?: RuntimeCfcEnforcementMode;

  /**
   * Flow-label propagation dial (S16). Shell hosts default to "persist"
   * (Epic H2): derive the per-tx conservative join and write it as a
   * `derived` label component on every value write.
   */
  cfcFlowLabels?: RuntimeCfcFlowLabelsMode;

  /**
   * Populate the default render confidentiality ceiling (Epic H3a).
   * Defaults to on: the worker's display sinks gate labeled values against
   * the §8.10.6 profile for this identity, shared `Space(...)` principals
   * resolve through the verified `HasRole` rules at the render boundary
   * (H3b), and author-supplied render-boundary declassification is denied.
   * `false` opts a host out, which renders labeled content ungated.
   */
  cfcRenderCeiling?: boolean;

  trustSnapshot?: RuntimeTrustSnapshot | null;

  /**
   * This shell build's identifier (normally `COMMIT_SHA`). Deployed builds use
   * it to select the immutable `/builds/<clientVersion>/` worker asset graph.
   */
  clientVersion?: string;

  /**
   * When true, forward the worker runtime's console output to the main
   * thread so it reaches devtools and integration-test console capture.
   * Off by default.
   */
  forwardWorkerConsole?: boolean;

  /**
   * When true, the worker runtime instruments pattern compiles for statement
   * coverage; the integration harness pulls the accumulated hits at teardown.
   * Test/CI only, off by default. See docs/development/COVERAGE.md.
   */
  patternCoverage?: boolean;

  /**
   * When true, the worker's remote storage overlaps watch-refresh round trips
   * up to a bounded window instead of strict single-flight
   * (`experimentalConcurrentWatchRefresh`). Dogfood flag, default off; fixed at
   * StorageManager.open time so it takes effect on the next runtime (reload).
   */
  concurrentWatchRefresh?: boolean;

  /**
   * Override the runtime worker URL. By default, deployed builds use the
   * immutable `/builds/<clientVersion>/` asset namespace while local builds
   * fall back to `/scripts/worker-runtime.js`.
   *
   * Ignored when `transport` supplies the connection, there being no worker to
   * address.
   */
  workerUrl?: URL;

  /**
   * The connection to the runtime's worker. Absent, this page spawns a
   * dedicated worker of its own and connects to that, which is what a page
   * with no runtime around it does.
   *
   * Supplied, the embedder has already made the connection and this page
   * speaks over it. How -- a port a family root's page transferred, a channel
   * a native shell relays -- is the embedder's to know and nothing here reads.
   */
  transport?: RuntimeTransport;

  /**
   * Join the runtime already running behind `transport` rather than standing
   * one up. It says which client this page is: the one whose initialization
   * settles the runtime's identity and security posture, or one attaching to a
   * runtime whose posture is already settled and which it asserts rather than
   * declares.
   *
   * Only meaningful with `transport`: a worker this page spawned has no
   * runtime to attach to.
   */
  attach?: boolean;

  getBuildHash?: () => Promise<string | undefined>;

  /**
   * Optional telemetry sink (browser OTel bridge). Purely additive and gated by
   * the embedder: when omitted, no telemetry work happens.
   */
  telemetry?: RuntimeTelemetrySink;
};

/** {@link fetchBuildHash}'s module-level memo. */
let buildHashPromise: Promise<string | undefined> | undefined;

/**
 * Fetch the worker bundle hash from the build manifest. This cache-busts the
 * mutable root worker URL used by local/legacy builds. Deployed shell builds
 * use their immutable `/builds/<sha>/` namespace instead.
 *
 * Cached — the hash doesn't change within a page session, so the manifest is
 * fetched at most once.
 */
export function fetchBuildHash(): Promise<string | undefined> {
  if (!buildHashPromise) {
    buildHashPromise = (async () => {
      try {
        const resp = await fetch(
          new URL("/build-manifest.json", globalThis.location.origin),
          { cache: "no-store" },
        );
        if (resp.ok) {
          const manifest = await resp.json();
          // Key must match the worker entry's `out` path in felt.config.ts.
          return manifest["scripts/worker-runtime.js"] as string | undefined;
        }
      } catch {
        // Manifest not available — compilation cache disabled
      }
      return undefined;
    })();
  }
  return buildHashPromise;
}

/**
 * The URL this page's runtime worker is loaded from.
 *
 * Production deploys retain each complete module graph under its commit SHA.
 * Keeping the entry and all of its relative split chunks in that same
 * immutable namespace prevents a later root deployment from deleting a chunk
 * that a long-lived page still needs. An explicit `workerUrl` (local
 * development) or an absent `clientVersion` retains the mutable root URL and
 * its manifest cache-buster.
 *
 * {@link RuntimeInternals.create} calls this for the worker it spawns. It is
 * exported for the page that spawns one and then hands ports to it: such a
 * page holds the transport itself, and must reach the same URL doing so.
 */
export async function resolveWorkerUrl(
  options: {
    workerUrl?: URL;
    clientVersion?: string;
    getBuildHash?: () => Promise<string | undefined>;
  } = {},
): Promise<URL> {
  const { workerUrl, clientVersion, getBuildHash = fetchBuildHash } = options;
  const immutableBuildId = workerUrl === undefined && clientVersion
    ? clientVersion
    : undefined;
  const resolved = workerUrl ?? new URL(
    immutableBuildId
      ? `/builds/${
        encodeURIComponent(immutableBuildId)
      }/scripts/worker-runtime.js`
      : "/scripts/worker-runtime.js",
    globalThis.location.origin,
  );
  if (!immutableBuildId) {
    const buildHash = await getBuildHash();
    if (buildHash) resolved.searchParams.set("v", buildHash);
  }
  return resolved;
}

export function createRuntimeClientOptions({
  session,
  apiUrl,
  spaceHostMap,
  experimental,
  cfcEnforcementMode = "enforce-strict",
  // Epic H2 (docs/history/plans/cfc-future-work-implementation.md): shell hosts run the
  // flow-label dial at "persist" — the per-tx conservative join is derived AND
  // written as a `derived` label component on every value write. This
  // activates inv-9 (flow-path confidentiality) in real shell deployments:
  // reading labeled data and writing a derived value no longer launders the
  // label away. Safe to persist because re-derivation is idempotent (SC-11:
  // an unchanged label writes no envelope — see prepare.ts) so a rerun that
  // reads the same inputs does not churn the ["cfc"] doc; replace-on-overwrite
  // (§8.12.8) keeps the derived component tracking the current value rather
  // than ratcheting forever. H1 shipped "observe" as the measurement stage.
  cfcFlowLabels = "persist",
  // Epic H3a: populate the render confidentiality ceiling. On by default:
  // display sinks admit only the §8.10.6 profile (the acting user's own
  // identity atoms plus display-dischargeable influence-class caveat kinds,
  // with shared `Space(...)` principals resolved through the verified
  // `HasRole` exchange rules at the render boundary, H3b) and
  // author-supplied render declassification is denied (audit S15); the
  // reconciler's fail-closed narrowing does the enforcement. The shell's
  // per-profile `commonfabric.cfcRenderCeiling(false)` toggle opts a browser
  // profile back out.
  cfcRenderCeiling = true,
  trustSnapshot,
  forwardWorkerConsole,
  patternCoverage,
  concurrentWatchRefresh,
}: {
  session: Session;
  apiUrl: URL;
  spaceHostMap?: Record<string, string>;
  experimental?: ExperimentalRuntimeFlags;
  cfcEnforcementMode?: RuntimeCfcEnforcementMode;
  cfcFlowLabels?: RuntimeCfcFlowLabelsMode;
  cfcRenderCeiling?: boolean;
  trustSnapshot?: RuntimeTrustSnapshot | null;
  forwardWorkerConsole?: boolean;
  patternCoverage?: boolean;
  concurrentWatchRefresh?: boolean;
}) {
  const resolvedTrustSnapshot = trustSnapshot === undefined
    ? {
      id: `principal:${session.as.did()}`,
      actingPrincipal: session.as.did(),
    }
    : trustSnapshot ?? undefined;

  return {
    apiUrl,
    spaceHostMap,
    identity: session.as,
    spaceIdentity: session.spaceIdentity,
    spaceDid: session.space,
    spaceName: session.spaceName,
    experimental,
    cfcEnforcementMode,
    cfcFlowLabels,
    ...(cfcRenderCeiling
      ? {
        renderDeclassificationPolicy: "deny" as const,
        // The ceiling admits the identity the runtime renders AS, which a
        // delegated host names in its own trust snapshot. Without a snapshot,
        // and for a principal that is not a DID, that is the session identity.
        renderConfidentialityCeiling: defaultRenderConfidentialityCeiling(
          isDID(resolvedTrustSnapshot?.actingPrincipal)
            ? resolvedTrustSnapshot.actingPrincipal
            : session.as.did(),
        ),
      }
      : {}),
    trustSnapshot: resolvedTrustSnapshot,
    forwardWorkerConsole,
    patternCoverage,
    concurrentWatchRefresh,
  };
}

/**
 * RuntimeInternals bundles all resources bound to an identity/host pair:
 * ONE runtime serving all of that identity's spaces over one worker.
 * There is no bound/current space — a space is just part of an address,
 * like an id, and every space-scoped method names it explicitly. (The
 * "current space" of the old one-piece-at-a-time shell is view state,
 * owned by the embedder.)
 */
export class RuntimeInternals extends EventTarget {
  #client: RuntimeClient;
  #disposed = false;
  #favorites: FavoritesManager;
  #callbacks: RuntimeInternalsCallbacks;

  /** Cached space roots, with whether the cached one was STARTED: a
   * started root also answers a caller that only reads its exports, while
   * one resolved without starting does not answer a caller that needs it
   * running. */
  #spaceRootPatterns: Map<
    DID,
    { pattern: Promise<PieceHandle<NameSchema>>; started: boolean }
  > = new Map();
  #patternCache: Map<
    string,
    { promise: Promise<PieceHandle<NameSchema>>; started: boolean }
  > = new Map();
  // TODO(runtime-worker-refactor)
  #telemetryMarkers: RuntimeTelemetryMarkerResult[] = [];
  // Optional OTel sink (browser telemetry enabled). Inert when undefined.
  #telemetrySink?: RuntimeTelemetrySink;

  constructor(
    client: RuntimeClient,
    callbacks: RuntimeInternalsCallbacks = {},
    telemetry?: RuntimeTelemetrySink,
  ) {
    super();
    this.#client = client;
    this.#callbacks = callbacks;
    this.#telemetrySink = telemetry;
    this.#favorites = new FavoritesManager(client);
    this.#client.on("console", this.#onConsole);
    this.#client.on("navigaterequest", this.#onNavigateRequest);
    this.#client.on("error", this.#onError);
    this.#client.on("telemetry", this.#onTelemetry);
  }

  runtime(): RuntimeClient {
    return this.#client;
  }

  telemetry(): RuntimeTelemetryMarkerResult[] {
    return this.#telemetryMarkers;
  }

  favorites(): FavoritesManager {
    this.#check();
    return this.#favorites;
  }

  /**
   * Creates a piece in the given space, `options.argument` being the record of
   * inputs it is created with.
   */
  async createPiece<T>(
    space: DID,
    source: URL | Program | string,
    options?: { argument?: FabricPlainObject; run?: boolean },
  ): Promise<PieceHandle<T>> {
    this.#check();
    const piece = await this.#client.createPiece<T>(source, space, options);
    if (!piece) {
      throw new Error("Could not create piece");
    }
    return piece;
  }

  /**
   * A piece's source state: the pattern it runs, the origin it tracks, the
   * history metadata it carries, and its authored source files.
   */
  getPieceSource(space: DID, pieceId: string): Promise<PieceSourceView> {
    this.#check();
    return this.#client.getPieceSource(pieceId, space);
  }

  getPiecesListCell<T>(space: DID): Promise<CellHandle<T[]>> {
    this.#check();
    return this.#client.getPiecesListCell<T>(space);
  }

  /**
   * The space's root pattern. `start` defaults to true, which a view that
   * renders the root needs; pass false to read its exports without running
   * it.
   */
  getSpaceRootPattern(
    space: DID,
    options: { start?: boolean } = {},
  ): Promise<PieceHandle<NameSchema>> {
    this.#check();
    const start = options.start ?? true;
    const cached = this.#spaceRootPatterns.get(space);
    if (cached && (cached.started || !start)) return cached.pattern;
    const pattern = this.#client.getSpaceRootPattern(space, { start });
    const entry = { pattern, started: start };
    this.#spaceRootPatterns.set(space, entry);
    // Evict on rejection: a transient failure (unreachable host, authz)
    // must not poison the space for the runtime's lifetime.
    pattern.catch(() => {
      if (this.#spaceRootPatterns.get(space) === entry) {
        this.#spaceRootPatterns.delete(space);
      }
    });
    return pattern;
  }

  resolveSpaceName(name: string): Promise<DID> {
    this.#check();
    return this.#client.resolveSpaceName(name);
  }

  async recreateSpaceRootPattern(space: DID): Promise<PieceHandle<NameSchema>> {
    this.#check();
    // Clear cached pattern since we're recreating it
    this.#spaceRootPatterns.delete(space);
    const pattern = await this.#client.recreateSpaceRootPattern(space);
    this.#spaceRootPatterns.set(space, {
      pattern: Promise.resolve(pattern),
      started: true,
    });
    return pattern;
  }

  /**
   * Get a piece's handle. By default this also STARTS the piece
   * (instantiates its pattern in the worker) — appropriate for the piece
   * about to be displayed. Pass `start: false` for read-only consumers
   * (e.g. listing piece names): the persisted result cell is synced and
   * readable without paying pattern instantiation for every piece
   * (starting every registered piece on reload cost about ten seconds of
   * dependency collection, either during reload or on the first interaction).
   *
   * Cached per (space, id) — a pattern's address. A cache entry created
   * with `start: false` is upgraded (re-fetched with start) when a
   * starting caller asks for the same pattern.
   */
  getPattern(
    space: DID,
    id: string,
    options?: { start?: boolean },
  ): Promise<PieceHandle<NameSchema>> {
    this.#check();
    const start = options?.start ?? true;
    const key = `${space}:${id}`;
    const cached = this.#patternCache.get(key);
    if (cached && (cached.started || !start)) {
      return cached.promise;
    }
    const promise = (async () => {
      const piece = await this.#client.getPiece<NameSchema>(id, space, start);
      if (!piece) {
        throw new Error(`Pattern not found: ${id}`);
      }
      return piece;
    })();
    const entry = { promise, started: start };
    this.#patternCache.set(key, entry);
    // Evict on rejection so the next request retries.
    promise.catch(() => {
      if (this.#patternCache.get(key) === entry) {
        this.#patternCache.delete(key);
      }
    });
    return promise;
  }

  invalidatePattern(space: DID, id: string): void {
    this.#patternCache.delete(`${space}:${id}`);
  }

  async refreshPattern(
    space: DID,
    id: string,
  ): Promise<PieceHandle<NameSchema>> {
    this.invalidatePattern(space, id);
    return await this.getPattern(space, id);
  }

  async getSlugCell(space: DID, slug: string): Promise<CellHandle<unknown>> {
    this.#check();
    return await this.#client.getCell(
      space,
      entityRefFromString(slugIdForSpace(space, slug)),
    );
  }

  async getSlug(space: DID, id: string): Promise<string | undefined> {
    this.#check();
    return await this.#client.getPieceSlug(id, space);
  }

  async removePiece(space: DID, id: string): Promise<boolean> {
    this.#check();
    return await this.#client.removePiece(id, space);
  }

  async synced(space: DID): Promise<void> {
    this.#check();
    await this.#client.synced(space);
  }

  /** See RuntimeClient.registerSpaceHost — the site-table v0 hint API. */
  async registerSpaceHost(space: DID, host: string): Promise<boolean> {
    this.#check();
    return await this.#client.registerSpaceHost(space, host);
  }

  async idle(): Promise<void> {
    this.#check();
    await this.#client.idle();
  }

  async uploadBlob(options: {
    space: DID;
    contentType: string;
    body: Uint8Array | ArrayBufferLike;
    suffix?: string;
  }): Promise<{ id: string; url: string }> {
    this.#check();
    return await this.#client.uploadBlob(options);
  }

  /**
   * The runtime's lifetime signal. It aborts when this runtime is disposed.
   * Consumers observe it to stop polling/subscribing and to recognize that a
   * disposal-raced operation was cancelled rather than failed.
   */
  get signal(): AbortSignal {
    return this.#client.signal;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    // Flush + tear down telemetry first so buffered spans aren't dropped on
    // runtime replacement/logout. Guarded — telemetry must never break disposal.
    if (this.#telemetrySink) {
      try {
        await this.#telemetrySink.shutdown();
      } catch (e) {
        console.error("[RuntimeInternals] telemetry sink shutdown failed:", e);
      }
      this.#telemetrySink = undefined;
    }
    await this.#client.dispose();
  }

  async #waitForNavigationConvergence(space: DID): Promise<void> {
    this.#check();
    await this.#client.idle();
    await this.#client.synced(space);
  }

  #onConsole = (e: RuntimeClientEvents["console"][0]) => {
    if (this.#callbacks.onConsole) {
      this.#callbacks.onConsole(e);
      return;
    }
    const { metadata, method, args } = e;
    if (metadata?.pieceId) {
      console.log(`Piece(${metadata.pieceId}) [${method}]:`, ...args);
    } else {
      console.log(`Console [${method}]:`, ...args);
    }
  };

  #onNavigateRequest = (
    e: RuntimeClientEvents["navigaterequest"][0],
  ) => {
    void this.#handleNavigateRequest(e);
  };

  async #handleNavigateRequest(
    e: RuntimeClientEvents["navigaterequest"][0],
  ): Promise<void> {
    const { cell } = e;
    // `CellHandle.id()` is the full schemed URI; routing pieceIds are bare
    // (the `PieceHandle.id()` convention) — URLs and the pieceId protocol
    // fields expect the `of:`-stripped form.
    const pieceId = cell.id().replace(/^of:/, "");
    logger.log("navigate", `Navigating to piece: ${pieceId}`);

    try {
      await this.#waitForNavigationConvergence(cell.space());
    } catch (error) {
      // A disposal race (logout, worker replacement) abandons convergence
      // cleanly; a genuine failure is logged. Either way navigation is
      // abandoned, and the rejection never escapes as unhandled.
      if (!this.#disposed) {
        console.error(
          "[RuntimeInternals] Navigation convergence failed:",
          error,
        );
      }
      return;
    }

    // The target is an address: (space, piece). Mapping a space DID back
    // to a human-readable view (e.g. a spaceName URL) is the embedder's
    // view-state concern, handled in its navigate callback.
    (this.#callbacks.navigate ?? navigate)({
      spaceDid: cell.space(),
      pieceId,
    });
  }

  #onError = (event: RuntimeClientEvents["error"][0]) => {
    if (this.#callbacks.onError) {
      this.#callbacks.onError(event);
      return;
    }
    console.error("[RuntimeClient Error]", event);
  };

  #onTelemetry = (marker: RuntimeTelemetryMarkerResult) => {
    this.#telemetryMarkers.push(marker);
    this.dispatchEvent(new CustomEvent("telemetryupdate"));
    // Additionally translate the marker into OTel spans/metrics when a sink is
    // attached (browser telemetry enabled). Guarded so a bridge error never
    // disrupts the existing debug telemetry pipeline.
    if (this.#telemetrySink) {
      try {
        this.#telemetrySink.handleMarker(marker);
      } catch (e) {
        console.error(
          "[RuntimeInternals] telemetry sink handleMarker failed:",
          e,
        );
      }
    }
  };

  #check() {
    if (this.#disposed) {
      throw new Error("RuntimeInternals disposed.");
    }
  }

  static async create({
    identity,
    apiUrl,
    spaceHostMap,
    experimental,
    cfcEnforcementMode,
    cfcFlowLabels,
    cfcRenderCeiling,
    trustSnapshot,
    clientVersion,
    forwardWorkerConsole,
    patternCoverage,
    concurrentWatchRefresh,
    getBuildHash = fetchBuildHash,
    workerUrl,
    transport,
    attach = false,
    navigate,
    onConsole,
    onError,
    telemetry,
  }: RuntimeInternalsCreateOptions): Promise<RuntimeInternals> {
    if (attach && !transport) {
      throw new Error(
        "`attach` needs a `transport`: a worker this page spawns has no " +
          "runtime to attach to.",
      );
    }

    // One runtime per identity: the worker session is always the
    // identity's home session. Spaces — including derived named spaces —
    // are addressed per call; nothing is bound at creation.
    const session: Session = await createSession({
      identity,
      spaceDid: identity.did(),
    });

    // Log user identity for debugging
    identityLogger.log(
      "identity",
      `[Identity] User DID: ${identity.did()}`,
    );

    const connection = transport ??
      await WebWorkerRuntimeTransport.connect({
        workerUrl: await resolveWorkerUrl({
          workerUrl,
          clientVersion,
          getBuildHash,
        }),
      });

    const clientOptions = createRuntimeClientOptions({
      session,
      apiUrl,
      spaceHostMap,
      experimental,
      cfcEnforcementMode,
      cfcFlowLabels,
      cfcRenderCeiling,
      trustSnapshot,
      forwardWorkerConsole,
      patternCoverage,
      concurrentWatchRefresh,
    });
    const client = attach
      ? await RuntimeClient.attach(
        connection,
        attachOptionsFrom(clientOptions),
      )
      : await RuntimeClient.initialize(connection, clientOptions);

    // Expose a usable RuntimeInternals immediately. Callers that need
    // storage/piece-manager convergence should await `rt.synced(space)`
    // explicitly.
    return new RuntimeInternals(
      client,
      { navigate, onConsole, onError },
      telemetry,
    );
  }
}

/**
 * Resolve a named space to its DID (the derived space key) without
 * touching any runtime. "Current space" is embedder view state; this is
 * the one piece of derivation embedders need to translate a
 * human-readable space name into an address.
 */
export async function resolveSpaceDid(
  identity: Identity,
  spaceName: string,
): Promise<DID> {
  const session = await createSession({ identity, spaceName });
  return session.space;
}
