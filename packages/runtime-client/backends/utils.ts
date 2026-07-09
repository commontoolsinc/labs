import {
  Cell,
  JSONSchema,
  KeepAsCell,
  parseLink,
  SigilLink,
} from "@commonfabric/runner";
import {
  cfcLabelViewForCell,
  redactCaveatSourcesForDisplay,
  stripSigilCfcLabelViews,
} from "@commonfabric/runner/cfc";
import { CellRef, PageRef } from "../protocol/types.ts";
import { Runtime } from "@commonfabric/runner";
import { isSigilLink, linkRefFrom } from "@commonfabric/runner/shared";
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
  } else if (isSigilLink(value)) {
    // A RAW sigil link in an inbound value bypasses the CellRef branch above
    // (hand-crafted JSON, or a CellHandle serialized into CustomEvent.detail
    // via toJSON). Its label view is a main-thread display artifact like a
    // ref's (inv-12 Stage 0) — drop it so it never becomes a link-write
    // policy input.
    return stripSigilCfcLabelViews(value);
  } else if (typeof value === "object" && value) {
    return Object.entries(value).reduce((acc: Record<string, any>, [k, v]) => {
      acc[k] = mapCellRefsToSigilLinks(v);
      return acc;
    }, {});
  }
  return value;
}

export function cellRefToSigilLink(cell: CellRef): SigilLink {
  // A `cfcLabelView` on an inbound CellRef is deliberately NOT forwarded
  // (inv-12 Stage 0 / SC-25): it round-tripped through the main thread
  // (CellHandle.deserialize keeps the view on the ref) and is
  // main-thread-influenceable — an untrusted display artifact. Forwarding it
  // onto the written sigil link previously made it a link-write policy input
  // that prepareBoundaryCommit persisted as link-origin labels; the worker
  // re-derives those from its own stored source metadata instead.
  return linkRefFrom<CfcCellLinkRefPayload>({
    id: cell.id,
    space: cell.space,
    scope: cell.scope,
    path: cell.path,
    ...(cell.schema !== undefined && { schema: cell.schema }),
    ...(cell.overwrite !== undefined && { overwrite: cell.overwrite }),
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
    // Ref-attached views are main-thread display copies like the in-value
    // sigil views: redact Caveat.source before they cross (inv-12 Stage 0).
    // The worker never re-imports them (see getCell / cellRefToSigilLink),
    // so the redacted copy cannot round-trip into label state.
    cellRef.cfcLabelView = redactCaveatSourcesForDisplay(cfcLabelView);
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
  //
  // `ref.cfcLabelView` is deliberately NOT seeded into the worker cell
  // (inv-12 Stage 0 / SC-25): an inbound view is a main-thread display
  // artifact, not worker label state. The worker derives label views from
  // its own stored metadata (`cfcLabelViewForCell`); outbound refs still
  // carry a view for the client's display. Stripped from the ref object
  // itself because getCellFromLink also reads the property off
  // normalized-link-shaped inputs.
  if (ref.cfcLabelView === undefined) {
    return runtime.getCellFromLink(ref);
  }
  const { cfcLabelView: _cfcLabelView, ...cleanRef } = ref;
  return runtime.getCellFromLink(cleanRef);
}
