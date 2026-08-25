import { GithubFabricTarget } from "@commonfabric/github-connector/fabric";
import { createSession, Identity, isDID } from "@commonfabric/identity";
import {
  experimentalOptionsFromEnv,
  type MemorySpace,
  Runtime,
  runtimePresets,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

export interface GithubFabricRuntime {
  runtime: Runtime;
  spaceDid: MemorySpace;
  target: GithubFabricTarget;
}

/** Open the authenticated remote Fabric runtime used by the GitHub host. */
export async function openGithubFabricRuntime(options: {
  apiUrl: string;
  identityPath: string;
  space: string;
  githubHost: string;
  githubAccount: string;
}): Promise<GithubFabricRuntime> {
  let apiUrl: URL;
  try {
    apiUrl = new URL(options.apiUrl);
  } catch (error) {
    throw new Error("Common Fabric API URL is not valid", { cause: error });
  }
  const identity = await Identity.fromPkcs8(
    await Deno.readFile(options.identityPath),
  );
  const session =
    await (isDID(options.space)
      ? createSession({ identity, spaceDid: options.space })
      : createSession({ identity, spaceName: options.space }));
  const storageManager = StorageManager.open({
    as: session.as,
    memoryHost: apiUrl,
    spaceIdentity: session.spaceIdentity,
  });
  const runtime = new Runtime(runtimePresets.remoteClient({
    apiUrl,
    storageManager,
    experimental: experimentalOptionsFromEnv((key) => Deno.env.get(key)),
    trustSnapshotProvider: () => ({
      id: `principal:${session.as.did()}`,
      actingPrincipal: session.as.did(),
    }),
  }));
  try {
    if (!(await runtime.healthCheck())) {
      throw new Error(`could not connect to ${apiUrl.origin}`);
    }
    const target = await GithubFabricTarget.open(
      { runtime, spaceDid: session.space },
      { host: options.githubHost, account: options.githubAccount },
    );
    return { runtime, spaceDid: session.space, target };
  } catch (error) {
    try {
      await runtime.dispose();
    } catch (disposeError) {
      throw new AggregateError(
        [error, disposeError],
        "GitHub Fabric runtime startup and cleanup failed",
      );
    }
    throw error;
  }
}
