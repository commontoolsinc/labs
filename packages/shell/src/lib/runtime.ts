import { createSession, DID, Identity, Session } from "@commontools/identity";
import { NameSchema } from "@commontools/runner/schemas";
import {
  CellHandle,
  RuntimeClient,
  RuntimeClientConsoleEvent,
  RuntimeClientErrorEvent,
  RuntimeClientNavigateEvent,
  RuntimeTelemetryMarkerResult,
} from "@commontools/runtime-client";
import { getLogger } from "@commontools/utils/logger";
import { AppView, navigate } from "../../shared/mod.ts";
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
 * Wrapper around a charm cell from RuntimeClient.
 * Provides a similar interface to CharmController for compatibility.
 */
export class CharmHandle<T = unknown> {
  readonly id: string;
  readonly cell: CellHandle<T>;

  constructor(cell: CellHandle<T>) {
    this.cell = cell;
    this.id = cell.id();
  }

  getCell(): CellHandle<T> {
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
 * Uses RuntimeClient to run the Runtime in a web worker.
 */
export class RuntimeInternals extends EventTarget {
  #worker: RuntimeClient;
  #disposed = false;
  #space: DID;
  #spaceName?: string;
  #isHomeSpace: boolean;
  #spaceRootPattern?: Promise<CharmHandle<NameSchema>>;
  #patternCache: Map<string, Promise<CharmHandle<NameSchema>>> = new Map();
  // TODO(runtime-worker-refactor)
  #telemetryMarkers: RuntimeTelemetryMarkerResult[] = [];

  private constructor(
    worker: RuntimeClient,
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
   * Get the RuntimeClient instance.
   */
  runtime(): RuntimeClient {
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
    const res = await this.#worker.createCharmFromUrl<T>(entryUrl, options);
    if (!res) {
      throw new Error("Could not create charm");
    }
    return new CharmHandle(res.cell);
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
  getCharmsListCell<T>(): Promise<CellHandle<T[]>> {
    this.#check();
    return this.#worker.getCharmsListCell<T>();
  }

  /**
   * Get the space root pattern, creating it if needed.
   */
  getSpaceRootPattern(): Promise<CharmHandle<NameSchema>> {
    this.#check();
    if (this.#spaceRootPattern) return this.#spaceRootPattern;
    this.#spaceRootPattern = this.#worker.getSpaceRootPattern().then((ref) =>
      new CharmHandle<NameSchema>(ref.cell)
    );
    return this.#spaceRootPattern;
  }

  getPattern(id: string): Promise<CharmHandle<NameSchema>> {
    this.#check();

    const cached = this.#patternCache.get(id);
    if (cached) {
      return cached;
    }

    const promise = (async () => {
      const result = await this.#worker.getCharm<NameSchema>(id, true);
      if (!result) {
        throw new Error(`Pattern not found: ${id}`);
      }
      return new CharmHandle<NameSchema>(result.cell);
    })();
    this.#patternCache.set(id, promise);
    return promise;
  }

  async idle(): Promise<void> {
    this.#check();
    await this.#worker.idle();
  }

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
    const e = event as RuntimeClientConsoleEvent;
    const { metadata, method, args } = e.detail;
    if (metadata?.charmId) {
      console.log(`Charm(${metadata.charmId}) [${method}]:`, ...args);
    } else {
      console.log(`Console [${method}]:`, ...args);
    }
  };

  #onNavigate = (event: Event) => {
    const e = event as RuntimeClientNavigateEvent;
    const { target } = e.detail;
    const charmId = target.id();
    logger.log("navigate", `Navigating to charm: ${charmId}`);
    if (target.space() === this.#space && this.#spaceName) {
      navigate({
        spaceName: this.#spaceName,
        charmId,
      });
    } else {
      navigate({ spaceDid: target.space(), charmId: target.id() });
    }
  };

  #onError = (event: Event) => {
    const e = event as RuntimeClientErrorEvent;
    console.error("[RuntimeClient Error]", e.detail);
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

    // Create RuntimeClient
    const worker = new RuntimeClient({
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
