import { CharmManager } from "../manager.ts";

export type CellPath = readonly (string | number)[];

export async function getCellValue(
  manager: CharmManager,
  charmId: string,
  path: CellPath,
): Promise<unknown> {
  const charmCell = await manager.get(charmId);
  if (!charmCell) {
    throw new Error(`Charm with ID "${charmId}" not found`);
  }
  
  let currentValue = charmCell.get();
  for (const segment of path) {
    if (currentValue == null) {
      throw new Error(`Cannot access path "${path.join("/")}" - encountered null/undefined at "${segment}"`);
    }
    if (typeof currentValue !== "object") {
      throw new Error(`Cannot access path "${path.join("/")}" - encountered non-object at "${segment}"`);
    }
    currentValue = (currentValue as any)[segment];
  }
  
  return currentValue;
}

export async function setCellValue(
  manager: CharmManager,
  charmId: string,
  path: CellPath,
  value: unknown,
): Promise<void> {
  const charmCell = await manager.get(charmId);
  if (!charmCell) {
    throw new Error(`Charm with ID "${charmId}" not found`);
  }
  
  const inputCell = manager.getArgument(charmCell);
  let targetCell = inputCell;
  for (const segment of path) {
    targetCell = targetCell.key(segment);
  }
  
  targetCell.set(value as any);
  await manager.runtime.idle();
  await manager.synced();
}
