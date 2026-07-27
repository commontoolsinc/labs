import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { Cell } from "../../src/cell.ts";
import type { Runtime } from "../../src/runtime.ts";

/** The fields the llm builtins write to their result cell. */
export interface LlmResultState<T = unknown> {
  pending?: boolean;
  result?: T;
  error?: string;
  partial?: string;
  requestHash?: string;
  messages?: unknown;
  groundingSources?: unknown;
}

/**
 * Resolve with the result cell of `llm`, `generateText` or `generateObject`
 * once its request has finished, and with the value that finished it.
 *
 * `runtime` is the one whose scheduler runs the pattern that writes `cell`. A
 * test that builds a second runtime has to pass that one here. Idling any other
 * scheduler drains work the cell has nothing to do with, which puts the read
 * back at an arbitrary moment and gives up everything below.
 *
 * The builtins set `pending` to true in the action that issues a request and
 * back to false in the writeback that lands the response or the error, so
 * `pending === false` marks the settled state. Reading at quiescence is what
 * keeps that predicate honest. The states a bare `pending === false` would
 * otherwise accept exist only before the builtin's action has run: the result
 * schema declares `pending` with a default of false, and a second request
 * leaves the first request's settled value in place until the action resets it.
 * `runtime.idle()` runs that action.
 *
 * Settled does not mean the model answered. A builtin handed neither a prompt
 * nor messages writes `pending` false with no `result` and no `error`, and this
 * wait returns on that state like any other. Assert on the field carrying the
 * output, not on `pending` alone, so a request that never went out fails the
 * test rather than passing it.
 *
 * The wait returns at quiescence, so a caller may equally read the cell it
 * passed in, as long as it does so before awaiting anything else.
 */
export function waitForLlmSettled<T = unknown>(
  runtime: Runtime,
  // deno-lint-ignore no-explicit-any
  cell: Cell<any>,
): Promise<LlmResultState<T>> {
  return waitForCellValue<LlmResultState<T>>(
    runtime,
    cell,
    (value) => value?.pending === false,
  );
}
