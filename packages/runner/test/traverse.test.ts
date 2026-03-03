import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  refer,
  resetCanonicalHashConfig,
  setCanonicalHashConfig,
} from "@commontools/memory/reference";
import type {
  Entity,
  Revision,
  SchemaPathSelector,
  State,
  StorableDatum,
  URI,
} from "@commontools/memory/interface";
import {
  canBranchMatch,
  CompoundCycleTracker,
  getAtPath,
  ManagedStorageTransaction,
  MapSet,
  mergeAnyOfBranchSchemas,
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

for (const canonicalHashing of [false, true]) {
  describe(`canonicalHashing=${canonicalHashing}`, () => {
    beforeAll(() => setCanonicalHashConfig(canonicalHashing));
    afterAll(() => resetCanonicalHashConfig());

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

        const traverser = getTraverser(store, {
          path: ["value"],
          schema: true,
        });

        const { ok: result } = traverser.traverse({
          address: {
            space: "did:null:null",
            id: doc2Uri,
            type,
            path: ["value"],
          },
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

        const traverser = getTraverser(store, {
          path: ["value"],
          schema: true,
        });

        const { ok: result } = traverser.traverse({
          address: {
            space: "did:null:null",
            id: docUri,
            type,
            path: ["value"],
          },
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
          address: {
            space: "did:null:null",
            id: docUri,
            type,
            path: ["value"],
          },
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
          address: {
            space: "did:null:null",
            id: docUri,
            type,
            path: ["value"],
          },
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
          address: {
            space: "did:null:null",
            id: docUri,
            type,
            path: ["value"],
          },
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
          address: {
            space: "did:null:null",
            id: docUri,
            type,
            path: ["value"],
          },
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
          address: {
            space: "did:null:null",
            id: docUri,
            type,
            path: ["value"],
          },
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
          address: {
            space: "did:null:null",
            id: docUri,
            type,
            path: ["value"],
          },
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
          address: {
            space: "did:null:null",
            id: docUri,
            type,
            path: ["value"],
          },
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
            cause: refer({ the: "application/json", of: id }),
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
          function makeRevision(
            id: URI,
            value: StorableDatum,
          ): Revision<State> {
            return {
              the: "application/json",
              of: id,
              is: { value: value },
              cause: refer({ the: "application/json", of: id }),
              since: 1,
            };
          }

          const store = new Map<string, Revision<State>>();
          const revD = makeRevision("of:doc-item-d", {
            foo: { text: "hello" },
          });
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
            schemaContext: { schema: true },
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
          const revC = makeRevision("of:doc-item-c", {
            foo: { label: "first" },
          });
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
          const revD = makeRevision("of:doc-item-d", {
            foo: { label: "first" },
          });
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
            schemaContext: { schema: true },
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
          address: {
            space: "did:null:null",
            id: docUri,
            type,
            path: ["value"],
          },
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
          address: {
            space: "did:null:null",
            id: docUri,
            type,
            path: ["value"],
          },
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
          address: {
            space: "did:null:null",
            id: docUri,
            type,
            path: ["value"],
          },
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
          address: {
            space: "did:null:null",
            id: docUri,
            type,
            path: ["value"],
          },
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
          address: {
            space: "did:null:null",
            id: docUri,
            type,
            path: ["value"],
          },
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
          address: {
            space: "did:null:null",
            id: docUri,
            type,
            path: ["value"],
          },
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
            address: {
              space: "did:null:null",
              id: docUri,
              type,
              path: ["value"],
            },
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
            address: {
              space: "did:null:null",
              id: docUri,
              type,
              path: ["value"],
            },
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
            anyOf: [{ type: "string" }, { type: "null" }, {
              type: "undefined",
            }],
          },
        } as JSONSchema;

        const { ok: result } = getTraverser(store, { path: ["value"], schema })
          .traverse({
            address: {
              space: "did:null:null",
              id: docUri,
              type,
              path: ["value"],
            },
            value: docValue,
          });

        expect(result).toEqual(["hello", undefined, "world"]);
      });

      it("returns undefined for the whole array when element fails and neither fallback is allowed", () => {
        const docValue = ["hello", 42, "world"];
        const { store, docUri, type } = makeArrayDoc(docValue);
        const schema = {
          type: "array",
          items: { type: "string" },
        } as JSONSchema;

        const { error } = getTraverser(store, { path: ["value"], schema })
          .traverse({
            address: {
              space: "did:null:null",
              id: docUri,
              type,
              path: ["value"],
            },
            value: docValue,
          });

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
          address: {
            space: "did:null:null",
            id: docUri,
            type,
            path: ["value"],
          },
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
          address: {
            space: "did:null:null",
            id: docUri,
            type,
            path: ["value"],
          },
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
          address: {
            space: "did:null:null",
            id: docUri,
            type,
            path: ["value"],
          },
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
          address: {
            space: "did:null:null",
            id: docUri,
            type,
            path: ["value"],
          },
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

    describe("canBranchMatch", () => {
      it("rejects type mismatch: string value vs number schema", () => {
        expect(canBranchMatch({ type: "number" }, "hello")).toBe(false);
      });

      it("rejects type mismatch: number value vs string schema", () => {
        expect(canBranchMatch({ type: "string" }, 42)).toBe(false);
      });

      it("rejects type mismatch: object value vs array schema", () => {
        expect(canBranchMatch({ type: "array" }, { a: 1 })).toBe(false);
      });

      it("accepts matching type", () => {
        expect(canBranchMatch({ type: "string" }, "hello")).toBe(true);
        expect(canBranchMatch({ type: "number" }, 42)).toBe(true);
        expect(canBranchMatch({ type: "object" }, { a: 1 })).toBe(true);
        expect(canBranchMatch({ type: "array" }, [1, 2])).toBe(true);
        expect(canBranchMatch({ type: "boolean" }, true)).toBe(true);
        expect(canBranchMatch({ type: "null" }, null)).toBe(true);
      });

      it("conservatively accepts const schemas (values may contain unresolved links)", () => {
        expect(canBranchMatch({ const: "a" }, "b")).toBe(true);
        expect(canBranchMatch({ const: "a" }, "a")).toBe(true);
      });

      it("conservatively accepts enum schemas (values may contain unresolved links)", () => {
        expect(canBranchMatch({ enum: ["a", "b"] }, "c")).toBe(true);
        expect(canBranchMatch({ enum: ["a", "b"] }, "a")).toBe(true);
      });

      it("rejects missing required properties", () => {
        expect(
          canBranchMatch(
            { type: "object", required: ["name", "age"] },
            { name: "Alice" },
          ),
        ).toBe(false);
      });

      it("accepts when all required properties present", () => {
        expect(
          canBranchMatch(
            { type: "object", required: ["name"] },
            { name: "Alice", extra: true },
          ),
        ).toBe(true);
      });

      it("conservatively accepts property-level const (values may be unresolved links)", () => {
        // Even when the property value doesn't match the const, we can't reject
        // because the value might be a link that resolves to a matching value.
        expect(
          canBranchMatch(
            {
              type: "object",
              properties: { kind: { const: "cat" } },
            },
            { kind: "dog", name: "Rex" },
          ),
        ).toBe(true);
        expect(
          canBranchMatch(
            {
              type: "object",
              properties: { kind: { const: "cat" } },
            },
            { kind: "cat", name: "Whiskers" },
          ),
        ).toBe(true);
      });

      it("conservatively accepts property-level enum (values may be unresolved links)", () => {
        expect(
          canBranchMatch(
            {
              type: "object",
              properties: { status: { enum: ["active", "inactive"] } },
            },
            { status: "deleted" },
          ),
        ).toBe(true);
      });

      it("returns true (conservative) when uncertain — no type specified", () => {
        expect(canBranchMatch({}, "anything")).toBe(true);
        expect(canBranchMatch({}, 123)).toBe(true);
        expect(canBranchMatch({}, { a: 1 })).toBe(true);
      });

      it("never rejects asCell branches", () => {
        expect(canBranchMatch({ asCell: true, type: "number" }, "hello")).toBe(
          true,
        );
      });

      it("never rejects asStream branches", () => {
        expect(
          canBranchMatch({ asStream: true, type: "number" }, "hello"),
        ).toBe(true);
      });

      it("handles boolean schemas", () => {
        expect(canBranchMatch(true, "anything")).toBe(true);
        expect(canBranchMatch(false, "anything")).toBe(false);
      });

      it("accepts when properties have const/enum (no property-level discrimination)", () => {
        // Property-level const/enum are not checked because values may contain
        // unresolved links. This test confirms no rejection happens.
        expect(
          canBranchMatch(
            {
              type: "object",
              properties: { kind: { const: "cat" } },
            },
            { name: "Whiskers" },
          ),
        ).toBe(true);
      });

      it("handles array type in schema", () => {
        expect(canBranchMatch({ type: ["string", "number"] }, "hello")).toBe(
          true,
        );
        expect(canBranchMatch({ type: ["string", "number"] }, 42)).toBe(true);
        expect(canBranchMatch({ type: ["string", "number"] }, true)).toBe(
          false,
        );
      });

      it("checks required properties when type is an array including 'object'", () => {
        // type: ["object", "null"] should still check required properties
        expect(
          canBranchMatch(
            { type: ["object", "null"], required: ["name"] },
            { name: "Alice" },
          ),
        ).toBe(true);
        expect(
          canBranchMatch(
            { type: ["object", "null"], required: ["name"] },
            { age: 30 },
          ),
        ).toBe(false);
        // type array without "object" should skip required check
        expect(
          canBranchMatch(
            { type: ["string", "number"], required: ["name"] },
            { age: 30 },
          ),
        ).toBe(false); // rejected by type mismatch, not required
      });

      it("conservatively accepts when value is a cell link object", () => {
        const linkValue = {
          "/": { [LINK_V1_TAG]: { id: "of:target", path: [] } },
        };
        // Even if the branch type doesn't match the link's shape, links get
        // resolved during traversal so we must not reject.
        expect(canBranchMatch({ type: "string" }, linkValue)).toBe(true);
        expect(canBranchMatch({ type: "number" }, linkValue)).toBe(true);
        expect(
          canBranchMatch(
            { type: "object", required: ["missing"] },
            linkValue,
          ),
        ).toBe(true);
      });
    });

    describe("mergeAnyOfBranchSchemas", () => {
      it("returns null for fewer than 2 branches", () => {
        expect(
          mergeAnyOfBranchSchemas([{ type: "object" }], {}),
        ).toBe(null);
      });

      it("returns null when a branch is not an object type", () => {
        expect(
          mergeAnyOfBranchSchemas(
            [{ type: "string" }, { type: "object" }],
            {},
          ),
        ).toBe(null);
      });

      it("merges disjoint properties from two branches", () => {
        const result = mergeAnyOfBranchSchemas(
          [
            { type: "object", properties: { a: { type: "string" } } },
            { type: "object", properties: { b: { type: "number" } } },
          ],
          {},
        );
        expect(result).not.toBe(null);
        const r = result as Record<string, unknown>;
        expect(r.type).toBe("object");
        const props = r.properties as Record<string, unknown>;
        expect(props.a).toEqual({ type: "string" });
        expect(props.b).toEqual({ type: "number" });
      });

      it("wraps overlapping properties with different schemas in anyOf", () => {
        const result = mergeAnyOfBranchSchemas(
          [
            { type: "object", properties: { x: { type: "string" } } },
            { type: "object", properties: { x: { type: "number" } } },
          ],
          {},
        );
        expect(result).not.toBe(null);
        const props = (result as Record<string, unknown>)
          .properties as Record<string, unknown>;
        const xSchema = props.x as Record<string, unknown>;
        expect(xSchema.anyOf).toBeDefined();
        expect((xSchema.anyOf as unknown[]).length).toBe(2);
      });

      it("uses single schema when overlapping properties are identical", () => {
        const result = mergeAnyOfBranchSchemas(
          [
            { type: "object", properties: { x: { type: "string" } } },
            { type: "object", properties: { x: { type: "string" } } },
          ],
          {},
        );
        expect(result).not.toBe(null);
        const props = (result as Record<string, unknown>)
          .properties as Record<string, unknown>;
        expect(props.x).toEqual({ type: "string" });
      });

      it("computes required as intersection", () => {
        const result = mergeAnyOfBranchSchemas(
          [
            {
              type: "object",
              properties: { a: { type: "string" }, b: { type: "string" } },
              required: ["a", "b"],
            },
            {
              type: "object",
              properties: { a: { type: "string" }, c: { type: "number" } },
              required: ["a"],
            },
          ],
          {},
        );
        expect(result).not.toBe(null);
        const r = result as Record<string, unknown>;
        // Only "a" is required by both branches
        expect(r.required).toEqual(["a"]);
      });

      it("merges $defs from all branches", () => {
        const result = mergeAnyOfBranchSchemas(
          [
            {
              type: "object",
              properties: { a: { type: "string" } },
              $defs: { Foo: { type: "string" } },
            },
            {
              type: "object",
              properties: { b: { type: "number" } },
              $defs: { Bar: { type: "number" } },
            },
          ],
          {},
        );
        expect(result).not.toBe(null);
        const r = result as Record<string, unknown>;
        const defs = r.$defs as Record<string, unknown>;
        expect(defs.Foo).toEqual({ type: "string" });
        expect(defs.Bar).toEqual({ type: "number" });
      });

      it("returns null when branches have no properties", () => {
        expect(
          mergeAnyOfBranchSchemas(
            [{ type: "object" }, { type: "object" }],
            {},
          ),
        ).toBe(null);
      });

      it("returns null for boolean branch schemas", () => {
        expect(
          mergeAnyOfBranchSchemas([true, { type: "object" }], {}),
        ).toBe(null);
      });
    });

    describe("anyOf optimization integration", () => {
      it("fast-rejects incompatible branches and still produces correct result", () => {
        const store = new Map<string, Revision<State>>();
        const type = "application/json" as const;
        const docUri = "of:doc-discriminated" as URI;
        const docEntity = docUri as Entity;

        const docValue = { kind: "circle", radius: 5 };

        const docRevision: Revision<State> = {
          the: type,
          of: docEntity,
          is: { value: docValue },
          cause: refer({ the: type, of: docEntity }),
          since: 1,
        };
        store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

        // Discriminated union by "kind" const
        const schema = {
          anyOf: [
            {
              type: "object",
              properties: {
                kind: { const: "square" },
                side: { type: "number" },
              },
              required: ["kind"],
            },
            {
              type: "object",
              properties: {
                kind: { const: "circle" },
                radius: { type: "number" },
              },
              required: ["kind"],
            },
            {
              type: "object",
              properties: {
                kind: { const: "triangle" },
                base: { type: "number" },
                height: { type: "number" },
              },
              required: ["kind"],
            },
          ],
        } as JSONSchema;

        const traverser = getTraverser(store, { path: ["value"], schema });

        const { ok: result } = traverser.traverse({
          address: {
            space: "did:null:null",
            id: docUri,
            type,
            path: ["value"],
          },
          value: docValue,
        });

        expect(result).toEqual({ kind: "circle", radius: 5 });
      });

      it("property-merges disjoint object branches into a single traversal", () => {
        const store = new Map<string, Revision<State>>();
        const type = "application/json" as const;
        const docUri = "of:doc-disjoint" as URI;
        const docEntity = docUri as Entity;

        const docValue = { name: "Alice", age: 30 };

        const docRevision: Revision<State> = {
          the: type,
          of: docEntity,
          is: { value: docValue },
          cause: refer({ the: type, of: docEntity }),
          since: 1,
        };
        store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

        const schema = {
          anyOf: [
            {
              type: "object",
              properties: { name: { type: "string" } },
            },
            {
              type: "object",
              properties: { age: { type: "number" } },
            },
          ],
        } as JSONSchema;

        const traverser = getTraverser(store, { path: ["value"], schema });

        const { ok: result } = traverser.traverse({
          address: {
            space: "did:null:null",
            id: docUri,
            type,
            path: ["value"],
          },
          value: docValue,
        });

        // Both properties should be discovered via branch-by-branch + mergeAnyOfMatches
        expect(result).toEqual({ name: "Alice", age: 30 });
      });

      it("preserves link discovery across all branches", () => {
        const store = new Map<string, Revision<State>>();
        const type = "application/json" as const;
        const docUri = "of:doc-links" as URI;
        const docEntity = docUri as Entity;
        const linkedUri = "of:linked-doc" as URI;
        const linkedEntity = linkedUri as Entity;

        const linkedRevision: Revision<State> = {
          the: type,
          of: linkedEntity,
          is: { value: "linked-value" },
          cause: refer({ the: type, of: linkedEntity }),
          since: 1,
        };
        store.set(`${linkedRevision.of}/${linkedRevision.the}`, linkedRevision);

        const docValue = {
          title: "test",
          ref: {
            "/": {
              [LINK_V1_TAG]: {
                id: linkedUri,
                path: [],
              },
            },
          },
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
          anyOf: [
            {
              type: "object",
              properties: {
                title: { type: "string" },
                ref: { type: "string" },
              },
            },
            {
              type: "object",
              properties: {
                title: { type: "string" },
              },
            },
          ],
        } as JSONSchema;

        const traverser = getTraverser(store, { path: ["value"], schema });

        const { ok: result } = traverser.traverse({
          address: {
            space: "did:null:null",
            id: docUri,
            type,
            path: ["value"],
          },
          value: docValue,
        });

        // Both branches survive (both are object types). Branch 1 includes ref,
        // branch 2 does not. mergeAnyOfMatches combines them via Object.assign.
        // The link value is preserved as-is (not resolved in this unit test context).
        expect((result as Record<string, unknown>).title).toBe("test");
        expect((result as Record<string, unknown>).ref).toEqual(docValue.ref);
      });

      it("falls back correctly for primitive values", () => {
        const store = new Map<string, Revision<State>>();
        const type = "application/json" as const;
        const docUri = "of:doc-primitive-anyof" as URI;
        const docEntity = docUri as Entity;

        const docValue = 42;

        const docRevision: Revision<State> = {
          the: type,
          of: docEntity,
          is: { value: docValue },
          cause: refer({ the: type, of: docEntity }),
          since: 1,
        };
        store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

        const schema = {
          anyOf: [
            { type: "string" },
            { type: "number" },
            { type: "boolean" },
          ],
        } as JSONSchema;

        const traverser = getTraverser(store, { path: ["value"], schema });

        const { ok: result } = traverser.traverse({
          address: {
            space: "did:null:null",
            id: docUri,
            type,
            path: ["value"],
          },
          value: docValue,
        });

        expect(result).toBe(42);
        // String and boolean branches should be fast-rejected
        expect(traverser.anyOfFastRejects).toBeGreaterThanOrEqual(2);
      });

      it("handles mixed object and primitive anyOf branches", () => {
        const store = new Map<string, Revision<State>>();
        const type = "application/json" as const;
        const docUri = "of:doc-mixed-anyof" as URI;
        const docEntity = docUri as Entity;

        const docValue = { name: "test" };

        const docRevision: Revision<State> = {
          the: type,
          of: docEntity,
          is: { value: docValue },
          cause: refer({ the: type, of: docEntity }),
          since: 1,
        };
        store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

        const schema = {
          anyOf: [
            { type: "string" },
            { type: "null" },
            { type: "object", properties: { name: { type: "string" } } },
          ],
        } as JSONSchema;

        const traverser = getTraverser(store, { path: ["value"], schema });

        const { ok: result } = traverser.traverse({
          address: {
            space: "did:null:null",
            id: docUri,
            type,
            path: ["value"],
          },
          value: docValue,
        });

        expect(result).toEqual({ name: "test" });
        // string and null branches should be fast-rejected
        expect(traverser.anyOfFastRejects).toBeGreaterThanOrEqual(2);
      });
    });

    describe("anyOf fast-reject reactivity invariants (traverseCells)", () => {
      // These tests verify that the fast-reject optimization does NOT break
      // reactivity. When traverseCells=true (the default), the schemaTracker
      // must record every document whose value can affect the result, so that
      // subscriptions fire when any contributing document changes.
      //
      // Key invariants:
      //   1. The root document is ALWAYS tracked.
      //   2. Linked documents reachable through surviving branches are tracked.
      //   3. If the root document later changes (e.g. discriminator flips), the
      //      subscription fires and a fresh traversal discovers the new branch's
      //      links. Therefore, links exclusive to fast-rejected branches do NOT
      //      need to be tracked preemptively — the root doc subscription covers
      //      that scenario.

      const SPACE = "did:null:null";
      const TYPE = "application/json" as const;

      /** Build a tracker key matching the internal getTrackerKey() format. */
      function trackerKey(id: string): string {
        return `${SPACE}/${id}/${TYPE}`;
      }

      /** Shortcut: store a document in the map-based store. */
      function putDoc(
        store: Map<string, Revision<State>>,
        id: string,
        value: unknown,
      ) {
        const entity = id as Entity;
        store.set(`${entity}/${TYPE}`, {
          the: TYPE,
          of: entity,
          is: { value },
          cause: refer({ the: TYPE, of: entity }),
          since: 1,
        } as Revision<State>);
      }

      /** Create a link value (sigil v1 format). */
      function makeLink(targetId: string, path: string[] = []) {
        return {
          "/": {
            [LINK_V1_TAG]: { id: targetId, path },
          },
        };
      }

      /** Access the protected schemaTracker from the traverser. */
      function getSchemaTracker(
        traverser: SchemaObjectTraverser<StorableDatum>,
      ): MapSet<string, SchemaPathSelector> {
        return (traverser as any).schemaTracker;
      }

      it("tracks the root document even when all anyOf branches are fast-rejected", () => {
        const store = new Map<string, Revision<State>>();
        const docUri = "of:doc-no-match" as URI;

        // Value is a number, but all branches expect string or boolean
        putDoc(store, docUri, 42);

        const schema = {
          anyOf: [
            { type: "string" },
            { type: "boolean" },
          ],
        } as JSONSchema;

        const traverser = getTraverser(store, { path: ["value"], schema });
        traverser.traverse({
          address: { space: SPACE, id: docUri, type: TYPE, path: ["value"] },
          value: 42,
        });

        const tracker = getSchemaTracker(traverser);
        // Root doc must ALWAYS be tracked — if its value changes, we re-traverse
        expect(tracker.has(trackerKey(docUri))).toBe(true);
      });

      it("tracks linked docs reached through the matching branch (type-based rejection)", () => {
        const store = new Map<string, Revision<State>>();
        const rootUri = "of:doc-disc-root" as URI;
        const circleDataUri = "of:circle-data" as URI;

        putDoc(store, circleDataUri, "radius-info");

        const rootValue = {
          kind: "circle",
          data: makeLink(circleDataUri),
        };
        putDoc(store, rootUri, rootValue);

        // Object branch has a link property; string branch is type-rejected
        const schema = {
          anyOf: [
            {
              type: "object",
              properties: {
                kind: { type: "string" },
                data: { type: "string" },
              },
            },
            { type: "string" },
          ],
        } as JSONSchema;

        const traverser = getTraverser(store, { path: ["value"], schema });
        const { ok: result } = traverser.traverse({
          address: { space: SPACE, id: rootUri, type: TYPE, path: ["value"] },
          value: rootValue,
        });

        // Correct result — link resolved through object branch
        expect((result as any).kind).toBe("circle");
        expect((result as any).data).toBe("radius-info");

        // "string" branch should be fast-rejected (type mismatch)
        expect(traverser.anyOfFastRejects).toBeGreaterThanOrEqual(1);

        // Reactivity: both root and linked doc must be tracked
        const tracker = getSchemaTracker(traverser);
        expect(tracker.has(trackerKey(rootUri))).toBe(true);
        expect(tracker.has(trackerKey(circleDataUri))).toBe(true);
      });

      it("tracks linked docs in shared properties even when some branches are fast-rejected", () => {
        const store = new Map<string, Revision<State>>();
        const rootUri = "of:doc-shared-link" as URI;
        const sharedUri = "of:shared-target" as URI;

        putDoc(store, sharedUri, "shared-value");

        // Both branches reference the same property "ref" which has a link.
        // "string" branch is fast-rejected (value is an object), but the
        // surviving "object" branch still traverses "ref".
        const rootValue = {
          name: "test",
          ref: makeLink(sharedUri),
        };
        putDoc(store, rootUri, rootValue);

        const schema = {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                name: { type: "string" },
                ref: { type: "string" },
              },
            },
          ],
        } as JSONSchema;

        const traverser = getTraverser(store, { path: ["value"], schema });
        const { ok: result } = traverser.traverse({
          address: { space: SPACE, id: rootUri, type: TYPE, path: ["value"] },
          value: rootValue,
        });

        expect((result as any).ref).toBe("shared-value");
        expect(traverser.anyOfFastRejects).toBeGreaterThanOrEqual(1);

        const tracker = getSchemaTracker(traverser);
        expect(tracker.has(trackerKey(rootUri))).toBe(true);
        expect(tracker.has(trackerKey(sharedUri))).toBe(true);
      });

      it("tracks all linked docs when multiple links survive fast-reject", () => {
        const store = new Map<string, Revision<State>>();
        const rootUri = "of:doc-multi-link" as URI;
        const linkAUri = "of:link-a" as URI;
        const linkBUri = "of:link-b" as URI;

        putDoc(store, linkAUri, "value-a");
        putDoc(store, linkBUri, "value-b");

        const rootValue = {
          kind: "circle",
          linkA: makeLink(linkAUri),
          linkB: makeLink(linkBUri),
        };
        putDoc(store, rootUri, rootValue);

        // Object branch has two links; null and string branches are type-rejected
        const schema = {
          anyOf: [
            {
              type: "object",
              properties: {
                kind: { type: "string" },
                linkA: { type: "string" },
                linkB: { type: "string" },
              },
            },
            { type: "null" },
            { type: "string" },
          ],
        } as JSONSchema;

        const traverser = getTraverser(store, { path: ["value"], schema });
        const { ok: result } = traverser.traverse({
          address: { space: SPACE, id: rootUri, type: TYPE, path: ["value"] },
          value: rootValue,
        });

        expect((result as any).linkA).toBe("value-a");
        expect((result as any).linkB).toBe("value-b");

        // "null" and "string" branches should be fast-rejected (type mismatch)
        expect(traverser.anyOfFastRejects).toBeGreaterThanOrEqual(2);

        // ALL three docs (root + 2 links) must be tracked for reactivity
        const tracker = getSchemaTracker(traverser);
        expect(tracker.has(trackerKey(rootUri))).toBe(true);
        expect(tracker.has(trackerKey(linkAUri))).toBe(true);
        expect(tracker.has(trackerKey(linkBUri))).toBe(true);
      });

      it("root doc subscription ensures rejected-branch links become discoverable on change", () => {
        // Scenario: branch A matches now and has linkA tracked.
        // Branch B is fast-rejected (missing required property); its exclusive
        // linkB is NOT tracked. This is safe because: if the root doc changes
        // to include branch B's required property, the root-doc subscription
        // fires and a fresh traversal will now match branch B and discover linkB.
        //
        // We verify this by doing TWO traversals with different root values.
        // Uses required-property discrimination (const/enum checks removed per
        // review — values may contain unresolved links).
        const store = new Map<string, Revision<State>>();
        const rootUri = "of:doc-flip" as URI;
        const circleLinkUri = "of:circle-link" as URI;
        const squareLinkUri = "of:square-link" as URI;

        putDoc(store, circleLinkUri, "circle-data");
        putDoc(store, squareLinkUri, "square-data");

        // First traversal: has circleOnly → branch A matches, branch B rejected
        const circleValue = {
          circleOnly: true,
          circleLink: makeLink(circleLinkUri),
          squareLink: makeLink(squareLinkUri),
        };
        putDoc(store, rootUri, circleValue);

        const schema = {
          anyOf: [
            {
              type: "object",
              properties: {
                circleLink: { type: "string" },
              },
              required: ["circleOnly"],
            },
            {
              type: "object",
              properties: {
                squareLink: { type: "string" },
              },
              required: ["squareOnly"],
            },
          ],
        } as JSONSchema;

        const traverser1 = getTraverser(store, { path: ["value"], schema });
        const result1 = traverser1.traverse({
          address: { space: SPACE, id: rootUri, type: TYPE, path: ["value"] },
          value: circleValue,
        });

        expect((result1 as any).circleLink).toBe("circle-data");
        expect(traverser1.anyOfFastRejects).toBeGreaterThanOrEqual(1);
        const tracker1 = getSchemaTracker(traverser1);
        expect(tracker1.has(trackerKey(rootUri))).toBe(true);
        expect(tracker1.has(trackerKey(circleLinkUri))).toBe(true);

        // Second traversal: root doc changes to have squareOnly
        // (simulates a reactive re-run after the root subscription fires)
        const squareValue = {
          squareOnly: true,
          circleLink: makeLink(circleLinkUri),
          squareLink: makeLink(squareLinkUri),
        };
        putDoc(store, rootUri, squareValue);

        const traverser2 = getTraverser(store, { path: ["value"], schema });
        const result2 = traverser2.traverse({
          address: { space: SPACE, id: rootUri, type: TYPE, path: ["value"] },
          value: squareValue,
        });

        expect((result2 as any).squareLink).toBe("square-data");
        expect(traverser2.anyOfFastRejects).toBeGreaterThanOrEqual(1);
        const tracker2 = getSchemaTracker(traverser2);
        expect(tracker2.has(trackerKey(rootUri))).toBe(true);
        expect(tracker2.has(trackerKey(squareLinkUri))).toBe(true);
      });

      it("tracks nested linked docs through surviving anyOf branches", () => {
        // Chain: root → midDoc → leafDoc, all through an anyOf-guarded schema
        const store = new Map<string, Revision<State>>();
        const rootUri = "of:doc-nested-root" as URI;
        const midUri = "of:doc-mid" as URI;
        const leafUri = "of:doc-leaf" as URI;

        putDoc(store, leafUri, "leaf-value");
        putDoc(store, midUri, { inner: makeLink(leafUri) });

        const rootValue = {
          kind: "deep",
          ref: makeLink(midUri),
        };
        putDoc(store, rootUri, rootValue);

        // Object branch has nested link chain; string and null branches type-rejected
        const schema = {
          anyOf: [
            {
              type: "object",
              properties: {
                kind: { type: "string" },
                ref: {
                  type: "object",
                  properties: {
                    inner: { type: "string" },
                  },
                },
              },
            },
            { type: "string" },
            { type: "null" },
          ],
        } as JSONSchema;

        const traverser = getTraverser(store, { path: ["value"], schema });
        const { ok: result } = traverser.traverse({
          address: { space: SPACE, id: rootUri, type: TYPE, path: ["value"] },
          value: rootValue,
        });

        expect((result as any).kind).toBe("deep");
        expect((result as any).ref).toEqual({ inner: "leaf-value" });

        // "string" and "null" branches fast-rejected (type mismatch)
        expect(traverser.anyOfFastRejects).toBeGreaterThanOrEqual(2);

        // All three docs in the chain must be tracked
        const tracker = getSchemaTracker(traverser);
        expect(tracker.has(trackerKey(rootUri))).toBe(true);
        expect(tracker.has(trackerKey(midUri))).toBe(true);
        expect(tracker.has(trackerKey(leafUri))).toBe(true);
      });
    });
  }); // describe(`canonicalHashing=${canonicalHashing}`)
} // for canonicalHashing

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

