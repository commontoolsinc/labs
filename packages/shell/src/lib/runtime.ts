import { ANYONE, Identity, Session } from "@commontools/identity";
import { Runtime } from "@commontools/runner";
import { CharmManager } from "@commontools/charm";
import { StorageManager } from "@commontools/runner/storage/cache";

async function createSession(
  root: Identity,
  spaceName: string,
): Promise<Session> {
  const account = spaceName.startsWith("~")
    ? root
    : await Identity.fromPassphrase(ANYONE);
  const user = await account.derive(spaceName);
  return {
    private: account.did() === root.did(),
    name: spaceName,
    space: user.did(),
    as: user,
  };
}

export async function createCharmManager(
  { identity, spaceName, apiUrl }: {
    identity: Identity;
    spaceName: string;
    apiUrl: URL;
  },
): Promise<CharmManager> {
  const session = await createSession(identity, spaceName);
  const url = apiUrl.toString();
  const runtime = new Runtime({
    storageManager: StorageManager.open({
      as: session.as,
      address: new URL("/api/storage/memory", url),
    }),
    blobbyServerUrl: url,
  });
  const charmManager = new CharmManager(session, runtime);
  await charmManager.synced();
  return charmManager;
}
