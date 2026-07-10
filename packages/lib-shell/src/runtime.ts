import { createSession, DID, Identity, Session } from "@commonfabric/identity";
import { CFC_CONCEPT_KIND, cfcAtom } from "@commonfabric/api/cfc-atoms";
import { entityRefFromString } from "@commonfabric/data-model/cell-rep";
import { slugIdForSpace } from "@commonfabric/runner/slugs";
import { NameSchema } from "@commonfabric/runner/schemas";
import {
  CellHandle,
  FavoritesManager,
  JSONValue,
  PageHandle,
  Program,
  RuntimeClient,
  RuntimeClientEvents,
  RuntimeClientOptions,
  RuntimeTelemetryMarkerResult,
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

export type ExperimentalRuntimeFlags = {
  modernCellRep?: boolean;
  persistentSchedulerState?: boolean;
  eagerSourceAnnotation?: boolean;
  systemPatternAutoUpdate?: boolean;
  systemPatternAutoUpdateHome?: boolean;
  /** Reactive interpreter (#4514): run pure pattern regions through the
   * graph-compression interpreter in the worker runtime. */
  experimentalInterpreter?: boolean;
};

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
  /**
   * A space's toolshed build differs from this client build, so its
   * system-pattern auto-update check was skipped. The shell surfaces a
   * non-blocking "reload to update" banner.
   */
  onVersionSkew?: (event: RuntimeClientEvents["versionskew"][0]) => void;
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
   * Optional space DID → host base URL map forwarded to the worker.
   * Spaces absent from the map resolve to `apiUrl` (the default host).
   */
  spaceHostMap?: Record<string, string>;
  experimental?: ExperimentalRuntimeFlags;
  cfcEnforcementMode?: RuntimeCfcEnforcementMode;
  /**
   * Flow-label propagation dial (S16). Shell hosts default to "observe"
   * (Epic H1): derive the per-tx conservative join and emit diagnostics,
   * persisting nothing — the measurement stage before "persist".
   */
  cfcFlowLabels?: RuntimeCfcFlowLabelsMode;
  /**
   * Populate the default render confidentiality ceiling (Epic H3a). When
   * true, the worker's display sinks gate labeled values against the
   * §8.10.6 profile for this identity and author-supplied render-boundary
   * declassification is denied. Dogfood flag, default off (= today's
   * unbounded rendering). Expect over-blocking while exchange resolution
   * (H3b) is not implemented.
   */
  cfcRenderCeiling?: boolean;
  trustSnapshot?: RuntimeTrustSnapshot | null;
  /**
   * This client build's git sha (the shell's `COMMIT_SHA`). Forwarded to the
   * worker runtime for the system-pattern auto-update version-skew gate.
   * Absent ⇒ never auto-update.
   */
  clientVersion?: string;
  /**
   * When true, forward the worker runtime's console output to the main
   * thread so it reaches devtools and integration-test console capture.
   * Off by default.
   */
  forwardWorkerConsole?: boolean;
  getBuildHash?: () => Promise<string | undefined>;
  workerUrl?: URL;
  /**
   * Optional telemetry sink (browser OTel bridge). Purely additive and gated by
   * the embedder: when omitted, no telemetry work happens.
   */
  telemetry?: RuntimeTelemetrySink;
};

const NavigationEventName = "cf-navigate";

class NavigationEvent extends CustomEvent<RuntimeNavigationTarget> {
  command: RuntimeNavigationTarget;
  constructor(command: RuntimeNavigationTarget) {
    super(NavigationEventName, { detail: command });
    this.command = command;
  }
}

function defaultNavigate(command: RuntimeNavigationTarget) {
  globalThis.dispatchEvent(new NavigationEvent(command));
}

/**
 * Fetch the worker bundle hash from the build manifest, used to cache-bust the
 * worker URL (`?v=<hash>`) so a deploy always loads the fresh worker bundle.
 * Cached at module level — the hash doesn't change within a page session.
 */
let buildHashPromise: Promise<string | undefined> | undefined;
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

export function createRuntimeClientOptions({
  session,
  apiUrl,
  spaceHostMap,
  experimental,
  cfcEnforcementMode = "enforce-explicit",
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
  // Epic H3a: populate the render confidentiality ceiling. Off by default —
  // a deployment-posture change to what the shell renders, enabled
  // deliberately per host (shell dogfood flag). When on, display sinks
  // admit only the §8.10.6 profile (the acting user's own identity atom
  // plus display-dischargeable influence-class caveat kinds) and
  // author-supplied render declassification is denied (audit S15); the
  // reconciler's fail-closed narrowing does the enforcement. Exact-match
  // forms only until H3b adds exchange resolution, so over-blocking is
  // expected — that is the point of the dogfood stage.
  cfcRenderCeiling = false,
  trustSnapshot,
  clientVersion,
  forwardWorkerConsole,
}: {
  session: Session;
  apiUrl: URL;
  spaceHostMap?: Record<string, string>;
  experimental?: ExperimentalRuntimeFlags;
  cfcEnforcementMode?: RuntimeCfcEnforcementMode;
  cfcFlowLabels?: RuntimeCfcFlowLabelsMode;
  cfcRenderCeiling?: boolean;
  trustSnapshot?: RuntimeTrustSnapshot | null;
  clientVersion?: string;
  forwardWorkerConsole?: boolean;
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
        renderConfidentialityCeiling: defaultRenderConfidentialityCeiling(
          session.as.did(),
        ),
      }
      : {}),
    trustSnapshot: resolvedTrustSnapshot,
    clientVersion,
    forwardWorkerConsole,
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
  #spaceRootPatterns: Map<DID, Promise<PageHandle<NameSchema>>> = new Map();
  #patternCache: Map<
    string,
    { promise: Promise<PageHandle<NameSchema>>; started: boolean }
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
    this.#client.on("versionskew", this.#onVersionSkew);
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

  async createPiece<T>(
    space: DID,
    source: URL | Program | string,
    options?: { argument?: JSONValue; run?: boolean },
  ): Promise<PageHandle<T>> {
    this.#check();
    const page = await this.#client.createPage<T>(source, space, options);
    if (!page) {
      throw new Error("Could not create piece");
    }
    return page;
  }

  getPiecesListCell<T>(space: DID): Promise<CellHandle<T[]>> {
    this.#check();
    return this.#client.getPiecesListCell<T>(space);
  }

  getSpaceRootPattern(space: DID): Promise<PageHandle<NameSchema>> {
    this.#check();
    const cached = this.#spaceRootPatterns.get(space);
    if (cached) return cached;
    const pattern = this.#client.getSpaceRootPattern(space);
    this.#spaceRootPatterns.set(space, pattern);
    // Evict on rejection: a transient failure (unreachable host, authz)
    // must not poison the space for the runtime's lifetime.
    pattern.catch(() => {
      if (this.#spaceRootPatterns.get(space) === pattern) {
        this.#spaceRootPatterns.delete(space);
      }
    });
    return pattern;
  }

  async recreateSpaceRootPattern(space: DID): Promise<PageHandle<NameSchema>> {
    this.#check();
    // Clear cached pattern since we're recreating it
    this.#spaceRootPatterns.delete(space);
    const pattern = await this.#client.recreateSpaceRootPattern(space);
    this.#spaceRootPatterns.set(space, Promise.resolve(pattern));
    return pattern;
  }

  /**
   * Get a piece's page handle. By default this also STARTS the piece
   * (instantiates its pattern in the worker) — appropriate for the piece
   * about to be displayed. Pass `start: false` for read-only consumers
   * (e.g. listing piece names): the persisted result cell is synced and
   * readable without paying pattern instantiation for every piece
   * (CT-1623: starting all pieces on reload cost ~10s of dependency
   * collection, either in the reload wall or on the first interaction).
   *
   * Cached per (space, id) — a pattern's address. A cache entry created
   * with `start: false` is upgraded (re-fetched with start) when a
   * starting caller asks for the same pattern.
   */
  getPattern(
    space: DID,
    id: string,
    options?: { start?: boolean },
  ): Promise<PageHandle<NameSchema>> {
    this.#check();
    const start = options?.start ?? true;
    const key = `${space}:${id}`;
    const cached = this.#patternCache.get(key);
    if (cached && (cached.started || !start)) {
      return cached.promise;
    }
    const promise = (async () => {
      const page = await this.#client.getPage<NameSchema>(id, space, start);
      if (!page) {
        throw new Error(`Pattern not found: ${id}`);
      }
      return page;
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
  ): Promise<PageHandle<NameSchema>> {
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
    return await this.#client.getPageSlug(id, space);
  }

  async removePage(space: DID, id: string): Promise<boolean> {
    this.#check();
    return await this.#client.removePage(id, space);
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
    body: Uint8Array;
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

  async trackRecentPiece(space: DID, pieceId: string): Promise<void> {
    this.#check();
    try {
      // Shell compatibility: assumes the space-root pattern exposes a
      // `trackRecent` handler accepting `{ piece }`.
      const spaceRoot = await this.getSpaceRootPattern(space);
      const trackRecent = spaceRoot.cell().key("trackRecent" as any);
      const page = await this.#client.getPage(pieceId, space);
      if (!page) return;
      await (trackRecent as any).send({ piece: page.cell() });
    } catch (e) {
      if (this.#disposed) return;
      console.error("[RuntimeInternals] Failed to track recent piece:", e);
    }
  }

  /** Register a navigated piece in ITS OWN space's root pattern. */
  async registerNavigatedPiece(cell: CellHandle<unknown>): Promise<void> {
    this.#check();
    try {
      // Shell compatibility: assumes the space-root pattern exposes an
      // `addPiece` handler accepting `{ piece }`.
      const spaceRoot = await this.getSpaceRootPattern(cell.space());
      const addPiece = spaceRoot.cell().key("addPiece" as any);
      await (addPiece as any).send({ piece: cell });
      await spaceRoot.cell().sync();
    } catch (e) {
      if (this.#disposed) return;
      console.error(
        "[RuntimeInternals] Failed to register navigated piece:",
        e,
      );
    }
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
    const pieceId = cell.id();
    logger.log("navigate", `Navigating to piece: ${pieceId}`);

    void this.registerNavigatedPiece(cell);
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
    (this.#callbacks.navigate ?? defaultNavigate)({
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

  #onVersionSkew = (event: RuntimeClientEvents["versionskew"][0]) => {
    this.#callbacks.onVersionSkew?.(event);
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
    getBuildHash = fetchBuildHash,
    workerUrl,
    navigate,
    onConsole,
    onError,
    onVersionSkew,
    telemetry,
  }: RuntimeInternalsCreateOptions): Promise<RuntimeInternals> {
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

    // Fetch the build manifest first so the worker URL is cache-busted with
    // the deployed bundle's hash (a deploy always loads the fresh worker).
    const buildHash = await getBuildHash();
    const resolvedWorkerUrl = workerUrl ?? new URL(
      "/scripts/worker-runtime.js",
      globalThis.location.origin,
    );
    if (buildHash) resolvedWorkerUrl.searchParams.set("v", buildHash);
    const transport = await WebWorkerRuntimeTransport.connect({
      workerUrl: resolvedWorkerUrl,
    });
    const client = await RuntimeClient.initialize(
      transport,
      createRuntimeClientOptions({
        session,
        apiUrl,
        spaceHostMap,
        experimental,
        cfcEnforcementMode,
        cfcFlowLabels,
        cfcRenderCeiling,
        trustSnapshot,
        clientVersion,
        forwardWorkerConsole,
      }),
    );

    // Expose a usable RuntimeInternals immediately. Callers that need
    // storage/piece-manager convergence should await `rt.synced(space)`
    // explicitly.
    return new RuntimeInternals(
      client,
      { navigate, onConsole, onError, onVersionSkew },
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
