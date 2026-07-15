import type { JSONSchema } from "@commonfabric/api";
import { jsonFromValue } from "@commonfabric/data-model/codec-json";
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
  type LinkSchemaTraversal,
  mapLinkSchemas,
  REQUEST_SCHEMA_CAS_REF_PREFIX,
} from "./schema-table-links.ts";
export { REQUEST_SCHEMA_CAS_REF_PREFIX } from "./schema-table-links.ts";
const MAX_REQUEST_SCHEMA_DEFINITIONS = 256;
const MAX_REQUEST_SCHEMA_BYTES = 256 * 1024;
const MAX_REQUEST_SCHEMA_HASH_LENGTH = 256;
const MAX_REQUEST_SCHEMA_TRAVERSAL_DEPTH = 64;
const MAX_REQUEST_SCHEMA_TRAVERSAL_NODES = 100_000;
const MAX_REQUEST_SCHEMA_POSITIONS = 100_000;
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

interface RequestSchemaTraversal extends LinkSchemaTraversal {
  nodes: number;
  positions: number;
}

const createRequestSchemaTraversal = (): RequestSchemaTraversal => ({
  nodes: 0,
  positions: 0,
  visitNode(depth) {
    this.nodes += 1;
    if (
      depth > MAX_REQUEST_SCHEMA_TRAVERSAL_DEPTH ||
      this.nodes > MAX_REQUEST_SCHEMA_TRAVERSAL_NODES
    ) {
      throw new InvalidRequestSchemaDefinitionsError(
        "Request schema traversal limit exceeded",
      );
    }
  },
  visitSchemaPosition() {
    this.positions += 1;
    if (this.positions > MAX_REQUEST_SCHEMA_POSITIONS) {
      throw new InvalidRequestSchemaDefinitionsError(
        "Request schema traversal limit exceeded",
      );
    }
  },
});

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
    let totalBytes = 0;
    for (const [hash, schema] of definitions) {
      if (hash.length > MAX_REQUEST_SCHEMA_HASH_LENGTH) return false;
      const canonical = internSchema(schema, true).schema;
      const bytes = textEncoder.encode(jsonFromValue(canonical)).byteLength;
      if (bytes > MAX_REQUEST_SCHEMA_BYTES) return false;
      totalBytes += bytes;
      if (totalBytes > MAX_REQUEST_SCHEMA_BYTES) return false;
    }
    return true;
  } catch {
    return false;
  }
};

const mapQuerySchemas = (
  query: GraphQuery,
  mapSchema: (schema: unknown) => unknown,
  traversal: RequestSchemaTraversal,
): GraphQuery => {
  traversal.visitNode(0);
  if (!isPlainRecord(query) || !Array.isArray(query.roots)) {
    throw new InvalidRequestSchemaDefinitionsError(
      "Invalid request schema query",
    );
  }
  let changed = false;
  const roots = query.roots.map((root) => {
    traversal.visitNode(1);
    if (!isPlainRecord(root) || !isPlainRecord(root.selector)) {
      throw new InvalidRequestSchemaDefinitionsError(
        "Invalid request schema query root",
      );
    }
    if (
      !Object.hasOwn(root.selector, "schema")
    ) return root;
    traversal.visitSchemaPosition();
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
  traversal: RequestSchemaTraversal,
): WatchSpec[] => {
  if (!Array.isArray(watches)) {
    throw new InvalidRequestSchemaDefinitionsError(
      "Invalid request schema watches",
    );
  }
  let changed = false;
  const mapped = watches.map((watch) => {
    traversal.visitNode(0);
    if (!isPlainRecord(watch)) {
      throw new InvalidRequestSchemaDefinitionsError(
        "Invalid request schema watch",
      );
    }
    const query = mapQuerySchemas(watch.query, mapSchema, traversal);
    if (query === watch.query) return watch;
    changed = true;
    return { ...watch, query };
  });
  return changed ? mapped : watches;
};

const mapTransactSchemas = (
  request: TransactRequest,
  mapSchema: (schema: unknown) => unknown,
  traversal: RequestSchemaTraversal,
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
    traversal.visitNode(0);
    if (!isPlainRecord(operation)) {
      throw new InvalidRequestSchemaDefinitionsError(
        "Invalid request schema operation",
      );
    }
    if (operation.op === "set") {
      const value = mapLinkSchemas(operation.value, mapSchema, traversal);
      if (value === operation.value) return operation;
      changed = true;
      return { ...operation, value: value as typeof operation.value };
    }
    if (operation.op === "patch") {
      const patches = mapLinkSchemas(operation.patches, mapSchema, traversal);
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
  traversal = createRequestSchemaTraversal(),
): RequestSchemaCasRequest => {
  switch (request.type) {
    case "graph.query": {
      const query = mapQuerySchemas(request.query, mapSchema, traversal);
      return query === request.query ? request : { ...request, query };
    }
    case "session.watch.set":
    case "session.watch.add": {
      const watches = mapWatchSchemas(request.watches, mapSchema, traversal);
      return watches === request.watches ? request : { ...request, watches };
    }
    case "transact":
      return mapTransactSchemas(request, mapSchema, traversal);
  }
};

/**
 * Collect CAS hashes only from schema-bearing positions supported by a request
 * envelope. This shares compression and expansion's schema traversal rather
 * than interpreting arbitrary user strings.
 */
export const collectRequestSchemaCasHashes = (
  request: unknown,
): ReadonlySet<string> => {
  if (!isSupportedRequest(request)) {
    throw new InvalidRequestSchemaDefinitionsError(
      "Unsupported request schema table message",
    );
  }
  const hashes = new Set<string>();
  mapRequestSchemas(request, (value) => {
    if (
      typeof value === "string" &&
      value.startsWith(REQUEST_SCHEMA_CAS_REF_PREFIX)
    ) {
      const hash = value.slice(REQUEST_SCHEMA_CAS_REF_PREFIX.length);
      if (hash.length > 0 && hash.length <= MAX_REQUEST_SCHEMA_HASH_LENGTH) {
        hashes.add(hash);
      }
    }
    return value;
  });
  return hashes;
};

export const compressRequestSchemas = <
  Request extends RequestSchemaCasRequest,
>(
  request: Request,
  options: CompressRequestSchemasOptions,
): Request => {
  const definitions = new Map<string, JSONSchema>();
  let rewritten: RequestSchemaCasRequest;
  try {
    rewritten = mapRequestSchemas(
      request,
      (value) =>
        isSchema(value) ? schemaReference(value, definitions, options) : value,
    );
  } catch (error) {
    if (error instanceof InvalidRequestSchemaDefinitionsError) return request;
    throw error;
  }
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
  let totalBytes = 0;
  for (const [hash, schema] of entries) {
    if (hash.length > MAX_REQUEST_SCHEMA_HASH_LENGTH) {
      throw new InvalidRequestSchemaDefinitionsError(
        `Request schema definition hash is too long: ${hash}`,
      );
    }
    if (!isSchema(schema)) {
      throw new InvalidRequestSchemaDefinitionsError(
        `Invalid request schema definition: ${hash}`,
      );
    }
    let canonical: ReturnType<typeof internSchema>;
    let encoded: string;
    try {
      canonical = internSchema(schema, true);
      encoded = jsonFromValue(canonical.schema);
    } catch {
      throw new InvalidRequestSchemaDefinitionsError(
        `Invalid request schema definition: ${hash}`,
      );
    }
    const bytes = textEncoder.encode(encoded).byteLength;
    if (bytes > MAX_REQUEST_SCHEMA_BYTES) {
      throw new InvalidRequestSchemaDefinitionsError(
        `Request schema definition is too large: ${hash}`,
      );
    }
    totalBytes += bytes;
    if (totalBytes > MAX_REQUEST_SCHEMA_BYTES) {
      throw new InvalidRequestSchemaDefinitionsError(
        "Request schema definitions are too large",
      );
    }
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
  resolvedSchemas: Map<string, JSONSchema>,
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
  if (definedSchema !== undefined) referencedDefinitions.add(hash);
  const resolved = resolvedSchemas.get(hash);
  if (resolved !== undefined) return resolved;
  const schema = definedSchema ?? lookup(hash);
  if (schema === undefined) throw new MissingRequestSchemaDefinitionError(hash);
  const canonical = definedSchema === undefined ? internSchema(schema, true) : {
    schema,
    taggedHashString: hash,
  };
  if (canonical.taggedHashString !== hash) {
    throw new InvalidRequestSchemaDefinitionsError(
      `Request schema definition hash mismatch: ${hash}`,
    );
  }
  resolvedSchemas.set(hash, canonical.schema);
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
  const resolvedSchemas = new Map<string, JSONSchema>();
  const expanded = mapRequestSchemas(
    request,
    (value) =>
      expandSchema(
        value,
        definitions,
        lookup,
        referencedDefinitions,
        resolvedSchemas,
      ),
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
  const traversal = createRequestSchemaTraversal();
  const queryHasReference = (query: unknown): boolean => {
    traversal.visitNode(0);
    if (!isPlainRecord(query) || !Array.isArray(query.roots)) return false;
    let found = false;
    for (const root of query.roots) {
      traversal.visitNode(1);
      if (!isPlainRecord(root) || !isPlainRecord(root.selector)) continue;
      if (!Object.hasOwn(root.selector, "schema")) continue;
      traversal.visitSchemaPosition();
      found ||= hasReference(root.selector.schema);
    }
    return found;
  };
  const watchesHaveReference = (watches: unknown): boolean => {
    if (!Array.isArray(watches)) return false;
    let found = false;
    for (const watch of watches) {
      traversal.visitNode(0);
      if (isPlainRecord(watch)) found ||= queryHasReference(watch.query);
    }
    return found;
  };
  const scanValue = (
    value: unknown,
  ): { hasReference: boolean; exceeded: boolean } => {
    const pending: Array<{ value: unknown; depth: number }> = [{
      value,
      depth: 0,
    }];
    let found = false;
    let exceeded = false;
    while (pending.length > 0) {
      const current = pending.pop()!;
      traversal.nodes += 1;
      if (traversal.nodes > MAX_REQUEST_SCHEMA_TRAVERSAL_NODES) {
        return { hasReference: found, exceeded: true };
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
      if (isPlainRecord(linkPayload) && Object.hasOwn(linkPayload, "schema")) {
        traversal.visitSchemaPosition();
        found ||= hasReference(linkPayload.schema);
      }
      const alias = current.value.$alias;
      if (isPlainRecord(alias) && Object.hasOwn(alias, "schema")) {
        traversal.visitSchemaPosition();
        found ||= hasReference(alias.schema);
      }

      const children = Object.values(current.value);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pending.push({ value: children[index], depth: current.depth + 1 });
      }
    }
    return { hasReference: found, exceeded };
  };
  let foundReference = false;
  let exceeded = false;
  try {
    switch (request.type) {
      case "graph.query":
        foundReference = queryHasReference(request.query);
        break;
      case "session.watch.set":
      case "session.watch.add":
        foundReference = watchesHaveReference(request.watches);
        break;
      case "transact": {
        if (
          !isPlainRecord(request.commit) ||
          !Array.isArray(request.commit.operations)
        ) break;
        for (const operation of request.commit.operations) {
          traversal.visitNode(0);
          if (!isPlainRecord(operation)) continue;
          if (operation.op === "set") {
            const scan = scanValue(operation.value);
            foundReference ||= scan.hasReference;
            exceeded ||= scan.exceeded;
          }
          if (operation.op === "patch") {
            const scan = scanValue(operation.patches);
            foundReference ||= scan.hasReference;
            exceeded ||= scan.exceeded;
          }
        }
        break;
      }
    }
  } catch (error) {
    if (error instanceof InvalidRequestSchemaDefinitionsError) {
      throw error;
    }
    throw error;
  }
  if (exceeded) {
    throw new InvalidRequestSchemaDefinitionsError(
      "Request schema traversal limit exceeded",
    );
  }
  return hasDefinitions || foundReference;
};
