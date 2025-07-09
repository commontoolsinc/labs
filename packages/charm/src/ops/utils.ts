import { RuntimeProgram } from "@commontools/runner";
import { CharmManager } from "../manager.ts";
import { compileRecipe } from "../iterate.ts";

export async function compileProgram(
  manager: CharmManager,
  program: RuntimeProgram | string,
) {
  const tx = manager.runtime.edit();
  const recipe = await compileRecipe(
    tx,
    program,
    "recipe",
    manager.runtime,
    manager.getSpace(),
    undefined, // parents
  );
  await tx.commit(); // TODO(seefeld): Retry?
  return recipe;
}
