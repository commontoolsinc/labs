import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchemaObj } from "@commonfabric/api";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model/schema-hash";

import { decomposeSchema } from "../src/schema-decompose.ts";
import {
  acquireSchemaRegistryLease,
  registerSchemaDocument,
} from "../src/schema-registry.ts";
import { externalizeSchema } from "../src/link-utils.ts";
import {
  resetContentAddressedSchemasConfig,
  setContentAddressedSchemasConfig,
} from "../src/schema-doc-config.ts";
import {
  externalizeSyncSelector,
  SelectorClosureUnavailableError,
} from "../src/storage/v2-watch.ts";

describe("v2-watch", () => {
  describe("externalizeSyncSelector()", () => {
    afterEach(() => {
      resetContentAddressedSchemasConfig();
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
      setContentAddressedSchemasConfig(false);
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
      setContentAddressedSchemasConfig(false);
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

    it("propagates a failing persistence probe instead of reading it as a refusal", () => {
      setContentAddressedSchemasConfig(true);
      expect(() =>
        externalizeSyncSelector({ path: [], schema }, () => {
          throw new Error("synthetic persistence probe failure");
        })
      ).toThrow("synthetic persistence probe failure");
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

    it("throws rather than emitting a reference the registry cannot back", () => {
      // The client's send-only-what-you-can-back obligation, enforced at
      // the emission gate: forwarding the ref would only move this failure
      // to the server's loud refusal, one round trip later. A reference
      // with no registered document reaches here only from another
      // process without its closure — minted references are pinned for
      // the process lifetime — so this is an invariant violation to
      // surface at its source.
      setContentAddressedSchemasConfig(true);
      const orphanRef = {
        path: [],
        schema: {
          $ref: "cid:fid1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      };
      expect(() => externalizeSyncSelector(orphanRef, () => false)).toThrow(
        SelectorClosureUnavailableError,
      );
    });

    it("recomposes a MINTED reference across a registry lease epoch", () => {
      // The vintage gate's failing shape, healed: `externalizeSchema`'s
      // ref-form object survives the epoch through the intern table and
      // content-keyed memos, and before minted documents were pinned, the
      // epoch clear left that reference unresolvable — undecomposable at
      // the emission gate, refused by the server. The mint now outlives
      // the clear, so a later session's selector recomposes inline.
      setContentAddressedSchemasConfig(true);
      const release = acquireSchemaRegistryLease();
      const inline: JSONSchemaObj = {
        type: "array",
        items: { type: "object", properties: { label: { type: "string" } } },
      };
      const refForm = externalizeSchema(inline) as JSONSchemaObj;
      expect(typeof refForm.$ref).toBe("string");
      release();

      const emitted = externalizeSyncSelector(
        { path: [], schema: refForm },
        () => false,
      );
      expect(emitted.schema).toEqual(inline);
    });
  });
});
