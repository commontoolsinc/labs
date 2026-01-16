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

  async createCharm<T>(
    source: URL | Program | string,
    options?: { argument?: JSONValue; run?: boolean },
  ): Promise<PageHandle<T>> {
    this.#check();
    const page = await this.#client.createPage<T>(source, options);
    if (!page) {
      throw new Error("Could not create charm");
    }
    return page;
  }

  getCharmsListCell<T>(): Promise<CellHandle<T[]>> {
    this.#check();
    return this.#client.getCharmsListCell<T>();
  }

  getSpaceRootPattern(): Promise<PageHandle<NameSchema>> {
    this.#check();
    if (this.#spaceRootPattern) return this.#spaceRootPattern;
    this.#spaceRootPattern = this.#client.getSpaceRootPattern();
    return this.#spaceRootPattern;
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
    if (metadata?.charmId) {
      console.log(`Charm(${metadata.charmId}) [${method}]:`, ...args);
    } else {
      console.log(`Console [${method}]:`, ...args);
    }
  };

  #onNavigateRequest = (e: RuntimeClientEvents["navigaterequest"][0]) => {
    const { cell } = e;
    const charmId = cell.id();
    logger.log("navigate", `Navigating to charm: ${charmId}`);

    // Add charm to allCharms list if in the same space (best-effort, async)
    if (cell.space() === this.#space) {
      this.#ensureCharmInList(cell).catch((err) => {
        logger.warn("add-charm-failed", `Failed to add charm to list: ${err}`);
      });
    }

    if (cell.space() === this.#space && this.#spaceName) {
      navigate({
        spaceName: this.#spaceName,
        charmId,
      });
    } else {
      navigate({ spaceDid: cell.space(), charmId: cell.id() });
    }
  };

  /**
   * Ensure a charm is in the allCharms list. If not present, add it via the
   * default pattern's addCharm handler.
   */
  async #ensureCharmInList(charmCell: CellHandle): Promise<void> {
    try {
      const rootPattern = await this.getSpaceRootPattern();
      const patternCell = rootPattern.cell();

      // Don't add the default pattern to its own allCharms list
      if (charmCell.id() === patternCell.id()) {
        return;
      }

      // Get the allCharms list to check if charm is already present
      const allCharmsCell = patternCell.asSchema<{ allCharms: CellHandle[] }>({
        type: "object",
        properties: {
          allCharms: { type: "array" },
        },
      }).key("allCharms");

      await allCharmsCell.sync();
      const allCharms = allCharmsCell.get() ?? [];

      // Check if charm is already in the list
      const charmId = charmCell.id();
      const exists = allCharms.some((c) => c.id() === charmId);
      if (exists) {
        return;
      }

      // Add via the addCharm handler
      const addCharmHandler = patternCell.asSchema<{
        addCharm: unknown;
      }>({
        type: "object",
        properties: {
          addCharm: { asStream: true },
        },
      }).key("addCharm");

      await addCharmHandler.send({ charm: charmCell } as unknown);
      logger.log("add-charm", `Added charm ${charmId} to allCharms list`);
    } catch (err) {
      // Non-fatal: charm navigation still works even if we can't add to list
      logger.warn(
        "add-charm-error",
        `Could not add charm to list: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

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
    });

    // Wait for CharmManager to sync
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
