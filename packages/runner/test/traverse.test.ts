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
  type BaseMemoryAddress,
  CompoundCycleTracker,
  type IAttestation,
  SchemaObjectTraverser,
} from "../src/traverse.ts";
import type { Immutable } from "@commontools/utils/types";
import type { JSONValue, SchemaContext } from "../src/builder/types.ts";
import { StoreObjectManager } from "../src/storage/query.ts";

class TestTraverser extends SchemaObjectTraverser<BaseMemoryAddress> {
  traverseDocument(doc: IAttestation) {
    const tracker = new CompoundCycleTracker<
      Immutable<JSONValue>,
      SchemaContext | undefined
    >();
    return this.traverseDAG(doc, tracker);
  }

  override traverse(doc: IAttestation) {
    return this.traverseDocument(doc);
  }
}

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
