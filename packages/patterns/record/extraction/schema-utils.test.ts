/**
 * Unit tests for the pure helpers in schema-utils-pure.ts.
 *
 * This file imports only the pure module, so it runs without the Common Fabric
 * runtime. The registry-driven schema discovery that extraction actually relies
 * on is exercised against real module definitions in schema-discovery.test.tsx.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { getCellValue } from "./schema-utils-pure.ts";

describe("getCellValue", () => {
  it("dereferences a Cell-like object", () => {
    expect(getCellValue({ get: () => "hello" })).toBe("hello");
  });

  it("returns a raw value unchanged", () => {
    expect(getCellValue("world")).toBe("world");
    expect(getCellValue(42)).toBe(42);
  });

  it("returns null and undefined unchanged", () => {
    expect(getCellValue(null)).toBe(null);
    expect(getCellValue(undefined)).toBe(undefined);
  });

  it("does not treat a plain object without get() as a Cell", () => {
    const obj = { foo: "bar" };
    expect(getCellValue(obj)).toBe(obj);
  });
});
