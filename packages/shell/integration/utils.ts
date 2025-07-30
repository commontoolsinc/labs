import { Page } from "@commontools/integration";
import { ANYONE, Identity, InsecureCryptoKeyPair } from "@commontools/identity";
import { AppState } from "../src/lib/app/mod.ts";
import { Runtime } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache";
import { CharmManager } from "@commontools/charm";
import { CharmsController } from "@commontools/charm/ops";

// Pass the key over the boundary. When the state is returned,
// the key is serialized to Uint8Arrays, and then turned into regular arrays,
// which can then by transferred across the astral boundary.
//
// The passed in identity must use the `noble` implementation, which
// contains raw private key material.
export async function login(page: Page, identity: Identity): Promise<AppState> {
  type TransferrableKeyPair = {
    privateKey: Array<number>;
    publicKey: Array<number>;
  };

  const serializedId = identity!.serialize() as InsecureCryptoKeyPair;
  const transferrableId = {
    privateKey: Array.from(serializedId.privateKey),
    publicKey: Array.from(serializedId.privateKey),
  };

  const state = await page!.evaluate<
    Promise<AppState>,
    [TransferrableKeyPair]
  >(
    async (rawId) => {
      // Convert transferrable key to a raw key of Uint8Array
      const keyPairRaw = {
        privateKey: Uint8Array.from(rawId.privateKey),
        publicKey: Uint8Array.from(rawId.publicKey),
      };
      await globalThis.app.setIdentity(keyPairRaw);
      const state = globalThis.app.state();
      state.identity = rawId as unknown as Identity;
      return state;
    },
    {
      args: [transferrableId],
    },
  );

  const privateKey = Uint8Array.from(
    (state.identity as unknown as TransferrableKeyPair)!
      .privateKey,
  );

  state.identity = await Identity.fromRaw(privateKey, {
    implementation: "noble",
  });
  return state;
}

// Create a new charm using `source` in the provided space.
// Returns the charm id upon success.
export async function registerCharm(
  { apiUrl, source, identity, spaceName }: {
    apiUrl: URL;
    source: string;
    identity: Identity;
    spaceName: string;
  },
): Promise<string> {
  const account = spaceName.startsWith("~")
    ? identity
    : await Identity.fromPassphrase(ANYONE);
  const user = await account.derive(spaceName);
  const session = {
    private: account.did() === identity.did(),
    name: spaceName,
    space: user.did(),
    as: user,
  };

  const runtime = new Runtime({
    storageManager: StorageManager.open({
      as: session.as,
      address: new URL("/api/storage/memory", apiUrl),
    }),
    blobbyServerUrl: apiUrl.toString(),
  });

  let charmId: string | undefined;
  try {
    const manager = new CharmManager(session, runtime);
    await manager.synced();
    const charms = new CharmsController(manager);
    const charm = await charms.create(source);
    charmId = charm.id;
  } finally {
    await runtime.dispose();
  }
  return charmId;
}
