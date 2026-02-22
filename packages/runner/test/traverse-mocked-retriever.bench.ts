import type { JSONSchema } from "../src/builder/types.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import type {
  IAttestation,
  IMemorySpaceAddress,
} from "../src/storage/interface.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import {
  type BaseMemoryAddress,
  ManagedStorageTransaction,
  type ObjectStorageManager,
  SchemaObjectTraverser,
} from "../src/traverse.ts";
import type { StorableDatum, URI } from "@commontools/memory/interface";

const TYPE = "application/json" as const;
const SPACE = "did:null:null";

type MemoryDoc = {
  address: IMemorySpaceAddress;
  value?: StorableDatum;
};

class MockObjectManager implements ObjectStorageManager {
  private docs = new Map<string, IAttestation>();

  constructor(docs: readonly MemoryDoc[]) {
    for (const doc of docs) {
      this.docs.set(this.key(doc.address), doc);
    }
  }

  private key(address: BaseMemoryAddress | IMemorySpaceAddress): string {
    return `${address.space}/${address.id}/${address.type}`;
  }

  load(address: BaseMemoryAddress): IAttestation | null {
    return this.docs.get(this.key(address)) ?? null;
  }
}

function createTx(docs: readonly MemoryDoc[]): ExtendedStorageTransaction {
  const manager = new MockObjectManager(docs);
  const managedTx = new ManagedStorageTransaction(manager);
  return new ExtendedStorageTransaction(managedTx);
}

function makeLink(id: URI, path: string[] = []): StorableDatum {
  return {
    "/": {
      [LINK_V1_TAG]: {
        id,
        path,
      },
    },
  };
}

const metaSchema = {
  type: "object",
  properties: {
    kind: { type: "string" },
    marker: { type: "string" },
  },
  required: ["kind", "marker"],
} as const satisfies JSONSchema;

const peerSchema = {
  type: "object",
  properties: {
    level: { type: "number" },
    meta: metaSchema,
  },
  required: ["level", "meta"],
} as const satisfies JSONSchema;

function buildNodeSchema(depth: number): JSONSchema {
  const base: {
    type: "object";
    properties: Record<string, JSONSchema>;
    required: string[];
  } = {
    type: "object",
    properties: {
      level: { type: "number" },
      meta: metaSchema,
      peers: {
        type: "array",
        minItems: 3,
        items: peerSchema,
      },
    },
    required: ["level", "meta", "peers"],
  };

  if (depth > 0) {
    base.properties.next = buildNodeSchema(depth - 1);
    base.required.push("next");
  }

  return base;
}

function buildFixture(
  prefix: string,
  depth: number,
  brokenLevel?: number,
): {
  tx: ExtendedStorageTransaction;
  rootDoc: MemoryDoc;
} {
  const chainIds = Array.from(
    { length: depth + 1 },
    (_unused, i) => `of:${prefix}-doc-${i}` as URI,
  );
  const peerIds = Array.from(
    { length: depth + 4 },
    (_unused, i) => `of:${prefix}-peer-${i}` as URI,
  );

  const docs: MemoryDoc[] = [];
  for (let i = 0; i < peerIds.length; i++) {
    docs.push({
      address: {
        space: SPACE,
        id: peerIds[i],
        type: TYPE,
        path: [],
      },
      value: {
        value: {
          node: {
            level: i,
            meta: {
              kind: "peer",
              marker: `peer-marker-${i}`,
            },
          },
        },
      },
    });
  }

  for (let level = depth; level >= 0; level--) {
    const meta = (brokenLevel !== undefined && level === brokenLevel)
      ? ({ kind: "node" } as const)
      : ({ kind: "node", marker: `marker-${level}` } as const);

    const node: Record<string, StorableDatum> = {
      level,
      meta,
      peers: [
        makeLink(peerIds[level], ["node"]),
        makeLink(peerIds[level + 1], ["node"]),
        makeLink(peerIds[level + 2], ["node"]),
      ],
    };

    if (level < depth) {
      node.next = makeLink(chainIds[level + 1], ["node"]);
    }

    docs.push({
      address: {
        space: SPACE,
        id: chainIds[level],
        type: TYPE,
        path: [],
      },
      value: { value: { node } },
    });
  }

  const rootId = `of:${prefix}-root` as URI;
  const rootValue = { node: makeLink(chainIds[0], ["node"]) };
  docs.push({
    address: {
      space: SPACE,
      id: rootId,
      type: TYPE,
      path: [],
    },
    value: { value: rootValue },
  });

  return {
    tx: createTx(docs),
    rootDoc: {
      address: {
        space: SPACE,
        id: rootId,
        type: TYPE,
        path: ["value"],
      },
      value: rootValue,
    },
  };
}

const depth = 48;
const deepLinkedSchema = buildNodeSchema(depth);
const matching = buildFixture("mocked-linked-match", depth);
const missingRequired = buildFixture("mocked-linked-miss", depth, depth - 3);

Deno.bench(
  "traverse.mocked retriever deep links required fields match (20x)",
  { group: "traverse-mocked-retriever" },
  (b) => {
    b.start();
    for (let i = 0; i < 20; i++) {
      const traverser = new SchemaObjectTraverser<StorableDatum>(
        matching.tx,
        { path: ["value", "node"], schema: deepLinkedSchema },
      );
      const result = traverser.traverse(matching.rootDoc);
      if (result === undefined) {
        throw new Error("Expected schema match benchmark to return value");
      }
    }
    b.end();
  },
);

Deno.bench(
  "traverse.mocked retriever deep links required field missing (20x)",
  { group: "traverse-mocked-retriever" },
  (b) => {
    b.start();
    for (let i = 0; i < 20; i++) {
      const traverser = new SchemaObjectTraverser<StorableDatum>(
        missingRequired.tx,
        { path: ["value", "node"], schema: deepLinkedSchema },
      );
      const result = traverser.traverse(missingRequired.rootDoc);
      if (result !== undefined) {
        throw new Error(
          "Expected missing-required benchmark to fail schema match",
        );
      }
    }
    b.end();
  },
);
