import {
  type EnvReader,
  EXPERIMENTAL_ENV_VARS,
  type ExperimentalOptions,
  experimentalOptionsFromEnv,
} from "@commonfabric/runner";

/**
 * Resolves the experimental flags of a runtime `cf test` builds from `env`,
 * refusing server execution.
 *
 * `cf test` runs a single-user test over emulated storage and a multi-user
 * test against a plain memory server, and neither has a serving loop beside
 * it. A runtime with server execution on commits the event a handler is fired
 * with and leaves the handler to that loop, so with no loop the event is
 * admitted and never served: each client sees only its own speculative
 * writes, and a test fails for a reason that has nothing to do with the
 * pattern under test.
 *
 * The refusal covers the environment and nothing else. A serving host
 * elsewhere in the same realm holds the process's ambient flag on while it
 * lives, and a runtime built from what this returns runs on that arm all the
 * same.
 *
 * @throws Error when `env` turns server execution on.
 */
export function patternTestExperimentalOptions(
  env: EnvReader,
): ExperimentalOptions {
  const experimental = experimentalOptionsFromEnv(env);
  if (experimental.serverExecution === true) {
    const name = EXPERIMENTAL_ENV_VARS.serverExecution;
    throw new Error(
      `\`cf test\` refuses \`${name}=true\`: it hosts no serving loop, so ` +
        `nothing would serve the events its runtimes commit, and every ` +
        `handler's writes would stay speculative. Unset \`${name}\` or set ` +
        `it to \`false\`. See "The ON topology in one process" in ` +
        `\`docs/development/TESTING.md\`.`,
    );
  }
  return experimental;
}
