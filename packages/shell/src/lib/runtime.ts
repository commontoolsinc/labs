import { createSession, Identity } from "@commontools/identity";
import {
  Runtime,
  RuntimeTelemetry,
  RuntimeTelemetryEvent,
  RuntimeTelemetryMarkerResult,
} from "@commontools/runner";
import { charmId, CharmManager } from "@commontools/charm";
import { CharmsController } from "@commontools/charm/ops";
import { StorageManager } from "@commontools/runner/storage/cache";
import { navigate } from "./navigate.ts";
import * as Inspector from "@commontools/runner/storage/inspector";
import { setupIframe } from "./iframe-ctx.ts";
import { getLogger } from "@commontools/utils/logger";
import { AppView } from "./app/view.ts";

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

  private constructor(
    cc: CharmsController,
    telemetry: RuntimeTelemetry,
    space: string,
  ) {
    super();
    this.#cc = cc;
    this.#space = space;
    const runtimeId = this.#cc.manager().runtime.id;
    this.#inspector = new Inspector.Channel(
      runtimeId,
      this.#onInspectorUpdate,
    );
    this.#telemetry = telemetry;
    this.#telemetry.addEventListener("telemetry", this.#onTelemetry);
    this.#telemetryMarkers = [];
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
    if ("builtin" in view) {
      switch (view.builtin) {
        case "home":
          session = await createSession({ identity, spaceDid: identity.did() });
          spaceName = "<home>";
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
      consoleHandler: (metadata, method, args) => {
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

        // NOTE(jake): Eventually, once we're doing multi-space navigation, we
        // will need to replace this charmManager.getSpaceName() with a call to
        // some sort of address book / dns-style server, OR just navigate to the
        // DID.

        // Get the space name for navigation until we support
        // DID spaces from the shell.
        const spaceName = charmManager.getSpaceName();

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

          if (!spaceName) {
            throw new Error(
              "Does not yet support navigating to a charm within a space loaded by DID.",
            );
          }
          // Use the human-readable space name from CharmManager instead of DID
          navigate({
            spaceName,
            charmId: id,
          });
        }).catch((err) => {
          console.error("[navigateCallback] Error during storage sync:", err);

          if (spaceName) {
            navigate({
              spaceName,
              charmId: id,
            });
          }
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
    return new RuntimeInternals(cc, telemetry, session.space);
  }
}
