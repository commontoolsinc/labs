import {
  compileAndSavePattern,
  type RuntimeProgram,
} from "@commonfabric/runner";
import type { PiecesController } from "./pieces-controller.ts";

export async function compileProgram(
  pieces: PiecesController,
  program: RuntimeProgram | string,
  options: { previousEntryIdentity?: string } = {},
) {
  const pattern = await compileAndSavePattern(
    pieces.runtime,
    program,
    {
      space: pieces.getSpace(),
      ...(options.previousEntryIdentity === undefined
        ? {}
        : { previousEntryIdentity: options.previousEntryIdentity }),
    },
  );
  return pattern;
}
