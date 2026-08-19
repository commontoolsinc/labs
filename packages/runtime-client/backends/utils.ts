import {
  FabricInstance,
  type FabricPlainObject,
  FabricPrimitive,
  type FabricValue,
  isFabricPlainObject,
  isFabricValue,
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
import {
  isSigilLink,
  linkRefFrom,
  refuseFabricInstance,
} from "@commonfabric/runner/shared";

import { isCellRef } from "../protocol/mod.ts";
import { CellRef, type LoggerFlagsData, PageRef } from "../protocol/types.ts";

/**
 * Converts a value arriving over the connection into the form the worker
 * writes: every `CellRef` in it becomes a `SigilLink`, and every raw
 * `SigilLink` loses its label view.
 *
 * A cell's value is a `FabricValue`, as are a `CellRef` and a `SigilLink`, so
 * the conversion moves within that type. The result holds no `CellRef`.
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
    // Atomic, so there is nothing under it to map. It goes _before_ the record
    // branch: one is also a record, and that branch rebuilds from enumerable
    // own properties a fabric class does not have, which would put `{}` here in
    // place of the value.
    return value;
  } else if (value instanceof FabricInstance) {
    // A `FabricInstance` is refused. Its codec contents can carry a link, and
    // those contents are not reachable by property name -- so the record
    // branch below would rebuild one from enumerable own properties it does
    // not have, yielding `{}` and losing whatever it holds, and passing it
    // through whole would leave any link inside it unmapped.
    //
    // Nothing reaches this in production today, de facto rather than by
    // construction: no flag gates it. The two callers pass a value that
    // arrived by structured cloning, which strips a fabric class, so one
    // cannot reach them as an instance at all; what would reach this is a
    // direct caller, and there is none. `CellHandle.serialize()` in
    // `../cell-handle.ts` refuses a `FabricSpecialObject` earlier still.
    //
    // TODO(danfuzz): descend by codec-mediated traversal into instance state,
    // at which point this becomes a walk rather than a refusal.
    refuseFabricInstance(value, "when mapping cell refs to sigil links");
  } else if (typeof value === "object" && value) {
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

/**
 * Vets a logger flag breakdown for the connection. A flag's metadata is
 * whatever its caller passed -- `Logger` takes a `Record<string, unknown>` and
 * constrains it no further -- so this is where it becomes a `FabricValue` or
 * does not travel.
 *
 * Metadata that does not vet is carried as `null`, which is what a flag set
 * without metadata carries: the flag's presence survives, its metadata does
 * not. Vetting here rather than at the logger keeps the constraint on what
 * crosses instead of on every caller that raises a flag.
 */
export function vetLoggerFlags(
  breakdown: Record<
    string,
    Record<string, Record<string, Record<string, unknown> | null>>
  >,
): LoggerFlagsData {
  const out: LoggerFlagsData = {};
  for (const [logger, flags] of Object.entries(breakdown)) {
    const byFlag: Record<string, Record<string, FabricPlainObject | null>> = {};
    for (const [flag, byId] of Object.entries(flags)) {
      const vetted: Record<string, FabricPlainObject | null> = {};
      for (const [id, metadata] of Object.entries(byId)) {
        // `isFabricValue()` is the validating half and runs first;
        // `isFabricPlainObject()` takes a value it has already accepted, which
        // is why the two are spelled together rather than either alone.
        vetted[id] = (metadata !== null) && isFabricValue(metadata) &&
            isFabricPlainObject(metadata)
          ? metadata
          : null;
      }
      byFlag[flag] = vetted;
    }
    out[logger] = byFlag;
  }
  return out;
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
