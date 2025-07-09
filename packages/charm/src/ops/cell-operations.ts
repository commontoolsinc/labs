import { CharmManager } from "../manager.ts";
import { Cell } from "@commontools/runner";

export type CellPath = readonly (string | number)[];

function parsePathSegments(segments: string[]): (string | number)[] {
  return segments.map((segment) => {
    // Keep empty strings as strings
    if (segment === "") {
      return segment;
    }
    const num = Number(segment);
    // Only convert to number if it's a non-negative integer
    return Number.isInteger(num) && num >= 0 ? num : segment;
  });
}

export function parsePath(path: string): (string | number)[] {
  if (!path || path.trim() === "") {
    return [];
  }
  return parsePathSegments(path.split("/"));
}

// Direct charm operations

export async function getCharmResult(
  manager: CharmManager,
  charmId: string,
  path: CellPath,
): Promise<unknown> {
  const charmCell = await manager.get(charmId);
  if (!charmCell) {
    throw new Error(`Charm with ID "${charmId}" not found`);
  }

  let currentValue: any = charmCell.get();
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
    currentValue = currentValue[segment];
  }

  return currentValue;
}

export async function getCharmInput(
  manager: CharmManager,
  charmId: string,
  path: CellPath,
): Promise<unknown> {
  const charmCell = await manager.get(charmId);
  if (!charmCell) {
    throw new Error(`Charm with ID "${charmId}" not found`);
  }

  const inputCell = manager.getArgument(charmCell);
  let currentValue: any = inputCell.get();
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
    currentValue = currentValue[segment];
  }

  return currentValue;
}

export async function setCharmInput(
  manager: CharmManager,
  charmId: string,
  path: CellPath,
  value: unknown,
): Promise<void> {
  const tx = manager.runtime.edit();

  const charmCell = await manager.get(charmId, false, undefined, tx);
  if (!charmCell) {
    throw new Error(`Charm with ID "${charmId}" not found`);
  }

  const inputCell = manager.getArgument(charmCell);
  let targetCell = inputCell;
  for (const segment of path) {
    targetCell = targetCell.key(segment);
  }

  targetCell.set(value as any);

  await tx.commit();
  await manager.runtime.idle();
  await manager.synced();
}

export async function setCharmResult(
  manager: CharmManager,
  charmId: string,
  path: CellPath,
  value: unknown,
): Promise<void> {
  const tx = manager.runtime.edit();

  const charmCell = await manager.get(charmId, false, undefined, tx);
  if (!charmCell) {
    throw new Error(`Charm with ID "${charmId}" not found`);
  }

  let targetCell = charmCell;
  for (const segment of path) {
    targetCell = targetCell.key(segment);
  }

  targetCell.set(value as any);

  await tx.commit();
  await manager.runtime.idle();
  await manager.synced();
}
