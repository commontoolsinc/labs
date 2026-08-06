// Server-execution v2 stage F (docs/specs/server-side-execution/
// serving-loop.md §1): the ExecutorHost bootstrap. Under
// EXPERIMENTAL_SERVER_EXECUTION this process hosts one committing runtime
// per ACTIVE space — the serving loop — wired to the co-hosted memory
// server: the admission-side observer (plane b) activates spaces, lease
// writes ride the direct engine plane (plane c), and the serving
// runtimes' storage sessions are in-process loopback connections with the
// SAME signed session-open production clients present (plane a). OFF (the
// default), nothing here runs and toolshed is byte-identical to today.

import {
  type EnvReader,
  experimentalOptionsFromEnv,
  Runtime,
} from "@commonfabric/runner";
import { ExecutorHost } from "@commonfabric/runner/executor/host";
import { LoopbackStorageManager } from "@commonfabric/runner/executor/loopback-storage";
import type { Server as MemoryServer } from "@commonfabric/memory/v2/server";
import type { Identity } from "@commonfabric/identity";

let host: ExecutorHost | undefined;

/**
 * Start the serving loop's host when the flag is on. Called once from
 * toolshed startup, after the memory server exists. Returns the host (or
 * undefined off the flag) so shutdown can close it.
 */
export function startServerExecutionHost(options: {
  server: MemoryServer;
  identity: Identity;
  /** The patterns/compile base — the serving runtimes' `apiUrl`. */
  apiUrl: URL;
  envGet?: EnvReader;
}): ExecutorHost | undefined {
  const experimental = experimentalOptionsFromEnv(
    options.envGet ?? Deno.env.get,
  );
  if (experimental.serverExecution !== true) {
    return undefined;
  }
  console.log(
    `Server-execution v2: serving loop ON (service ${options.identity.did()})`,
  );
  host = new ExecutorHost({
    server: options.server,
    serviceIdentity: options.identity.did(),
    createRuntime: (space) => {
      const storageManager = LoopbackStorageManager.connect(options.server, {
        as: options.identity,
      });
      const runtime = new Runtime({
        apiUrl: options.apiUrl,
        storageManager,
        experimental: {
          ...experimental,
          serverExecution: true,
          // serving-loop.md §3e: the pattern-update posture flips
          // server-side — the SpaceServer owns the watcher and the swap
          // under the flag.
          systemPatternAutoUpdate: true,
        },
      });
      void space;
      return Promise.resolve({
        runtime,
        dispose: async () => {
          await runtime.dispose();
          await storageManager.close();
        },
      });
    },
  });
  return host;
}

export async function stopServerExecutionHost(): Promise<void> {
  await host?.close();
  host = undefined;
}
