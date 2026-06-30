import {
  Cell,
  JSONSchema,
  KeepAsCell,
  parseLink,
  SigilLink,
} from "@commonfabric/runner";
import { cfcLabelViewForCell } from "@commonfabric/runner/cfc";
import { CellRef, PageRef } from "../protocol/types.ts";
import { Runtime } from "@commonfabric/runner";
import { linkRefFrom } from "@commonfabric/runner/shared";
import { type CfcCellLinkRefPayload } from "@commonfabric/runner/cfc";
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
  return linkRefFrom<CfcCellLinkRefPayload>({
    id: cell.id,
    space: cell.space,
    scope: cell.scope,
    path: cell.path,
    ...(cell.schema !== undefined && { schema: cell.schema }),
    ...(cell.overwrite !== undefined && { overwrite: cell.overwrite }),
    ...(cell.cfcLabelView !== undefined && {
      cfcLabelView: cell.cfcLabelView,
    }),
  });
}

export function createCellRef(cell: Cell<unknown>, schema?: unknown): CellRef {
  const link = parseLink(
    cell.getAsLink({
      includeSchema: true,
      keepAsCell: KeepAsCell.All,
    }),
  );
  // Check before casting to a NormalizedFullLink
  if (!link.id || !link.space) {
    throw new Error("Serialized links must contain id and space.");
  }
  const cellRef: CellRef = {
    id: link.id,
    space: link.space,
    scope: link.scope === "inherit" || link.scope === undefined
      ? "space"
      : link.scope,
    path: link.path,
  };
  if (link.schema != null) cellRef.schema = link.schema;
  if (link.overwrite != null) cellRef.overwrite = link.overwrite;
  if (schema !== undefined) {
    cellRef.schema = schema as JSONSchema;
  }
  const cfcLabelView = cfcLabelViewForCell(cell);
  if (cfcLabelView !== undefined) {
    cellRef.cfcLabelView = cfcLabelView;
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
  return runtime.getCellFromLink(ref, undefined, undefined, ref.cfcLabelView);
}
