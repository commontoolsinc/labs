import { toCompactDebugString } from "@commonfabric/data-model";
import {
  compileAndSavePattern,
  type RuntimeProgram,
} from "@commonfabric/runner";
import type { PiecesController } from "./pieces-controller.ts";

export async function compileProgram(
  pieces: PiecesController,
  program: RuntimeProgram | string,
) {
  const pattern = await compileAndSavePattern(
    pieces.runtime,
    program,
    {
      space: pieces.getSpace(),
    },
  );
  return pattern;
}

/**
 * The `Error` to throw for a failed commit.
 *
 * A commit reports failure as a `Result` error — a plain object carrying
 * `name` and `message`, not an `Error` — and throwing it as it stands leaves
 * every caller holding something that fails `instanceof Error`, has no stack,
 * and renders as `[object Object]`. Cliffy's own handler replaces such a throw
 * with `[non-error-thrown] [object Object]` before `cf` can render it, so a
 * commit conflict reaches an operator with its reason already discarded.
 *
 * An `Error` `reason` is the real cause and is thrown as it stands. Otherwise
 * the Result's `name` and `message` become the error's, and the Result itself
 * is kept on `cause` so a caller that wants the conflict's own fields — which
 * documents conflicted, at which sequence — still has them.
 *
 * A Result carrying no `message` is rendered with `toCompactDebugString` rather
 * than `JSON.stringify`, which would be this defect again one level down: it
 * renders most non-plain objects as `{}`, and throws outright on a circular
 * one — inside the path that exists to make a failure legible.
 */
export function commitFailure(error: object): Error {
  if ("reason" in error && error.reason instanceof Error) return error.reason;
  const named = error as { name?: unknown; message?: unknown };
  const message = typeof named.message === "string"
    ? named.message
    : toCompactDebugString(error);
  const wrapped = new Error(message, { cause: error });
  if (typeof named.name === "string") wrapped.name = named.name;
  return wrapped;
}
