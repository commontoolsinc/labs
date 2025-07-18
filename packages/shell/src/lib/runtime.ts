import { ANYONE, Identity, Session } from "@commontools/identity";
import { Runtime } from "@commontools/runner";
import { charmId, CharmManager } from "@commontools/charm";
import { CharmsController } from "@commontools/charm/ops";
import { StorageManager } from "@commontools/runner/storage/cache";
import { API_URL } from "./env.ts";
import { navigateToCharm } from "./navigate.ts";

async function createSession(
  root: Identity,
  spaceName: string,
): Promise<Session> {
  console.log("[createSession] Creating session for space:", spaceName);
  console.log("[createSession] Root identity DID:", root.did());

  const account = spaceName.startsWith("~")
    ? root
    : await Identity.fromPassphrase(ANYONE);

  console.log("[createSession] Account selection:", {
    accountDid: account.did(),
    isPrivateSpace: spaceName.startsWith("~"),
    explanation: spaceName.startsWith("~")
      ? "Using user's root identity for private space"
      : "Using ANYONE identity for public/shared space",
  });

  const user = await account.derive(spaceName);
  const session = {
    private: account.did() === root.did(),
    name: spaceName,
    space: user.did(),
    as: user,
  };

  console.log("[createSession] Session created:", {
    private: session.private,
    name: session.name,
    spaceDid: session.space,
    sessionIdentity: session.as.did(),
    explanation: session.private
      ? "Using user's derived identity for private space"
      : "Using ANYONE-derived identity for public space",
  });

  return session;
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

  console.log("[createCharmsController] Creating CharmManager with session");
  charmManager = new CharmManager(session, runtime);

  await charmManager.synced();
  console.log("[createCharmsController] Creating CharmsController");
  return new CharmsController(charmManager);
}
