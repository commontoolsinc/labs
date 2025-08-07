import { ANYONE, Identity, Session } from "@commontools/identity";
import {
  Runtime,
  RuntimeTelemetry,
  RuntimeTelemetryEvent,
  RuntimeTelemetryMarkerResult,
} from "@commontools/runner";
import { charmId, CharmManager } from "@commontools/charm";
import { CharmsController } from "@commontools/charm/ops";
import { StorageManager } from "@commontools/runner/storage/cache";
import { API_URL } from "./env.ts";
import { navigate } from "./navigate.ts";
import * as Inspector from "@commontools/runner/storage/inspector";
import {
  StorageInspectorState,
  StorageInspectorUpdateEvent,
} from "./storage-inspector.ts";
import { setupIframe } from "./iframe-ctx.ts";
import { getLogger } from "@commontools/utils/logger";

const logger = getLogger("shell.telemetry", {
  enabled: false,
  level: "debug",
});

async function createSession(
  root: Identity,
  spaceName: string,
): Promise<Session> {
  const account = spaceName.startsWith("~")
    ? root
    : await Identity.fromPassphrase(ANYONE);

  const user = await account.derive(spaceName);
  const session = {
    private: account.did() === root.did(),
    name: spaceName,
    space: user.did(),
    as: user,
  };

  return session;
}

// RuntimeInternals bundles all of the lifetimes
// of resources bound to an identity,host,space triplet,
// containing runtime, inspector, and charm references.
export class RuntimeInternals extends EventTarget {
  #cc: CharmsController;
  #telemetry: RuntimeTelemetry;
  #telemetryMarkers: RuntimeTelemetryMarkerResult[];
  #inspector: Inspector.Channel;
  #inspectorState: StorageInspectorState;
  #disposed = false;

  private constructor(cc: CharmsController, telemetry: RuntimeTelemetry) {
    super();
    this.#cc = cc;
    const runtimeId = this.#cc.manager().runtime.id;
    this.#inspector = new Inspector.Channel(
      runtimeId,
      this.#onInspectorUpdate,
    );
    this.#telemetry = telemetry;
    this.#telemetry.addEventListener("telemetry", this.#onTelemetry);
    this.#telemetryMarkers = [];
    // Initialize StorageInspectorState with telemetry integration
    this.#inspectorState = new StorageInspectorState(Date.now(), telemetry);
  }

  telemetry(): RuntimeTelemetryMarkerResult[] {
    return this.#telemetryMarkers;
  }

  cc(): CharmsController {
    return this.#cc;
  }

  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#inspector.close();
    await this.#cc.dispose();
  }

  #onInspectorUpdate = (command: Inspector.BroadcastCommand) => {
    this.#check();
    this.#inspectorState.update(command);
    this.dispatchEvent(new StorageInspectorUpdateEvent(this.#inspectorState));
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
    { identity, spaceName, apiUrl }: {
      identity: Identity;
      spaceName: string;
      apiUrl: URL;
    },
  ): Promise<RuntimeInternals> {
    const session = await createSession(identity, spaceName);
    const url = apiUrl.toString();

    const staticAssetUrl = new URL(API_URL);
    staticAssetUrl.pathname = "/static";

    // We're hoisting CharmManager so that
    // we can create it after the runtime, but still reference
    // its `getSpaceName` method in a runtime callback.
    // deno-lint-ignore prefer-const
    let charmManager: CharmManager;

    const telemetry = new RuntimeTelemetry();
    const runtime = new Runtime({
      storageManager: StorageManager.open({
        as: session.as,
        address: new URL("/api/storage/memory", url),
      }),
      blobbyServerUrl: url,
      staticAssetServerUrl: staticAssetUrl,
      errorHandlers: [(error) => {
        console.error(error);
        //Sentry.captureException(error);
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

        // Await storage being synced, at least for now, as the page fully
        // reloads. Once we have in-page navigation with reloading, we don't
        // need this anymore
        runtime.storage.synced().then(async () => {
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

          // Use the human-readable space name from CharmManager instead of DID
          navigate({
            type: "charm",
            spaceName: charmManager.getSpaceName(),
            charmId: id,
          });
        }).catch((err) => {
          console.error("[navigateCallback] Error during storage sync:", err);

          navigate({
            type: "charm",
            spaceName: charmManager.getSpaceName(),
            charmId: id,
          });
        });
      },
    });

    // Set up iframe context handler
    setupIframe(runtime);

    charmManager = new CharmManager(session, runtime);
    await charmManager.synced();
    const cc = new CharmsController(charmManager);
    return new RuntimeInternals(cc, telemetry);
  }
}
