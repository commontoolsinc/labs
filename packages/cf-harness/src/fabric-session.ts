/**
 * The trusted Fabric session behind the `run_pattern` tool: a
 * `PiecesController` connected to a deployed API, built lazily on the tool's
 * first invocation and cached for the rest of the run. Everything here runs
 * on the trusted host side — nothing in this module ever enters the docker
 * sandbox.
 */

import { createSession, Identity, isDID } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  experimentalOptionsFromEnv,
  Runtime,
  runtimePresets,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import type { HarnessFabricSessionConfig } from "./config.ts";

export interface HarnessFabricSession {
  pieces: PiecesController;
}

/**
 * Builds the run's Fabric session. The engine caches the result, so a
 * factory is called at most once per run; a construction failure surfaces as
 * an ordinary `run_pattern` tool-output error and is not retried.
 */
export type HarnessFabricSessionFactory = () => Promise<HarnessFabricSession>;

/**
 * Default factory over `config`: loads the PKCS#8 identity from disk and
 * connects a `PiecesController` to the deployed API. A space name goes
 * through `PiecesController.initialize`; a `did:key` space needs the manual
 * `createSession` path, since `initialize` accepts only a name.
 */
export const createHarnessFabricSessionFactory = (
  config: HarnessFabricSessionConfig,
): HarnessFabricSessionFactory =>
async () => {
  const identity = await Identity.fromPkcs8(
    await Deno.readFile(config.identityKeyPath),
  );
  const apiUrl = new URL(config.apiUrl);
  if (!isDID(config.space)) {
    return {
      pieces: await PiecesController.initialize({
        apiUrl,
        identity,
        spaceName: config.space,
      }),
    };
  }
  const session = await createSession({ identity, spaceDid: config.space });
  // Shared first-party posture for client runtimes against a deployed API,
  // matching `PiecesController.initialize`; trust provenance stays a visible
  // delta of this session.
  const runtime = new Runtime(runtimePresets.remoteClient({
    apiUrl,
    storageManager: StorageManager.open({
      as: session.as,
      memoryHost: apiUrl,
      spaceIdentity: session.spaceIdentity,
    }),
    experimental: experimentalOptionsFromEnv((key) => Deno.env.get(key)),
    trustSnapshotProvider: () => ({
      id: `principal:${session.as.did()}`,
      actingPrincipal: session.as.did(),
    }),
  }));
  const pieces = new PiecesController(session, runtime);
  await pieces.synced();
  return { pieces };
};

/**
 * Wraps `factory` so the session is built once and shared by every
 * invocation in the run. A rejected construction is cached too: the run
 * carries no reconnect logic, so a session that failed to build stays
 * failed. A synchronous throw from the factory folds into that cached
 * rejection, so the factory is never invoked twice.
 */
export const cacheHarnessFabricSessionFactory = (
  factory: HarnessFabricSessionFactory,
): HarnessFabricSessionFactory => {
  let session: Promise<HarnessFabricSession> | undefined;
  return () => session ??= Promise.resolve().then(factory);
};
