import { type Cell, isCell } from "./cell.ts";
import type { MemorySpace } from "./storage/interface.ts";
import type { JSONSchema, Pattern } from "./builder/types.ts";
import type { Runtime } from "./runtime.ts";
import type { RuntimeProgram } from "./harness/types.ts";

export type CellPath = (string | number)[];

export function parseCellPath(path: string): CellPath {
  if (!path || path.trim() === "") {
    return [];
  }
  return path.split("/").map((segment) => {
    if (segment === "") {
      return segment;
    }
    const num = Number(segment);
    return Number.isInteger(num) && num >= 0 ? num : segment;
  });
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

  return isCell(resolvedValue) ? resolvedValue.get() : resolvedValue;
}

export function cellEntityIdString(cell: Cell<unknown>): string | undefined {
  const id = cell.entityId;
  if (!id) return undefined;
  const idValue = id["/"];
  return typeof idValue === "string" ? idValue : undefined;
}

export function getResultCellWithSourceSchema<T = unknown>(
  cell: Cell<T>,
): Cell<T> {
  const link = cell.getAsNormalizedFullLink();
  if (link.schema === undefined) {
    const resultSchema = cell.getMetaRaw("schema") as JSONSchema | undefined;
    if (resultSchema !== undefined) {
      const schema = cell.runtime.cfc.schemaAtPath(resultSchema, link.path);
      return cell.asSchema<T>(schema);
    }
  }
  return cell;
}

/**
 * Compile a pattern into `space` and persist its content-addressed source +
 * compiled documents there (the awaited write-back inside `compilePattern`).
 * The compiled pattern carries its `{ identity, symbol }` entry ref, the single
 * durable pattern pointer; no separate meta-cell save is needed. (Formerly
 * `compileAndSavePattern`, which additionally wrote a now-deleted meta cell.)
 */
export async function compileAndSavePattern(
  runtime: Runtime,
  patternSrc: string | RuntimeProgram,
  options: {
    space: MemorySpace;
  },
): Promise<Pattern> {
  if (typeof patternSrc === "string") {
    patternSrc = {
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: patternSrc }],
    };
  }
  // Route through the content-addressed cell cache in the target space so the
  // compiled module set + source docs are written back (awaited) and reused on
  // subsequent loads (CT-1623).
  const pattern = await runtime.patternManager.compilePattern(patternSrc, {
    space: options.space,
  });
  if (!pattern) {
    throw new Error("No default pattern found in the compiled exports.");
  }

  return pattern;
}
