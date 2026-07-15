import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { LINK_V1_TAG } from "@commonfabric/data-model/cell-rep";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import type { JSONSchema } from "@commonfabric/api";
import type {
  EntityDocument,
  GraphQueryRequest,
  TransactRequest,
  WatchAddRequest,
  WatchSetRequest,
} from "../v2.ts";
import {
  compressRequestSchemas,
  expandRequestSchemas,
  hasRequestSchemaCasPayload,
  InvalidRequestSchemaDefinitionsError,
  MissingRequestSchemaDefinitionError,
} from "../v2/request-schema-cas.ts";

const schema: JSONSchema = {
  type: "object",
  properties: { title: { type: "string" } },
};
const equivalentSchema: JSONSchema = {
  properties: { title: { type: "string" } },
  type: "object",
};
const hash = internSchema(schema, true).taggedHashString;
const noKnownSchemas = () => false;

const graphRequest = (): GraphQueryRequest => ({
  type: "graph.query",
  requestId: "query",
  space: "did:key:request-schema-cas",
  sessionId: "session:request-schema-cas",
  query: {
    roots: [{ id: "of:root", selector: { path: [], schema } }],
  },
});

const watchRequest = <Type extends "session.watch.set" | "session.watch.add">(
  type: Type,
): Type extends "session.watch.set" ? WatchSetRequest : WatchAddRequest => ({
  type,
  requestId: "watch",
  space: "did:key:request-schema-cas",
  sessionId: "session:request-schema-cas",
  watches: [{
    id: "root",
    kind: "graph",
    query: {
      roots: [{ id: "of:root", selector: { path: [], schema } }],
    },
  }],
} as Type extends "session.watch.set" ? WatchSetRequest : WatchAddRequest);

const transactRequest = (): TransactRequest => ({
  type: "transact",
  requestId: "transact",
  space: "did:key:request-schema-cas",
  sessionId: "session:request-schema-cas",
  commit: {
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [
      {
        op: "set",
        id: "of:set",
        value: {
          ref: {
            "/": { [LINK_V1_TAG]: { id: "of:modern", path: [], schema } },
          },
          legacy: { $alias: { id: "of:legacy", path: [], schema } },
          fake: { schema },
        },
      },
      {
        op: "patch",
        id: "of:patch",
        patches: [{
          op: "add",
          path: "/nested",
          value: [{
            "/": {
              [LINK_V1_TAG]: { id: "of:patched", path: [], schema },
            },
          }],
        }],
      },
    ],
  },
});

const schemaAtSelector = (
  request: unknown,
): unknown => ((request as {
  query: { roots: Array<{ selector: { schema?: unknown } }> };
})
  .query.roots[0].selector.schema);

Deno.test("request schema CAS definitions canonicalize structural equals and expand inline", () => {
  const request = graphRequest();
  request.query.roots.push({
    id: "of:equivalent",
    selector: { path: [], schema: equivalentSchema },
  });

  const compressed = compressRequestSchemas(request, {
    isKnownSchemaHash: noKnownSchemas,
  });

  assertEquals(Object.keys(compressed.schemaDefinitions ?? {}), [hash]);
  assertEquals(schemaAtSelector(compressed), `schema-cas@1:${hash}`);
  assertEquals(
    schemaAtSelector({ query: { roots: [compressed.query.roots[1]] } }),
    `schema-cas@1:${hash}`,
  );
  assertEquals(expandRequestSchemas(compressed, () => undefined), request);
});

Deno.test("request schema CAS definitions respect known hashes and force definitions", () => {
  const request = graphRequest();
  const known = compressRequestSchemas(request, {
    isKnownSchemaHash: (candidate) => candidate === hash,
  });
  assertEquals(known.schemaDefinitions, undefined);
  assertEquals(schemaAtSelector(known), `schema-cas@1:${hash}`);
  assertEquals(
    expandRequestSchemas(
      known,
      (candidate) => candidate === hash ? schema : undefined,
    ),
    request,
  );

  const forced = compressRequestSchemas(request, {
    isKnownSchemaHash: () => true,
    forceDefinitions: true,
  });
  assertEquals(Object.keys(forced.schemaDefinitions ?? {}), [hash]);
});

Deno.test("request schema CAS rewrites only selectors and transact link schemas", () => {
  const graph = compressRequestSchemas(graphRequest(), {
    isKnownSchemaHash: noKnownSchemas,
  });
  const watchSet = compressRequestSchemas(watchRequest("session.watch.set"), {
    isKnownSchemaHash: noKnownSchemas,
  });
  const watchAdd = compressRequestSchemas(watchRequest("session.watch.add"), {
    isKnownSchemaHash: noKnownSchemas,
  });
  const transact = compressRequestSchemas(transactRequest(), {
    isKnownSchemaHash: noKnownSchemas,
  });
  const set = transact.commit.operations[0];
  const patch = transact.commit.operations[1];

  if (set.op !== "set" || patch.op !== "patch") {
    throw new Error("expected set and patch operations");
  }
  const patchValue = patch.patches[0];
  if (patchValue.op !== "add" || !Array.isArray(patchValue.value)) {
    throw new Error("expected an array add patch");
  }

  assertEquals(schemaAtSelector(graph), `schema-cas@1:${hash}`);
  assertEquals(
    schemaAtSelector({ query: watchSet.watches[0].query }),
    `schema-cas@1:${hash}`,
  );
  assertEquals(
    schemaAtSelector({ query: watchAdd.watches[0].query }),
    `schema-cas@1:${hash}`,
  );
  assertEquals(
    ((set as { value: Record<string, unknown> }).value.ref as Record<
      string,
      unknown
    >)["/"],
    {
      [LINK_V1_TAG]: {
        id: "of:modern",
        path: [],
        schema: `schema-cas@1:${hash}`,
      },
    },
  );
  assertEquals(
    ((set as { value: Record<string, unknown> }).value.legacy as Record<
      string,
      unknown
    >).$alias,
    { id: "of:legacy", path: [], schema: `schema-cas@1:${hash}` },
  );
  assertEquals(
    ((set as { value: Record<string, unknown> }).value.fake as Record<
      string,
      unknown
    >).schema,
    schema,
  );
  const patchedLink = ((patchValue.value[0] as Record<string, unknown>)[
    "/"
  ] as Record<string, unknown>)[LINK_V1_TAG] as Record<string, unknown>;
  assertEquals(patchedLink.schema, `schema-cas@1:${hash}`);
  assertEquals(
    expandRequestSchemas(transact, () => undefined),
    transactRequest(),
  );
});

Deno.test("request schema CAS rejects missing, mismatched, and malformed definitions", () => {
  const request = graphRequest();
  const refRequest = {
    ...request,
    query: {
      roots: [{
        ...request.query.roots[0],
        selector: { path: [], schema: "schema-cas@1:missing" },
      }],
    },
  };
  const missing = assertThrows(
    () => expandRequestSchemas(refRequest, () => undefined),
    MissingRequestSchemaDefinitionError,
  );
  assertEquals(missing.hash, "missing");
  assertThrows(
    () =>
      expandRequestSchemas(
        { ...request, schemaDefinitions: [] },
        () => undefined,
      ),
    InvalidRequestSchemaDefinitionsError,
  );
  assertThrows(
    () =>
      expandRequestSchemas({
        ...refRequest,
        schemaDefinitions: { missing: schema },
      }, () => undefined),
    InvalidRequestSchemaDefinitionsError,
  );
  assertThrows(
    () =>
      expandRequestSchemas({
        ...request,
        schemaDefinitions: { [hash]: "not-a-schema" },
      }, () => undefined),
    InvalidRequestSchemaDefinitionsError,
  );
  assertThrows(
    () =>
      expandRequestSchemas({
        ...request,
        query: {
          roots: [{
            ...request.query.roots[0],
            selector: { path: [], schema: "schema-cas@1:" },
          }],
        },
      }, () => undefined),
    InvalidRequestSchemaDefinitionsError,
  );
  assertThrows(
    () =>
      expandRequestSchemas({
        ...request,
        schemaDefinitions: { [hash]: schema },
      }, () => undefined),
    InvalidRequestSchemaDefinitionsError,
    "Unused request schema definitions",
  );
  const inherited = {
    ...refRequest,
    query: {
      roots: [{
        ...request.query.roots[0],
        selector: { path: [], schema: "schema-cas@1:toString" },
      }],
    },
    schemaDefinitions: {},
  };
  assertThrows(
    () => expandRequestSchemas(inherited, () => undefined),
    MissingRequestSchemaDefinitionError,
    "toString",
  );
});

Deno.test("request schema CAS ingests only after every reference expands", () => {
  const request = graphRequest();
  const compressed = compressRequestSchemas(request, {
    isKnownSchemaHash: noKnownSchemas,
  });
  const invalid = {
    ...compressed,
    query: {
      ...compressed.query,
      roots: [...compressed.query.roots, {
        id: "of:missing",
        selector: { path: [], schema: "schema-cas@1:missing" },
      }],
    },
  };
  let ingested = false;

  assertThrows(
    () =>
      expandRequestSchemas(
        invalid,
        () => undefined,
        () => {
          ingested = true;
        },
      ),
    MissingRequestSchemaDefinitionError,
  );
  assertEquals(ingested, false);
});

Deno.test("request schema CAS bounds definition count, size, and reference length", () => {
  const request = graphRequest();
  const tooMany = Object.fromEntries(
    Array.from({ length: 257 }, (_, index) => [`hash-${index}`, false]),
  );
  assertThrows(
    () =>
      expandRequestSchemas(
        { ...request, schemaDefinitions: tooMany },
        () => undefined,
      ),
    InvalidRequestSchemaDefinitionsError,
    "Too many request schema definitions",
  );
  assertThrows(
    () =>
      expandRequestSchemas({
        ...request,
        schemaDefinitions: {
          oversized: { description: "x".repeat(256 * 1024) },
        },
      }, () => undefined),
    InvalidRequestSchemaDefinitionsError,
    "too large",
  );
  assertThrows(
    () =>
      expandRequestSchemas({
        ...request,
        query: {
          roots: [{
            id: "of:root",
            selector: {
              path: [],
              schema: `schema-cas@1:${"x".repeat(257)}`,
            },
          }],
        },
      }, () => undefined),
    InvalidRequestSchemaDefinitionsError,
    "Malformed request schema reference",
  );

  const manySchemas: GraphQueryRequest = {
    ...request,
    query: {
      roots: Array.from({ length: 257 }, (_, index) => ({
        id: `of:${index}`,
        selector: {
          path: [],
          schema: { type: "string", description: `schema-${index}` },
        },
      })),
    },
  };
  assertStrictEquals(
    compressRequestSchemas(manySchemas, { isKnownSchemaHash: () => false }),
    manySchemas,
  );
  const oversizedSchema: GraphQueryRequest = {
    ...request,
    query: {
      roots: [{
        id: "of:root",
        selector: {
          path: [],
          schema: { description: "x".repeat(256 * 1024) },
        },
      }],
    },
  };
  assertStrictEquals(
    compressRequestSchemas(oversizedSchema, {
      isKnownSchemaHash: () => false,
    }),
    oversizedSchema,
  );
});

Deno.test("request schema CAS bounds preflight traversal", () => {
  const casLink = {
    "/": {
      [LINK_V1_TAG]: {
        id: "of:child",
        path: [],
        schema: `schema-cas@1:${hash}`,
      },
    },
  };
  let nested: unknown = { inline: true };
  for (let depth = 0; depth < 65; depth += 1) {
    nested = { nested };
  }
  const request = {
    ...transactRequest(),
    commit: {
      ...transactRequest().commit,
      operations: [{ op: "set", id: "of:root", value: nested }],
    },
  };
  assertEquals(hasRequestSchemaCasPayload(request), false);
  assertThrows(
    () =>
      hasRequestSchemaCasPayload({
        ...request,
        schemaDefinitions: {},
      }),
    InvalidRequestSchemaDefinitionsError,
    "traversal limit",
  );
  assertThrows(
    () =>
      hasRequestSchemaCasPayload({
        ...request,
        commit: {
          ...request.commit,
          operations: [{
            op: "set",
            id: "of:root",
            value: { casLink, nested },
          }],
        },
      }),
    InvalidRequestSchemaDefinitionsError,
    "traversal limit",
  );

  const wide = Array.from({ length: 100_001 }, () => null);
  const wideRequest = {
    ...request,
    commit: {
      ...request.commit,
      operations: [{ op: "set", id: "of:root", value: wide }],
    },
  };
  assertEquals(hasRequestSchemaCasPayload(wideRequest), false);
  assertThrows(
    () =>
      hasRequestSchemaCasPayload({
        ...wideRequest,
        schemaDefinitions: {},
      }),
    InvalidRequestSchemaDefinitionsError,
    "traversal limit",
  );
  assertThrows(
    () =>
      hasRequestSchemaCasPayload({
        ...request,
        commit: {
          ...request.commit,
          operations: [{
            op: "set",
            id: "of:root",
            value: { casLink, wide },
          }],
        },
      }),
    InvalidRequestSchemaDefinitionsError,
    "traversal limit",
  );

  let deepLink: EntityDocument = {
    "/": {
      [LINK_V1_TAG]: { id: "of:child", path: [], schema },
    },
  };
  for (let depth = 0; depth < 65; depth += 1) {
    deepLink = { nested: deepLink };
  }
  const deepLinkRequest: TransactRequest = {
    ...transactRequest(),
    commit: {
      ...transactRequest().commit,
      operations: [{ op: "set", id: "of:root", value: deepLink }],
    },
  };
  assertStrictEquals(
    compressRequestSchemas(deepLinkRequest, {
      isKnownSchemaHash: () => false,
    }),
    deepLinkRequest,
  );
});
