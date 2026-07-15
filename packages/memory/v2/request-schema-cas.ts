import type { JSONSchema } from "@commonfabric/api";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { isPlainObject } from "@commonfabric/utils/types";
import type {
  GraphQuery,
  GraphQueryRequest,
  TransactRequest,
  WatchAddRequest,
  WatchSetRequest,
  WatchSpec,
} from "../v2.ts";
import {
  mapLinkSchemas,
  REQUEST_SCHEMA_CAS_REF_PREFIX,
} from "./schema-table-links.ts";
export { REQUEST_SCHEMA_CAS_REF_PREFIX } from "./schema-table-links.ts";
const MAX_REQUEST_SCHEMA_DEFINITIONS = 256;
const MAX_REQUEST_SCHEMA_BYTES = 256 * 1024;
const MAX_REQUEST_SCHEMA_HASH_LENGTH = 256;
const MAX_REQUEST_SCHEMA_TRAVERSAL_DEPTH = 64;
const MAX_REQUEST_SCHEMA_TRAVERSAL_NODES = 100_000;
const textEncoder = new TextEncoder();

export type RequestSchemaDefinitions = Record<string, JSONSchema>;
export type RequestSchemaCasRequest =
  | GraphQueryRequest
  | WatchSetRequest
  | WatchAddRequest
  | TransactRequest;

export type SchemaHashLookup = (hash: string) => JSONSchema | undefined;
export type SchemaDefinitionsIngest = (
  schemas: readonly JSONSchema[],
) => void;

export interface CompressRequestSchemasOptions {
  isKnownSchemaHash: (hash: string) => boolean;
  forceDefinitions?: boolean;
}

export class RequestSchemaCasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestSchemaCasError";
  }
}

export class MissingRequestSchemaDefinitionError extends RequestSchemaCasError {
  readonly hash: string;

  constructor(hash: string) {
    super(`Missing request schema definition: ${hash}`);
    this.name = "MissingRequestSchemaDefinitionError";
    this.hash = hash;
  }
}

export class InvalidRequestSchemaDefinitionsError
  extends RequestSchemaCasError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestSchemaDefinitionsError";
  }
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  isPlainObject(value);

const isSchema = (value: unknown): value is JSONSchema =>
  value === true || value === false || isPlainRecord(value);

const isSupportedRequest = (
  value: unknown,
): value is RequestSchemaCasRequest =>
  isPlainRecord(value) &&
  (value.type === "graph.query" || value.type === "session.watch.set" ||
    value.type === "session.watch.add" || value.type === "transact");

const schemaReference = (
  schema: JSONSchema,
  table: Map<string, JSONSchema>,
  options: CompressRequestSchemasOptions,
): string => {
  const canonical = internSchema(schema, true);
  if (
    options.forceDefinitions ||
    !options.isKnownSchemaHash(canonical.taggedHashString)
  ) {
    table.set(canonical.taggedHashString, canonical.schema);
  }
  return `${REQUEST_SCHEMA_CAS_REF_PREFIX}${canonical.taggedHashString}`;
};

const definitionsFitLimits = (
  definitions: ReadonlyMap<string, JSONSchema>,
): boolean => {
  if (definitions.size > MAX_REQUEST_SCHEMA_DEFINITIONS) return false;
  try {
    return [...definitions].every(([hash, schema]) =>
      hash.length <= MAX_REQUEST_SCHEMA_HASH_LENGTH &&
      textEncoder.encode(JSON.stringify(schema)).byteLength <=
        MAX_REQUEST_SCHEMA_BYTES
    );
  } catch {
    return false;
  }
};

const mapQuerySchemas = (
  query: GraphQuery,
  mapSchema: (schema: unknown) => unknown,
): GraphQuery => {
  if (!isPlainRecord(query) || !Array.isArray(query.roots)) {
    throw new InvalidRequestSchemaDefinitionsError(
      "Invalid request schema query",
    );
  }
  let changed = false;
  const roots = query.roots.map((root) => {
    if (!isPlainRecord(root) || !isPlainRecord(root.selector)) {
      throw new InvalidRequestSchemaDefinitionsError(
        "Invalid request schema query root",
      );
    }
    if (
      !Object.hasOwn(root.selector, "schema")
    ) return root;
    const schema = mapSchema(root.selector.schema);
    if (schema === root.selector.schema) return root;
    changed = true;
    return {
      ...root,
      selector: { ...root.selector, schema: schema as JSONSchema },
    };
  });
  return changed ? { ...query, roots } : query;
};

const mapWatchSchemas = (
  watches: WatchSpec[],
  mapSchema: (schema: unknown) => unknown,
): WatchSpec[] => {
  if (!Array.isArray(watches)) {
    throw new InvalidRequestSchemaDefinitionsError(
      "Invalid request schema watches",
    );
  }
  let changed = false;
  const mapped = watches.map((watch) => {
    if (!isPlainRecord(watch)) {
      throw new InvalidRequestSchemaDefinitionsError(
        "Invalid request schema watch",
      );
    }
    const query = mapQuerySchemas(watch.query, mapSchema);
    if (query === watch.query) return watch;
    changed = true;
    return { ...watch, query };
  });
  return changed ? mapped : watches;
};

const mapTransactSchemas = (
  request: TransactRequest,
  mapSchema: (schema: unknown) => unknown,
): TransactRequest => {
  if (
    !isPlainRecord(request.commit) || !Array.isArray(request.commit.operations)
  ) {
    throw new InvalidRequestSchemaDefinitionsError(
      "Invalid request schema transaction",
    );
  }
  let changed = false;
  const operations = request.commit.operations.map((operation) => {
    if (!isPlainRecord(operation)) {
      throw new InvalidRequestSchemaDefinitionsError(
        "Invalid request schema operation",
      );
    }
    if (operation.op === "set") {
      const value = mapLinkSchemas(operation.value, mapSchema);
      if (value === operation.value) return operation;
      changed = true;
      return { ...operation, value: value as typeof operation.value };
    }
    if (operation.op === "patch") {
      const patches = mapLinkSchemas(operation.patches, mapSchema);
      if (patches === operation.patches) return operation;
      changed = true;
      return { ...operation, patches: patches as typeof operation.patches };
    }
    return operation;
  });
  return changed
    ? { ...request, commit: { ...request.commit, operations } }
    : request;
};

const mapRequestSchemas = (
  request: RequestSchemaCasRequest,
  mapSchema: (schema: unknown) => unknown,
): RequestSchemaCasRequest => {
  switch (request.type) {
    case "graph.query": {
      const query = mapQuerySchemas(request.query, mapSchema);
      return query === request.query ? request : { ...request, query };
    }
    case "session.watch.set":
    case "session.watch.add": {
      const watches = mapWatchSchemas(request.watches, mapSchema);
      return watches === request.watches ? request : { ...request, watches };
    }
    case "transact":
      return mapTransactSchemas(request, mapSchema);
  }
};

export const compressRequestSchemas = <
  Request extends RequestSchemaCasRequest,
>(
  request: Request,
  options: CompressRequestSchemasOptions,
): Request => {
  const definitions = new Map<string, JSONSchema>();
  const rewritten = mapRequestSchemas(
    request,
    (value) =>
      isSchema(value) ? schemaReference(value, definitions, options) : value,
  );
  if (rewritten === request && request.schemaDefinitions === undefined) {
    return request;
  }
  if (definitions.size === 0) return rewritten as Request;

  const suppliedDefinitions = rewritten.schemaDefinitions;
  if (
    suppliedDefinitions !== undefined && !isPlainRecord(suppliedDefinitions)
  ) {
    return request;
  }
  const mergedDefinitions = new Map(definitions);
  for (const [hash, schema] of Object.entries(suppliedDefinitions ?? {})) {
    if (!isSchema(schema)) return request;
    mergedDefinitions.set(hash, schema);
  }
  if (!definitionsFitLimits(mergedDefinitions)) return request;

  const compressed = {
    ...rewritten,
    schemaDefinitions: Object.fromEntries(mergedDefinitions),
  } as Request;
  try {
    // A generated reference must remain discoverable by bounded server
    // preflight. Otherwise this optimization would turn a valid inline request
    // into a ProtocolError instead of degrading transparently.
    if (rewritten !== request && !hasRequestSchemaCasPayload(compressed)) {
      return request;
    }
  } catch (error) {
    if (error instanceof InvalidRequestSchemaDefinitionsError) return request;
    throw error;
  }
  return compressed;
};

const canonicalDefinitions = (
  value: unknown,
): RequestSchemaDefinitions => {
  if (!isPlainRecord(value)) {
    throw new InvalidRequestSchemaDefinitionsError(
      "Invalid request schema definitions",
    );
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_REQUEST_SCHEMA_DEFINITIONS) {
    throw new InvalidRequestSchemaDefinitionsError(
      `Too many request schema definitions: ${entries.length}`,
    );
  }
  const definitions: RequestSchemaDefinitions = {};
  for (const [hash, schema] of entries) {
    if (!isSchema(schema)) {
      throw new InvalidRequestSchemaDefinitionsError(
        `Invalid request schema definition: ${hash}`,
      );
    }
    const encoded = JSON.stringify(schema);
    if (textEncoder.encode(encoded).byteLength > MAX_REQUEST_SCHEMA_BYTES) {
      throw new InvalidRequestSchemaDefinitionsError(
        `Request schema definition is too large: ${hash}`,
      );
    }
    const canonical = internSchema(schema, true);
    if (canonical.taggedHashString !== hash) {
      throw new InvalidRequestSchemaDefinitionsError(
        `Request schema definition hash mismatch: ${hash}`,
      );
    }
    definitions[hash] = canonical.schema;
  }
  return definitions;
};

const expandSchema = (
  value: unknown,
  definitions: RequestSchemaDefinitions | undefined,
  lookup: SchemaHashLookup,
  referencedDefinitions: Set<string>,
): unknown => {
  if (
    typeof value !== "string" ||
    !value.startsWith(REQUEST_SCHEMA_CAS_REF_PREFIX)
  ) {
    return value;
  }
  const hash = value.slice(REQUEST_SCHEMA_CAS_REF_PREFIX.length);
  if (hash.length === 0 || hash.length > MAX_REQUEST_SCHEMA_HASH_LENGTH) {
    throw new InvalidRequestSchemaDefinitionsError(
      `Malformed request schema reference: ${value}`,
    );
  }
  const definedSchema = definitions !== undefined &&
      Object.hasOwn(definitions, hash)
    ? definitions[hash]
    : undefined;
  const schema = definedSchema ?? lookup(hash);
  if (schema === undefined) throw new MissingRequestSchemaDefinitionError(hash);
  if (definedSchema !== undefined) referencedDefinitions.add(hash);
  const canonical = internSchema(schema, true);
  if (canonical.taggedHashString !== hash) {
    throw new InvalidRequestSchemaDefinitionsError(
      `Request schema definition hash mismatch: ${hash}`,
    );
  }
  return canonical.schema;
};

export const expandRequestSchemas = (
  request: unknown,
  lookup: SchemaHashLookup,
  ingest?: SchemaDefinitionsIngest,
): RequestSchemaCasRequest => {
  if (!isSupportedRequest(request)) {
    throw new InvalidRequestSchemaDefinitionsError(
      "Unsupported request schema table message",
    );
  }
  const definitions = request.schemaDefinitions === undefined
    ? undefined
    : canonicalDefinitions(request.schemaDefinitions);
  const referencedDefinitions = new Set<string>();
  const expanded = mapRequestSchemas(
    request,
    (value) => expandSchema(value, definitions, lookup, referencedDefinitions),
  );
  if (definitions !== undefined) {
    const unused = Object.keys(definitions).filter((hash) =>
      !referencedDefinitions.has(hash)
    );
    if (unused.length > 0) {
      throw new InvalidRequestSchemaDefinitionsError(
        `Unused request schema definitions: ${unused.join(", ")}`,
      );
    }
    ingest?.(Object.values(definitions));
  }
  const { schemaDefinitions: _schemaDefinitions, ...logical } = expanded;
  return logical as RequestSchemaCasRequest;
};

/** Whether a supported request uses a CAS-only field that requires negotiation. */
export const hasRequestSchemaCasPayload = (request: unknown): boolean => {
  if (!isSupportedRequest(request)) return false;
  const hasDefinitions = request.schemaDefinitions !== undefined;

  const hasReference = (value: unknown): boolean =>
    typeof value === "string" &&
    value.startsWith(REQUEST_SCHEMA_CAS_REF_PREFIX);
  const queryHasReference = (query: unknown): boolean => {
    if (!isPlainRecord(query) || !Array.isArray(query.roots)) return false;
    return query.roots.some((root) =>
      isPlainRecord(root) && isPlainRecord(root.selector) &&
      hasReference(root.selector.schema)
    );
  };
  const watchesHaveReference = (watches: unknown): boolean =>
    Array.isArray(watches) &&
    watches.some((watch) =>
      isPlainRecord(watch) && queryHasReference(watch.query)
    );
  const scanValue = (
    value: unknown,
  ): { hasReference: boolean; exceeded: boolean } => {
    const pending: Array<{ value: unknown; depth: number }> = [{
      value,
      depth: 0,
    }];
    let nodes = 0;
    let found = false;
    let exceeded = false;
    while (pending.length > 0) {
      const current = pending.pop()!;
      nodes += 1;
      if (nodes > MAX_REQUEST_SCHEMA_TRAVERSAL_NODES) {
        exceeded = true;
        break;
      }
      if (current.depth > MAX_REQUEST_SCHEMA_TRAVERSAL_DEPTH) {
        exceeded = true;
        continue;
      }
      if (Array.isArray(current.value)) {
        for (let index = current.value.length - 1; index >= 0; index -= 1) {
          pending.push({
            value: current.value[index],
            depth: current.depth + 1,
          });
        }
        continue;
      }
      if (!isPlainRecord(current.value)) continue;

      const linkEnvelope = current.value["/"];
      const linkPayload = isPlainRecord(linkEnvelope)
        ? linkEnvelope["link@1"]
        : undefined;
      if (
        isPlainRecord(linkPayload) &&
        Object.hasOwn(linkPayload, "schema") &&
        hasReference(linkPayload.schema)
      ) found = true;
      const alias = current.value.$alias;
      if (
        isPlainRecord(alias) && Object.hasOwn(alias, "schema") &&
        hasReference(alias.schema)
      ) found = true;

      const children = Object.values(current.value);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pending.push({ value: children[index], depth: current.depth + 1 });
      }
    }
    return { hasReference: found, exceeded };
  };

  switch (request.type) {
    case "graph.query":
      return hasDefinitions || queryHasReference(request.query);
    case "session.watch.set":
    case "session.watch.add":
      return hasDefinitions || watchesHaveReference(request.watches);
    case "transact": {
      if (
        !isPlainRecord(request.commit) ||
        !Array.isArray(request.commit.operations)
      ) return hasDefinitions;
      let hasReference = false;
      let exceeded = false;
      for (const operation of request.commit.operations) {
        if (!isPlainRecord(operation)) continue;
        let scan: ReturnType<typeof scanValue> | undefined;
        if (operation.op === "set") scan = scanValue(operation.value);
        if (operation.op === "patch") scan = scanValue(operation.patches);
        if (scan !== undefined) {
          hasReference ||= scan.hasReference;
          exceeded ||= scan.exceeded;
        }
      }
      if (exceeded && (hasDefinitions || hasReference)) {
        throw new InvalidRequestSchemaDefinitionsError(
          "Request schema traversal limit exceeded",
        );
      }
      return hasDefinitions || hasReference;
    }
  }
};
