import { Cell, RuntimeProgram } from "@commontools/runner";
import { CharmManager } from "../manager.ts";
import { compileRecipe } from "../iterate.ts";

export type CellPath = (string | number)[];

export function parsePath(path: string): CellPath {
  if (!path || path.trim() === "") {
    return [];
  }
  return path.split("/").map((segment) => {
    // Keep empty strings as strings
    if (segment === "") {
      return segment;
    }
    const num = Number(segment);
    // Only convert to number if it's a non-negative integer
    return Number.isInteger(num) && num >= 0 ? num : segment;
  });
}

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

export function resolveCellPath<T>(
  cell: Cell<T>,
  path: CellPath,
): unknown {
  let currentValue = cell.get() as unknown;
  for (const segment of path) {
    if (currentValue == null) {
      throw new Error(
        `Cannot access path "${
          path.join("/")
        }" - encountered null/undefined at "${segment}"`,
      );
    }
    if (typeof currentValue !== "object") {
      throw new Error(
        `Cannot access path "${
          path.join("/")
        }" - encountered non-object at "${segment}"`,
      );
    }
    if (!(segment in currentValue)) {
      throw new Error(
        `Cannot access path "${
          path.join("/")
        }" - property "${segment}" not found`,
      );
    }
    currentValue = (currentValue as Record<string, unknown>)[segment];
  }
  return currentValue;
}
