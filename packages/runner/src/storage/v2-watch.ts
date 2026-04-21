import { hashSchema } from "@commonfabric/data-model/schema-hash";
import { internPathSelector } from "@commonfabric/data-model/schema-utils";
import type { MIME } from "@commonfabric/memory/interface";
import { stableHash } from "../traverse.ts";
import { ContextualFlowControl } from "../cfc.ts";
import { SelectorTracker } from "./cache.ts";
import type {
  PullError,
  Result,
  SchemaPathSelector,
  Unit,
  URI,
} from "./interface.ts";

// Canonical "reject everything at the root" selector returned when
// `normalizeSyncSelector` is given `undefined` or `{ schema: false, ... }`.
// Interned on module load; reused by reference.
const NORMALIZED_REJECT: SchemaPathSelector = internPathSelector({
  path: [],
  schema: false,
});

export const normalizeSyncSelector = (
  selector: SchemaPathSelector | undefined,
): SchemaPathSelector => {
  if (selector === undefined || selector.schema === false) {
    return NORMALIZED_REJECT;
  }
  return internPathSelector(selector);
};

export const normalizeSyncEntries = (
  entries: [{ id: URI; type: MIME }, SchemaPathSelector | undefined][],
): [{ id: URI; type: MIME }, SchemaPathSelector][] =>
  entries.map((
    [address, selector],
  ) => [address, normalizeSyncSelector(selector)]);

export const compactWatchEntries = (
  entries: [{ id: URI; type: MIME }, SchemaPathSelector][],
): [{ id: URI; type: MIME }, SchemaPathSelector][] => {
  const tracker = new SelectorTracker<Result<Unit, PullError>>();
  const cfc = new ContextualFlowControl();
  const compacted: [{ id: URI; type: MIME }, SchemaPathSelector][] = [];

  for (const entry of entries) {
    const [address, selector] = entry;
    const baseAddress = { id: address.id, type: address.type, path: [] };
    const [superset] = tracker.getSupersetSelector(
      baseAddress,
      selector,
      cfc,
    );
    if (superset !== undefined) {
      continue;
    }
    tracker.add(
      baseAddress,
      selector,
      Promise.resolve({ ok: {} } as Result<Unit, PullError>),
    );
    compacted.push(entry);
  }

  return compacted;
};

const selectorIdentity = (selector: SchemaPathSelector): string =>
  stableHash({
    path: selector.path,
    schemaHash: selector.schema === undefined
      ? ""
      : hashSchema(selector.schema),
  });

export const watchIdForEntry = (
  address: { id: URI; type: MIME },
  selector: SchemaPathSelector,
  branch = "",
): string =>
  `replica:${
    stableHash({
      branch,
      id: address.id,
      type: address.type,
      selector: selectorIdentity(selector),
    })
  }`;
