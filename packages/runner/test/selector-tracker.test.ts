import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  SelectorTracker,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";
import { ContextualFlowControl, type JSONSchema } from "@commonfabric/runner";
import type { BaseMemoryAddress } from "@commonfabric/runner/traverse";
import { Runtime } from "../src/runtime.ts";
import type { Result, Unit } from "../src/storage/interface.ts";

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
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    selectorTracker = new SelectorTracker();
  });

  afterEach(async () => {
    await storageManager?.close();
    await runtime.idle();
  });

  const vnodeSchema = {
    "$ref": "#/$defs/VNode",
    "$defs": {
      "VNode": {
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
              asCell: ["cell"],
            },
          },
          "children": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/VNode",
                  asCell: ["cell"],
                },
                {
                  "type": "string",
                  asCell: ["cell"],
                },
                {
                  "type": "number",
                  asCell: ["cell"],
                },
                {
                  "type": "boolean",
                  asCell: ["cell"],
                },
                {
                  "type": "array",
                  "items": {
                    "$ref": "#/$defs/VNode",
                    asCell: ["cell"],
                  },
                },
              ],
            },
            asCell: ["cell"],
          },
          "$UI": {
            "$ref": "#/$defs/VNode",
          },
        },
      },
    },
  } as const satisfies JSONSchema;

  describe("getSupersetSelector", () => {
    it("should detect superset selector", () => {
      const address: BaseMemoryAddress = {
        "id": "of:baeddoc",
        type: "application/json",
      };
      const { promise } = Promise.withResolvers<
        Result<Unit, Error>
      >();
      const initialSelector = {
        path: ["$UI"],
        schema: vnodeSchema,
      };
      selectorTracker.add(address, initialSelector, promise);
      // For comparison, I want these to be in the standard form that doesn't
      // include the asCell/asStream flags.
      const standardInitialSelector = {
        ...initialSelector,
        schema: SelectorTracker.getStandardSchema(initialSelector.schema),
      };
      const cfc = new ContextualFlowControl();
      const vnodeChildrenSchema = cfc.schemaAtPath(vnodeSchema, ["children"]);
      const [existingSelector1, _existingPromise1] = selectorTracker
        .getSupersetSelector(address, {
          path: ["$UI", "children"],
          schema: vnodeChildrenSchema,
        }, runtime.cfc);
      expect(existingSelector1).toEqual(standardInitialSelector);

      const [existingSelector2, _existingPromise2] = selectorTracker
        .getSupersetSelector(address, {
          path: ["$UI", "children", "0"],
          schema: vnodeSchema,
        }, runtime.cfc);
      expect(existingSelector2).toEqual(standardInitialSelector);
    });

    it("should ignore schema mismatches when schema has no $ref", () => {
      const address: BaseMemoryAddress = {
        "id": "of:baeddoc",
        type: "application/json",
      };
      const { promise } = Promise.withResolvers<
        Result<Unit, Error>
      >();
      const initialSelector = {
        path: ["$UI"],
        schema: vnodeSchema,
      };
      selectorTracker.add(address, initialSelector, promise);
      // For comparison, I want these to be in the standard form that doesn't
      // include the asCell/asStream flags.
      const standardInitialSelector = {
        ...initialSelector,
        schema: SelectorTracker.getStandardSchema(
          initialSelector.schema,
        ),
      };
      const nameSchema = { "type": "string" } as const satisfies JSONSchema;
      const [existingSelector1, _existingPromise1] = selectorTracker
        .getSupersetSelector(address, {
          path: ["$UI", "name"],
          schema: nameSchema,
        }, runtime.cfc);
      expect(existingSelector1).toEqual(standardInitialSelector);
    });

    it("does not treat selectors for the same id in different scopes as supersets", () => {
      const userAddress: BaseMemoryAddress = {
        id: "of:scoped-selector-doc",
        type: "application/json",
        scope: "user",
      };
      const sessionAddress: BaseMemoryAddress = {
        ...userAddress,
        scope: "session",
      };
      const { promise } = Promise.withResolvers<
        Result<Unit, Error>
      >();
      const selector = {
        path: [],
        schema: { type: "object" },
      } as const satisfies { path: string[]; schema: JSONSchema };

      selectorTracker.add(userAddress, selector, promise);

      const [existingSelector] = selectorTracker.getSupersetSelector(
        sessionAddress,
        selector,
        runtime.cfc,
      );

      expect(existingSelector).toBeUndefined();
    });
  });

  describe("getStandardSchema", () => {
    it("interns standardized structurally equal schemas", () => {
      const first = {
        type: "object",
        asCell: ["cell"],
        properties: {
          child: {
            type: "string",
            asCell: ["stream"],
          },
        },
      } as const satisfies JSONSchema;
      const second = {
        properties: {
          child: {
            asCell: ["stream"],
            type: "string",
          },
        },
        asCell: ["cell"],
        type: "object",
      } as const satisfies JSONSchema;

      const standardizedFirst = SelectorTracker.getStandardSchema(first);
      const standardizedSecond = SelectorTracker.getStandardSchema(second);

      expect(standardizedFirst).toBe(standardizedSecond);
      expect(standardizedFirst).toEqual({
        properties: {
          child: {
            type: "string",
          },
        },
        type: "object",
      });
    });

    it("does not reuse cached output for mutable schemas edited in place", () => {
      const mutable = {
        type: "object",
        properties: {
          child: {
            type: "string",
            asCell: ["cell"],
          },
        },
      } as {
        type: "object";
        properties: Record<string, JSONSchema>;
      };

      const first = SelectorTracker.getStandardSchema(mutable as JSONSchema);
      mutable.properties = {
        count: {
          type: "number",
        },
      };

      const second = SelectorTracker.getStandardSchema(mutable as JSONSchema);

      expect(first).toEqual({
        properties: {
          child: {
            type: "string",
          },
        },
        type: "object",
      });
      expect(second).toEqual({
        properties: {
          count: {
            type: "number",
          },
        },
        type: "object",
      });
      expect(second).not.toBe(first);
    });
  });
});
