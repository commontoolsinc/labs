import { Cell, RuntimeProgram } from "@commonfabric/runner";
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
  let parentValue: unknown = undefined;

  for (const segment of path) {
    parentValue = currentCell.get() as unknown;
    if (parentValue != null && typeof parentValue !== "object") {
      throw new Error(
        `Cannot access path "${
          path.join("/")
        }" - encountered non-object at "${segment}"`,
      );
    }
    currentCell = currentCell.key(segment as keyof unknown) as Cell<unknown>;
  }

  const resolvedValue = currentCell.get();
  const segment = path[path.length - 1];
  const keyMissing = parentValue != null && typeof parentValue === "object"
    ? !(segment in (parentValue as object))
    : resolvedValue === undefined;
  if (path.length > 0 && keyMissing) {
    const availableKeys = parentValue != null && typeof parentValue === "object"
      ? Object.keys(parentValue as Record<string, unknown>)
        .filter((k) => !k.startsWith("$"))
        .sort()
      : [];
    const keysHint = availableKeys.length > 0
      ? `. Available keys: ${availableKeys.join(", ")}`
      : "";
    throw new Error(
      `Cannot access path "${path.join("/")}" - property "${
        String(segment)
      }" not found${keysHint}`,
    );
  }

  return resolvedValue;
}
