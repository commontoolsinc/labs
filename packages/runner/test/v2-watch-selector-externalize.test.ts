import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchemaObj } from "@commonfabric/api";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model/schema-hash";

import { decomposeSchema } from "../src/schema-decompose.ts";
import { registerSchemaDocument } from "../src/schema-registry.ts";
import { setContentAddressedSchemasConfig } from "../src/schema-doc-config.ts";
import { externalizeSyncSelector } from "../src/storage/v2-watch.ts";

describe("v2-watch", () => {
  describe("externalizeSyncSelector()", () => {
    afterEach(() => {
      setContentAddressedSchemasConfig(false);
    });

    const schema: JSONSchemaObj = {
      type: "object",
      properties: { externalizedField: { $ref: "#/$defs/ExternalizedLeaf" } },
      $defs: {
        ExternalizedLeaf: {
          type: "object",
          properties: { leafField: { type: "string" } },
        },
      },
    };

    it("returns the selector unchanged with the flag off", () => {
      const selector = { path: [], schema } as const;
      expect(externalizeSyncSelector(selector, () => true)).toBe(selector);
    });

    it("emits a reference when the whole closure is persisted", () => {
      setContentAddressedSchemasConfig(true);
      const decomposed = decomposeSchema(schema);
      const persisted = new Set(decomposed.documents.keys());
      const externalized = externalizeSyncSelector(
        { path: [], schema },
        (hash) => persisted.has(hash),
      );
      expect(externalized.schema).toEqual({ $ref: decomposed.rootRef });
      expect(externalized.path).toEqual([]);
    });

    it("falls back to the inline form when any closure document is absent", () => {
      setContentAddressedSchemasConfig(true);
      const decomposed = decomposeSchema(schema);
      const [first] = decomposed.documents.keys();
      const selector = { path: [], schema } as const;
      expect(
        externalizeSyncSelector(selector, (hash) => hash !== first),
      ).toBe(selector);
    });

    it("leaves boolean selectors alone", () => {
      setContentAddressedSchemasConfig(true);
      const permissive = { path: [], schema: true } as const;
      expect(externalizeSyncSelector(permissive, () => true)).toBe(permissive);
    });

    it("keeps the reference form while its closure is persisted", () => {
      setContentAddressedSchemasConfig(true);
      const doc: JSONSchemaObj = {
        type: "string",
        title: "already-referenced",
      };
      const hash = internSchemaAsTaggedHashString(doc);
      registerSchemaDocument(hash, doc);
      const referenced = { path: [], schema: { $ref: `cid:${hash}` } };
      const emitted = externalizeSyncSelector(referenced, () => true);
      expect(emitted.schema).toEqual({ $ref: `cid:${hash}` });
    });

    it("recomposes a ref-bearing schema inline when the space lacks its closure", () => {
      // Unconditional correctness, not flag preference: a reference the
      // target space cannot resolve must not reach the wire — the server
      // answers it loudly — so the schema inlines through the registry.
      setContentAddressedSchemasConfig(true);
      const doc: JSONSchemaObj = {
        type: "string",
        title: "inline-me-back",
      };
      const hash = internSchemaAsTaggedHashString(doc);
      registerSchemaDocument(hash, doc);
      const referenced = { path: [], schema: { $ref: `cid:${hash}` } };
      const emitted = externalizeSyncSelector(referenced, () => false);
      expect(emitted.schema).toEqual(doc);
    });

    it("inlines a ref-bearing schema even with the flag off", () => {
      const doc: JSONSchemaObj = {
        type: "string",
        title: "vintage-client-inline",
      };
      const hash = internSchemaAsTaggedHashString(doc);
      registerSchemaDocument(hash, doc);
      const referenced = { path: [], schema: { $ref: `cid:${hash}` } };
      const emitted = externalizeSyncSelector(referenced, () => true);
      expect(emitted.schema).toEqual(doc);
    });

    it("keeps a selector whose decomposition refuses inline", () => {
      setContentAddressedSchemasConfig(true);
      const refused = {
        path: [],
        schema: {
          type: "object",
          properties: {
            nested: { type: "object", $defs: { Inner: { type: "string" } } },
          },
        },
      } as const;
      expect(externalizeSyncSelector(refused as never, () => true)).toBe(
        refused as never,
      );
    });
  });
});
