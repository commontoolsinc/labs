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
import { ContextualFlowControl } from "@commontools/runner";
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

    const { ok: result } = traverser.traverse({
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

    const { ok: result } = traverser.traverse({
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

    const { ok: result } = traverser.traverse({
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

    const { ok: result } = traverser.traverse({
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

    const { ok: result } = traverser.traverse({
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

    const { error } = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    // Missing elements make the array invalid.
    expect(error).toBeDefined();
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

    const { ok: result } = traverser.traverse({
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

    const { ok: result } = traverser.traverse({
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

    const { error } = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    expect(error).toBeDefined();
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
    const schemaTracker = new MapSet<string, SchemaPathSelector>(true);

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

    const { ok: result } = traverser.traverse({
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

    const { error } = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    // boolean doesn't match string schema
    expect(error).toBeDefined();
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

    const { ok: result } = traverser.traverse({
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

    const { ok: result } = traverser.traverse({
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

    const { ok: result } = traverser.traverse({
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

describe("SchemaObjectTraverser array element validation fallback priority", () => {
  // These tests exercise the fallback in traverse.ts: when an element
  // fails schema validation, the traverser falls back in priority order:
  //   1. undefined  — if the item schema allows "undefined"
  //   2. null       — else if the item schema allows "null"
  //   3. failure    — otherwise the whole array is returned as undefined
  //
  // All tests use an inline number (42) inside a string array to trigger a
  // type-mismatch error without needing a broken link.

  function makeArrayDoc(
    docValue: StorableDatum[],
  ): {
    store: Map<string, Revision<State>>;
    docUri: URI;
    type: "application/json";
  } {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-fallback-array" as URI;
    const docEntity = docUri as Entity;
    store.set(`${docEntity}/${type}`, {
      the: type,
      of: docEntity,
      is: { value: docValue },
      cause: refer({ the: type, of: docEntity }),
      since: 1,
    });
    return { store, docUri, type };
  }

  it("uses undefined when element fails type check and schema allows undefined", () => {
    const docValue = ["hello", 42, "world"];
    const { store, docUri, type } = makeArrayDoc(docValue);
    const schema = {
      type: "array",
      items: { anyOf: [{ type: "string" }, { type: "undefined" }] },
    } as JSONSchema;

    const { ok: result } = getTraverser(store, { path: ["value"], schema })
      .traverse({
        address: { space: "did:null:null", id: docUri, type, path: ["value"] },
        value: docValue,
      });

    expect(result).toEqual(["hello", undefined, "world"]);
  });

  it("uses null when element fails type check and schema allows null (not undefined)", () => {
    const docValue = ["hello", 42, "world"];
    const { store, docUri, type } = makeArrayDoc(docValue);
    const schema = {
      type: "array",
      items: { anyOf: [{ type: "string" }, { type: "null" }] },
    } as JSONSchema;

    const { ok: result } = getTraverser(store, { path: ["value"], schema })
      .traverse({
        address: { space: "did:null:null", id: docUri, type, path: ["value"] },
        value: docValue,
      });

    expect(result).toEqual(["hello", null, "world"]);
  });

  it("prefers undefined over null when both are allowed by the item schema", () => {
    // undefined is checked first, so it wins even when null is also valid.
    const docValue = ["hello", 42, "world"];
    const { store, docUri, type } = makeArrayDoc(docValue);
    const schema = {
      type: "array",
      items: {
        anyOf: [{ type: "string" }, { type: "null" }, { type: "undefined" }],
      },
    } as JSONSchema;

    const { ok: result } = getTraverser(store, { path: ["value"], schema })
      .traverse({
        address: { space: "did:null:null", id: docUri, type, path: ["value"] },
        value: docValue,
      });

    expect(result).toEqual(["hello", undefined, "world"]);
  });

  it("returns an error for the whole array when element fails and neither fallback is allowed", () => {
    const docValue = ["hello", 42, "world"];
    const { store, docUri, type } = makeArrayDoc(docValue);
    const schema = {
      type: "array",
      items: { type: "string" },
    } as JSONSchema;

    const { error } = getTraverser(store, { path: ["value"], schema }).traverse(
      {
        address: { space: "did:null:null", id: docUri, type, path: ["value"] },
        value: docValue,
      },
    );

    expect(error).toBeDefined();
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
    const { error } = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    expect(error).toBeDefined();
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
    const { error } = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    expect(error).toBeDefined();
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
    const { ok: result } = traverser.traverse({
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
    const { ok: result } = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: undefined,
    });

    expect(result).toBe("from-ref");
  });
});

describe("SchemaObjectTraverser unknown type handling", () => {
  it("returns undefined for object value matched by type: unknown schema", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-unknown-object" as URI;
    const docEntity = docUri as Entity;

    const docValue = { key: "value", nested: { count: 42 } };

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      cause: refer({ the: type, of: docEntity }),
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = { type: "unknown" } as JSONSchema;
    const traverser = getTraverser(store, { path: ["value"], schema });

    const { ok: result, error } = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    // type: "unknown" marks the value as opaque — traversal short-circuits
    // without descending, so any links within are not followed
    expect(error).toBeUndefined();
    expect(result).toBeUndefined();
  });

  it("returns undefined for array value matched by type: unknown schema", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-unknown-array" as URI;
    const docEntity = docUri as Entity;

    const linkedUri = "of:doc-unknown-array-target" as URI;
    const docValue = [
      "a",
      { "/": { [LINK_V1_TAG]: { id: linkedUri, path: [] } } },
      "c",
    ];

    store.set(`${docEntity}/${type}`, {
      the: type,
      of: docEntity,
      is: { value: docValue },
      cause: refer({ the: type, of: docEntity }),
      since: 1,
    });
    store.set(`${linkedUri}/${type}`, {
      the: type,
      of: linkedUri as Entity,
      is: { value: { label: "should not appear" } },
      cause: refer({ the: type, of: linkedUri as Entity }),
      since: 1,
    });

    const schema = { type: "unknown" } as JSONSchema;
    const traverser = getTraverser(store, { path: ["value"], schema });

    const { ok: result, error } = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    // type: "unknown" on an array means the whole array is treated as opaque —
    // traversal short-circuits without following the embedded link
    expect(error).toBeUndefined();
    expect(result).toBeUndefined();
  });

  it("does not resolve linked content for object property with type: unknown schema", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const doc1Uri = "of:doc-unknown-prop-target" as URI;
    const doc2Uri = "of:doc-unknown-prop-container" as URI;

    // doc1 is the link target — its content should not appear in the result
    store.set(`${doc1Uri}/${type}`, {
      the: type,
      of: doc1Uri as Entity,
      is: { value: { name: "Alice", secret: "hidden" } },
      cause: refer({ the: type, of: doc1Uri as Entity }),
      since: 1,
    });

    const doc2Value = {
      id: 1,
      data: { "/": { [LINK_V1_TAG]: { id: doc1Uri, path: [] } } },
    };
    store.set(`${doc2Uri}/${type}`, {
      the: type,
      of: doc2Uri as Entity,
      is: { value: doc2Value },
      cause: refer({ the: type, of: doc2Uri as Entity }),
      since: 2,
    });

    const schema = {
      type: "object",
      properties: {
        id: { type: "number" },
        // type: "unknown" prevents the link target from being traversed
        data: { type: "unknown" },
      },
    } as JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });
    const { ok: result } = traverser.traverse({
      address: { space: "did:null:null", id: doc2Uri, type, path: ["value"] },
      value: doc2Value,
    });

    // "id" is traversed normally; "data" link target is not resolved into content
    const obj = result as Record<string, unknown>;
    expect(obj?.id).toBe(1);
    expect(obj?.data).toBeUndefined();
  });

  it("does not resolve linked properties when property schema is type: unknown", () => {
    // Chain: outer => inner => redir => first -> second -> data
    //
    // Behavior: All redirect links are followed, toCell() stops at first non-redirect
    // The data is fully resolved to { test: "foo" } but the cell reference stops at `first`

    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const redirectTestDataUri = "of:doc-redirect-test-data" as URI;
    const redirectTestSecondUri = "of:doc-redirect-test-second" as URI;
    const redirectTestFirstUri = "of:doc-redirect-test-first" as URI;
    const redirectTestRedirUri = "of:doc-redirect-test-redir" as URI;
    const redirectTestInnerUri = "of:doc-redirect-test-inner" as URI;
    const redirectTestOuterUri = "of:doc-redirect-test-outer" as URI;

    // redirect-test-data: holds the actual value
    store.set(`${redirectTestDataUri}/${type}`, {
      the: type,
      of: redirectTestDataUri as Entity,
      is: { value: { label: "should not appear" } },
      cause: refer({ the: type, of: redirectTestDataUri as Entity }),
      since: 1,
    });

    // redirect-test-second: points the actual value
    const secondValue = {
      "/": { [LINK_V1_TAG]: { id: redirectTestDataUri, path: [] } },
    };
    store.set(`${redirectTestSecondUri}/${type}`, {
      the: type,
      of: redirectTestSecondUri as Entity,
      is: { value: secondValue },
      cause: refer({ the: type, of: redirectTestSecondUri as Entity }),
      since: 2,
    });

    // redirect-test-first: points the actual value
    const firstValue = {
      "/": { [LINK_V1_TAG]: { id: redirectTestSecondUri, path: [] } },
    };
    store.set(`${redirectTestFirstUri}/${type}`, {
      the: type,
      of: redirectTestFirstUri as Entity,
      is: { value: firstValue },
      cause: refer({ the: type, of: redirectTestFirstUri as Entity }),
      since: 3,
    });

    // redirect-test-redir: holds the actual value
    const redirValue = {
      "/": {
        [LINK_V1_TAG]: { id: redirectTestFirstUri, path: [] },
        overwrite: "redirect",
      },
    };
    store.set(`${redirectTestRedirUri}/${type}`, {
      the: type,
      of: redirectTestRedirUri as Entity,
      is: { value: redirValue },
      cause: refer({ the: type, of: redirectTestRedirUri as Entity }),
      since: 4,
    });

    const innerValue = {
      "/": {
        [LINK_V1_TAG]: { id: redirectTestRedirUri, path: [] },
        overwrite: "redirect",
      },
    };
    store.set(`${redirectTestInnerUri}/${type}`, {
      the: type,
      of: redirectTestInnerUri as Entity,
      is: { value: innerValue },
      cause: refer({ the: type, of: redirectTestInnerUri as Entity }),
      since: 5,
    });

    const outerValue = {
      inner: {
        "/": {
          [LINK_V1_TAG]: { id: redirectTestInnerUri, path: [] },
          overwrite: "redirect",
        },
      },
    };
    store.set(`${redirectTestOuterUri}/${type}`, {
      the: type,
      of: redirectTestOuterUri as Entity,
      is: { value: outerValue },
      cause: refer({ the: type, of: redirectTestOuterUri as Entity }),
      since: 6,
    });

    const schema = {
      type: "object",
      properties: {
        inner: { type: "unknown" },
      },
      required: ["inner"],
      additionalProperties: false,
    } as JSONSchema;

    // Create these without the helper, so we can check the manager to see
    // which objects we include.
    const manager = new StoreObjectManager(store);
    const managedTx = new ManagedStorageTransaction(manager);
    const tx = new ExtendedStorageTransaction(managedTx);
    const traverser = new SchemaObjectTraverser(tx, {
      path: ["value"],
      schema,
    });

    const { ok: result, error } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: redirectTestOuterUri,
        type,
        path: ["value"],
      },
      value: outerValue,
    });

    expect(error).toBeUndefined();
    // linked object is not resolved into content
    expect(result).toEqual({ inner: undefined });
    // We should have read all the way through to the data object
    expect(
      [...manager.getReadDocs()].some((att) =>
        att.address.id === redirectTestDataUri
      ),
    ).toBe(true);
  });

  it("does not resolve linked properties when property schema is type: unknown and asCell is true", () => {
    // Chain: outer => inner => redir => first -> second -> data
    //
    // Behavior: All redirect links are followed, toCell() stops at first non-redirect
    // The data is fully resolved to { test: "foo" } but the cell reference stops at `first`

    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const redirectTestDataUri = "of:doc-redirect-test-data" as URI;
    const redirectTestSecondUri = "of:doc-redirect-test-second" as URI;
    const redirectTestFirstUri = "of:doc-redirect-test-first" as URI;
    const redirectTestRedirUri = "of:doc-redirect-test-redir" as URI;
    const redirectTestInnerUri = "of:doc-redirect-test-inner" as URI;
    const redirectTestOuterUri = "of:doc-redirect-test-outer" as URI;

    // redirect-test-data: holds the actual value
    store.set(`${redirectTestDataUri}/${type}`, {
      the: type,
      of: redirectTestDataUri as Entity,
      is: { value: { label: "should not appear" } },
      cause: refer({ the: type, of: redirectTestDataUri as Entity }),
      since: 1,
    });

    // redirect-test-second: points the actual value
    const secondValue = {
      "/": { [LINK_V1_TAG]: { id: redirectTestDataUri, path: [] } },
    };
    store.set(`${redirectTestSecondUri}/${type}`, {
      the: type,
      of: redirectTestSecondUri as Entity,
      is: { value: secondValue },
      cause: refer({ the: type, of: redirectTestSecondUri as Entity }),
      since: 2,
    });

    // redirect-test-first: points the actual value
    const firstValue = {
      "/": { [LINK_V1_TAG]: { id: redirectTestSecondUri, path: [] } },
    };
    store.set(`${redirectTestFirstUri}/${type}`, {
      the: type,
      of: redirectTestFirstUri as Entity,
      is: { value: firstValue },
      cause: refer({ the: type, of: redirectTestFirstUri as Entity }),
      since: 3,
    });

    // redirect-test-redir: holds the actual value
    const redirValue = {
      "/": {
        [LINK_V1_TAG]: { id: redirectTestFirstUri, path: [] },
        overwrite: "redirect",
      },
    };
    store.set(`${redirectTestRedirUri}/${type}`, {
      the: type,
      of: redirectTestRedirUri as Entity,
      is: { value: redirValue },
      cause: refer({ the: type, of: redirectTestRedirUri as Entity }),
      since: 4,
    });

    const innerValue = {
      "/": {
        [LINK_V1_TAG]: { id: redirectTestRedirUri, path: [] },
        overwrite: "redirect",
      },
    };
    store.set(`${redirectTestInnerUri}/${type}`, {
      the: type,
      of: redirectTestInnerUri as Entity,
      is: { value: innerValue },
      cause: refer({ the: type, of: redirectTestInnerUri as Entity }),
      since: 5,
    });

    const outerValue = {
      inner: {
        "/": {
          [LINK_V1_TAG]: { id: redirectTestInnerUri, path: [] },
          overwrite: "redirect",
        },
      },
    };
    store.set(`${redirectTestOuterUri}/${type}`, {
      the: type,
      of: redirectTestOuterUri as Entity,
      is: { value: outerValue },
      cause: refer({ the: type, of: redirectTestOuterUri as Entity }),
      since: 6,
    });

    const schema = {
      type: "object",
      properties: {
        inner: { type: "unknown", asCell: true },
      },
      required: ["inner"],
      additionalProperties: false,
    } as JSONSchema;

    // Create these without the helper, so we can check the manager to see
    // which objects we include.
    const manager = new StoreObjectManager(store);
    const managedTx = new ManagedStorageTransaction(manager);
    const tx = new ExtendedStorageTransaction(managedTx);
    const traverser = new SchemaObjectTraverser(tx, {
      path: ["value"],
      schema,
    });

    const { ok: result, error } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: redirectTestOuterUri,
        type,
        path: ["value"],
      },
      value: outerValue,
    });

    expect(error).toBeUndefined();
    // linked object is not resolved into content
    expect(result).toEqual({ inner: undefined });
    // We should have read all the way through to the data object
    expect(
      [...manager.getReadDocs()].some((att) =>
        att.address.id === redirectTestDataUri
      ),
    ).toBe(true);
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
