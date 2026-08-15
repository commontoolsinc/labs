import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model/schema-hash";
import {
  type DecomposedSchema,
  decomposeSchema,
  formatExternalSchemaRef,
  isExternalSchemaRef,
  parseExternalSchemaRef,
  recomposeSchema,
  SchemaNotDecomposableError,
} from "../src/schema-decompose.ts";

/** A lookup over a decomposition's own documents. */
const lookupIn =
  (decomposed: DecomposedSchema) =>
  (taggedHash: string): JSONSchema | undefined =>
    decomposed.documents.get(taggedHash);

/** Round trip: recompose a decomposition and decompose the result again. */
const redecompose = (decomposed: DecomposedSchema): DecomposedSchema =>
  decomposeSchema(
    recomposeSchema(decomposed.rootRef, lookupIn(decomposed)) as JSONSchemaObj,
  );

/** Asserts the fixpoint property: `d2` names the same documents as `d1`. */
const expectSameDecomposition = (
  d1: DecomposedSchema,
  d2: DecomposedSchema,
): void => {
  expect(d2.rootRef).toBe(d1.rootRef);
  expect([...d2.documents.keys()].toSorted()).toEqual(
    [...d1.documents.keys()].toSorted(),
  );
};

describe("schema-decompose", () => {
  describe("parseExternalSchemaRef()", () => {
    it("parses a bare reference", () => {
      expect(parseExternalSchemaRef("cid:fid1:abc")).toEqual({
        taggedHash: "fid1:abc",
      });
    });

    it("parses a fragment reference to a group member", () => {
      expect(parseExternalSchemaRef("cid:fid1:abc#/$defs/Node")).toEqual({
        taggedHash: "fid1:abc",
        defName: "Node",
      });
    });

    it("round-trips through formatExternalSchemaRef()", () => {
      const ref = formatExternalSchemaRef("fid1:abc", "A/B~C");
      expect(parseExternalSchemaRef(ref)).toEqual({
        taggedHash: "fid1:abc",
        defName: "A/B~C",
      });
    });

    it("returns `undefined` for a local ref", () => {
      expect(parseExternalSchemaRef("#/$defs/Node")).toBeUndefined();
    });

    it("returns `undefined` for an empty hash", () => {
      expect(parseExternalSchemaRef("cid:")).toBeUndefined();
    });

    it("returns `undefined` for a fragment that is not a `$defs` pointer", () => {
      expect(parseExternalSchemaRef("cid:fid1:abc#/properties/x"))
        .toBeUndefined();
      expect(parseExternalSchemaRef("cid:fid1:abc#")).toBeUndefined();
    });
  });

  describe("isExternalSchemaRef()", () => {
    it("returns `true` for a bare reference and `false` for a local one", () => {
      expect(isExternalSchemaRef("cid:fid1:abc")).toBe(true);
      expect(isExternalSchemaRef("#/$defs/Node")).toBe(false);
    });
  });

  describe("decomposeSchema()", () => {
    it("turns a schema without `$defs` into a single document", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { name: { type: "string" } },
      };
      const { rootRef, documents } = decomposeSchema(schema);
      expect(documents.size).toBe(1);
      const hash = parseExternalSchemaRef(rootRef)!.taggedHash;
      expect(documents.get(hash)).toEqual(schema);
    });

    it("externalizes a definition into its own name-free document", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: {
          home: { $ref: "#/$defs/Address" },
          work: { $ref: "#/$defs/Address" },
        },
        $defs: {
          Address: {
            type: "object",
            properties: { street: { type: "string" } },
          },
        },
      };
      const { rootRef, documents } = decomposeSchema(schema);
      expect(documents.size).toBe(2);

      const defDoc: JSONSchema = {
        type: "object",
        properties: { street: { type: "string" } },
      };
      const defHash = internSchemaAsTaggedHashString(defDoc);
      expect(documents.get(defHash)).toEqual(defDoc);

      const rootHash = parseExternalSchemaRef(rootRef)!.taggedHash;
      expect(documents.get(rootHash)).toEqual({
        type: "object",
        properties: {
          home: { $ref: `cid:${defHash}` },
          work: { $ref: `cid:${defHash}` },
        },
      });
    });

    it("produces identical documents for two schemas whose only difference is a definition's name", () => {
      const withName = (name: string): JSONSchemaObj => ({
        type: "object",
        properties: { addr: { $ref: `#/$defs/${name}` } },
        $defs: {
          [name]: {
            type: "object",
            properties: { street: { type: "string" } },
          },
        },
      });
      const a = decomposeSchema(withName("Address"));
      const b = decomposeSchema(withName("Location"));
      expectSameDecomposition(a, b);
    });

    it("keeps a self-referential definition in a group document referenced by fragment", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { head: { $ref: "#/$defs/Node" } },
        $defs: {
          Node: {
            type: "object",
            properties: {
              value: { type: "number" },
              next: { $ref: "#/$defs/Node" },
            },
          },
        },
      };
      const { rootRef, documents } = decomposeSchema(schema);
      expect(documents.size).toBe(2);

      const rootDoc = documents.get(
        parseExternalSchemaRef(rootRef)!.taggedHash,
      ) as JSONSchemaObj;
      const memberRef = (rootDoc.properties!.head as JSONSchemaObj).$ref!;
      const parsed = parseExternalSchemaRef(memberRef)!;
      expect(parsed.defName).toBe("Node");
      expect(documents.get(parsed.taggedHash)).toEqual({
        $defs: {
          Node: {
            type: "object",
            properties: {
              value: { type: "number" },
              next: { $ref: "#/$defs/Node" },
            },
          },
        },
      });
    });

    it("keeps a mutual cycle together in one group document", () => {
      const schema: JSONSchemaObj = {
        $ref: "#/$defs/Folder",
        $defs: {
          Folder: {
            type: "object",
            properties: {
              children: { type: "array", items: { $ref: "#/$defs/Entry" } },
            },
          },
          Entry: {
            anyOf: [{ type: "string" }, { $ref: "#/$defs/Folder" }],
          },
        },
      };
      const { rootRef, documents } = decomposeSchema(schema);
      // The root reduced to a single reference, so the group is the only
      // document.
      expect(documents.size).toBe(1);
      const parsed = parseExternalSchemaRef(rootRef)!;
      expect(parsed.defName).toBe("Folder");
      const group = documents.get(parsed.taggedHash) as JSONSchemaObj;
      expect(Object.keys(group.$defs!).toSorted()).toEqual([
        "Entry",
        "Folder",
      ]);
      // Internal refs stay local.
      const folder = group.$defs!.Folder as JSONSchemaObj;
      expect((folder.properties!.children as JSONSchemaObj).items).toEqual({
        $ref: "#/$defs/Entry",
      });
    });

    it("lets a cyclic group reference an acyclic definition externally", () => {
      const schema: JSONSchemaObj = {
        $ref: "#/$defs/Tree",
        $defs: {
          Tree: {
            type: "object",
            properties: {
              label: { $ref: "#/$defs/Label" },
              children: { type: "array", items: { $ref: "#/$defs/Tree" } },
            },
          },
          Label: { type: "string" },
        },
      };
      const { rootRef, documents } = decomposeSchema(schema);
      expect(documents.size).toBe(2);

      const labelHash = internSchemaAsTaggedHashString({ type: "string" });
      expect(documents.get(labelHash)).toEqual({ type: "string" });

      const group = documents.get(
        parseExternalSchemaRef(rootRef)!.taggedHash,
      ) as JSONSchemaObj;
      const tree = group.$defs!.Tree as JSONSchemaObj;
      expect(tree.properties!.label).toEqual({ $ref: `cid:${labelHash}` });
    });

    it("shares one document across a diamond dependency", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: {
          b: { $ref: "#/$defs/B" },
          c: { $ref: "#/$defs/C" },
        },
        $defs: {
          B: { type: "object", properties: { d: { $ref: "#/$defs/D" } } },
          C: { type: "array", items: { $ref: "#/$defs/D" } },
          D: { type: "number" },
        },
      };
      const { documents } = decomposeSchema(schema);
      // Root, B, C, D — with D appearing once.
      expect(documents.size).toBe(4);
      const dHash = internSchemaAsTaggedHashString({ type: "number" });
      expect(documents.get(dHash)).toEqual({ type: "number" });
    });

    it("drops a definition unreachable from the root body", () => {
      const withUnused: JSONSchemaObj = {
        type: "object",
        properties: { x: { $ref: "#/$defs/Used" } },
        $defs: {
          Used: { type: "string" },
          Unused: { type: "number" },
        },
      };
      const withoutUnused: JSONSchemaObj = {
        type: "object",
        properties: { x: { $ref: "#/$defs/Used" } },
        $defs: { Used: { type: "string" } },
      };
      expectSameDecomposition(
        decomposeSchema(withoutUnused),
        decomposeSchema(withUnused),
      );
    });

    it("is invariant under key order", () => {
      const a = decomposeSchema({
        type: "object",
        properties: { x: { $ref: "#/$defs/T" }, y: { type: "string" } },
        $defs: { T: { type: "number" } },
      });
      const b = decomposeSchema({
        $defs: { T: { type: "number" } },
        properties: { y: { type: "string" }, x: { $ref: "#/$defs/T" } },
        type: "object",
      });
      expectSameDecomposition(a, b);
    });

    it("memoizes on the interned input", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { x: { type: "string" } },
      };
      const first = decomposeSchema(schema);
      // `schema` was interned (and frozen) by the first call, so the second
      // call hits the memo and returns the same result object.
      expect(decomposeSchema(schema)).toBe(first);
    });

    it("orders documents dependency-first", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { b: { $ref: "#/$defs/B" } },
        $defs: {
          B: { type: "object", properties: { d: { $ref: "#/$defs/D" } } },
          D: { type: "number" },
        },
      };
      const { rootRef, documents } = decomposeSchema(schema);
      const hashes = [...documents.keys()];
      const dHash = internSchemaAsTaggedHashString({ type: "number" });
      const rootHash = parseExternalSchemaRef(rootRef)!.taggedHash;
      expect(hashes.indexOf(dHash)).toBeLessThan(hashes.indexOf(rootHash));
      expect(hashes[hashes.length - 1]).toBe(rootHash);
    });

    it("throws for a `$ref` naming a definition that does not exist", () => {
      expect(() =>
        decomposeSchema({
          type: "object",
          properties: { x: { $ref: "#/$defs/Missing" } },
        })
      ).toThrow(SchemaNotDecomposableError);
    });

    it("throws for a `$ref` form outside the local and external vocabularies", () => {
      expect(() =>
        decomposeSchema({
          properties: { x: { $ref: "#" } },
        })
      ).toThrow(SchemaNotDecomposableError);
      expect(() =>
        decomposeSchema({
          properties: {
            x: { $ref: "https://commonfabric.org/schemas/vdom.json" },
          },
        })
      ).toThrow(SchemaNotDecomposableError);
    });

    it("throws for a nested `$defs` scope", () => {
      expect(() =>
        decomposeSchema({
          type: "object",
          properties: {
            x: {
              type: "object",
              $defs: { Inner: { type: "string" } },
              properties: { y: { $ref: "#/$defs/Inner" } },
            },
          },
        })
      ).toThrow(SchemaNotDecomposableError);
    });

    it("throws for the deprecated `definitions` keyword", () => {
      expect(() =>
        decomposeSchema({
          type: "object",
          definitions: { T: { type: "string" } },
        })
      ).toThrow(SchemaNotDecomposableError);
    });

    it("throws for a pre-existing external ref with no document resolver", () => {
      expect(() =>
        decomposeSchema({
          type: "object",
          properties: { x: { $ref: "cid:fid1:abc" } },
        })
      ).toThrow(SchemaNotDecomposableError);
    });

    it("includes the resolved closure behind a pre-existing external ref", () => {
      const inner = decomposeSchema({
        type: "object",
        properties: { closureLeaf: { $ref: "#/$defs/ClosureLeaf" } },
        $defs: { ClosureLeaf: { type: "string" } },
      });
      const outer: JSONSchemaObj = {
        type: "object",
        properties: { nested: { $ref: inner.rootRef } },
      };
      const { rootRef, documents } = decomposeSchema(outer, {
        resolveDocument: (hash) => inner.documents.get(hash),
      });
      // The outer root document keeps the ref untouched, and the referenced
      // closure travels with the result.
      const rootDoc = documents.get(
        parseExternalSchemaRef(rootRef)!.taggedHash,
      );
      expect(rootDoc).toEqual(outer);
      for (const hash of inner.documents.keys()) {
        expect(documents.has(hash)).toBe(true);
      }
    });

    it("throws when the resolver supplies a document that does not match its id", () => {
      const target = internSchemaAsTaggedHashString({
        type: "object",
        properties: { mismatchedSupply: { type: "string" } },
      });
      expect(() =>
        decomposeSchema({
          type: "object",
          properties: { x: { $ref: `cid:${target}` } },
        }, { resolveDocument: () => ({ type: "number" }) })
      ).toThrow(SchemaNotDecomposableError);
    });

    it("binds a pure-ref definition straight to its target instead of minting an alias document", () => {
      const aliased: JSONSchemaObj = {
        type: "object",
        properties: {
          direct: { $ref: "#/$defs/AliasTarget" },
          via: { $ref: "#/$defs/Alias" },
        },
        $defs: {
          Alias: { $ref: "#/$defs/AliasTarget" },
          AliasTarget: {
            type: "object",
            properties: { aliasLeaf: { type: "string" } },
          },
        },
      };
      const direct: JSONSchemaObj = {
        type: "object",
        properties: {
          direct: { $ref: "#/$defs/AliasTarget" },
          via: { $ref: "#/$defs/AliasTarget" },
        },
        $defs: {
          AliasTarget: {
            type: "object",
            properties: { aliasLeaf: { type: "string" } },
          },
        },
      };
      expectSameDecomposition(
        decomposeSchema(direct),
        decomposeSchema(aliased),
      );
    });

    it("throws for `$id` and the anchor keywords", () => {
      expect(() =>
        decomposeSchema({
          type: "object",
          properties: {
            x: { $id: "https://example.invalid/x", type: "string" },
          },
        } as JSONSchemaObj)
      ).toThrow(SchemaNotDecomposableError);
      expect(() =>
        decomposeSchema({
          type: "object",
          properties: { x: { $anchor: "x", type: "string" } },
        } as JSONSchemaObj)
      ).toThrow(SchemaNotDecomposableError);
    });
  });

  describe("recomposeSchema()", () => {
    it("returns the document itself for a closure of one", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { name: { type: "string" } },
      };
      const decomposed = decomposeSchema(schema);
      expect(recomposeSchema(decomposed.rootRef, lookupIn(decomposed)))
        .toEqual(schema);
    });

    it("preserves cyclic-group member names exactly", () => {
      const schema: JSONSchemaObj = {
        $ref: "#/$defs/Folder",
        $defs: {
          Folder: {
            type: "object",
            properties: {
              children: { type: "array", items: { $ref: "#/$defs/Entry" } },
            },
          },
          Entry: { anyOf: [{ type: "string" }, { $ref: "#/$defs/Folder" }] },
        },
      };
      const decomposed = decomposeSchema(schema);
      const recomposed = recomposeSchema(
        decomposed.rootRef,
        lookupIn(decomposed),
      ) as JSONSchemaObj;
      expect(Object.keys(recomposed.$defs!).toSorted()).toEqual([
        "Entry",
        "Folder",
      ]);
      expect(recomposed.$ref).toBe("#/$defs/Folder");
    });

    it("throws for a missing document", () => {
      const decomposed = decomposeSchema({
        type: "object",
        properties: { x: { $ref: "#/$defs/T" } },
        $defs: { T: { type: "string" } },
      });
      expect(() => recomposeSchema(decomposed.rootRef, () => undefined))
        .toThrow("not found");
    });

    it("breaks a member-name collision between two group documents by renaming", () => {
      // Two disjoint self-referential definitions both named into their own
      // group documents; decomposing a root that references both would need
      // one name twice, so recomposition renames one.
      const listOf = (member: string, leaf: JSONSchema): JSONSchemaObj => ({
        $ref: `#/$defs/${member}`,
        $defs: {
          [member]: {
            type: "object",
            properties: {
              value: leaf,
              next: { $ref: `#/$defs/${member}` },
            },
          },
        },
      });
      const numbers = decomposeSchema(listOf("Node", { type: "number" }));
      const strings = decomposeSchema(listOf("Node", { type: "string" }));
      const root: JSONSchemaObj = {
        type: "object",
        properties: {
          numbers: { $ref: numbers.rootRef },
          strings: { $ref: strings.rootRef },
        },
      };
      const decomposed = decomposeSchema(root, {
        resolveDocument: (hash) =>
          numbers.documents.get(hash) ?? strings.documents.get(hash),
      });
      const documents = new Map([
        ...numbers.documents,
        ...strings.documents,
        ...decomposed.documents,
      ]);
      const recomposed = recomposeSchema(
        decomposed.rootRef,
        (hash) => documents.get(hash),
      ) as JSONSchemaObj;
      const names = Object.keys(recomposed.$defs!).toSorted();
      expect(names).toEqual(["Node", "Node_2"]);
      // Both lists survive with their internal self-refs intact under the
      // assigned names.
      for (const name of names) {
        const def = recomposed.$defs![name] as JSONSchemaObj;
        expect((def.properties!.next as JSONSchemaObj).$ref).toBe(
          `#/$defs/${name}`,
        );
      }
    });
  });

  describe("round trip", () => {
    const fixtures: Record<string, JSONSchemaObj> = {
      "no definitions": {
        type: "object",
        properties: { name: { type: "string" } },
      },
      "shared definition": {
        type: "object",
        properties: {
          home: { $ref: "#/$defs/Address" },
          work: { $ref: "#/$defs/Address" },
        },
        $defs: {
          Address: {
            type: "object",
            properties: { street: { type: "string" } },
          },
        },
      },
      "self cycle": {
        type: "object",
        properties: { head: { $ref: "#/$defs/Node" } },
        $defs: {
          Node: {
            type: "object",
            properties: { next: { $ref: "#/$defs/Node" } },
          },
        },
      },
      "mutual cycle behind a pure-ref root": {
        $ref: "#/$defs/Folder",
        $defs: {
          Folder: {
            type: "object",
            properties: {
              children: { type: "array", items: { $ref: "#/$defs/Entry" } },
            },
          },
          Entry: { anyOf: [{ type: "string" }, { $ref: "#/$defs/Folder" }] },
        },
      },
      "diamond": {
        type: "object",
        properties: {
          b: { $ref: "#/$defs/B" },
          c: { $ref: "#/$defs/C" },
        },
        $defs: {
          B: { type: "object", properties: { d: { $ref: "#/$defs/D" } } },
          C: { type: "array", items: { $ref: "#/$defs/D" } },
          D: { type: "number" },
        },
      },
      "pure-ref alias chain": {
        type: "object",
        properties: { via: { $ref: "#/$defs/ChainAlias" } },
        $defs: {
          ChainAlias: { $ref: "#/$defs/ChainTarget" },
          ChainTarget: {
            type: "object",
            properties: { chainLeaf: { type: "string" } },
          },
        },
      },
      "cyclic member named __proto__": {
        type: "object",
        properties: { protoHead: { $ref: "#/$defs/__proto__" } },
        $defs: {
          ["__proto__"]: {
            type: "object",
            properties: {
              protoLabel: { type: "string" },
              next: { $ref: "#/$defs/__proto__" },
            },
          },
        },
      },
      "cycle referencing an acyclic definition": {
        $ref: "#/$defs/Tree",
        $defs: {
          Tree: {
            type: "object",
            properties: {
              label: { $ref: "#/$defs/Label" },
              children: { type: "array", items: { $ref: "#/$defs/Tree" } },
            },
          },
          Label: { type: "string" },
        },
      },
    };

    for (const [name, schema] of Object.entries(fixtures)) {
      it(`reaches a fixpoint for the ${name} fixture`, () => {
        const decomposed = decomposeSchema(schema);
        expectSameDecomposition(decomposed, redecompose(decomposed));
      });
    }
  });
});
