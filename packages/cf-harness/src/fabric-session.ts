/**
 * The trusted Fabric session behind the `run_pattern` tool: a
 * `PiecesController` connected to a deployed API, built lazily on the tool's
 * first invocation and cached for the rest of the run while healthy.
 * Everything here runs on the trusted host side — nothing in this module ever
 * enters the docker sandbox.
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
 * Builds the run's Fabric session. The engine caches a healthy result so a
 * factory is called at most once per run while its session holds; a
 * construction failure surfaces as an ordinary `run_pattern` tool-output
 * error, and the next tool call invokes the factory again.
 */
export type HarnessFabricSessionFactory = () => Promise<HarnessFabricSession>;

/**
 * Surfaces a permanent authorization denial for the controller's configured
 * space. The storage layer's per-space contract (see
 * `authorizationError()` in `packages/runner/src/storage/v2.ts`) keeps
 * `synced()` quiet on a denial — a denied cross-space link must stay a silent
 * absent read — so a caller that must reach a specific space reads the
 * per-space status after `synced()` and throws it deliberately. Minimal
 * replica of the CLI's post-`synced()` check in `packages/cli/lib/piece.ts`.
 */
const assertSpaceAuthorized = (pieces: PiecesController): void => {
  const authorizationError = pieces.runtime.storageManager
    .authorizationError?.(pieces.getSpace());
  if (authorizationError) {
    throw authorizationError;
  }
};

/**
 * Default factory over `config`: loads the PKCS#8 identity from disk and
 * connects a `PiecesController` to the deployed API. A space name goes
 * through `PiecesController.initialize`; a `did:key` space needs the manual
 * `createSession` path, since `initialize` accepts only a name. Either way,
 * an unauthorized space fails construction rather than yielding a session
 * whose every read is a silent absence.
 */
export const createHarnessFabricSessionFactory = (
  config: HarnessFabricSessionConfig,
): HarnessFabricSessionFactory =>
async () => {
  const identity = await Identity.fromPkcs8(
    await Deno.readFile(config.identityKeyPath),
  );
  const apiUrl = new URL(config.apiUrl);
  const cfcDials = {
    ...(config.cfcEnforcementMode !== undefined
      ? { cfcEnforcementMode: config.cfcEnforcementMode }
      : {}),
    ...(config.cfcFlowLabels !== undefined
      ? { cfcFlowLabels: config.cfcFlowLabels }
      : {}),
  };
  if (!isDID(config.space)) {
    const pieces = await PiecesController.initialize({
      apiUrl,
      identity,
      spaceName: config.space,
      ...cfcDials,
    });
    assertSpaceAuthorized(pieces);
    return { pieces };
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
    ...cfcDials,
    trustSnapshotProvider: () => ({
      id: `principal:${session.as.did()}`,
      actingPrincipal: session.as.did(),
    }),
  }));
  const pieces = new PiecesController(session, runtime);
  await pieces.synced();
  assertSpaceAuthorized(pieces);
  return { pieces };
};

/**
 * Wraps `factory` so a healthy session is built once and shared by every
 * invocation in the run. An in-flight construction is shared too, but a
 * REJECTED construction clears the cache: the failure still reaches every
 * caller awaiting it, and the next tool call invokes the factory again
 * rather than replaying a terminal failure for the rest of the run. A
 * synchronous throw from the factory folds into the same rejected promise.
 */
export const cacheHarnessFabricSessionFactory = (
  factory: HarnessFabricSessionFactory,
): HarnessFabricSessionFactory => {
  let session: Promise<HarnessFabricSession> | undefined;
  return () => {
    if (session === undefined) {
      const attempt: Promise<HarnessFabricSession> = Promise.resolve()
        .then(factory)
        .catch((error) => {
          if (session === attempt) {
            session = undefined;
          }
          throw error;
        });
      session = attempt;
    }
    return session;
  };
};
