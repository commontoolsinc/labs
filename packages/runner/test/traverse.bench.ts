import { refer } from "merkle-reference/json";
import type {
  Revision,
  SchemaPathSelector,
  State,
  StorableDatum,
  URI,
} from "@commontools/memory/interface";
import type { JSONSchema } from "../src/builder/types.ts";
import { ContextualFlowControl } from "../src/cfc.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import {
  CompoundCycleTracker,
  getAtPath,
  ManagedStorageTransaction,
  MapSet,
  SchemaObjectTraverser,
} from "../src/traverse.ts";

const TYPE = "application/json" as const;
const SPACE = "did:null:null";

type MemoryDoc = {
  address: IMemorySpaceAddress;
  value?: StorableDatum;
};

function createTx(store: Map<string, Revision<State>>) {
  const manager = new StoreObjectManager(store);
  const managedTx = new ManagedStorageTransaction(manager);
  return new ExtendedStorageTransaction(managedTx);
}

function makeRevision(
  id: URI,
  value: StorableDatum,
  since: number,
): Revision<State> {
  return {
    the: TYPE,
    of: id as any,
    is: { value },
    cause: refer({ the: TYPE, of: id as any }),
    since,
  };
}

function makeRootDoc(id: URI, value: StorableDatum): MemoryDoc {
  return {
    address: {
      space: SPACE,
      id,
      type: TYPE,
      path: ["value"],
    },
    value,
  };
}

function makeLink(
  id: URI,
  path: string[] = [],
  redirect = false,
): StorableDatum {
  return {
    "/": {
      [LINK_V1_TAG]: {
        id,
        path,
        ...(redirect && { overwrite: "redirect" as const }),
      },
    },
  };
}

function createGetAtPathHelpers() {
  return {
    tracker: new CompoundCycleTracker<StorableDatum, JSONSchema | undefined>(),
    cfc: new ContextualFlowControl(),
    schemaTracker: new MapSet<string, SchemaPathSelector>(),
  };
}

function buildDeepObjectFixture(depth: number) {
  const path = Array.from({ length: depth }, (_unused, i) => `k${i}`);
  let value: StorableDatum = "leaf";
  for (let i = depth - 1; i >= 0; i--) {
    value = { [path[i]]: value };
  }
  return {
    path,
    doc: makeRootDoc("of:bench-deep-object" as URI, value),
    expected: "leaf",
  };
}

function buildLinkChainFixture(length: number) {
  const ids = Array.from(
    { length },
    (_unused, i) => `of:bench-link-chain-${i}` as URI,
  );

  const store = new Map<string, Revision<State>>();
  let rootValue: StorableDatum | undefined;

  for (let i = length - 1; i >= 0; i--) {
    const value = i === length - 1
      ? ({ result: { value: i } } as StorableDatum)
      : makeLink(ids[i + 1], [], i % 2 === 0);

    if (i === 0) {
      rootValue = value;
    }

    const revision = makeRevision(ids[i], value, length - i);
    store.set(`${revision.of}/${revision.the}`, revision);
  }

  return {
    store,
    doc: makeRootDoc(ids[0], rootValue!),
    path: ["result", "value"],
    expected: length - 1,
  };
}

const deepFixture = buildDeepObjectFixture(64);
const linkFixture = buildLinkChainFixture(16);

const anyOfValue: StorableDatum = {
  common: "ok",
  ...Object.fromEntries(
    Array.from({ length: 8 }, (_unused, i) => [`k${i}`, i]),
  ),
};

const anyOfSchema = {
  anyOf: Array.from({ length: 8 }, (_unused, i) => ({
    type: "object",
    properties: {
      common: { type: "string" },
      [`k${i}`]: { type: "number" },
    },
    required: ["common", `k${i}`],
  })),
} as const satisfies JSONSchema;

const oneOfValue: StorableDatum = { tag3: 3 };

const oneOfSchema = {
  oneOf: Array.from({ length: 8 }, (_unused, i) => ({
    type: "object",
    properties: { [`tag${i}`]: { type: "number" } },
    required: [`tag${i}`],
    additionalProperties: false,
  })),
} as const satisfies JSONSchema;

const allOfValue: StorableDatum = Object.fromEntries(
  Array.from({ length: 8 }, (_unused, i) => [`f${i}`, `v${i}`]),
);

const allOfSchema = {
  allOf: Array.from({ length: 8 }, (_unused, i) => ({
    type: "object",
    properties: { [`f${i}`]: { type: "string" } },
    required: [`f${i}`],
    additionalProperties: false,
  })),
} as const satisfies JSONSchema;

const schemaBenchTx = createTx(new Map<string, Revision<State>>());

const asCellObjectValue: StorableDatum = {
  meta: { count: 1, label: "meta" },
  plain: "value",
};

const asCellObjectSchema = {
  type: "object",
  properties: {
    meta: {
      type: "object",
      asCell: true,
      properties: {
        count: { type: "number" },
        label: { type: "string" },
      },
      required: ["count", "label"],
    },
    plain: { type: "string" },
  },
  required: ["meta", "plain"],
} as const satisfies JSONSchema;

const asStreamObjectSchema = {
  type: "object",
  properties: {
    events: {
      type: "object",
      asStream: true,
      properties: {
        eventType: { type: "string" },
        payload: { type: "number" },
      },
      required: ["eventType", "payload"],
    },
    plain: { type: "string" },
  },
  required: ["events", "plain"],
} as const satisfies JSONSchema;

const asCellArrayValue: StorableDatum = Array.from(
  { length: 200 },
  (_unused, i) => ({
    id: i,
    payload: {
      a: i,
      b: i * 2,
      c: `item-${i}`,
    },
  }),
);

const asCellArraySchema = {
  type: "array",
  items: {
    type: "object",
    asCell: true,
    properties: {
      id: { type: "number" },
      payload: {
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" },
          c: { type: "string" },
        },
        required: ["a", "b", "c"],
      },
    },
    required: ["id", "payload"],
  },
} as const satisfies JSONSchema;

Deno.bench(
  "traverse.getAtPath deep object path (100x)",
  { group: "traverse-getAtPath" },
  (b) => {
    const tx = createTx(new Map<string, Revision<State>>());
    const { tracker, cfc, schemaTracker } = createGetAtPathHelpers();

    b.start();
    for (let i = 0; i < 100; i++) {
      const [result] = getAtPath(
        tx,
        deepFixture.doc,
        deepFixture.path,
        tracker,
        cfc,
        schemaTracker,
      );
      if (result.value !== deepFixture.expected) {
        throw new Error("deep path traversal returned unexpected value");
      }
    }
    b.end();
  },
);

Deno.bench(
  "traverse.getAtPath link chain resolution (100x)",
  { group: "traverse-getAtPath" },
  (b) => {
    const tx = createTx(linkFixture.store);
    const { tracker, cfc, schemaTracker } = createGetAtPathHelpers();

    b.start();
    for (let i = 0; i < 100; i++) {
      const [result] = getAtPath(
        tx,
        linkFixture.doc,
        linkFixture.path,
        tracker,
        cfc,
        schemaTracker,
        { path: ["value"], schema: true },
      );
      if (result.value !== linkFixture.expected) {
        throw new Error("link chain traversal returned unexpected value");
      }
    }
    b.end();
  },
);

Deno.bench(
  "traverse.schema anyOf branch-heavy object (40x)",
  { group: "traverse-schema-logic" },
  (b) => {
    const doc = makeRootDoc("of:bench-anyof" as URI, anyOfValue);

    b.start();
    for (let i = 0; i < 40; i++) {
      const traverser = new SchemaObjectTraverser<StorableDatum>(
        schemaBenchTx,
        { path: ["value"], schema: anyOfSchema },
      );
      const result = traverser.traverse(doc);
      if (result === undefined) {
        throw new Error("anyOf benchmark unexpectedly returned undefined");
      }
    }
    b.end();
  },
);

Deno.bench(
  "traverse.schema oneOf branch scan exact-match (60x)",
  { group: "traverse-schema-logic" },
  (b) => {
    const doc = makeRootDoc("of:bench-oneof" as URI, oneOfValue);

    b.start();
    for (let i = 0; i < 60; i++) {
      const traverser = new SchemaObjectTraverser<StorableDatum>(
        schemaBenchTx,
        { path: ["value"], schema: oneOfSchema },
      );
      const result = traverser.traverse(doc);
      if (result === undefined) {
        throw new Error("oneOf benchmark unexpectedly returned undefined");
      }
    }
    b.end();
  },
);

Deno.bench(
  "traverse.schema allOf merge-heavy object (60x)",
  { group: "traverse-schema-logic" },
  (b) => {
    const doc = makeRootDoc("of:bench-allof" as URI, allOfValue);

    b.start();
    for (let i = 0; i < 60; i++) {
      const traverser = new SchemaObjectTraverser<StorableDatum>(
        schemaBenchTx,
        { path: ["value"], schema: allOfSchema },
      );
      const result = traverser.traverse(doc);
      if (result === undefined) {
        throw new Error("allOf benchmark unexpectedly returned undefined");
      }
    }
    b.end();
  },
);

Deno.bench(
  "traverse.asCell object property boundary (traverseCells=false, 80x)",
  { group: "traverse-ascell-asstream" },
  (b) => {
    const doc = makeRootDoc("of:bench-ascell-object" as URI, asCellObjectValue);

    b.start();
    for (let i = 0; i < 80; i++) {
      const traverser = new SchemaObjectTraverser<StorableDatum>(
        schemaBenchTx,
        { path: ["value"], schema: asCellObjectSchema },
        undefined,
        undefined,
        undefined,
        undefined,
        false,
      );
      const result = traverser.traverse(doc);
      if (!result || typeof result !== "object") {
        throw new Error(
          "asCell object benchmark unexpectedly returned non-object",
        );
      }
    }
    b.end();
  },
);

Deno.bench(
  "traverse.asStream object property boundary (traverseCells=false, 80x)",
  { group: "traverse-ascell-asstream" },
  (b) => {
    const doc = makeRootDoc("of:bench-asstream-object" as URI, {
      events: { eventType: "click", payload: 1 },
      plain: "value",
    });

    b.start();
    for (let i = 0; i < 80; i++) {
      const traverser = new SchemaObjectTraverser<StorableDatum>(
        schemaBenchTx,
        { path: ["value"], schema: asStreamObjectSchema },
        undefined,
        undefined,
        undefined,
        undefined,
        false,
      );
      const result = traverser.traverse(doc);
      if (!result || typeof result !== "object") {
        throw new Error(
          "asStream object benchmark unexpectedly returned non-object",
        );
      }
    }
    b.end();
  },
);

Deno.bench(
  "traverse.asCell array items boundary (traverseCells=false, 25x)",
  { group: "traverse-ascell-asstream" },
  (b) => {
    const doc = makeRootDoc("of:bench-ascell-array" as URI, asCellArrayValue);

    b.start();
    for (let i = 0; i < 25; i++) {
      const traverser = new SchemaObjectTraverser<StorableDatum>(
        schemaBenchTx,
        { path: ["value"], schema: asCellArraySchema },
        undefined,
        undefined,
        undefined,
        undefined,
        false,
      );
      const result = traverser.traverse(doc);
      if (!Array.isArray(result)) {
        throw new Error(
          "asCell array benchmark unexpectedly returned non-array",
        );
      }
    }
    b.end();
  },
);

Deno.bench(
  "traverse.asCell array items deep traversal (traverseCells=true, 25x)",
  { group: "traverse-ascell-asstream" },
  (b) => {
    const doc = makeRootDoc(
      "of:bench-ascell-array-deep" as URI,
      asCellArrayValue,
    );

    b.start();
    for (let i = 0; i < 25; i++) {
      const traverser = new SchemaObjectTraverser<StorableDatum>(
        schemaBenchTx,
        { path: ["value"], schema: asCellArraySchema },
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );
      const result = traverser.traverse(doc);
      if (!Array.isArray(result)) {
        throw new Error(
          "asCell deep array benchmark unexpectedly returned non-array",
        );
      }
    }
    b.end();
  },
);
