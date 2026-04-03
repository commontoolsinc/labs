import { Cell, JSONSchema, parseLink, SigilLink } from "@commontools/runner";
import { CellRef, PageRef } from "../protocol/types.ts";
import { Runtime } from "@commontools/runner";
import { LINK_V1_TAG } from "@commontools/runner/shared";
import { isCellRef } from "../protocol/mod.ts";

export function mapCellRefsToSigilLinks(value: unknown): any {
  if (
    typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => mapCellRefsToSigilLinks(v));
  } else if (isCellRef(value)) {
    return cellRefToSigilLink(value);
  } else if (typeof value === "object" && value) {
    return Object.entries(value).reduce((acc: Record<string, any>, [k, v]) => {
      acc[k] = mapCellRefsToSigilLinks(v);
      return acc;
    }, {});
  }
  return value;
}

export function cellRefToSigilLink(cell: CellRef): SigilLink {
  return {
    "/": {
      [LINK_V1_TAG]: cell,
    },
  };
}

export function createCellRef(cell: Cell<unknown>, schema?: unknown): CellRef {
  const link = parseLink(
    cell.getAsLink({
      includeSchema: true,
      keepAsCell: true,
      keepStreams: true,
    }),
  );
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
  if (link.overwrite != null) cellRef.overwrite = link.overwrite;
  if (schema !== undefined) {
    cellRef.schema = schema as JSONSchema;
  }
  return cellRef;
}

export function createPageRef(cell: Cell<unknown>): PageRef {
  return {
    cell: createCellRef(cell),
  };
}

export function getCell(runtime: Runtime, ref: CellRef): Cell<unknown> {
  // We explicitly do not pass in `schema`, as this function applies
  // the schema to `schema`, and cell refs already contain all this
  // information. Maybe the upstream function should change.
  return runtime.getCellFromLink(ref);
}
