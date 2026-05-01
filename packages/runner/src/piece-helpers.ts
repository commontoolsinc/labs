import type { Cell } from "./cell.ts";
import type { MemorySpace } from "./storage/interface.ts";
import type { Pattern } from "./builder/types.ts";
import type { Runtime } from "./runtime.ts";
import type { RuntimeProgram } from "./harness/types.ts";
import type { PatternMeta } from "./pattern-manager.ts";
import { TYPE } from "./shared.ts";
import { processSchema } from "./schemas.ts";
import type { Mutable } from "@commonfabric/utils/types";

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

  return resolvedValue;
}

export function cellEntityIdString(cell: Cell<unknown>): string | undefined {
  const id = cell.entityId;
  if (!id) return undefined;
  const idValue = id["/"];
  return typeof idValue === "string" ? idValue : undefined;
}

export function getPatternIdFromResultCell(
  cell: Cell<unknown>,
): string | undefined {
  return cell.getSourceCell(processSchema)?.get()?.[TYPE];
}

export function getResultCellWithSourceSchema<T = unknown>(
  cell: Cell<T>,
): Cell<T> {
  const processCell = cell.getSourceCell();
  if (processCell) {
    const resultRefCell = processCell.key("resultRef").resolveAsCell();
    if (resultRefCell?.schema) {
      return cell.asSchema<T>(resultRefCell.schema);
    }
  }
  return cell;
}

export async function compileAndSavePattern(
  runtime: Runtime,
  patternSrc: string | RuntimeProgram,
  options: {
    space: MemorySpace;
    spec?: string;
    parents?: string[];
  },
): Promise<Pattern> {
  const pattern = await runtime.patternManager.compilePattern(patternSrc);
  if (!pattern) {
    throw new Error("No default pattern found in the compiled exports.");
  }

  const patternId = runtime.patternManager.registerPattern(pattern, patternSrc);
  await runtime.patternManager.setPatternMetaFields(patternId, {
    spec: options.spec,
    parents: options.parents?.map((id) => id.toString()),
  } as Partial<Mutable<PatternMeta>>);
  await runtime.patternManager.saveAndSyncPattern({
    patternId,
    space: options.space,
  });

  return pattern;
}
