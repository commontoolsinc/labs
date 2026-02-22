import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { refer } from "merkle-reference/json";
import type {
  Entity,
  Revision,
  SchemaPathSelector,
  State,
  StorableDatum,
  URI,
} from "@commontools/memory/interface";
import {
  CompoundCycleTracker,
  getAtPath,
  ManagedStorageTransaction,
  MapSet,
  PointerCycleTracker,
  SchemaObjectTraverser,
} from "../src/traverse.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { Immutable } from "@commontools/utils/types";
import { ContextualFlowControl, deepEqual } from "@commontools/runner";
import {
  IMemorySpaceAddress,
  IMemorySpaceAttestation,
} from "../src/storage/interface.ts";

// Helper function to get the SchemaObjectTraverser backed by a store map
function getTraverser(
  store: Map<string, Revision<State>>,
  selector: SchemaPathSelector,
): SchemaObjectTraverser<StorableDatum> {
  const manager = new StoreObjectManager(store);
  const managedTx = new ManagedStorageTransaction(manager);
  const tx = new ExtendedStorageTransaction(managedTx);
  return new SchemaObjectTraverser(tx, selector);
}

describe("SchemaObjectTraverser.traverseDAG", () => {
  it("follows sigil cell links when traversing", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const doc1Uri = "of:doc-1" as URI;
    const doc2Uri = "of:doc-2" as URI;
    const doc1Entity = doc1Uri as Entity;
    const doc2Entity = doc2Uri as Entity;

    const doc1Value = { employees: [{ name: "Bob" }] };

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
        "/": {
          [LINK_V1_TAG]: {
            id: doc1Uri,
            path: ["employees", "0", "name"],
          },
        },
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

    const traverser = getTraverser(store, { path: ["value"], schema: true });

    const result = traverser.traverse({
      address: { space: "did:null:null", id: doc2Uri, type, path: ["value"] },
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

describe("SchemaObjectTraverser missing value handling", () => {
  // Missing values are handled consistently with other value transforms
  // (toJSON, toStorableValue, etc.):
  // - Arrays: null is inserted for missing elements
  // - Objects: undefined is assigned for missing properties

  it("uses null for missing array elements", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-with-array" as URI;
    const docEntity = docUri as Entity;
    const missingUri = "of:missing-doc" as URI;

    // Array with a link to a non-existent document
    const docValue = [
      "present",
      { "/": { [LINK_V1_TAG]: { id: missingUri, path: [] } } }, // link to missing doc
      "also-present",
    ];

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      cause: refer({ the: type, of: docEntity }),
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);
    // Note: missingUri is NOT in the store

    const traverser = getTraverser(store, { path: ["value"], schema: true });

    const result = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    // Missing elements become null (consistent with toJSON, toStorableValue, etc.)
    expect(result).toEqual(["present", null, "also-present"]);
  });

  it("removes missing object properties from object", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-with-object" as URI;
    const docEntity = docUri as Entity;
    const missingUri = "of:missing-doc" as URI;

    // Object with a link to a non-existent document
    const docValue = {
      present: "here",
      missing: { "/": { [LINK_V1_TAG]: { id: missingUri, path: [] } } }, // link to missing doc
      alsoPresent: "also here",
    };

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      cause: refer({ the: type, of: docEntity }),
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);
    // Note: missingUri is NOT in the store

    const traverser = getTraverser(store, {
      path: ["value"],
      schema: { type: "object", additionalProperties: { type: "string" } },
    });

    const result = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    // Missing properties become undefined
    expect(result).toEqual({
      present: "here",
      alsoPresent: "also here",
    });
    expect("missing" in (result as Record<string, unknown>)).toBe(false);
  });

  it("uses undefined for missing object properties when allowed", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-with-object" as URI;
    const docEntity = docUri as Entity;
    const missingUri = "of:missing-doc" as URI;

    // Object with a link to a non-existent document
    const docValue = {
      present: "here",
      missing: { "/": { [LINK_V1_TAG]: { id: missingUri, path: [] } } }, // link to missing doc
      alsoPresent: "also here",
    };

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      cause: refer({ the: type, of: docEntity }),
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);
    // Note: missingUri is NOT in the store

    const traverser = getTraverser(store, {
      path: ["value"],
      schema: {
        type: "object",
        additionalProperties: { type: ["string", "undefined"] },
      },
    });

    const result = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    // Missing properties become undefined
    expect(result).toEqual({
      present: "here",
      missing: undefined,
      alsoPresent: "also here",
    });
    expect("missing" in (result as Record<string, unknown>)).toBe(true);
  });

  it("uses null for missing array elements with schema when allowed", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-with-array" as URI;
    const docEntity = docUri as Entity;
    const missingUri = "of:missing-doc" as URI;

    // Array with a link to a non-existent document
    const docValue = [
      "present",
      { "/": { [LINK_V1_TAG]: { id: missingUri, path: [] } } }, // link to missing doc
      "also-present",
    ];

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      cause: refer({ the: type, of: docEntity }),
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);
    // Note: missingUri is NOT in the store

    const schema = {
      type: "array",
      items: {
        anyOf: [
          { type: "null" },
          { type: "string" },
        ],
      },
    } as JSONSchema;
    const traverser = getTraverser(store, { path: ["value"], schema });

    const result = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    // Missing elements become null (consistent with toJSON, toStorableValue, etc.)
    expect(result).toEqual(["present", null, "also-present"]);
  });

  it("does not use null for missing array elements with schema when not allowed", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-with-array" as URI;
    const docEntity = docUri as Entity;
    const missingUri = "of:missing-doc" as URI;

    // Array with a link to a non-existent document
    const docValue = [
      "present",
      { "/": { [LINK_V1_TAG]: { id: missingUri, path: [] } } }, // link to missing doc
      "also-present",
    ];

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      cause: refer({ the: type, of: docEntity }),
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);
    // Note: missingUri is NOT in the store

    const schema = {
      type: "array",
      items: { type: "string" },
    } as JSONSchema;
    const traverser = getTraverser(store, { path: ["value"], schema });

    const result = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    // Missing elements make the array invalid, thus undefined.
    expect(result).toBeUndefined();
  });

  it("uses undefined for missing array elements with schema when allowed", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-with-array" as URI;
    const docEntity = docUri as Entity;
    const missingUri = "of:missing-doc" as URI;

    // Array with a link to a non-existent document
    const docValue = [
      "present",
      { "/": { [LINK_V1_TAG]: { id: missingUri, path: [] } } }, // link to missing doc
      "also-present",
    ];

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      cause: refer({ the: type, of: docEntity }),
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);
    // Note: missingUri is NOT in the store

    const schema = {
      type: "array",
      items: {
        anyOf: [
          { type: "undefined" },
          { type: "string" },
        ],
      },
    } as JSONSchema;
    const traverser = getTraverser(store, { path: ["value"], schema });

    const result = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    // Missing elements become undefined when allowed
    expect(result).toEqual(["present", undefined, "also-present"]);
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

    const traverser = getTraverser(store, { path: ["value"], schema });

    const result = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
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

    const traverser = getTraverser(store, { path: ["value"], schema });

    const result = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    expect(result).toBeUndefined();
  });

  describe("SchemaObjectTraverser getAtPath", () => {
    // Some helper functions
    function makeLink(id: URI, path: string[], redirect: boolean) {
      return {
        "/": {
          "link@1": {
            path: path,
            id: id,
            space: "did:null:null",
            ...(redirect && { overwrite: "redirect" }),
          },
        },
      };
    }
    function makeRevision(id: URI, value: StorableDatum): Revision<State> {
      return {
        the: "application/json",
        of: id,
        is: { value: value },
        cause: refer({ the: "applicaton/json", of: id }),
        since: 1,
      };
    }

    it("returns proper redirect data", () => {
      // A[foo] => B[foo] -> C[foo] => D[foo]
      // Some helper functions
      function makeLink(id: URI, path: string[], redirect: boolean) {
        return {
          "/": {
            "link@1": {
              path: path,
              id: id,
              space: "did:null:null",
              ...(redirect && { overwrite: "redirect" }),
            },
          },
        };
      }
      function makeRevision(id: URI, value: StorableDatum): Revision<State> {
        return {
          the: "application/json",
          of: id,
          is: { value: value },
          cause: refer({ the: "applicaton/json", of: id }),
          since: 1,
        };
      }

      const store = new Map<string, Revision<State>>();
      const revD = makeRevision("of:doc-item-d", { foo: { text: "hello" } });
      const revC = makeRevision("of:doc-item-c", {
        foo: makeLink("of:doc-item-d", ["foo"], true),
      });
      const revB = makeRevision("of:doc-item-b", {
        foo: makeLink("of:doc-item-c", ["foo"], false),
      });
      const revA = makeRevision("of:doc-item-a", {
        foo: makeLink("of:doc-item-b", ["foo"], true),
      });
      for (const docRevision of [revA, revB, revC, revD]) {
        store.set(`${docRevision.of}/${docRevision.the}`, docRevision);
      }

      const manager = new StoreObjectManager(store);
      const managedTx = new ManagedStorageTransaction(manager);
      const tx = new ExtendedStorageTransaction(managedTx);
      const tracker = new CompoundCycleTracker<
        Immutable<StorableDatum>,
        JSONSchema | undefined
      >();
      const cfc = new ContextualFlowControl();
      const schemaTracker = new MapSet<string, SchemaPathSelector>();
      const docAFoo = {
        address: {
          id: revA.of,
          type: revA.the,
          path: ["value", "foo"],
          space: "did:null:null",
        } as IMemorySpaceAddress,
        value: (revA.is as any).value.foo as StorableDatum,
      };
      const docASelector = {
        path: ["value", "foo"],
        schemaContext: { schema: true, rootSchema: true },
      };
      const [curDoc, _selector1] = getAtPath(
        tx,
        docAFoo,
        [],
        tracker,
        cfc,
        schemaTracker,
        docASelector,
      );
      const [redirDoc, _selector2] = getAtPath(
        tx,
        docAFoo,
        [],
        tracker,
        cfc,
        schemaTracker,
        docASelector,
        false,
        "writeRedirect",
      );
      expect(curDoc.address.id).toBe(revD.of);
      expect(curDoc.address.path).toEqual(["value", "foo"]);
      expect(redirDoc.address.id).toBe(revB.of);
      expect(redirDoc.address.path).toEqual(["value", "foo"]);
    });

    it("returns proper redirect data when redirect is outside of link", () => {
      // A[current] => B[foo]
      // B -> C
      // we return C[foo] here, because there is no B[foo].
      const store = new Map<string, Revision<State>>();
      const revC = makeRevision("of:doc-item-c", { foo: { label: "first" } });
      const revB = makeRevision(
        "of:doc-item-b",
        makeLink("of:doc-item-c", [], false),
      );
      const revA = makeRevision("of:doc-item-a", {
        current: makeLink("of:doc-item-b", ["foo"], true),
      });
      for (const docRevision of [revA, revB, revC]) {
        store.set(`${docRevision.of}/${docRevision.the}`, docRevision);
      }

      const manager = new StoreObjectManager(store);
      const managedTx = new ManagedStorageTransaction(manager);
      const tx = new ExtendedStorageTransaction(managedTx);
      const tracker = new CompoundCycleTracker<
        Immutable<StorableDatum>,
        JSONSchema | undefined
      >();
      const cfc = new ContextualFlowControl();
      const schemaTracker = new MapSet<string, SchemaPathSelector>();
      const docACurrent = {
        address: {
          id: revA.of,
          type: revA.the,
          path: ["value", "current"],
          space: "did:null:null",
        } as IMemorySpaceAddress,
        value: (revA.is as any).value.current as StorableDatum,
      };
      const docASelector = { path: ["value", "current"], schema: true };
      const [curDoc, _selector1] = getAtPath(
        tx,
        docACurrent,
        [],
        tracker,
        cfc,
        schemaTracker,
        docASelector,
      );
      const [redirDoc, _selector2] = getAtPath(
        tx,
        docACurrent,
        [],
        tracker,
        cfc,
        schemaTracker,
        docASelector,
        false,
        "writeRedirect",
      );
      expect(curDoc.address.id).toBe(revC.of);
      expect(curDoc.address.path).toEqual(["value", "foo"]);
      expect(redirDoc.address.id).toBe(revC.of);
      expect(redirDoc.address.path).toEqual(["value", "foo"]);
    });

    it("returns proper redirect data when redirect is outside of link but then there's another redir", () => {
      // A[current] => B[foo]
      // B -> C
      // C[foo] => D[foo]
      // Redirect should be D[foo]
      const store = new Map<string, Revision<State>>();
      const revD = makeRevision("of:doc-item-d", { foo: { label: "first" } });
      const revC = makeRevision("of:doc-item-c", {
        foo: makeLink("of:doc-item-d", ["foo"], true),
      });
      const revB = makeRevision(
        "of:doc-item-b",
        makeLink("of:doc-item-c", [], false),
      );
      const revA = makeRevision("of:doc-item-a", {
        current: makeLink("of:doc-item-b", ["foo"], true),
      });
      for (const docRevision of [revA, revB, revC, revD]) {
        store.set(`${docRevision.of}/${docRevision.the}`, docRevision);
      }

      const manager = new StoreObjectManager(store);
      const managedTx = new ManagedStorageTransaction(manager);
      const tx = new ExtendedStorageTransaction(managedTx);
      const tracker = new CompoundCycleTracker<
        Immutable<StorableDatum>,
        JSONSchema | undefined
      >();
      const cfc = new ContextualFlowControl();
      const schemaTracker = new MapSet<string, SchemaPathSelector>();
      const docACurrent = {
        address: {
          id: revA.of,
          type: revA.the,
          path: ["value", "current"],
          space: "did:null:null",
        } as IMemorySpaceAddress,
        value: (revA.is as any).value.current as StorableDatum,
      };
      const docASelector = {
        path: ["value", "current"],
        schemaContext: { schema: true, rootSchema: true },
      };
      const [curDoc, _selector1] = getAtPath(
        tx,
        docACurrent,
        [],
        tracker,
        cfc,
        schemaTracker,
        docASelector,
      );
      const [redirDoc, redirDocSelector] = getAtPath(
        tx,
        docACurrent,
        [],
        tracker,
        cfc,
        schemaTracker,
        docASelector,
        false,
        "writeRedirect",
      );
      // we should also be able to get the value starting at the redir doc
      const [curDoc2, _selector3] = getAtPath(
        tx,
        redirDoc,
        [],
        tracker,
        cfc,
        schemaTracker,
        redirDocSelector,
      );
      expect(curDoc.address.id).toBe(revD.of);
      expect(curDoc.address.path).toEqual(["value", "foo"]);
      expect(redirDoc.address.id).toBe(revD.of);
      expect(redirDoc.address.path).toEqual(["value", "foo"]);
      expect(curDoc2.address.id).toBe(revD.of);
      expect(curDoc2.address.path).toEqual(["value", "foo"]);
    });
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
    const managedTx = new ManagedStorageTransaction(manager);
    const tx = new ExtendedStorageTransaction(managedTx);
    const tracker: PointerCycleTracker = new CompoundCycleTracker<
      Immutable<StorableDatum>,
      JSONSchema | undefined
    >();
    const cfc = new ContextualFlowControl();
    const schemaTracker = new MapSet<string, SchemaPathSelector>(deepEqual);

    const doc: IMemorySpaceAttestation = {
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    };

    // Navigate with invalid index "01"
    const [result1] = getAtPath(
      tx,
      doc,
      ["01"],
      tracker,
      cfc,
      schemaTracker,
    );

    // Navigate with valid index "1"
    const [result2] = getAtPath(
      tx,
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

describe("SchemaObjectTraverser boolean type handling", () => {
  it("correctly validates boolean values against boolean schema", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-boolean" as URI;
    const docEntity = docUri as Entity;

    // Array of booleans (like the hits array in the bug)
    const docValue = [true, false, true, false];

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
      items: { type: "boolean" },
    } as const satisfies JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });

    const result = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    // Should return the full array with boolean values preserved
    expect(result).toEqual([true, false, true, false]);
  });

  it("rejects boolean values when schema expects different type", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-boolean-reject" as URI;
    const docEntity = docUri as Entity;

    const docValue = true;

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      cause: refer({ the: type, of: docEntity }),
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = {
      type: "string",
    } as const satisfies JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });

    const result = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    // Should return undefined because boolean doesn't match string schema
    expect(result).toBeUndefined();
  });
});

describe("SchemaObjectTraverser anyOf/oneOf handling", () => {
  it("resolves anyOf schema by matching value type", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-anyof" as URI;
    const docEntity = docUri as Entity;

    const docValue = "hello";

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      cause: refer({ the: type, of: docEntity }),
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    // anyOf with string or number alternatives
    const schema = {
      anyOf: [
        { type: "string" },
        { type: "number" },
      ],
    } as JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });

    const result = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    // Should return the string value since it matches the string alternative
    expect(result).toBe("hello");
  });

  it("resolves oneOf schema with $ref by matching value type", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-oneof-ref" as URI;
    const docEntity = docUri as Entity;

    const docValue = { id: 1, name: "Item1" };

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      cause: refer({ the: type, of: docEntity }),
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    // oneOf with $ref that resolves to object type
    const schema = {
      oneOf: [
        { $ref: "#/$defs/Item" },
        { type: "null" },
      ],
      $defs: {
        Item: {
          type: "object",
          properties: {
            id: { type: "number" },
            name: { type: "string" },
          },
        },
      },
    } as JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });

    const result = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    // Should return the object since it matches the Item $ref alternative
    expect(result).toEqual({ id: 1, name: "Item1" });
  });

  it("handles nested objects with boolean arrays in anyOf schema", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-nested-boolean-array" as URI;
    const docEntity = docUri as Entity;

    // This mirrors the battleship bug structure: object with boolean array
    const docValue = {
      id: 1,
      name: "Ship1",
      hits: [false, false, true],
    };

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      cause: refer({ the: type, of: docEntity }),
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = {
      type: "object",
      properties: {
        id: { type: "number" },
        name: { type: "string" },
        hits: {
          type: "array",
          items: { type: "boolean" },
        },
      },
    } as JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });

    const result = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    // Should return the full object with hits array preserved
    expect(result).toEqual({
      id: 1,
      name: "Ship1",
      hits: [false, false, true],
    });
  });
});

describe("SchemaObjectTraverser oneOf correctness", () => {
  it("rejects values matching multiple oneOf branches", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-oneof-multiple" as URI;
    const docEntity = docUri as Entity;
    const docValue = { a: "x", b: "y" };

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      cause: refer({ the: type, of: docEntity }),
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = {
      oneOf: [
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
        {
          type: "object",
          properties: { b: { type: "string" } },
          required: ["b"],
        },
      ],
    } as const satisfies JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });
    const result = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    expect(result).toBeUndefined();
  });

  it("rejects values that only match oneOf by type but not constraints", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-oneof-constraints" as URI;
    const docEntity = docUri as Entity;
    const docValue = { name: "not-an-id" };

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      cause: refer({ the: type, of: docEntity }),
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = {
      oneOf: [
        {
          type: "object",
          required: ["id"],
          properties: { id: { type: "number" } },
        },
        { type: "null" },
      ],
    } as const satisfies JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });
    const result = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    expect(result).toBeUndefined();
  });
});

describe("SchemaObjectTraverser allOf correctness", () => {
  it("merges all successful allOf branch results", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-allof-merge" as URI;
    const docEntity = docUri as Entity;
    const docValue = { a: "x", b: "y" };

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      cause: refer({ the: type, of: docEntity }),
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = {
      allOf: [
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { b: { type: "string" } },
          required: ["b"],
          additionalProperties: false,
        },
      ],
    } as const satisfies JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });
    const result = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    expect(result).toEqual({ a: "x", b: "y" });
  });
});

describe("SchemaObjectTraverser defaults with $ref", () => {
  it("applies top-level default from resolved $ref schema", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-default-ref" as URI;

    const schema = {
      $ref: "#/$defs/Name",
      $defs: {
        Name: {
          type: "string",
          default: "from-ref",
        },
      },
    } as const satisfies JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });
    const result = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: undefined,
    });

    expect(result).toBe("from-ref");
  });
});

describe("CompoundCycleTracker cleanup", () => {
  it("removes empty partial-key entries on dispose", () => {
    const tracker = new CompoundCycleTracker<object, boolean>();
    const key = { id: "k1" };
    const disposable = tracker.include(key, true);
    expect(disposable).not.toBeNull();
    disposable![Symbol.dispose]();
    expect((tracker as any).partial.size).toBe(0);
  });
});
