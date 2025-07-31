import { ANYONE, Identity, Session } from "@commontools/identity";
import { Runtime } from "@commontools/runner";
import { charmId, CharmManager } from "@commontools/charm";
import { CharmsController } from "@commontools/charm/ops";
import { StorageManager } from "@commontools/runner/storage/cache";
import { API_URL } from "./env.ts";
import { navigateToCharm } from "./navigate.ts";
import * as Inspector from "@commontools/runner/storage/inspector";
import { InspectorState, InspectorUpdateEvent } from "./inspector.ts";

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
  #inspector: Inspector.Channel;
  #inspectorState = new InspectorState();
  #disposed = false;

  private constructor(cc: CharmsController) {
    super();
    this.#cc = cc;
    const runtimeId = this.#cc.manager().runtime.id;
    this.#inspector = new Inspector.Channel(
      runtimeId,
      this.#onInspectorUpdate,
    );
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
    this.dispatchEvent(new InspectorUpdateEvent(this.#inspectorState));
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
        runtime.storage.synced().then(() => {
          // Use the human-readable space name from CharmManager instead of DID
          navigateToCharm(charmManager.getSpaceName(), id);
        });
      },
    });

    charmManager = new CharmManager(session, runtime);
    await charmManager.synced();
    const cc = new CharmsController(charmManager);
    return new RuntimeInternals(cc);
  }
}

export async function createCharmsController(
  { identity, spaceName, apiUrl }: {
    identity: Identity;
    spaceName: string;
    apiUrl: URL;
  },
): Promise<CharmsController> {
  console.log("[createCharmsController] Starting with:", {
    identityDid: identity.did(),
    spaceName,
    apiUrl: apiUrl.toString(),
  });

  const session = await createSession(identity, spaceName);
  const url = apiUrl.toString();

  console.log("[createCharmsController] Creating Runtime with:", {
    storageUrl: new URL("/api/storage/memory", url).toString(),
    blobbyServerUrl: url,
    sessionIdentity: session.as.did(),
    sessionSpace: session.space,
    isPrivateSpace: session.private,
  });

  const staticAssetUrl = new URL(API_URL);
  staticAssetUrl.pathname = "/static";

  // We're hoisting CharmManager so that
  // we can create it after the runtime, but still reference
  // its `getSpaceName` method in a runtime callback.
  // deno-lint-ignore prefer-const
  let charmManager: CharmManager;

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

      // NOTE(jake): Eventually, once we're doing multi-space navigation, we will
      // need to replace this charmManager.getSpaceName() with a call to some
      // sort of address book / dns-style server, OR just navigate to the DID.

      // Use the human-readable space name from CharmManager instead of the DID
      navigateToCharm(charmManager.getSpaceName(), id);
    },
  });

  charmManager = new CharmManager(session, runtime);
  await charmManager.synced();
  return new CharmsController(charmManager);
}
