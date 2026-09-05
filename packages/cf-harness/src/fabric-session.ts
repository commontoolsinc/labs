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
import {
  createFabricInstantiationRecorder,
  type FabricPatternInstantiations,
} from "./fabric-instantiations.ts";

export interface HarnessFabricSession {
  pieces: PiecesController;

  /**
   * The identity this session acts as, when the session was built from one.
   *
   * The render gate needs it to stand up an isolated, in-memory runtime for
   * its probe: a probe run in the session's own space persists its inputs and
   * its result graph there, and neither `stop()` nor staying out of the piece
   * registry deletes them. A session that carries no identity gets no
   * isolated runtime and therefore no probe — the gate abstains rather than
   * quietly probing in the live space.
   */
  identity?: Identity;

  /**
   * What this session's runtime materialized, when the session was built with
   * an instantiation observer. A session without one answers no question about
   * pattern pointers, and the checks that read it are skipped rather than
   * failed.
   */
  instantiations?: FabricPatternInstantiations;
}

/**
 * Builds the run's Fabric session. The engine caches a healthy result so a
 * factory is called at most once per run while its session holds; a
 * construction failure surfaces as an ordinary `run_pattern` tool-output
 * error, and the next tool call invokes the factory again.
 */
export type HarnessFabricSessionFactory = () => Promise<HarnessFabricSession>;

/**
 * The `PiecesController.initialize` options a session config resolves to,
 * identity aside: the space and whichever CFC dials the config carries — an
 * unset dial stays absent so the remoteClient preset's own posture governs.
 * Pure so the resolution is testable without touching disk or network.
 */
export const harnessFabricSessionControllerOptions = (
  config: HarnessFabricSessionConfig,
): {
  apiUrl: URL;
  space: string;
  cfcEnforcementMode?: HarnessFabricSessionConfig["cfcEnforcementMode"];
  cfcFlowLabels?: HarnessFabricSessionConfig["cfcFlowLabels"];
  cfcPosture?: HarnessFabricSessionConfig["cfcPosture"];
  cfcReadMaxConfidentiality?: HarnessFabricSessionConfig[
    "cfcReadMaxConfidentiality"
  ];
  cfcReadOnExceed?: HarnessFabricSessionConfig["cfcReadOnExceed"];
} => ({
  apiUrl: new URL(config.apiUrl),
  space: config.space,
  ...(config.cfcEnforcementMode !== undefined
    ? { cfcEnforcementMode: config.cfcEnforcementMode }
    : {}),
  ...(config.cfcFlowLabels !== undefined
    ? { cfcFlowLabels: config.cfcFlowLabels }
    : {}),
  ...(config.cfcPosture !== undefined ? { cfcPosture: config.cfcPosture } : {}),
  ...(config.cfcReadMaxConfidentiality !== undefined
    ? { cfcReadMaxConfidentiality: config.cfcReadMaxConfidentiality }
    : {}),
  ...(config.cfcReadOnExceed !== undefined
    ? { cfcReadOnExceed: config.cfcReadOnExceed }
    : {}),
});

/**
 * Default factory over `config`: loads the PKCS#8 identity from disk and
 * connects a `PiecesController` to the deployed API. An unauthorized space
 * fails construction rather than yielding a session whose every read is a
 * silent absence. The controller's runtime is given an instantiation recorder,
 * whose read side rides along on the session — the observer is a runtime
 * constructor option, so this is the only point at which it can be installed.
 */
export const createHarnessFabricSessionFactory = (
  config: HarnessFabricSessionConfig,
): HarnessFabricSessionFactory =>
async () => {
  const identity = await Identity.fromPkcs8(
    await Deno.readFile(config.identityKeyPath),
  );
  const recorder = createFabricInstantiationRecorder();
  const pieces = await PiecesController.initialize({
    ...harnessFabricSessionControllerOptions(config),
    identity,
    onPatternInstantiated: recorder.observe,
  });
  return { pieces, identity, instantiations: recorder.instantiations };
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
