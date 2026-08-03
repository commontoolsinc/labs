import { hashSchema } from "@commonfabric/data-model/schema-hash";
import {
  internPathSelector,
  REJECTING_SELECTOR,
} from "@commonfabric/data-model/schema-utils";
import type { MIME } from "@commonfabric/memory/interface";
import type { CellScope } from "@commonfabric/memory/v2";
import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { ContextualFlowControl } from "../cfc.ts";
import { pruneCfcSchemaDefinitions } from "../cfc/schema-refs.ts";
import { SelectorTracker } from "./selector-tracker.ts";
import type { SchemaPathSelector } from "@commonfabric/api";
import type { PullError, Result, Unit, URI } from "./interface.ts";

const DOCUMENT_MIME = "application/json" as const;
type ScopedWatchAddress = { id: URI; type: MIME; scope?: CellScope };

export const normalizeSyncSelector = (
  selector: SchemaPathSelector | undefined,
): SchemaPathSelector => {
  if (selector === undefined || selector.schema === false) {
    return REJECTING_SELECTOR;
  }
  const schema = selector.schema === undefined
    ? undefined
    : pruneCfcSchemaDefinitions(selector.schema);
  return internPathSelector(
    schema === selector.schema ? selector : { path: selector.path, schema },
  );
};

export const normalizeSyncEntries = (
  entries: [ScopedWatchAddress, SchemaPathSelector | undefined][],
): [ScopedWatchAddress, SchemaPathSelector][] =>
  entries.map((
    [address, selector],
  ) => [address, normalizeSyncSelector(selector)]);

export const compactWatchEntries = (
  entries: [ScopedWatchAddress, SchemaPathSelector][],
): [ScopedWatchAddress, SchemaPathSelector][] => {
  const tracker = new SelectorTracker<Result<Unit, PullError>>();
  const cfc = new ContextualFlowControl();
  const compacted: [ScopedWatchAddress, SchemaPathSelector][] = [];

  for (const entry of entries) {
    const [address, selector] = entry;
    const baseAddress = {
      id: address.id,
      type: DOCUMENT_MIME,
      path: [],
      scope: address.scope ?? "space",
    };
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
  address: ScopedWatchAddress,
  selector: SchemaPathSelector,
  branch = "",
  lane = "space",
): string =>
  `replica:${
    hashStringOf({
      branch,
      id: address.id,
      scope: address.scope ?? "space",
      type: DOCUMENT_MIME,
      selector: selectorIdentity(selector),
      // Same address + selector under two acting lanes are two watches: the
      // host resolves their scoped roots to different instances (C1.5b).
      // Spread keeps space-lane watch ids byte-identical to pre-lane ids.
      ...(lane !== "space" ? { lane } : {}),
    })
  }`;
