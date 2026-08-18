import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchemaObj } from "@commonfabric/api";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model/schema-hash";

import { decomposeSchema } from "../src/schema-decompose.ts";
import { setContentAddressedSelectorSchemasConfig } from "../src/schema-doc-config.ts";
import { externalizeSyncSelector } from "../src/storage/v2-watch.ts";

describe("v2-watch", () => {
  describe("externalizeSyncSelector()", () => {
    afterEach(() => {
      setContentAddressedSelectorSchemasConfig(false);
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
      setContentAddressedSelectorSchemasConfig(true);
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
      setContentAddressedSelectorSchemasConfig(true);
      const decomposed = decomposeSchema(schema);
      const [first] = decomposed.documents.keys();
      const selector = { path: [], schema } as const;
      expect(
        externalizeSyncSelector(selector, (hash) => hash !== first),
      ).toBe(selector);
    });

    it("leaves boolean and reference-only selectors alone", () => {
      setContentAddressedSelectorSchemasConfig(true);
      const permissive = { path: [], schema: true } as const;
      expect(externalizeSyncSelector(permissive, () => true)).toBe(permissive);
      const hash = internSchemaAsTaggedHashString({
        type: "string",
        title: "already-referenced",
      });
      const referenced = {
        path: [],
        schema: { $ref: `cid:${hash}` },
      } as const;
      expect(externalizeSyncSelector(referenced, () => true)).toBe(referenced);
    });

    it("keeps a selector whose decomposition refuses inline", () => {
      setContentAddressedSelectorSchemasConfig(true);
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
