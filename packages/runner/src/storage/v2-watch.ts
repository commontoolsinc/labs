import { hashSchema } from "@commonfabric/data-model/schema-hash";
import {
  internPathSelector,
  REJECTING_SELECTOR,
} from "@commonfabric/data-model/schema-utils";
import type { MIME } from "@commonfabric/memory/interface";
import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { ContextualFlowControl } from "../cfc.ts";
import { SelectorTracker } from "./selector-tracker.ts";
import type {
  PullError,
  Result,
  SchemaPathSelector,
  Unit,
  URI,
} from "./interface.ts";

const DOCUMENT_MIME = "application/json" as const;

export const normalizeSyncSelector = (
  selector: SchemaPathSelector | undefined,
): SchemaPathSelector => {
  if (selector === undefined || selector.schema === false) {
    return REJECTING_SELECTOR;
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
    const baseAddress = { id: address.id, type: DOCUMENT_MIME, path: [] };
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
  hashStringOf({
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
    hashStringOf({
      branch,
      id: address.id,
      type: DOCUMENT_MIME,
      selector: selectorIdentity(selector),
    })
  }`;
