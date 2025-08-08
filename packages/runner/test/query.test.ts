import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { refer } from "merkle-reference/json";
import type { JSONSchema, JSONValue } from "../src/index.ts";
import {
  CycleTracker,
  MapSet,
  SchemaObjectTraverser,
} from "../src/traverse.ts";
import type {
  Revision,
  SchemaPathSelector,
  State,
} from "@commontools/memory/interface";
import type { Entity } from "@commontools/memory/interface";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Identity } from "@commontools/identity";
import { StoreObjectManager } from "../src/storage/query.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Query", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  const store: Map<string, Revision<State>> = new Map<
    string,
    Revision<State>
  >();
  let manager: StoreObjectManager;
  let tracker: CycleTracker<JSONValue>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });
    tx = runtime.edit();
    manager = new StoreObjectManager(store);
    tracker = new CycleTracker<JSONValue>();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    //store.clear();
  });

  it("should track schemas used for each doc traversed with pointer", () => {
    const docValue1 = {
      employees: [{ fulllName: { first: "Bob", last: "Hope" } }],
    };
    const testCell1 = runtime.getCell<
      { employees: { fulllName: { first: string } }[] }
    >(
      space,
      `query test cell 1`,
      undefined,
      tx,
    );
    testCell1.set(docValue1);
    const entityId1 = JSON.parse(JSON.stringify(testCell1.entityId!));
    const assert1 = {
      the: "application/json",
      of: `of:${entityId1["/"]}` as Entity,
      is: { value: testCell1.get() },
      cause: refer({ the: "application/json", of: `of:${entityId1["/"]}` }),
      since: 1,
    };
    const docValue2 = {
      name: {
        cell: entityId1,
        path: ["employees", "0", "fullName"],
      },
    };
    const testCell2 = runtime.getCell<
      { name: { cell: { ["/"]: string }; path: string[] } }
    >(
      space,
      `query test cell 2`,
      undefined,
      tx,
    );
    testCell2.setRaw(docValue2);
    const entityId2 = testCell2.entityId!;
    const assert2 = {
      the: "application/json",
      of: `of:${entityId2["/"]}` as Entity,
      is: { value: docValue2 },
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
    const testCell1 = runtime.getCell<
      { employees: { name: { first: string } }[] }
    >(
      space,
      `query test cell 1`,
      undefined,
      tx,
    );
    testCell1.set({ employees: [{ name: { first: "Bob" } }] });
    const entityId1 = JSON.parse(JSON.stringify(testCell1.entityId!));
    const assert1 = {
      the: "application/json",
      of: `of:${entityId1["/"]}` as Entity,
      is: { value: testCell1.get() },
      cause: refer({ the: "application/json", of: `of:${entityId1["/"]}` }),
      since: 1,
    };
    const testCell2 = runtime.getCell<
      { name: { cell: { ["/"]: string }; path: string[] } }
    >(
      space,
      `query test cell 2`,
      undefined,
      tx,
    );
    const docValue2 = {
      name: {
        cell: entityId1,
        path: ["employees", "0", "name"],
      },
    };
    testCell2.setRaw(docValue2);
    const entityId2 = testCell2.entityId!;
    const assert2 = {
      the: "application/json",
      of: `of:${entityId2["/"]}` as Entity,
      is: { value: docValue2 },
      cause: refer({ the: "application/json", of: `of:${entityId2["/"]}` }),
      since: 2,
    };

    store.set(`${assert1.of}/${assert1.the}`, assert1);
    store.set(`${assert2.of}/${assert2.the}`, assert2);
    const schemaContext = {
      schema: {
        "type": "object",
        "additionalProperties": true,
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
    const testCell1 = runtime.getCell<
      { name: { cell: { ["/"]: string }; path: string[] } }
    >(
      space,
      `query test cell 1`,
      undefined,
      tx,
    );
    testCell1.setRaw({
      name: {
        cell: { "/": "<placeholder>" },
        path: ["name"],
      },
    });
    const entityId1 = JSON.parse(JSON.stringify(testCell1.entityId!));
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
    const testCell1 = runtime.getCell<
      { home: { street: string } }
    >(
      space,
      `query test cell 1`,
      undefined,
      tx,
    );
    testCell1.set(docValue1);
    const entityId1 = JSON.parse(JSON.stringify(testCell1.entityId!));
    const assert1 = {
      the: "application/json",
      of: `of:${entityId1["/"]}` as Entity,
      is: { value: testCell1.get() },
      cause: refer({ the: "application/json", of: `of:${entityId1["/"]}` }),
      since: 1,
    };

    const docValue2 = {
      employees: [{
        address: {
          cell: entityId1,
          path: ["home"],
        },
      }],
    };
    const testCell2 = runtime.getCell<any>(
      space,
      `query test cell 2`,
      undefined,
      tx,
    );
    testCell2.setRaw(docValue2);

    const schema = { "type": "string" } as const satisfies JSONSchema;
    const selector = {
      path: ["employees", "0", "address", "street"],
      schemaContext: {
        schema: schema,
        rootSchema: schema,
      },
    };

    const entityId2 = testCell2.entityId!;
    const assert2 = {
      the: "application/json",
      of: `of:${entityId2["/"]}` as Entity,
      is: { value: testCell2.getRaw() },
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
