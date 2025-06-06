import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { JSONSchema, JSONValue } from "@commontools/builder";
import {
  CycleTracker,
  MapSet,
  SchemaObjectTraverser,
} from "@commontools/builder/traverse";
import {
  Revision,
  SchemaPathSelector,
  State,
} from "@commontools/memory/interface";
import { Runtime } from "../src/runtime.ts";
import { ClientObjectManager } from "../src/storage/query.ts";
import { expect } from "@std/expect";
import { CellLink } from "../src/cell.ts";
import { refer } from "merkle-reference/json";
import { Entity } from "@commontools/memory";
import { string } from "zod";

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
    const testMap = new Map<string, string>();

    store.set(`${assert1.of}/${assert1.the}`, assert1);
    store.set(`${assert2.of}/${assert2.the}`, assert2);
    console.log(
      "store contents:",
      JSON.stringify([...store.entries()], undefined, 2),
    );
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
      schemaContext,
      tracker,
      schemaTracker,
    );
    const obj = manager.load({ the: assert2.the, of: assert2.of });
    //   // We've provided a schema context for this, so traverse it
    traverser.traverse(
      { the: assert2.the, of: assert2.of },
      assert2.is.value,
      assert2.is.value,
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
    console.log(
      JSON.stringify([selector1, selector2], undefined, 2),
    );
    expect(selector2).toEqual({
      path: [],
      schemaContext: schemaContext,
    });
    expect(selector1).toEqual({
      path: ["employees", "0", "name"],
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
    const testMap = new Map<string, string>();

    store.set(`${assert1.of}/${assert1.the}`, assert1);
    store.set(`${assert2.of}/${assert2.the}`, assert2);
    console.log(
      "store contents:",
      JSON.stringify([...store.entries()], undefined, 2),
    );
    const schemaContext = {
      schema: {
        "type": "object",
      } as const satisfies JSONSchema,
      rootSchema: true,
    };
    const schemaTracker = new MapSet<string, SchemaPathSelector>();
    const traverser = new SchemaObjectTraverser(
      manager,
      schemaContext,
      tracker,
      schemaTracker,
    );
    const obj = manager.load({ the: assert2.the, of: assert2.of });
    //   // We've provided a schema context for this, so traverse it
    traverser.traverse(
      { the: assert2.the, of: assert2.of },
      assert2.is.value,
      assert2.is.value,
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
    console.log(
      JSON.stringify([selector1, selector2], undefined, 2),
    );
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
});
