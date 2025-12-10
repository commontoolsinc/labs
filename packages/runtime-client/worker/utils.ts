import { charmId } from "@commontools/charm";
import { Cell, JSONSchema, parseLink } from "@commontools/runner";
import { CellRef, CharmInfo } from "../ipc.ts";

export function cellToCellRef(cell: Cell<unknown>, schema?: unknown): CellRef {
  const link = parseLink(cell.getAsLink());
  // Check before casting to a NormalizedFullLink
  if (!link.id || !link.space || !link.type) {
    throw new Error("Serialized links must contain id, space, type.");
  }
  const cellRef: CellRef = {
    id: link.id,
    space: link.space,
    path: link.path,
    type: link.type as `${string}/${string}`,
  };
  if (link.schema != null) cellRef.schema = link.schema;
  if (link.rootSchema != null) cellRef.rootSchema = link.rootSchema;
  if (link.overwrite != null) cellRef.overwrite = link.overwrite;
  if (schema !== undefined) cellRef.schema = schema as JSONSchema;
  return cellRef;
}

export function cellToCharmInfo(cell: Cell<unknown>): CharmInfo {
  const id = charmId(cell);
  if (!id) throw new Error("Cell is not a charm");
  return {
    id,
    cellRef: cellToCellRef(cell),
  };
}
