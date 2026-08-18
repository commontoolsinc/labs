import type { SchemaPathSelector } from "@commonfabric/api";
import { hashSchema } from "@commonfabric/data-model/schema-hash";
import {
  internPathSelector,
  REJECTING_SELECTOR,
} from "@commonfabric/data-model/schema-utils";
import { hashStringOf } from "@commonfabric/data-model/value-hash";
import type { MIME } from "@commonfabric/memory/interface";
import type { CellScope } from "@commonfabric/memory/v2";

import type { JSONSchemaObj } from "@commonfabric/api";

import { pruneCfcSchemaDefinitions } from "../cfc/schema-refs.ts";
import {
  decomposeSchema,
  SchemaNotDecomposableError,
} from "../schema-decompose.ts";
import { getContentAddressedSchemasConfig } from "../schema-doc-config.ts";
import {
  lookupSchemaDocument,
  registerSchemaDocument,
} from "../schema-registry.ts";
import type { PullError, Result, Unit, URI } from "./interface.ts";
import { SelectorTracker } from "./selector-tracker.ts";

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

/**
 * Replaces a selector's inline schema with a reference to content-addressed
 * schema documents (`docs/specs/content-addressed-schemas.md`, Phase 2;
 * `contentAddressedSelectorSchemas` flag). A selector externalizes only
 * when `isSchemaDocPersisted` confirms its whole closure in the target
 * space — local presence implies server presence, since a document is
 * local by delivery or by this client's own commit and can never change —
 * and falls back to the inline form otherwise, exactly as with the flag
 * off. A schema decomposition refuses stays inline the same way.
 */
export const externalizeSyncSelector = (
  selector: SchemaPathSelector,
  isSchemaDocPersisted: (hash: string) => boolean,
): SchemaPathSelector => {
  if (!getContentAddressedSchemasConfig()) return selector;
  const schema = selector.schema;
  if (schema === undefined || typeof schema === "boolean") return selector;
  const keys = Object.keys(schema);
  if (keys.length === 1 && keys[0] === "$ref") return selector;
  try {
    const { rootRef, documents } = decomposeSchema(schema as JSONSchemaObj, {
      resolveDocument: lookupSchemaDocument,
    });
    for (const [hash, document] of documents) {
      registerSchemaDocument(hash, document);
    }
    for (const hash of documents.keys()) {
      if (!isSchemaDocPersisted(hash)) return selector;
    }
    return internPathSelector({
      path: selector.path,
      schema: { $ref: rootRef },
    });
  } catch (error) {
    if (error instanceof SchemaNotDecomposableError) return selector;
    throw error;
  }
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
    })
  }`;
