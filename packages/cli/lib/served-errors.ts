/**
 * Errors thrown by served handler runs, for `cf test` on the server-execution
 * arm. There the test's runtime runs a handler speculatively and a serving
 * runtime runs it for real, and the serving runtime has no error handler of
 * the test's. A served run that throws reaches the test's runtime only as an
 * `errored` outcome of the event that fired it, which this module turns into
 * a runtime error of the test. It covers the events the test's runtime fired:
 * an event a served handler fires on its own account is no event of the
 * test's runtime, and has no outcome there.
 */

import type { Runtime } from "@commonfabric/runner";

/** Prefix that marks a runtime error as a served run's. */
export const SERVED_ERROR_PREFIX = "[served] ";

/**
 * Records the error of every `errored` outcome `runtime` hears, for as long
 * as `runtime` lives, and returns the list they are recorded in. On the arm
 * without server execution the runtime has no outcomes, and the list stays
 * empty.
 */
export function collectServedErrors(runtime: Runtime): string[] {
  const errors: string[] = [];
  runtime.subscribeEventIntentOutcomes((outcome) => {
    if (outcome.kind === "errored") errors.push(outcome.reason);
  });
  return errors;
}

/**
 * Returns the runtime errors to report for `served` errors beside the errors
 * the test's runtime recorded, whose messages are `local`, each marked with
 * {@link SERVED_ERROR_PREFIX}. A served error whose text is a local error's
 * message is the speculative run's throw over again and is left out, one
 * local error answering for one served error, so each throw is reported once
 * whichever run saw it.
 */
export function servedRuntimeErrors(
  served: readonly string[],
  local: readonly string[],
): string[] {
  const unmatched = new Map<string, number>();
  for (const error of local) {
    unmatched.set(error, (unmatched.get(error) ?? 0) + 1);
  }
  const result: string[] = [];
  for (const error of served) {
    const count = unmatched.get(error) ?? 0;
    if (count > 0) unmatched.set(error, count - 1);
    else result.push(`${SERVED_ERROR_PREFIX}${error}`);
  }
  return result;
}
