import { assertEquals } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { scrub } from "../src/iterate.ts";
import { type JSONSchema, Runtime } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Identity } from "@commontools/identity";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("scrub function", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should return primitive values unchanged", () => {
    assertEquals(scrub(123), 123);
    assertEquals(scrub("test"), "test");
    assertEquals(scrub(true), true);
    assertEquals(scrub(null), null);
    assertEquals(scrub(undefined), undefined);
  });

  it("should scrub arrays recursively", () => {
    const cellValue = { test: 123, $UI: "hidden" };
    const testCell = runtime.getImmutableCell(space, cellValue);

    const input = [1, "test", testCell, { a: 1 }];
    const result = scrub(input);

    assertEquals(result[0], 1);
    assertEquals(result[1], "test");
    assertEquals(result[2].get(), { test: 123 });
    assertEquals(result[3], { a: 1 });
  });

  it("should handle cells with object schemas that have properties", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
        $UI: { type: "object" },
        streamProp: { asStream: true },
      },
    };

    const cellValue = { name: "test", age: 30, $UI: {}, streamProp: {} };
    const cellWithSchema = runtime.getImmutableCell(space, cellValue, schema);

    const result = scrub(cellWithSchema);

    // Check that the result has the expected schema properties
    assertEquals(result.schema?.type, "object");

    // The properties object should exist and have exactly name and age
    const resultProperties = result.schema?.properties || {};
    assertEquals(Object.keys(resultProperties).length, 2);
    assertEquals("name" in resultProperties, true);
    assertEquals("age" in resultProperties, true);
    assertEquals("$UI" in resultProperties, false);
    assertEquals("streamProp" in resultProperties, false);

    assertEquals(result.get(), { name: "test", age: 30 });
  });

  it("should handle cells with object schemas that have no properties", () => {
    const schema: JSONSchema = {
      type: "object",
    };

    const cellWithEmptySchema = runtime.getImmutableCell(space, {
      name: "test",
      $UI: {},
    }, schema);

    const result = scrub(cellWithEmptySchema);

    // Should return the cell unchanged
    assertEquals(result.get(), { name: "test" });
  });

  it("should handle cells with non-object schemas", () => {
    const schema: JSONSchema = {
      type: "string",
    };

    const cellWithStringSchema = runtime.getImmutableCell(
      space,
      "test value",
      schema,
    );

    const result = scrub(cellWithStringSchema);

    // For non-object schemas with primitive values, it should return the cell unchanged
    assertEquals(result.get(), "test value");
  });
});

// XML tag functions have been moved elsewhere
// Tests will be updated when we create proper tests for the workflow module
