import {
  compileAndSavePattern,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { PieceManager } from "../manager.ts";

export async function compileProgram(
  manager: PieceManager,
  program: RuntimeProgram | string,
  options: { previousEntryIdentity?: string } = {},
) {
  const pattern = await compileAndSavePattern(
    manager.runtime,
    program,
    {
      space: manager.getSpace(),
      ...(options.previousEntryIdentity === undefined
        ? {}
        : { previousEntryIdentity: options.previousEntryIdentity }),
    },
  );
  return pattern;
}
