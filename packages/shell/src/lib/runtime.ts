import { createSession, DID, Identity, Session } from "@commontools/identity";
import { RuntimeTelemetryMarkerResult } from "@commontools/runner";
import { NameSchema } from "@commontools/charm";
import {
  RemoteCell,
  RuntimeWorker,
  RuntimeWorkerConsoleEvent,
  RuntimeWorkerErrorEvent,
  RuntimeWorkerNavigateEvent,
} from "@commontools/runner/worker";
import { navigate } from "./navigate.ts";
import { getLogger } from "@commontools/utils/logger";
import { AppView } from "./app/view.ts";
import { API_URL } from "./env.ts";

const logger = getLogger("shell.runtime", {
  enabled: false,
  level: "debug",
});

const identityLogger = getLogger("shell.identity", {
  enabled: true,
  level: "debug",
});

/**
 * Wrapper around a charm cell from RuntimeWorker.
 * Provides a similar interface to CharmController for compatibility.
 */
export class CharmHandle<T = unknown> {
  readonly id: string;
  readonly cell: RemoteCell<T>;

  constructor(id: string, cell: RemoteCell<T>) {
    this.id = id;
    this.cell = cell;
  }

  getCell(): RemoteCell<T> {
    return this.cell;
  }

  /**
   * Get the charm's name from its cell data.
   * Returns undefined if the name field is not set.
   */
  name(): string | undefined {
    try {
      const data = this.cell.get() as Record<string, unknown> | undefined;
      if (data && typeof data === "object" && "$NAME" in data) {
        return data.$NAME as string;
      }
    } catch {
      // Cell not synced yet
    }
    return undefined;
  }
}

/**
 * RuntimeInternals bundles all resources bound to an identity/host/space triplet.
 * Uses RuntimeWorker to run the Runtime in a web worker.
 */
export class RuntimeInternals extends EventTarget {
  #worker: RuntimeWorker;
  #disposed = false;
  #space: DID;
  #spaceName?: string;
  #isHomeSpace: boolean;
  #spaceRootPatternId?: string;
  #patternCache: Map<string, CharmHandle<NameSchema>> = new Map();
  #telemetryMarkers: RuntimeTelemetryMarkerResult[] = [];

  private constructor(
    worker: RuntimeWorker,
    space: DID,
    spaceName: string | undefined,
    isHomeSpace: boolean,
  ) {
    super();
    this.#worker = worker;
    this.#space = space;
    this.#spaceName = spaceName;
    this.#isHomeSpace = isHomeSpace;

    // Forward worker events
    this.#worker.addEventListener("console", this.#onConsole);
    this.#worker.addEventListener("navigate", this.#onNavigate);
    this.#worker.addEventListener("error", this.#onError);
  }

  /**
   * Get the RuntimeWorker instance.
   */
  runtime(): RuntimeWorker {
    return this.#worker;
  }

  /**
   * Get telemetry markers.
   * Note: Telemetry is currently not collected in worker mode.
   */
  telemetry(): RuntimeTelemetryMarkerResult[] {
    return this.#telemetryMarkers;
  }

  /**
   * Get the space DID.
   */
  space(): DID {
    return this.#space;
  }

  /**
   * Get the space name if available.
   */
  spaceName(): string | undefined {
    return this.#spaceName;
  }

  /**
   * Check if this is the home space.
   */
  isHomeSpace(): boolean {
    return this.#isHomeSpace;
  }

  /**
   * Create a new charm from a program.
   */
  async createCharm<T>(
    entryUrl: URL,
    options?: { argument?: unknown; run?: boolean },
  ): Promise<CharmHandle<T>> {
    this.#check();
    const result = await this.#worker.createCharmFromUrl<T>(entryUrl, options);
    return new CharmHandle(result.id, result.cell);
  }

  /**
   * Get a charm by ID.
   */
  async getCharm<T>(
    charmId: string,
    runIt?: boolean,
  ): Promise<CharmHandle<T> | null> {
    this.#check();
    const result = await this.#worker.getCharm<T>(charmId, runIt);
    if (!result) return null;
    return new CharmHandle(result.id, result.cell);
  }

  /**
   * Remove a charm.
   */
  async removeCharm(charmId: string): Promise<void> {
    this.#check();
    await this.#worker.removeCharm(charmId);
  }

  /**
   * Start a charm.
   */
  async startCharm(charmId: string): Promise<void> {
    this.#check();
    await this.#worker.startCharm(charmId);
  }

  /**
   * Stop a charm.
   */
  async stopCharm(charmId: string): Promise<void> {
    this.#check();
    await this.#worker.stopCharm(charmId);
  }

  /**
   * Get the charms list cell for reactive updates.
   */
  getCharmsListCell<T>(): Promise<RemoteCell<T[]>> {
    this.#check();
    return this.#worker.getCharmsListCell<T>();
  }

  /**
   * Get the space root pattern, creating it if needed.
   */
  async getSpaceRootPattern(): Promise<CharmHandle<NameSchema>> {
    this.#check();
    if (this.#spaceRootPatternId) {
      return this.getPattern(this.#spaceRootPatternId);
    }

    // Import pattern factory dynamically to avoid circular deps
    const PatternFactory = await import("./pattern-factory.ts");
    const pattern = await PatternFactory.getOrCreateWorker(
      this.#worker,
      this.#isHomeSpace ? "home" : "space-root",
    );
    this.#spaceRootPatternId = pattern.id;
    this.#patternCache.set(pattern.id, pattern);
    return pattern;
  }

  /**
   * Get a pattern by ID.
   */
  async getPattern(id: string): Promise<CharmHandle<NameSchema>> {
    this.#check();

    const cached = this.#patternCache.get(id);
    if (cached) {
      return cached;
    }

    const result = await this.#worker.getCharm<NameSchema>(id, true);
    if (!result) {
      throw new Error(`Pattern not found: ${id}`);
    }

    const handle = new CharmHandle<NameSchema>(result.id, result.cell);
    this.#patternCache.set(id, handle);
    return handle;
  }

  /**
   * Wait for pending operations to complete.
   */
  async idle(): Promise<void> {
    this.#check();
    await this.#worker.idle();
  }

  /**
   * Wait for storage to be synced.
   */
  async synced(): Promise<void> {
    this.#check();
    await this.#worker.synced();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#worker.removeEventListener("console", this.#onConsole);
    this.#worker.removeEventListener("navigate", this.#onNavigate);
    this.#worker.removeEventListener("error", this.#onError);
    await this.#worker.dispose();
  }

  #onConsole = (event: Event) => {
    const e = event as RuntimeWorkerConsoleEvent;
    const { metadata, method, args } = e.detail;
    if (metadata?.charmId) {
      console.log(`Charm(${metadata.charmId}) [${method}]:`, ...args);
    } else {
      console.log(`Console [${method}]:`, ...args);
    }
  };

  #onNavigate = (event: Event) => {
    const e = event as RuntimeWorkerNavigateEvent;
    const { target } = e.detail;

    // Get charm ID from the target cell
    // The target is a RemoteCell, we need to extract the ID from its link
    const link = target.getAsLink();
    const linkData = link["/"];
    if (!linkData || !("link@1" in linkData)) {
      console.error("Invalid navigation target - not a valid link");
      return;
    }

    const id = (linkData as { "link@1": { id: string } })["link@1"].id;
    if (!id) {
      console.error("Could not get charm ID from navigation target");
      return;
    }

    // Extract just the charm ID from the entity URI
    const charmIdMatch = id.match(/^[^/]+/);
    const targetCharmId = charmIdMatch ? charmIdMatch[0] : id;

    logger.log("navigate", `Navigating to charm: ${targetCharmId}`);

    if (this.#spaceName) {
      navigate({
        spaceName: this.#spaceName,
        charmId: id,
      });
    } else {
      navigate({ spaceDid: this.#space as DID, charmId: id });
    }
  };

  #onError = (event: Event) => {
    const e = event as RuntimeWorkerErrorEvent;
    console.error("[RuntimeWorker Error]", e.detail);
  };

  #check() {
    if (this.#disposed) {
      throw new Error("RuntimeInternals disposed.");
    }
  }

  /**
   * Create a new RuntimeInternals instance.
   */
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

    // Create RuntimeWorker
    const worker = new RuntimeWorker({
      apiUrl,
      identity: session.as,
      spaceIdentity: session.spaceIdentity,
      spaceDid: session.space,
      spaceName: session.spaceName,
      workerUrl: new URL("./scripts/worker-runtime.js", API_URL),
    });

    // Wait for CharmManager to sync
    await worker.synced();

    return new RuntimeInternals(
      worker,
      session.space,
      session.spaceName,
      isHomeSpace,
    );
  }
}
