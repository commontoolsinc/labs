import { ANYONE, Identity, Session } from "@commontools/identity";
import { Runtime } from "@commontools/runner";
import { CharmManager } from "@commontools/charm";
import { CharmsController } from "@commontools/charm/ops";
import { StorageManager } from "@commontools/runner/storage/cache";
import { API_URL } from "./env.ts";

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
  const runtime = new Runtime({
    storageManager: StorageManager.open({
      as: session.as,
      address: new URL("/api/storage/memory", url),
    }),
    blobbyServerUrl: url,
    staticAssetServerUrl: staticAssetUrl,
  });
  console.log("[createCharmsController] Creating CharmManager with session");
  const charmManager = new CharmManager(session, runtime);
  await charmManager.synced();
  console.log("[createCharmsController] Creating CharmsController");
  return new CharmsController(charmManager);
}
