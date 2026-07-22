import {
  entityRefToString,
  isEntityRef,
} from "@commonfabric/data-model/cell-rep";
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
  for (const [index, segment] of path.entries()) {
    currentCell = currentCell.key(segment as keyof unknown) as Cell<unknown>;
    if (index < path.length - 1) {
      // An asCell-schema slot surfaces its value as a live Cell (the
      // Writable<...> result shape). Follow only that selected child; reading
      // the root here could materialize unrelated cold factory siblings.
      const selectedValue = currentCell.get();
      if (isCell(selectedValue)) {
        currentCell = selectedValue as Cell<unknown>;
      }
    }
  }

  const resolvedValue = currentCell.get();
  if (path.length === 0) {
    return isCell(resolvedValue) ? resolvedValue.get() : resolvedValue;
  }
  if (resolvedValue !== undefined) {
    return isCell(resolvedValue) ? resolvedValue.get() : resolvedValue;
  }

  // Only inspect the parent on an unresolved path. Successful child reads must
  // not materialize unrelated siblings (which may include a cold Factory@1).
  let parentCell = cell as Cell<unknown>;
  for (const segment of path.slice(0, -1)) {
    parentCell = parentCell.key(segment as keyof unknown) as Cell<unknown>;
    const selectedValue = parentCell.get();
    if (isCell(selectedValue)) {
      parentCell = selectedValue as Cell<unknown>;
    }
  }
  const parentValue = parentCell.get() as unknown;
  const segment = path[path.length - 1];
  if (parentValue != null && typeof parentValue !== "object") {
    throw new Error(
      `Cannot access path "${
        path.join("/")
      }" - encountered non-object at "${segment}"`,
    );
  }
  const keyMissing = parentValue != null && typeof parentValue === "object"
    ? !(segment in (parentValue as object))
    : true;
  if (keyMissing) {
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

  return undefined;
}

export function cellEntityIdString(cell: Cell<unknown>): string | undefined {
  const id = cell.entityId;
  return isEntityRef(id) ? entityRefToString(id) : undefined;
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
    previousEntryIdentity?: string;
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
    ...(options.previousEntryIdentity === undefined
      ? {}
      : { previousEntryIdentity: options.previousEntryIdentity }),
  });
  if (!pattern) {
    throw new Error("No default pattern found in the compiled exports.");
  }

  return pattern;
}
