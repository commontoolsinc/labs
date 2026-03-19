import { Cell, RuntimeProgram } from "@commontools/runner";
import { PieceManager } from "../manager.ts";
import { compilePattern } from "../iterate.ts";

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
  manager: PieceManager,
  program: RuntimeProgram | string,
) {
  const pattern = await compilePattern(
    program,
    "pattern",
    manager.runtime,
    manager.getSpace(),
    undefined, // parents
  );
  return pattern;
}

export function resolveCellPath<T>(
  cell: Cell<T>,
  path: CellPath,
): unknown {
  let currentCell = cell as Cell<unknown>;

  for (const segment of path) {
    const currentValue = currentCell.get() as unknown;
    if (currentValue != null && typeof currentValue !== "object") {
      throw new Error(
        `Cannot access path "${
          path.join("/")
        }" - encountered non-object at "${segment}"`,
      );
    }
    currentCell = currentCell.key(segment as keyof unknown) as Cell<unknown>;
  }

  const resolvedValue = currentCell.get();
  if (path.length > 0 && resolvedValue === undefined) {
    const segment = path[path.length - 1];
    throw new Error(
      `Cannot access path "${
        path.join("/")
      }" - property "${segment}" not found`,
    );
  }

  return resolvedValue;
}
