import { assertEquals, assertExists } from "@std/assert";
import { beforeEach, describe, it, afterEach } from "@std/testing/bdd";
import { scrub } from "../src/iterate.ts";
import { getImmutableCell, isCell, isStream, Cell } from "@commontools/runner";
import { JSONSchema } from "@commontools/builder";
import { isObj } from "@commontools/utils";
import { Charm, CharmManager } from "../src/charm.ts";

describe("scrub function", () => {
  it("should return primitive values unchanged", () => {
    assertEquals(scrub(123), 123);
    assertEquals(scrub("test"), "test");
    assertEquals(scrub(true), true);
    assertEquals(scrub(null), null);
    assertEquals(scrub(undefined), undefined);
  });

  it("should scrub arrays recursively", () => {
    const cellValue = { test: 123, $UI: "hidden" };
    const testCell = getImmutableCell("test", cellValue);

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
    const cellWithSchema = getImmutableCell("test", cellValue, schema);

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

    const cellWithEmptySchema = getImmutableCell("test", {
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

    const cellWithStringSchema = getImmutableCell("test", "test value", schema);

    const result = scrub(cellWithStringSchema);

    // For non-object schemas with primitive values, it should return the cell unchanged
    assertEquals(result.get(), "test value");
  });
});

// XML tag functions have been moved elsewhere
// Tests will be updated when we create proper tests for the workflow module
