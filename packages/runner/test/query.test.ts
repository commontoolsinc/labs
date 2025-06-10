import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { refer } from "merkle-reference/json";
import type { JSONSchema, JSONValue } from "@commontools/builder";
import {
  CycleTracker,
  MapSet,
  SchemaObjectTraverser,
} from "@commontools/builder/traverse";
import type {
  Revision,
  SchemaPathSelector,
  State,
} from "@commontools/memory/interface";
import { type Entity } from "@commontools/memory";
import { Runtime } from "../src/runtime.ts";
import { ClientObjectManager } from "../src/storage/query.ts";

describe("Query", () => {
  let runtime: Runtime;
  const store: Map<string, Revision<State>> = new Map<
    string,
    Revision<State>
  >();
  let manager: ClientObjectManager;
  let tracker: CycleTracker<JSONValue>;

  beforeEach(() => {
    runtime = new Runtime({
      storageUrl: "volatile://",
    });
    manager = new ClientObjectManager(store);
    tracker = new CycleTracker<JSONValue>();
  });

  afterEach(async () => {
    await runtime?.dispose();
    //store.clear();
  });

  it("should track schemas used for each doc traversed with pointer", () => {
    const docValue1 = {
      employees: [{ fulllName: { first: "Bob", last: "Hope" } }],
    };
    const testDoc1 = runtime.documentMap.getDoc<
      { employees: { fulllName: { first: string } }[] }
    >(
      docValue1,
      `query test cell 1`,
      "test",
    );
    const entityId1 = testDoc1.entityId.toJSON!();
    const assert1 = {
      the: "application/json",
      of: `of:${entityId1["/"]}` as Entity,
      is: { value: testDoc1.value },
      cause: refer({ the: "application/json", of: `of:${entityId1["/"]}` }),
      since: 1,
    };
    const docValue2 = {
      name: {
        cell: entityId1,
        path: ["employees", "0", "fullName"],
      },
    };
    const testDoc2 = runtime.documentMap.getDoc<
      { name: { cell: { ["/"]: string }; path: string[] } }
    >(
      docValue2,
      `query test cell 2`,
      "test",
    );
    const entityId2 = testDoc2.entityId.toJSON!();
    const assert2 = {
      the: "application/json",
      of: `of:${entityId2["/"]}` as Entity,
      is: { value: testDoc2.value },
      cause: refer({ the: "application/json", of: `of:${entityId2["/"]}` }),
      since: 2,
    };

    store.set(`${assert1.of}/${assert1.the}`, assert1);
    store.set(`${assert2.of}/${assert2.the}`, assert2);
    const schemaContext = {
      schema: {
        "type": "object",
        "properties": {
          "name": {
            "type": "object",
            "properties": { "first": { "type": "string" } },
            "additionalProperties": false,
          },
        },
        "additionalProperties": false,
      } as const satisfies JSONSchema,
      rootSchema: true,
    };
    const schemaTracker = new MapSet<string, SchemaPathSelector>();
    const traverser = new SchemaObjectTraverser(
      manager,
      { path: [], schemaContext: schemaContext },
      tracker,
      schemaTracker,
    );
    // We've provided a schema context for this, so traverse it
    traverser.traverse({
      doc: { the: assert2.the, of: assert2.of },
      docRoot: assert2.is.value,
      path: [],
      value: assert2.is.value,
    });
    const selectorSet1 = schemaTracker.get(
      `of:${entityId1["/"]}/application/json`,
    );
    const selectorSet2 = schemaTracker.get(
      `of:${entityId2["/"]}/application/json`,
    );
    expect(selectorSet1?.size).toBe(1);
    expect(selectorSet2?.size).toBe(1);
    const [selector1] = selectorSet1!.values();
    const [selector2] = selectorSet2!.values();
    expect(selector2).toEqual({
      path: [],
      schemaContext: schemaContext,
    });
    expect(selector1).toEqual({
      path: ["employees", "0", "fullName"],
      schemaContext: {
        schema: schemaContext.schema.properties.name,
        rootSchema: true,
      },
    });
  });

  it("should handle true schema", () => {
    const testDoc1 = runtime.documentMap.getDoc<
      { employees: { name: { first: string } }[] }
    >(
      { employees: [{ name: { first: "Bob" } }] },
      `query test cell 1`,
      "test",
    );
    const entityId1 = testDoc1.entityId.toJSON!();
    const assert1 = {
      the: "application/json",
      of: `of:${entityId1["/"]}` as Entity,
      is: { value: testDoc1.value },
      cause: refer({ the: "application/json", of: `of:${entityId1["/"]}` }),
      since: 1,
    };
    const testDoc2 = runtime.documentMap.getDoc<
      { name: { cell: { ["/"]: string }; path: string[] } }
    >(
      {
        name: {
          cell: entityId1,
          path: ["employees", "0", "name"],
        },
      },
      `query test cell 2`,
      "test",
    );
    const entityId2 = testDoc2.entityId.toJSON!();
    const assert2 = {
      the: "application/json",
      of: `of:${entityId2["/"]}` as Entity,
      is: { value: testDoc2.value },
      cause: refer({ the: "application/json", of: `of:${entityId2["/"]}` }),
      since: 2,
    };

    store.set(`${assert1.of}/${assert1.the}`, assert1);
    store.set(`${assert2.of}/${assert2.the}`, assert2);
    const schemaContext = {
      schema: {
        "type": "object",
      } as const satisfies JSONSchema,
      rootSchema: true,
    };
    const schemaTracker = new MapSet<string, SchemaPathSelector>();
    const traverser = new SchemaObjectTraverser(
      manager,
      { path: [], schemaContext: schemaContext },
      tracker,
      schemaTracker,
    );
    // We've provided a schema context for this, so traverse it
    traverser.traverse(
      {
        doc: { the: assert2.the, of: assert2.of },
        docRoot: assert2.is.value,
        path: [],
        value: assert2.is.value,
      },
    );
    const selectorSet1 = schemaTracker.get(
      `of:${entityId1["/"]}/application/json`,
    );
    const selectorSet2 = schemaTracker.get(
      `of:${entityId2["/"]}/application/json`,
    );
    expect(selectorSet1?.size).toBe(1);
    expect(selectorSet2?.size).toBe(1);
    const [selector1] = selectorSet1!.values();
    const [selector2] = selectorSet2!.values();
    expect(selector2).toEqual({
      path: [],
      schemaContext: schemaContext,
    });
    expect(selector1).toEqual({
      path: ["employees", "0", "name"],
      schemaContext: {
        schema: true,
        rootSchema: true,
      },
    });
  });

  it("should handle pointer loops", () => {
    // schema that enables loops
    const schema = {
      "type": "object",
      "properties": {
        "name": { "$ref": "#" },
        "firstName": { "type": "string" },
      },
    } as const satisfies JSONSchema;
    // Now we make the doc with the cycle
    const testDoc1 = runtime.documentMap.getDoc<
      { name: { cell: { ["/"]: string }; path: string[] } }
    >(
      {
        name: {
          cell: { "/": "<placeholder>" },
          path: ["name"],
        },
      },
      `query test cell 1`,
      "test",
    );
    const entityId1 = testDoc1.entityId.toJSON!();
    const assert1 = {
      the: "application/json",
      of: `of:${entityId1["/"]}` as Entity,
      is: {
        value: {
          name: {
            cell: entityId1,
            path: ["name"],
          },
        },
      },
      cause: refer({ the: "application/json", of: `of:${entityId1["/"]}` }),
      since: 1,
    };
    store.set(`${assert1.of}/${assert1.the}`, assert1);
    const schemaContext = {
      schema: schema,
      rootSchema: schema,
    };
    const schemaTracker = new MapSet<string, SchemaPathSelector>();
    const traverser = new SchemaObjectTraverser(
      manager,
      { path: [], schemaContext: schemaContext },
      tracker,
      schemaTracker,
    );
    // We've provided a schema context for this, so traverse it
    traverser.traverse(
      {
        doc: { the: assert1.the, of: assert1.of },
        docRoot: assert1.is.value,
        path: [],
        value: assert1.is.value,
      },
    );
    const selectorSet1 = schemaTracker.get(
      `of:${entityId1["/"]}/application/json`,
    );
    expect(selectorSet1?.size).toBe(2);
    expect(selectorSet1).toContainEqual({
      path: [],
      schemaContext: schemaContext,
    });
    expect(selectorSet1).toContainEqual({
      path: ["name"],
      schemaContext: schemaContext,
    });
  });

  it("should handle paths in schema and cell links", () => {
    const docValue1 = { home: { street: "1 Infinite Loop" } };
    const testDoc1 = runtime.documentMap.getDoc<
      { home: { street: string } }
    >(
      docValue1,
      `query test cell 1`,
      "test",
    );
    const entityId1 = testDoc1.entityId.toJSON!();
    const assert1 = {
      the: "application/json",
      of: `of:${entityId1["/"]}` as Entity,
      is: { value: testDoc1.value },
      cause: refer({ the: "application/json", of: `of:${entityId1["/"]}` }),
      since: 1,
    };

    const docValue2 = {
      employees: [{ address: { cell: entityId1, path: ["home"] } }],
    };
    const testDoc2 = runtime.documentMap.getDoc<any>(
      docValue2,
      `query test cell 2`,
      "test",
    );

    const schema = { "type": "string" } as const satisfies JSONSchema;
    const selector = {
      path: ["employees", "0", "address", "street"],
      schemaContext: {
        schema: schema,
        rootSchema: schema,
      },
    };

    const entityId2 = testDoc2.entityId.toJSON!();
    const assert2 = {
      the: "application/json",
      of: `of:${entityId2["/"]}` as Entity,
      is: { value: testDoc2.value },
      cause: refer({ the: "application/json", of: `of:${entityId2["/"]}` }),
      since: 2,
    };

    store.set(`${assert1.of}/${assert1.the}`, assert1);
    store.set(`${assert2.of}/${assert2.the}`, assert2);

    const schemaTracker = new MapSet<string, SchemaPathSelector>();
    const traverser = new SchemaObjectTraverser(
      manager,
      selector,
      tracker,
      schemaTracker,
    );
    // We've provided a schema context for this, so traverse it
    traverser.traverse(
      {
        doc: { the: assert2.the, of: assert2.of },
        docRoot: assert2.is.value,
        path: [],
        value: assert2.is.value,
      },
    );
    const selectorSet1 = schemaTracker.get(
      `of:${entityId1["/"]}/application/json`,
    );
    const selectorSet2 = schemaTracker.get(
      `of:${entityId2["/"]}/application/json`,
    );
    expect(selectorSet1?.size).toBe(1);
    expect(selectorSet2?.size).toBe(1);
    const [selector1] = selectorSet1!.values();
    const [selector2] = selectorSet2!.values();
    expect(selector1).toEqual({
      path: ["home", "street"],
      schemaContext: {
        schema: schema, // {"type": "string"}
        rootSchema: schema,
      },
    });
    expect(selector2).toEqual({
      path: selector.path, // ["employees", "0", "address", "street"]
      schemaContext: selector.schemaContext,
    });
  });
});
