import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import {
  SelectorTracker,
  StorageManager,
} from "@commontools/runner/storage/cache.deno";
import { JSONSchema } from "@commontools/runner";
import { BaseMemoryAddress } from "@commontools/runner/traverse";
import { Runtime } from "../src/runtime.ts";
import { Result, Unit } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");

describe("SelectorTracker", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let selectorTracker: SelectorTracker;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });

    selectorTracker = new SelectorTracker();
  });

  afterEach(async () => {
    await runtime?.storage.cancelAll();
    await storageManager?.close();
    // _processCurrentBatch leaves sleep behind that makes deno error
    await new Promise((wake) => setTimeout(wake, 1));
  });

  const vnodeSchema = {
    "type": "object",
    "properties": {
      "type": {
        "type": "string",
      },
      "name": {
        "type": "string",
      },
      "props": {
        "type": "object",
        "additionalProperties": {
          "asCell": true,
        },
      },
      "children": {
        "type": "array",
        "items": {
          "anyOf": [
            {
              "$ref": "#",
              "asCell": true,
            },
            {
              "type": "string",
              "asCell": true,
            },
            {
              "type": "number",
              "asCell": true,
            },
            {
              "type": "boolean",
              "asCell": true,
            },
            {
              "type": "array",
              "items": {
                "$ref": "#",
                "asCell": true,
              },
            },
          ],
        },
        "asCell": true,
      },
      "$UI": {
        "$ref": "#",
      },
    },
  } as const satisfies JSONSchema;

  describe("getSupersetSelector", () => {
    it("should detect superset selector", () => {
      const address: BaseMemoryAddress = {
        "id": "of:baeddoc",
        type: "application/json",
      };
      const { promise, resolve, reject } = Promise.withResolvers<
        Result<Unit, Error>
      >();
      const initialSelector = {
        path: ["$UI"],
        schemaContext: { schema: vnodeSchema, rootSchema: vnodeSchema },
      };
      selectorTracker.add(address, initialSelector, promise);
      // For comparison, I want these to be in the standard form that doesn't
      // include the asCell/asStream flags.
      const standardInitialSelector = {
        ...initialSelector,
        schemaContext: {
          schema: SelectorTracker.getStandardSchema(
            initialSelector.schemaContext.schema,
          ),
          rootSchema: SelectorTracker.getStandardSchema(
            initialSelector.schemaContext.rootSchema,
          ),
        },
      };
      const vnodeChildrenSchema = vnodeSchema.properties.children;
      const [existingSelector1, existingPromise1] = selectorTracker
        .getSupersetSelector(address, {
          path: ["$UI", "children"],
          schemaContext: {
            schema: vnodeChildrenSchema,
            rootSchema: vnodeSchema,
          },
        }, runtime.cfc);
      expect(existingSelector1).toEqual(standardInitialSelector);

      const [existingSelector2, existingPromise2] = selectorTracker
        .getSupersetSelector(address, {
          path: ["$UI", "children", "0"],
          schemaContext: {
            schema: vnodeSchema,
            rootSchema: vnodeSchema,
          },
        }, runtime.cfc);
      expect(existingSelector2).toEqual(standardInitialSelector);
    });

    it("should ignore rootSchema mismatches when schema has no $ref", () => {
      const address: BaseMemoryAddress = {
        "id": "of:baeddoc",
        type: "application/json",
      };
      const { promise, resolve, reject } = Promise.withResolvers<
        Result<Unit, Error>
      >();
      const initialSelector = {
        path: ["$UI"],
        schemaContext: { schema: vnodeSchema, rootSchema: vnodeSchema },
      };
      selectorTracker.add(address, initialSelector, promise);
      // For comparison, I want these to be in the standard form that doesn't
      // include the asCell/asStream flags.
      const standardInitialSelector = {
        ...initialSelector,
        schemaContext: {
          schema: SelectorTracker.getStandardSchema(
            initialSelector.schemaContext.schema,
          ),
          rootSchema: SelectorTracker.getStandardSchema(
            initialSelector.schemaContext.rootSchema,
          ),
        },
      };
      const nameSchema = { "type": "string" } as const satisfies JSONSchema;
      const [existingSelector1, existingPromise1] = selectorTracker
        .getSupersetSelector(address, {
          path: ["$UI", "name"],
          schemaContext: {
            schema: nameSchema,
            rootSchema: {},
          },
        }, runtime.cfc);
      expect(existingSelector1).toEqual(standardInitialSelector);
    });
  });
});
