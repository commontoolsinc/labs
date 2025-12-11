import { createSession, DID, Identity } from "@commontools/identity";
import {
  Runtime,
  RuntimeTelemetry,
  RuntimeTelemetryEvent,
  RuntimeTelemetryMarkerResult,
} from "@commontools/runner";
import {
  charmId,
  CharmManager,
  NameSchema,
  nameSchema,
} from "@commontools/charm";
import { CharmController, CharmsController } from "@commontools/charm/ops";
import { StorageManager } from "@commontools/runner/storage/cache";
import { navigate } from "./navigate.ts";
import * as Inspector from "@commontools/runner/storage/inspector";
import { setupIframe } from "./iframe-ctx.ts";
import { getLogger } from "@commontools/utils/logger";
import { AppView } from "./app/view.ts";
import * as PatternFactory from "./pattern-factory.ts";

const logger = getLogger("shell.telemetry", {
  enabled: false,
  level: "debug",
});

const identityLogger = getLogger("shell.telemetry", {
  enabled: true,
  level: "debug",
});

// RuntimeInternals bundles all of the lifetimes
// of resources bound to an identity,host,space triplet,
// containing runtime, inspector, and charm references.
export class RuntimeInternals extends EventTarget {
  #cc: CharmsController;
  #telemetry: RuntimeTelemetry;
  #telemetryMarkers: RuntimeTelemetryMarkerResult[];
  #inspector: Inspector.Channel;
  #disposed = false;
  #space: string; // The MemorySpace DID
  #spaceRootPatternId?: string;
  #isHomeSpace: boolean;
  #patternCache: PatternCache;

  private constructor(
    cc: CharmsController,
    telemetry: RuntimeTelemetry,
    space: string,
    isHomeSpace: boolean,
  ) {
    super();
    this.#cc = cc;
    this.#space = space;
    this.#isHomeSpace = isHomeSpace;
    const runtimeId = this.#cc.manager().runtime.id;
    this.#inspector = new Inspector.Channel(
      runtimeId,
      this.#onInspectorUpdate,
    );
    this.#telemetry = telemetry;
    this.#telemetry.addEventListener("telemetry", this.#onTelemetry);
    this.#telemetryMarkers = [];
    this.#patternCache = new PatternCache(this.#cc);
  }

  telemetry(): RuntimeTelemetryMarkerResult[] {
    return this.#telemetryMarkers;
  }

  cc(): CharmsController {
    return this.#cc;
  }

  runtime(): Runtime {
    return this.#cc.manager().runtime;
  }

  space(): string {
    return this.#space;
  }

  // Returns the space root pattern, creating it if it doesn't exist.
  // The space root pattern type is determined at RuntimeInternals creation
  // based on the view type (home vs space).
  async getSpaceRootPattern(): Promise<CharmController<NameSchema>> {
    this.#check();
    if (this.#spaceRootPatternId) {
      return this.getPattern(this.#spaceRootPatternId);
    }
    const pattern = await PatternFactory.getOrCreate(
      this.#cc,
      this.#isHomeSpace ? "home" : "space-root",
    );
    this.#spaceRootPatternId = pattern.id;
    await this.#patternCache.add(pattern);
    return pattern;
  }

  async getPattern(id: string): Promise<CharmController<NameSchema>> {
    this.#check();
    const cached = await this.#patternCache.get(id);
    if (cached) {
      return cached;
    }

    const pattern = await this.#cc.get(id, true, nameSchema);
    await this.#patternCache.add(pattern);
    return pattern;
  }

  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#inspector.close();
    await this.#cc.dispose();
  }

  #onInspectorUpdate = (command: Inspector.BroadcastCommand) => {
    this.#check();
    this.#telemetry.processInspectorCommand(command);
  };

  #onTelemetry = (event: Event) => {
    this.#check();
    const marker = (event as RuntimeTelemetryEvent).marker;
    this.#telemetryMarkers.push(marker);
    // Dispatch an event here so that views may subscribe,
    // and know when to rerender, fetching the markers
    this.dispatchEvent(new CustomEvent("telemetryupdate"));
    logger.log(marker.type, marker);
  };

  #check() {
    if (this.#disposed) {
      throw new Error("RuntimeInternals disposed.");
    }
  }

  static async create(
    { identity, view, apiUrl }: {
      identity: Identity;
      view: AppView;
      apiUrl: URL;
    },
  ): Promise<RuntimeInternals> {
    let session;
    let spaceName;
    let isHomeSpace = false;
    if ("builtin" in view) {
      switch (view.builtin) {
        case "home":
          session = await createSession({ identity, spaceDid: identity.did() });
          spaceName = "<home>";
          isHomeSpace = true;
          break;
      }
    } else if ("spaceName" in view) {
      session = await createSession({ identity, spaceName: view.spaceName });
      spaceName = view.spaceName;
    } else if ("spaceDid" in view) {
      session = await createSession({ identity, spaceDid: view.spaceDid });
    }
    if (!session) {
      throw new Error("Unexpected view provided.");
    }

    // Log user identity for debugging and sharing
    identityLogger.log("telemetry", `[Identity] User DID: ${session.as.did()}`);
    identityLogger.log(
      "telemetry",
      `[Identity] Space: ${spaceName ?? "<unknown>"} (${session.space})`,
    );

    // We're hoisting CharmManager so that
    // we can create it after the runtime, but still reference
    // its `getSpaceName` method in a runtime callback.
    // deno-lint-ignore prefer-const
    let charmManager: CharmManager;

    const telemetry = new RuntimeTelemetry();
    const runtime = new Runtime({
      apiUrl: new URL(apiUrl),
      storageManager: StorageManager.open({
        as: session.as,
        spaceIdentity: session.spaceIdentity,
        address: new URL("/api/storage/memory", apiUrl),
      }),
      errorHandlers: [(error) => {
        console.error(error);
      }],
      telemetry,
      consoleHandler: ({ metadata, method, args }) => {
        // Handle console messages depending on charm context.
        // This is essentially the same as the default handling currently,
        // but adding this here for future use.
        if (metadata?.charmId) {
          return [`Charm(${metadata.charmId}) [${method}]:`, ...args];
        }
        return [`Console [${method}]:`, ...args];
      },
      navigateCallback: (target) => {
        const id = charmId(target);
        if (!id) {
          throw new Error(`Could not navigate to cell that is not a charm.`);
        }
        const navigateCallback = createNavCallback(
          session.space,
          charmManager.getSpaceName(),
        );

        // Await storage being synced, at least for now, as the page fully
        // reloads. Once we have in-page navigation with reloading, we don't
        // need this anymore
        runtime.storageManager.synced().then(async () => {
          // Check if the charm is already in the list
          const charms = charmManager.getCharms();
          const existingCharm = charms.get().find((charm) =>
            charmId(charm) === id
          );

          // If the charm doesn't exist in the list, add it
          if (!existingCharm) {
            // FIXME(jake): This feels, perhaps, like an incorrect mix of
            // concerns. If `navigateTo`
            // should be managing/updating the charms list cell, that should be
            // happening as part of the runtime built-in function, not up in
            // the shell layer...

            // Add target charm to the charm list
            await charmManager.add([target]);
          }

          navigateCallback(id);
        }).catch((err) => {
          console.error("[navigateCallback] Error during storage sync:", err);
          navigateCallback(id);
        });
      },
    });

    if (!(await runtime.healthCheck())) {
      const message =
        `Runtime failed health check: could not connect to "${apiUrl.toString()}".`;

      // Throw an error for good measure, but this is typically called
      // in a Lit task where the error is not displayed, so mostly
      // relying on console error here for DX.
      console.error(message);
      throw new Error(message);
    }

    // Set up iframe context handler
    setupIframe(runtime);

    charmManager = new CharmManager(session, runtime);
    await charmManager.synced();
    const cc = new CharmsController(charmManager);
    return new RuntimeInternals(
      cc,
      telemetry,
      session.space,
      isHomeSpace,
    );
  }
}

// Caches patterns, and updates recent charms data upon access.
class PatternCache {
  private cache: Map<string, CharmController<NameSchema>> = new Map();
  private cc: CharmsController;

  constructor(cc: CharmsController) {
    this.cc = cc;
  }

  async add(pattern: CharmController<NameSchema>) {
    this.cache.set(pattern.id, pattern);
    await this.cc.manager().trackRecentCharm(pattern.getCell());
  }

  async get(id: string): Promise<CharmController<NameSchema> | undefined> {
    const cached = this.cache.get(id);
    if (cached) {
      await this.cc.manager().trackRecentCharm(cached.getCell());
      return cached;
    }
  }
}

function createNavCallback(spaceDid: DID, spaceName?: string) {
  return (id: string) => {
    if (spaceName) {
      navigate({
        spaceName,
        charmId: id,
      });
    } else {
      navigate({ spaceDid, charmId: id });
    }
  };
}
