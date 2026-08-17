import { hashSchema } from "@commonfabric/data-model/schema-hash";
import {
  internPathSelector,
  REJECTING_SELECTOR,
} from "@commonfabric/data-model/schema-utils";
import type { MIME } from "@commonfabric/memory/interface";
import type {
  CellScope,
  ScopeKey,
  ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { pruneCfcSchemaDefinitions } from "../cfc/schema-refs.ts";
import { SelectorTracker } from "./selector-tracker.ts";
import type { SchemaPathSelector } from "@commonfabric/api";
import type { PullError, Result, Unit, URI } from "./interface.ts";

const DOCUMENT_MIME = "application/json" as const;
type ScopedWatchAddress = {
  id: URI;
  type: MIME;
  scope?: CellScope;
  /** The explicit scope INSTANCE an instance-named load targets
   * (server-execution v2 stage A); absent = the session's own. */
  scopeKey?: ScopeKey;
};

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
  identity: ScopeKeyIdentity,
): [ScopedWatchAddress, SchemaPathSelector][] => {
  const tracker = new SelectorTracker<Result<Unit, PullError>>(() => identity);
  const compacted: [ScopedWatchAddress, SchemaPathSelector][] = [];

  for (const entry of entries) {
    const [address, selector] = entry;
    const baseAddress = {
      id: address.id,
      type: DOCUMENT_MIME,
      path: [],
      scope: address.scope ?? "space",
      ...(address.scopeKey !== undefined ? { scopeKey: address.scopeKey } : {}),
    };
    const [superset] = tracker.getSupersetSelector(
      baseAddress,
      selector,
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
): string =>
  `replica:${
    hashStringOf({
      branch,
      id: address.id,
      scope: address.scope ?? "space",
      type: DOCUMENT_MIME,
      selector: selectorIdentity(selector),
      // The explicit instance (stage A) is watch identity: two instances
      // of one doc are two watches, never merged by id. Absent from the
      // hashed object when unnamed, so the OFF-arm id is byte-identical.
      ...(address.scopeKey !== undefined ? { scopeKey: address.scopeKey } : {}),
    })
  }`;
