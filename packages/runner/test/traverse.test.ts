import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { refer } from "merkle-reference/json";
import type {
  Entity,
  JSONValue,
  Revision,
  SchemaContext,
  SchemaPathSelector,
  State,
  URI,
} from "@commontools/memory/interface";
import {
  CompoundCycleTracker,
  getAtPath,
  ManagedStorageTransaction,
  MapSet,
  SchemaObjectTraverser,
} from "../src/traverse.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { Immutable } from "@commontools/utils/types";
import { ContextualFlowControl } from "@commontools/runner";
import { IMemorySpaceAddress } from "../src/storage/interface.ts";

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
    const managedTx = new ManagedStorageTransaction(manager);
    const tx = new ExtendedStorageTransaction(managedTx);
    const traverser = new SchemaObjectTraverser(tx, {
      path: ["value"],
      schemaContext: { schema: true, rootSchema: true },
    });

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
    const managedTx = new ManagedStorageTransaction(manager);
    const tx = new ExtendedStorageTransaction(managedTx);
    const traverser = new SchemaObjectTraverser(tx, {
      path: ["value"],
      schemaContext: { schema, rootSchema: schema },
    });

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

    const manager = new StoreObjectManager(store);
    const managedTx = new ManagedStorageTransaction(manager);
    const tx = new ExtendedStorageTransaction(managedTx);
    const traverser = new SchemaObjectTraverser(tx, {
      path: ["value"],
      schemaContext: { schema, rootSchema: schema },
    });

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
    function makeRevision(id: URI, value: JSONValue): Revision<State> {
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
      function makeRevision(id: URI, value: JSONValue): Revision<State> {
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
        Immutable<JSONValue>,
        SchemaContext | undefined
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
        value: (revA.is as any).value.foo as JSONValue,
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
        Immutable<JSONValue>,
        SchemaContext | undefined
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
        value: (revA.is as any).value.current as JSONValue,
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
        Immutable<JSONValue>,
        SchemaContext | undefined
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
        value: (revA.is as any).value.current as JSONValue,
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
