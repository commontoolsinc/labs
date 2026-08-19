import {
  FabricPrimitive,
  type FabricValue,
} from "@commonfabric/data-model/fabric-value";
import {
  Cell,
  JSONSchema,
  KeepAsCell,
  parseLink,
  Runtime,
  SigilLink,
} from "@commonfabric/runner";
import {
  type CfcCellLinkRefPayload,
  cfcLabelViewForCell,
  redactCaveatSourcesForDisplay,
  stripSigilCfcLabelViews,
} from "@commonfabric/runner/cfc";
import { isSigilLink, linkRefFrom } from "@commonfabric/runner/shared";

import { isCellRef } from "../protocol/mod.ts";
import { CellRef, PageRef } from "../protocol/types.ts";

/**
 * Converts a value arriving over the connection into the form the worker
 * writes: every `CellRef` in it becomes a `SigilLink`, and every raw
 * `SigilLink` loses its label view.
 *
 * A cell's value is a `FabricValue`, so that is the domain both ways, and a
 * `CellRef` is one too -- the conversion moves within the type rather than
 * across it. That the result holds no `CellRef` is therefore a fact about this
 * function and not something its return type states; a narrower name for the
 * result would only seem to exclude them.
 */
export function mapCellRefsToSigilLinks(value: FabricValue): FabricValue {
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
    //
    // `stripSigilCfcLabelViews()` reports `unknown`, being general over what it
    // walks. Narrowed here by what it does: it removes a property from each
    // link payload it finds, so given a link it returns one.
    return stripSigilCfcLabelViews(value) as SigilLink;
  } else if (value instanceof FabricPrimitive) {
    // Atomic, so there is nothing under it to map and handing it back whole is
    // the complete answer rather than a deferral. It goes _before_ the record
    // branch: one is also a record, and that branch rebuilds from enumerable
    // own properties a fabric class does not have, which would put `{}` here in
    // place of the value.
    return value;
  } else if (typeof value === "object" && value) {
    // TODO(danfuzz): descend a `FabricInstance` by its codec contents, at
    // which point this becomes a walk rather than a silent flattening. This is
    // the one arm of the declared domain that is not yet served: an instance
    // reaches here and the rebuild below reads enumerable own properties it
    // does not have, so it leaves as `{}`. Handing one back whole instead is
    // no better, unlike the primitive above -- an instance can hold a link in
    // its contents, which would then go unmapped -- so which disposition to
    // take meanwhile is open. What keeps it from arising today is
    // `CellHandle.serialize()` in `../cell-handle.ts`, which refuses a
    // `FabricSpecialObject` before it can reach this walk; the marker on
    // `WireCellValue` in `../protocol/types.ts` states the same gap at the
    // type.
    return Object.entries(value).reduce(
      (acc: Record<string, FabricValue>, [k, v]) => {
        acc[k] = mapCellRefsToSigilLinks(v);
        return acc;
      },
      {},
    );
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
