import { createSession, DID, Identity, Session } from "@commontools/identity";
import { NameSchema } from "@commontools/runner/schemas";
import {
  CellHandle,
  FavoritesManager,
  JSONValue,
  PageHandle,
  Program,
  RuntimeClient,
  RuntimeClientEvents,
  RuntimeTelemetryMarkerResult,
} from "@commontools/runtime-client";
import { WebWorkerRuntimeTransport } from "@commontools/runtime-client/transports/web-worker";
import { getLogger } from "@commontools/utils/logger";
import { AppView, navigate } from "../../shared/mod.ts";

const logger = getLogger("shell.runtime", {
  enabled: false,
  level: "debug",
});

const identityLogger = getLogger("shell.identity", {
  enabled: true,
  level: "debug",
});

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
  #spaceRootPattern?: Promise<PageHandle<NameSchema>>;
  #patternCache: Map<string, Promise<PageHandle<NameSchema>>> = new Map();
  // TODO(runtime-worker-refactor)
  #telemetryMarkers: RuntimeTelemetryMarkerResult[] = [];

  private constructor(
    client: RuntimeClient,
    space: DID,
    spaceName: string | undefined,
    isHomeSpace: boolean,
    homeSpaceDID: DID,
  ) {
    super();
    this.#client = client;
    this.#space = space;
    this.#spaceName = spaceName;
    this.#isHomeSpace = isHomeSpace;
    this.#homeSpaceDID = homeSpaceDID;
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

  async removePage(id: string): Promise<boolean> {
    return await this.#client.removePage(id);
  }

  async synced(): Promise<void> {
    this.#check();
    await this.#client.synced();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#client.dispose();
  }

  #onConsole = (e: RuntimeClientEvents["console"][0]) => {
    const { metadata, method, args } = e;
    if (metadata?.pieceId) {
      console.log(`Piece(${metadata.pieceId}) [${method}]:`, ...args);
    } else {
      console.log(`Console [${method}]:`, ...args);
    }
  };

  #onNavigateRequest = (e: RuntimeClientEvents["navigaterequest"][0]) => {
    const { cell } = e;
    const pieceId = cell.id();
    logger.log("navigate", `Navigating to piece: ${pieceId}`);

    if (cell.space() === this.#space && this.#spaceName) {
      navigate({
        spaceName: this.#spaceName,
        pieceId,
      });
    } else {
      navigate({ spaceDid: cell.space(), pieceId: cell.id() });
    }
  };

  #onError = (event: RuntimeClientEvents["error"][0]) => {
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
  }: {
    identity: Identity;
    view: AppView;
    apiUrl: URL;
  }): Promise<RuntimeInternals> {
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

    // Fetch server config (includes experimental flags)
    let experimental: {
      richStorableValues?: boolean;
      storableProtocol?: boolean;
      unifiedJsonEncoding?: boolean;
    } | undefined;
    try {
      const metaResponse = await fetch(new URL("/api/meta", apiUrl));
      const meta = await metaResponse.json();
      experimental = meta.experimental;
    } catch (e) {
      console.warn("Failed to fetch /api/meta for experimental flags:", e);
    }

    // Worker script is bundled with shell assets, so load from shell origin
    // (not apiUrl which points to the backend/router)
    const transport = await WebWorkerRuntimeTransport.connect({
      workerUrl: new URL(
        "/scripts/worker-runtime.js",
        globalThis.location.origin,
      ),
    });
    const client = await RuntimeClient.initialize(transport, {
      apiUrl,
      identity: session.as,
      spaceIdentity: session.spaceIdentity,
      spaceDid: session.space,
      spaceName: session.spaceName,
      experimental,
    });

    // Wait for PieceManager to sync
    await client.synced();

    return new RuntimeInternals(
      client,
      session.space,
      session.spaceName,
      isHomeSpace,
      identity.did(), // homeSpaceDID is always identity.did()
    );
  }
}
