import { CellRef } from "../protocol/mod.ts";

export function cellRefToKey(cell: CellRef): `${string}:${string}:${string}` {
  const id = cell.id.startsWith("of:") ? cell.id.substring(3) : cell.id;
  const schema = cell.schema ? `:${JSON.stringify(cell.schema)}` : "";
  return `${cell.space}:${id}:${cell.path.join(".")}${schema}`;
}
