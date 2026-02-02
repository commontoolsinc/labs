/**
 * Sink declassification rules — allow specific taint atoms to be stripped
 * when consumed at specific paths by specific builtin sinks.
 *
 * For example: `Service(google-auth)` taint on `options.headers.Authorization`
 * gets stripped when consumed by `fetchData`, but the same taint on
 * `options.body` blocks the request.
 */

import type { AtomPattern } from "./exchange-rules.ts";

export type SinkDeclassificationRule = {
  /** Atom pattern to match against taint on the path. */
  taintPattern: AtomPattern;
  /** Builtin that may consume this taint (e.g. "fetchData"). */
  allowedSink: string;
  /** Paths within the sink's input where consumption is allowed. */
  allowedPaths: readonly (readonly string[])[];
  /** Variables for pattern matching (documentation). */
  variables: string[];
};
