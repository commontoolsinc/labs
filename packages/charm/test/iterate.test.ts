import { assertEquals } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commontools/utils/equal-ignoring-symbols";

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
    expect(scrub(123)).toEqualIgnoringSymbols(123);
    expect(scrub("test")).toEqualIgnoringSymbols("test");
    expect(scrub(true)).toEqualIgnoringSymbols(true);
    expect(scrub(null)).toEqualIgnoringSymbols(null);
    expect(scrub(undefined)).toEqualIgnoringSymbols(undefined);
  });

  it("should scrub arrays recursively", () => {
    const cellValue = { test: 123, $UI: "hidden" };
    const testCell = runtime.getImmutableCell(space, cellValue);

    const input = [1, "test", testCell, { a: 1 }];
    const result = scrub(input);

    expect(result[0]).toEqualIgnoringSymbols(1);
    expect(result[1]).toEqualIgnoringSymbols("test");
    expect(result[2].get()).toEqualIgnoringSymbols({ test: 123 });
    expect(result[3]).toEqualIgnoringSymbols({ a: 1 });
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
    expect(result.schema?.type).toEqualIgnoringSymbols("object");

    // The properties object should exist and have exactly name and age
    const resultProperties = result.schema?.properties || {};
    expect(Object.keys(resultProperties).length).toEqualIgnoringSymbols(2);
    expect("name" in resultProperties).toEqualIgnoringSymbols(true);
    expect("age" in resultProperties).toEqualIgnoringSymbols(true);
    expect("$UI" in resultProperties).toEqualIgnoringSymbols(false);
    expect("streamProp" in resultProperties).toEqualIgnoringSymbols(false);

    expect(result.get()).toEqualIgnoringSymbols({ name: "test", age: 30 });
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
    expect(result.get()).toEqualIgnoringSymbols({ name: "test" });
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
    expect(result.get()).toEqualIgnoringSymbols("test value");
  });
});

// XML tag functions have been moved elsewhere
// Tests will be updated when we create proper tests for the workflow module
