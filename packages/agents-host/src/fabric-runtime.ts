import { createSession, Identity, isDID } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  experimentalOptionsFromEnv,
  type MemorySpace,
  Runtime,
  runtimePresets,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { AgentFabricTarget } from "@commonfabric/agents-connector/fabric";
import { abortable } from "./abort.ts";
import { parseAgentFabricApiUrl } from "./target-state.ts";

export interface AgentFabricRuntime {
  runtime: Runtime;
  manager: PiecesController;
  spaceDid: MemorySpace;
  target: AgentFabricTarget;
}

export async function openAgentFabricRuntime(options: {
  apiUrl: string;
  identityPath: string;
  space: string;
  signal?: AbortSignal;
}): Promise<AgentFabricRuntime> {
  options.signal?.throwIfAborted();
  const apiUrl = parseAgentFabricApiUrl(options.apiUrl);
  const identityBytes = await Deno.readFile(options.identityPath);
  options.signal?.throwIfAborted();
  const identity = await Identity.fromPkcs8(identityBytes);
  options.signal?.throwIfAborted();
  const session =
    await (isDID(options.space)
      ? createSession({ identity, spaceDid: options.space })
      : createSession({ identity, spaceName: options.space }));
  options.signal?.throwIfAborted();
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
  let disposeTask: Promise<void> | undefined;
  const dispose = () => disposeTask ??= runtime.dispose();

  const stage = async <T>(operation: Promise<T>): Promise<T> => {
    try {
      return await abortable(operation, options.signal);
    } catch (error) {
      if (options.signal?.aborted) {
        const [, disposal] = await Promise.allSettled([operation, dispose()]);
        if (disposal.status === "rejected") {
          throw new AggregateError(
            [error, disposal.reason],
            "Fabric runtime startup cancellation and cleanup failed",
          );
        }
      }
      throw error;
    }
  };

  try {
    if (!(await stage(runtime.healthCheck(options.signal)))) {
      throw new Error(`could not connect to ${apiUrl.origin}`);
    }
    options.signal?.throwIfAborted();
    const manager = new PiecesController(session, runtime);
    await stage(manager.synced());
    options.signal?.throwIfAborted();
    const target = await stage(
      AgentFabricTarget.open({
        runtime,
        spaceDid: session.space,
      }),
    );
    options.signal?.throwIfAborted();
    return { runtime, manager, spaceDid: session.space, target };
  } catch (error) {
    try {
      await dispose();
    } catch (disposeError) {
      throw new AggregateError(
        [error, disposeError],
        "Fabric runtime startup and cleanup failed",
      );
    }
    throw error;
  }
}
