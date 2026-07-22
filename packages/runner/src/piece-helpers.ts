import {
  entityRefToString,
  isEntityRef,
} from "@commonfabric/data-model/cell-rep";
import { isRecord } from "@commonfabric/utils/types";
import { type Cell, isCell, isStream } from "./cell.ts";
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
    // An asCell-schema slot surfaces its value as a live Cell (the
    // Writable<...> result shape); read through it like the leaf below
    // does, or the traversal inspects the Cell instance's own JS
    // properties and reports runner internals as "available keys".
    if (isCell(parentValue)) {
      currentCell = parentValue as Cell<unknown>;
      parentValue = currentCell.get() as unknown;
    }
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

const DEFAULT_APP_PATTERN_SOURCE = "/api/patterns/system/default-app.tsx";

/**
 * Identifies a persisted default-app-shaped root that still exposes its piece
 * registry under the retired field. Provenance-free roots and roots tracking
 * the official default app qualify; custom sourced roots do not.
 */
export function isLegacyPieceRegistryRoot(
  root: Cell<unknown>,
): boolean {
  const patternIdentity = root.getMetaRaw("patternIdentity");
  const patternSource = root.getMetaRaw("patternSource");
  if (
    !isRecord(patternIdentity) ||
    typeof patternIdentity.identity !== "string" ||
    typeof patternIdentity.symbol !== "string" ||
    (patternSource !== undefined &&
      patternSource !== DEFAULT_APP_PATTERN_SOURCE)
  ) {
    return false;
  }

  return root.key("pieceRegistry").getRaw() === undefined &&
    root.key("allPieces").getRaw() !== undefined &&
    isStream(root.key("addPiece").resolveAsCell());
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
