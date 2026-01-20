import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { refer } from "merkle-reference/json";
import type {
  Entity,
  Revision,
  State,
  URI,
} from "@commontools/memory/interface";
import {
  CompoundCycleTracker,
  getAtPath,
  MapSet,
  type PointerCycleTracker,
  SchemaObjectTraverser,
  type SchemaPathSelector,
} from "../src/traverse.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import type { JSONSchema, JSONValue } from "../src/builder/types.ts";
import type { Immutable } from "@commontools/utils/types";
import { ContextualFlowControl } from "../src/cfc.ts";
import type { SchemaContext } from "@commontools/memory/interface";
import { deepEqual } from "@commontools/utils/deep-equal";

describe("SchemaObjectTraverser.traverseDAG", () => {
  it("follows legacy cell links when traversing", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const doc1Uri = "of:doc-1" as URI;
    const doc2Uri = "of:doc-2" as URI;
    const doc1Entity = doc1Uri as Entity;
    const doc2Entity = doc2Uri as Entity;

    const doc1Value = { employees: [{ name: "Bob" }] };
    const doc1EntityId = { "/": doc1Uri };

    const doc1Revision: Revision<State> = {
      the: type,
      of: doc1Entity,
      is: { value: doc1Value },
      cause: refer({ the: type, of: doc1Entity }),
      since: 1,
    };
    store.set(
      `${doc1Revision.of}/${doc1Revision.the}`,
      doc1Revision,
    );

    const doc2Value = {
      employeeName: {
        cell: doc1EntityId,
        path: ["employees", "0", "name"],
      },
      argument: {
        tools: {
          search_web: {
            pattern: {
              result: {
                $alias: {
                  path: ["internal", "__#0"],
                },
              },
            },
          },
        },
      },
      internal: {
        "__#0": {
          name: "Foo",
        },
      },
    };

    const doc2Revision: Revision<State> = {
      the: type,
      of: doc2Entity,
      is: { value: doc2Value },
      cause: refer({ the: type, of: doc2Entity }),
      since: 2,
    };
    store.set(
      `${doc2Revision.of}/${doc2Revision.the}`,
      doc2Revision,
    );

    const manager = new StoreObjectManager(store);
    const traverser = new SchemaObjectTraverser(manager, {
      path: [],
      schemaContext: { schema: true, rootSchema: true },
    });

    const result = traverser.traverse({
      address: { id: doc2Uri, type, path: ["value"] },
      value: doc2Value,
    });

    expect(result).toEqual({
      argument: {
        tools: {
          search_web: {
            pattern: {
              result: {
                name: "Foo",
              },
            },
          },
        },
      },
      employeeName: "Bob",
      internal: {
        "__#0": {
          name: "Foo",
        },
      },
    });
  });
});

describe("SchemaObjectTraverser array traversal", () => {
  it("uses prefixItems schemas for indexed items", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-prefix-items" as URI;
    const docEntity = docUri as Entity;

    const docValue = ["alpha", { count: 42 }, 3];

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      cause: refer({ the: type, of: docEntity }),
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = {
      type: "array",
      prefixItems: [
        { type: "string" },
        {
          type: "object",
          properties: {
            count: { type: "number" },
          },
          required: ["count"],
        },
      ],
      items: { type: "number" },
    } as const satisfies JSONSchema;

    const manager = new StoreObjectManager(store);
    const traverser = new SchemaObjectTraverser(manager, {
      path: [],
      schemaContext: { schema, rootSchema: schema },
    });

    const result = traverser.traverse({
      address: { id: docUri, type, path: ["value"] },
      value: docValue,
    });

    expect(result).toEqual(["alpha", { count: 42 }, 3]);
  });

  it("rejects additional items when items is false", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-items-false" as URI;
    const docEntity = docUri as Entity;

    const docValue = ["alpha", 1, true];

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      cause: refer({ the: type, of: docEntity }),
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = {
      type: "array",
      prefixItems: [
        { type: "string" },
        { type: "number" },
      ],
      items: false,
    } as const satisfies JSONSchema;

    const manager = new StoreObjectManager(store);
    const traverser = new SchemaObjectTraverser(manager, {
      path: [],
      schemaContext: { schema, rootSchema: schema },
    });

    const result = traverser.traverse({
      address: { id: docUri, type, path: ["value"] },
      value: docValue,
    });

    expect(result).toBeUndefined();
  });
});

describe("getAtPath array index validation", () => {
  it("rejects leading-zero array index like '01'", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-getAtPath" as URI;
    const docEntity = docUri as Entity;

    // Array with three elements
    const docValue = ["zero", "one", "two"];

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      cause: refer({ the: type, of: docEntity }),
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const manager = new StoreObjectManager(store);
    const tracker: PointerCycleTracker = new CompoundCycleTracker<
      Immutable<JSONValue>,
      SchemaContext | undefined
    >();
    const cfc = new ContextualFlowControl();
    const schemaTracker = new MapSet<string, SchemaPathSelector>(deepEqual);

    const doc = {
      address: { id: docUri, type, path: ["value"] },
      value: docValue,
    };

    // Navigate with invalid index "01"
    const [result1] = getAtPath(
      manager,
      doc,
      ["01"],
      tracker,
      cfc,
      schemaTracker,
    );

    // Navigate with valid index "1"
    const [result2] = getAtPath(
      manager,
      doc,
      ["1"],
      tracker,
      cfc,
      schemaTracker,
    );

    // "01" is not a valid array index (leading zero), should return undefined
    // BUG: Current code returns "one" because new Number("01").valueOf() === 1
    expect(result1.value).toBeUndefined();
    // "1" is a valid array index, should return "one"
    expect(result2.value).toBe("one");
  });
});
