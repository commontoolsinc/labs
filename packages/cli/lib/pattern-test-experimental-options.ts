import {
  type EnvReader,
  type ExperimentalOptions,
  experimentalOptionsFromEnv,
  withServerExecutionDefault,
} from "@commonfabric/runner";

/** The flags of a runtime `cf test` builds, with its posture decided. */
export type PatternTestExperimentalOptions = ExperimentalOptions & {
  /**
   * Whether the run is on the server-execution arm, in which case the runner
   * hosts a serving loop beside the memory server its runtimes commit to.
   */
  serverExecution: boolean;
};

/**
 * Resolves the experimental flags of a runtime `cf test` builds from `env`,
 * deciding its server-execution posture as a deployed entry point does: the
 * explicit `EXPERIMENTAL_SERVER_EXECUTION`, else the first-party default.
 *
 * The posture decides the topology as well as the runtime's flags. A runtime
 * on the server-execution arm commits the event a handler is fired with and
 * leaves the handler to a serving loop, so a run on that arm hosts one beside
 * its memory server, and a run on the other arm hosts none.
 */
export function patternTestExperimentalOptions(
  env: EnvReader,
): PatternTestExperimentalOptions {
  return withServerExecutionDefault(experimentalOptionsFromEnv(env));
}
