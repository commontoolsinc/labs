/**
 * Before/after benchmark for PR #3027 (copy-before-freeze at schema sites).
 *
 * Exercises the five copy-before-freeze sites:
 *   1. mergeSchemaFlags — deepFreeze on uncached result
 *   2. combineSchema — deepFreeze on uncached result
 *   3. traverseWithSchema entry — isDeepFrozen guard + structuredClone + deepFreeze
 *   4. mergeSchemaOption — deepFreeze with spread copies
 *   5. mergeAnyOfBranchSchemas — deepFreeze on uncached result
 *
 * Each benchmark is run in two modes:
 *   - "cold": fresh schemas each iteration (forces cache misses + freeze work)
 *   - "warm": reuses the same schemas (measures cached path + isDeepFrozen guard)
 */

import { refer } from "merkle-reference/json";
import type {
  Entity,
  Revision,
  SchemaPathSelector,
  State,
  URI,
} from "@commontools/memory/interface";
import type { FabricValue } from "@commontools/data-model/fabric-value";
import {
  combineSchema,
  IMemorySpaceValueAttestation,
  mergeAnyOfBranchSchemas,
  mergeSchemaFlags,
  SchemaObjectTraverser,
} from "../src/traverse.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import { ManagedStorageTransaction } from "../src/traverse.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { JSONSchemaObj } from "@commontools/api";

// ---------------------------------------------------------------------------
// Helpers (same pattern as traverse-anyof.bench.ts)
// ---------------------------------------------------------------------------

function getTraverser(
  store: Map<string, Revision<State>>,
  selector: SchemaPathSelector,
): SchemaObjectTraverser<FabricValue> {
  const manager = new StoreObjectManager(store);
  const managedTx = new ManagedStorageTransaction(manager);
  const tx = new ExtendedStorageTransaction(managedTx);
  return new SchemaObjectTraverser(tx, selector);
}

function makeDoc(
  store: Map<string, Revision<State>>,
  uri: string,
  value: FabricValue,
): IMemorySpaceValueAttestation {
  const type = "application/json" as const;
  const entity = uri as Entity;
  const revision: Revision<State> = {
    the: type,
    of: entity,
    is: { value },
    cause: refer({ the: type, of: entity }),
    since: 1,
  };
  store.set(`${revision.of}/${revision.the}`, revision);
  return {
    address: {
      space: "did:null:null" as `did:${string}:${string}`,
      id: uri as URI,
      type,
      path: ["value"],
    },
    value,
  };
}

// ---------------------------------------------------------------------------
// Schema factories — produce fresh (unfrozen) schemas each call
// ---------------------------------------------------------------------------

function makeObjectSchema(n: number): JSONSchemaObj {
  const props: Record<string, JSONSchema> = {};
  for (let i = 0; i < n; i++) {
    props[`prop${i}`] = { type: "string" };
  }
  return { type: "object", properties: props };
}

function makeAnyOfSchema(branchCount: number): JSONSchema {
  const branches: JSONSchema[] = [];
  for (let i = 0; i < branchCount; i++) {
    const props: Record<string, JSONSchema> = {};
    props[`kind`] = { const: `type${i}` };
    for (let j = 0; j < 3; j++) {
      props[`field${j}`] = { type: "string" };
    }
    branches.push({
      type: "object",
      properties: props,
      required: ["kind"],
    });
  }
  return { anyOf: branches };
}

// ---------------------------------------------------------------------------
// Group 1: mergeSchemaFlags — isolated
// ---------------------------------------------------------------------------

Deno.bench(
  "mergeSchemaFlags: cold (fresh schemas, cache miss)",
  { group: "mergeSchemaFlags" },
  (b) => {
    // Pre-generate schemas so allocation doesn't dominate timing
    const pairs: [JSONSchema, JSONSchema][] = [];
    for (let i = 0; i < 200; i++) {
      pairs.push([
        {
          type: "object",
          asCell: i % 2 === 0 ? true : undefined,
        } as JSONSchema,
        makeObjectSchema(4 + (i % 3)),
      ]);
    }
    let idx = 0;
    b.start();
    for (let i = 0; i < 200; i++) {
      mergeSchemaFlags(pairs[idx][0], pairs[idx][1]);
      idx++;
    }
    b.end();
  },
);

Deno.bench(
  "mergeSchemaFlags: warm (cached path)",
  { group: "mergeSchemaFlags" },
  (b) => {
    const flagSchema: JSONSchema = { type: "object", asCell: true };
    const schema: JSONSchema = { type: "string", description: "test" };
    // Prime the cache
    mergeSchemaFlags(flagSchema, schema);
    b.start();
    for (let i = 0; i < 1000; i++) {
      mergeSchemaFlags(flagSchema, schema);
    }
    b.end();
  },
);

// ---------------------------------------------------------------------------
// Group 2: combineSchema — isolated
// ---------------------------------------------------------------------------

Deno.bench(
  "combineSchema: cold (fresh schemas, cache miss)",
  { group: "combineSchema" },
  (b) => {
    const pairs: [JSONSchema, JSONSchema][] = [];
    for (let i = 0; i < 200; i++) {
      pairs.push([
        makeObjectSchema(3 + (i % 4)),
        makeObjectSchema(2 + (i % 3)),
      ]);
    }
    let idx = 0;
    b.start();
    for (let i = 0; i < 200; i++) {
      combineSchema(pairs[idx][0], pairs[idx][1]);
      idx++;
    }
    b.end();
  },
);

Deno.bench(
  "combineSchema: warm (cached path)",
  { group: "combineSchema" },
  (b) => {
    const parent: JSONSchema = {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
    };
    const link: JSONSchema = {
      type: "object",
      properties: { name: { type: "string" }, email: { type: "string" } },
    };
    // Prime
    combineSchema(parent, link);
    b.start();
    for (let i = 0; i < 1000; i++) {
      combineSchema(parent, link);
    }
    b.end();
  },
);

// ---------------------------------------------------------------------------
// Group 3: mergeAnyOfBranchSchemas — isolated
// ---------------------------------------------------------------------------

Deno.bench(
  "mergeAnyOfBranchSchemas: cold (5-branch)",
  { group: "mergeAnyOfBranch" },
  (b) => {
    const sets: { branches: JSONSchema[]; outer: JSONSchemaObj }[] = [];
    for (let i = 0; i < 50; i++) {
      const branches: JSONSchema[] = [];
      for (let j = 0; j < 5; j++) {
        branches.push({
          properties: {
            [`f${j}`]: { type: "string" },
            shared: { type: i % 2 === 0 ? "number" : "string" },
          },
        });
      }
      sets.push({
        branches,
        outer: { type: "object", properties: { shared: { type: "string" } } },
      });
    }
    let idx = 0;
    b.start();
    for (let i = 0; i < 50; i++) {
      mergeAnyOfBranchSchemas(sets[idx].branches, sets[idx].outer);
      idx++;
    }
    b.end();
  },
);

Deno.bench(
  "mergeAnyOfBranchSchemas: warm (cached)",
  { group: "mergeAnyOfBranch" },
  (b) => {
    const branches: JSONSchema[] = [
      { properties: { name: { type: "string" }, age: { type: "number" } } },
      { properties: { name: { type: "string" }, email: { type: "string" } } },
    ];
    const outer: JSONSchemaObj = {
      type: "object",
      properties: { name: { type: "string" } },
    };
    // Prime
    mergeAnyOfBranchSchemas(branches, outer);
    b.start();
    for (let i = 0; i < 1000; i++) {
      mergeAnyOfBranchSchemas(branches, outer);
    }
    b.end();
  },
);

// ---------------------------------------------------------------------------
// Group 4: Full traversal — exercises traverseWithSchema entry point
//          (isDeepFrozen guard + all schema merge paths)
// ---------------------------------------------------------------------------

Deno.bench(
  "traversal: simple object schema (cold schema)",
  { group: "traversal" },
  (b) => {
    const store = new Map<string, Revision<State>>();
    const doc = makeDoc(store, "of:perf-simple", {
      name: "Alice",
      age: 30,
      email: "alice@test.com",
    });
    b.start();
    for (let i = 0; i < 100; i++) {
      // Fresh schema each time to test isDeepFrozen guard + structuredClone
      const schema: JSONSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
          email: { type: "string" },
        },
      };
      const traverser = getTraverser(store, { path: ["value"], schema });
      traverser.traverse(doc);
    }
    b.end();
  },
);

Deno.bench(
  "traversal: simple object schema (warm/unfrozen schema, cache hit)",
  { group: "traversal" },
  (b) => {
    const store = new Map<string, Revision<State>>();
    const doc = makeDoc(store, "of:perf-simple-cache", {
      name: "Carol",
      age: 28,
      email: "carol@test.com",
    });
    // Same unfrozen schema object reused — exercises the WeakMap cache
    const schema: JSONSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
        email: { type: "string" },
      },
    };
    b.start();
    for (let i = 0; i < 100; i++) {
      const traverser = getTraverser(store, { path: ["value"], schema });
      traverser.traverse(doc);
    }
    b.end();
  },
);

Deno.bench(
  "traversal: simple object schema (warm/frozen schema)",
  { group: "traversal" },
  (b) => {
    const store = new Map<string, Revision<State>>();
    const doc = makeDoc(store, "of:perf-simple-warm", {
      name: "Bob",
      age: 25,
      email: "bob@test.com",
    });
    // Pre-freeze the schema — simulates what happens after first traversal
    const schema: JSONSchema = Object.freeze({
      type: "object",
      properties: Object.freeze({
        name: Object.freeze({ type: "string" }),
        age: Object.freeze({ type: "number" }),
        email: Object.freeze({ type: "string" }),
      }),
    }) as JSONSchema;
    b.start();
    for (let i = 0; i < 100; i++) {
      const traverser = getTraverser(store, { path: ["value"], schema });
      traverser.traverse(doc);
    }
    b.end();
  },
);

Deno.bench(
  "traversal: 5-branch anyOf (warm schema)",
  { group: "traversal" },
  (b) => {
    const store = new Map<string, Revision<State>>();
    const doc = makeDoc(store, "of:perf-anyof", {
      kind: "type2",
      field0: "a",
      field1: "b",
      field2: "c",
    });
    const schema = makeAnyOfSchema(5);
    // Prime by running once
    const primer = getTraverser(store, { path: ["value"], schema });
    primer.traverse(doc);

    b.start();
    for (let i = 0; i < 100; i++) {
      const traverser = getTraverser(store, { path: ["value"], schema });
      traverser.traverse(doc);
    }
    b.end();
  },
);

Deno.bench(
  "traversal: nested object with links (warm schema)",
  { group: "traversal" },
  (b) => {
    const store = new Map<string, Revision<State>>();
    const doc = makeDoc(store, "of:perf-nested", {
      user: { name: "Alice", role: "admin" },
      settings: { theme: "dark", lang: "en" },
      stats: { logins: 42, lastSeen: "2026-01-01" },
    });
    const schema: JSONSchema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            name: { type: "string" },
            role: { type: "string" },
          },
        },
        settings: {
          type: "object",
          properties: {
            theme: { type: "string" },
            lang: { type: "string" },
          },
        },
        stats: {
          type: "object",
          properties: {
            logins: { type: "number" },
            lastSeen: { type: "string" },
          },
        },
      },
    };
    // Prime
    const primer = getTraverser(store, { path: ["value"], schema });
    primer.traverse(doc);

    b.start();
    for (let i = 0; i < 100; i++) {
      const traverser = getTraverser(store, { path: ["value"], schema });
      traverser.traverse(doc);
    }
    b.end();
  },
);
