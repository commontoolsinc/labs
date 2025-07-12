import { RuntimeProgram } from "@commontools/runner";
import { CharmManager } from "../manager.ts";
import { compileRecipe } from "../iterate.ts";

export async function compileProgram(
  manager: CharmManager,
  program: RuntimeProgram | string,
) {
  const recipe = await compileRecipe(
    program,
    "recipe",
    manager.runtime,
    manager.getSpace(),
    undefined, // parents
  );
  return recipe;
}
