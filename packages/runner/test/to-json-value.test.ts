import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toJSONValue } from "../src/cell.ts";

describe("toJSONValue", () => {
  it("should pass through primitive values unchanged", () => {
    expect(toJSONValue(null)).toBe(null);
    expect(toJSONValue(true)).toBe(true);
    expect(toJSONValue(false)).toBe(false);
    expect(toJSONValue(42)).toBe(42);
    expect(toJSONValue("hello")).toBe("hello");
  });

  it("should pass through plain objects unchanged", () => {
    const obj = { a: 1, b: "two", c: [3, 4] };
    expect(toJSONValue(obj)).toEqual(obj);
  });

  it("should pass through arrays unchanged", () => {
    const arr = [1, "two", { three: 3 }];
    expect(toJSONValue(arr)).toEqual(arr);
  });

  it("should convert Error to @Error wrapper with name, message, and stack", () => {
    const error = new Error("test message");
    const result = toJSONValue(error) as { "@Error": Record<string, unknown> };

    expect(result).toHaveProperty("@Error");
    expect(result["@Error"].name).toBe("Error");
    expect(result["@Error"].message).toBe("test message");
    expect(typeof result["@Error"].stack).toBe("string");
  });

  it("should preserve Error subclass name", () => {
    const error = new TypeError("type error message");
    const result = toJSONValue(error) as { "@Error": Record<string, unknown> };

    expect(result["@Error"].name).toBe("TypeError");
    expect(result["@Error"].message).toBe("type error message");
  });

  it("should preserve custom properties on Error", () => {
    const error = new Error("with extras") as Error & { code: number };
    error.code = 404;
    const result = toJSONValue(error) as { "@Error": Record<string, unknown> };

    expect(result["@Error"].message).toBe("with extras");
    expect(result["@Error"].code).toBe(404);
  });

  it("should convert nested Error inside object", () => {
    const obj = {
      status: "failed",
      error: new Error("nested error"),
    };
    const result = toJSONValue(obj) as {
      status: string;
      error: { "@Error": Record<string, unknown> };
    };

    expect(result.status).toBe("failed");
    expect(result.error).toHaveProperty("@Error");
    expect(result.error["@Error"].message).toBe("nested error");
  });

  it("should convert Error inside array", () => {
    const arr = [new Error("first"), "middle", new Error("last")];
    const result = toJSONValue(arr) as unknown[];

    expect(
      (result[0] as { "@Error": Record<string, unknown> })["@Error"].message,
    ).toBe("first");
    expect(result[1]).toBe("middle");
    expect(
      (result[2] as { "@Error": Record<string, unknown> })["@Error"].message,
    ).toBe("last");
  });

  it("should throw on circular references", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;

    expect(() => toJSONValue(obj)).toThrow();
  });
});
