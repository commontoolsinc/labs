import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchemaObj } from "@commonfabric/api";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model/schema-hash";
import { getLogger } from "@commonfabric/utils/logger";

import { decomposeSchema } from "../src/schema-decompose.ts";
import { registerSchemaDocument } from "../src/schema-registry.ts";
import {
  resetContentAddressedSchemasConfig,
  setContentAddressedSchemasConfig,
} from "../src/schema-doc-config.ts";
import { externalizeSyncSelector } from "../src/storage/v2-watch.ts";

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

    /** Capture `storage.v2-watch` error logs around `fn`, resolving thunked
     * message parts to their values. */
    const captureErrorLogs = (fn: () => void): unknown[][] => {
      const logger = getLogger("storage.v2-watch") as unknown as {
        error(...args: unknown[]): void;
      };
      const captured: unknown[][] = [];
      logger.error = (...args: unknown[]) => {
        captured.push(
          args.map((arg) => (typeof arg === "function" ? arg() : arg)),
        );
      };
      try {
        fn();
      } finally {
        delete (logger as { error?: unknown }).error;
      }
      return captured;
    };

    it("logs the missing document when a ref-bearing selector passes through unresolved", () => {
      // The pass-through sends the server a selector naming a document this
      // client could not resolve; without this line the failure surfaces as
      // a dropped event far from the cause (#6303).
      setContentAddressedSchemasConfig(true);
      const doc: JSONSchemaObj = {
        type: "string",
        title: "never-registered-6303",
      };
      const hash = internSchemaAsTaggedHashString(doc);
      const selector = { path: [], schema: { $ref: `cid:${hash}` } };
      const captured = captureErrorLogs(() => {
        expect(externalizeSyncSelector(selector, () => true)).toBe(selector);
      });
      expect(captured.length).toBe(1);
      expect(captured[0][0]).toBe("unresolvable-selector-schema-ref");
      expect(JSON.stringify(captured[0])).toContain(hash);
    });

    it("stays silent when an inline-only schema refuses decomposition", () => {
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
      const captured = captureErrorLogs(() => {
        expect(externalizeSyncSelector(refused as never, () => true)).toBe(
          refused as never,
        );
      });
      expect(captured).toEqual([]);
    });
  });
});
