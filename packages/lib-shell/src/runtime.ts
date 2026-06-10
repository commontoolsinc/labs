import { createSession, DID, Identity, Session } from "@commonfabric/identity";
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

export type RuntimeView =
  | { builtin: "home" }
  | { spaceName: string }
  | { spaceDid: DID };

export type ExperimentalRuntimeFlags = {
  modernCellRep?: boolean;
  persistentSchedulerState?: boolean;
  esmModuleLoader?: boolean;
};

export type RuntimeCfcEnforcementMode = NonNullable<
  RuntimeClientOptions["cfcEnforcementMode"]
>;

export type RuntimeTrustSnapshot = NonNullable<
  RuntimeClientOptions["trustSnapshot"]
>;

export type RuntimeNavigationTarget =
  | { spaceName: string; pieceId: string }
  | { spaceDid: DID; pieceId: string };

export type RuntimeInternalsCallbacks = {
  navigate?: (target: RuntimeNavigationTarget) => void;
  onConsole?: (event: RuntimeClientEvents["console"][0]) => void;
  onError?: (event: RuntimeClientEvents["error"][0]) => void;
};

export type RuntimeInternalsCreateOptions = RuntimeInternalsCallbacks & {
  identity: Identity;
  view: RuntimeView;
  apiUrl: URL;
  /**
   * Optional space DID → host base URL map forwarded to the worker.
   * Spaces absent from the map resolve to `apiUrl` (the default host).
   */
  spaceHostMap?: Record<string, string>;
  experimental?: ExperimentalRuntimeFlags;
  cfcEnforcementMode?: RuntimeCfcEnforcementMode;
  trustSnapshot?: RuntimeTrustSnapshot | null;
  compilationCacheClient?: boolean;
  getBuildHash?: () => Promise<string | undefined>;
  workerUrl?: URL;
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
 * Fetch the worker bundle hash from the build manifest.
 * Cached at module level — the hash doesn't change within a page session.
 * See docs/specs/compilation-cache.md Phase 3.
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
  buildHash,
  experimental,
  cfcEnforcementMode = "enforce-explicit",
  trustSnapshot,
}: {
  session: Session;
  apiUrl: URL;
  spaceHostMap?: Record<string, string>;
  buildHash?: string;
  experimental?: ExperimentalRuntimeFlags;
  cfcEnforcementMode?: RuntimeCfcEnforcementMode;
  trustSnapshot?: RuntimeTrustSnapshot | null;
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
    trustSnapshot: resolvedTrustSnapshot,
    buildHash,
  };
}

/**
 * RuntimeInternals bundles all resources bound to an identity/host/space triplet.
 * Uses RuntimeClient to run the Runtime in a web client.
 */
export class RuntimeInternals extends EventTarget {
  #client: RuntimeClient;
  #disposed = false;
  #space: DID;
  #spaceName?: string;
  #isHomeSpace: boolean;
  #homeSpaceDID: DID;
  #favorites: FavoritesManager;
  #callbacks: RuntimeInternalsCallbacks;
  #spaceRootPattern?: Promise<PageHandle<NameSchema>>;
  #patternCache: Map<string, Promise<PageHandle<NameSchema>>> = new Map();
  // TODO(runtime-worker-refactor)
  #telemetryMarkers: RuntimeTelemetryMarkerResult[] = [];

  constructor(
    client: RuntimeClient,
    space: DID,
    spaceName: string | undefined,
    isHomeSpace: boolean,
    homeSpaceDID: DID,
    callbacks: RuntimeInternalsCallbacks = {},
  ) {
    super();
    this.#client = client;
    this.#space = space;
    this.#spaceName = spaceName;
    this.#isHomeSpace = isHomeSpace;
    this.#homeSpaceDID = homeSpaceDID;
    this.#callbacks = callbacks;
    this.#favorites = new FavoritesManager(client, space);
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

  space(): DID {
    return this.#space;
  }

  spaceName(): string | undefined {
    return this.#spaceName;
  }

  isHomeSpace(): boolean {
    return this.#isHomeSpace;
  }

  homeSpaceDID(): DID {
    return this.#homeSpaceDID;
  }

  favorites(): FavoritesManager {
    this.#check();
    return this.#favorites;
  }

  async createPiece<T>(
    source: URL | Program | string,
    options?: { argument?: JSONValue; run?: boolean },
  ): Promise<PageHandle<T>> {
    this.#check();
    const page = await this.#client.createPage<T>(source, options);
    if (!page) {
      throw new Error("Could not create piece");
    }
    return page;
  }

  getPiecesListCell<T>(): Promise<CellHandle<T[]>> {
    this.#check();
    return this.#client.getPiecesListCell<T>();
  }

  getSpaceRootPattern(): Promise<PageHandle<NameSchema>> {
    this.#check();
    if (this.#spaceRootPattern) return this.#spaceRootPattern;
    this.#spaceRootPattern = this.#client.getSpaceRootPattern();
    return this.#spaceRootPattern;
  }

  async recreateSpaceRootPattern(): Promise<PageHandle<NameSchema>> {
    this.#check();
    // Clear cached pattern since we're recreating it
    this.#spaceRootPattern = undefined;
    const pattern = await this.#client.recreateSpaceRootPattern();
    this.#spaceRootPattern = Promise.resolve(pattern);
    return pattern;
  }

  getPattern(id: string): Promise<PageHandle<NameSchema>> {
    this.#check();
    const cached = this.#patternCache.get(id);
    if (cached) {
      return cached;
    }
    const promise = (async () => {
      const page = await this.#client.getPage<NameSchema>(id, true);
      if (!page) {
        throw new Error(`Pattern not found: ${id}`);
      }
      return page;
    })();
    this.#patternCache.set(id, promise);
    return promise;
  }

  invalidatePattern(id: string): void {
    this.#patternCache.delete(id);
  }

  async refreshPattern(id: string): Promise<PageHandle<NameSchema>> {
    this.invalidatePattern(id);
    return await this.getPattern(id);
  }

  async getSlugCell(slug: string): Promise<CellHandle<unknown>> {
    this.#check();
    return await this.#client.getCell(this.#space, {
      "/": slugIdForSpace(this.#space, slug),
    });
  }

  async getSlug(id: string): Promise<string | undefined> {
    this.#check();
    return await this.#client.getPageSlug(id);
  }

  async removePage(id: string): Promise<boolean> {
    this.#check();
    return await this.#client.removePage(id);
  }

  async synced(): Promise<void> {
    this.#check();
    await this.#client.synced();
  }

  async idle(): Promise<void> {
    this.#check();
    await this.#client.idle();
  }

  async uploadBlob(options: {
    contentType: string;
    body: Uint8Array;
    suffix?: string;
  }): Promise<{ id: string; url: string }> {
    this.#check();
    return await this.#client.uploadBlob(options);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#client.dispose();
  }

  async trackRecentPiece(pieceId: string): Promise<void> {
    this.#check();
    try {
      // Shell compatibility: assumes the space-root pattern exposes a
      // `trackRecent` handler accepting `{ piece }`.
      const spaceRoot = await this.getSpaceRootPattern();
      const trackRecent = spaceRoot.cell().key("trackRecent" as any);
      const page = await this.#client.getPage(pieceId);
      if (!page) return;
      await (trackRecent as any).send({ piece: page.cell() });
    } catch (e) {
      console.error("[RuntimeInternals] Failed to track recent piece:", e);
    }
  }

  async registerNavigatedPiece(cell: CellHandle<unknown>): Promise<void> {
    this.#check();
    if (cell.space() !== this.#space) return;
    try {
      // Shell compatibility: assumes the space-root pattern exposes an
      // `addPiece` handler accepting `{ piece }`.
      const spaceRoot = await this.getSpaceRootPattern();
      const addPiece = spaceRoot.cell().key("addPiece" as any);
      await (addPiece as any).send({ piece: cell });
      await spaceRoot.cell().sync();
    } catch (e) {
      console.error(
        "[RuntimeInternals] Failed to register navigated piece:",
        e,
      );
    }
  }

  async #waitForNavigationConvergence(): Promise<void> {
    this.#check();
    await this.#client.idle();
    await this.#client.synced();
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

    const sameSpace = cell.space() === this.#space;

    if (sameSpace) {
      void this.registerNavigatedPiece(cell);
    }
    await this.#waitForNavigationConvergence();

    if (sameSpace && this.#spaceName) {
      (this.#callbacks.navigate ?? defaultNavigate)({
        spaceName: this.#spaceName,
        pieceId,
      });
    } else {
      (this.#callbacks.navigate ?? defaultNavigate)({
        spaceDid: cell.space(),
        pieceId: cell.id(),
      });
    }
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
  };

  #check() {
    if (this.#disposed) {
      throw new Error("RuntimeInternals disposed.");
    }
  }

  static async create({
    identity,
    view,
    apiUrl,
    spaceHostMap,
    experimental,
    cfcEnforcementMode,
    trustSnapshot,
    compilationCacheClient = false,
    getBuildHash = fetchBuildHash,
    workerUrl,
    navigate,
    onConsole,
    onError,
  }: RuntimeInternalsCreateOptions): Promise<RuntimeInternals> {
    let session: Session | undefined;
    let isHomeSpace = false;

    if ("builtin" in view) {
      switch (view.builtin) {
        case "home":
          session = await createSession({
            identity,
            spaceDid: identity.did(),
          });
          session.spaceName = "<home>";
          isHomeSpace = true;
          break;
      }
    } else if ("spaceName" in view) {
      session = await createSession({
        identity,
        spaceName: view.spaceName,
      });
    } else if ("spaceDid" in view) {
      session = await createSession({
        identity,
        spaceDid: view.spaceDid,
      });
    }

    if (!session) {
      throw new Error(`Invalid view: ${view}`);
    }

    // Log user identity for debugging
    identityLogger.log(
      "identity",
      `[Identity] User DID: ${identity.did()}`,
    );
    identityLogger.log(
      "identity",
      `[Identity] Space: ${session.spaceName ?? "<unknown>"} (${
        session.space ?? "by name"
      })`,
    );

    // Fetch the build manifest first so the worker URL and compilation-cache
    // fingerprint both point at the same worker bundle.
    // See docs/specs/compilation-cache.md Phase 3.
    const buildHash = compilationCacheClient ? await getBuildHash() : undefined;
    const resolvedWorkerUrl = workerUrl ?? new URL(
      "/scripts/worker-runtime.js",
      globalThis.location.origin,
    );
    if (buildHash) resolvedWorkerUrl.searchParams.set("v", buildHash);
    const transport = await WebWorkerRuntimeTransport.connect({
      workerUrl: resolvedWorkerUrl,
    });
    if (compilationCacheClient) {
      console.log(
        buildHash
          ? `Compilation cache enabled (client), buildHash=${
            buildHash.substring(0, 8)
          }`
          : "Compilation cache disabled (client): no build manifest",
      );
    } else {
      console.log(
        "Compilation cache disabled (client): COMPILATION_CACHE_CLIENT not set",
      );
    }
    const client = await RuntimeClient.initialize(
      transport,
      createRuntimeClientOptions({
        session,
        apiUrl,
        spaceHostMap,
        buildHash,
        experimental,
        cfcEnforcementMode,
        trustSnapshot,
      }),
    );

    // Expose a usable RuntimeInternals immediately. Callers that need
    // storage/piece-manager convergence should await `rt.synced()` explicitly.
    return new RuntimeInternals(
      client,
      session.space,
      session.spaceName,
      isHomeSpace,
      identity.did(), // homeSpaceDID is always identity.did()
      { navigate, onConsole, onError },
    );
  }
}
