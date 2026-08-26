/**
 * The trusted Fabric session behind the `run_pattern` tool: a
 * `PiecesController` connected to a deployed API, built lazily on the tool's
 * first invocation and cached for the rest of the run while healthy.
 * Everything here runs on the trusted host side — nothing in this module ever
 * enters the docker sandbox.
 */

import { Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
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
 * Default factory over `config`: loads the PKCS#8 identity from disk and
 * connects a `PiecesController` to the deployed API. An unauthorized space
 * fails construction rather than yielding a session whose every read is a
 * silent absence.
 */
export const createHarnessFabricSessionFactory = (
  config: HarnessFabricSessionConfig,
): HarnessFabricSessionFactory =>
async () => {
  const identity = await Identity.fromPkcs8(
    await Deno.readFile(config.identityKeyPath),
  );
  const pieces = await PiecesController.initialize({
    apiUrl: new URL(config.apiUrl),
    identity,
    space: config.space,
    ...(config.cfcEnforcementMode !== undefined
      ? { cfcEnforcementMode: config.cfcEnforcementMode }
      : {}),
    ...(config.cfcFlowLabels !== undefined
      ? { cfcFlowLabels: config.cfcFlowLabels }
      : {}),
    ...(config.cfcPosture !== undefined
      ? { cfcPosture: config.cfcPosture }
      : {}),
  });
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
