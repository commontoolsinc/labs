import { describe, it } from "@std/testing/bdd";
import * as assert from "./assert.ts";
import { h } from "../src/h.ts";

describe("bidirectional binding validation", () => {
  it("throws when $value is a primitive string", () => {
    assert.throws(
      () => h("cf-input", { $value: "hello" }),
      "Should throw for primitive string $value",
    );
  });

  it("throws when $value is a primitive number", () => {
    assert.throws(
      () => h("cf-input", { $value: 42 }),
      "Should throw for primitive number $value",
    );
  });

  it("throws when $checked is a primitive boolean", () => {
    assert.throws(
      () => h("cf-checkbox", { $checked: true }),
      "Should throw for primitive boolean $checked",
    );
  });

  it("throws when $value is null", () => {
    assert.throws(
      () => h("cf-input", { $value: null }),
      "Should throw for null $value",
    );
  });

  it("throws when $value is undefined", () => {
    assert.throws(
      () => h("cf-input", { $value: undefined }),
      "Should throw for undefined $value",
    );
  });

  it("throws when $value is a plain object (not a Cell)", () => {
    assert.throws(
      () => h("cf-input", { $value: { someData: "test" } }),
      "Should throw for plain object $value",
    );
  });

  it("throws when $value is an array (not a Cell)", () => {
    assert.throws(
      () => h("cf-input", { $value: [1, 2, 3] }),
      "Should throw for array $value",
    );
  });

  it("does not throw for regular (non-$) props with any value", () => {
    // Regular props should not be validated
    const vnode = h("div", {
      value: "string",
      count: 42,
      checked: true,
      data: { nested: "object" },
    });
    assert.equal(vnode.type, "vnode");
    assert.equal(vnode.name, "div");
  });

  it("allows null props object", () => {
    const vnode = h("div", null, "child");
    assert.equal(vnode.type, "vnode");
    assert.equal(vnode.name, "div");
  });

  it("error message mentions $value property name", () => {
    let errorMessage = "";
    try {
      h("cf-input", { $value: "test" });
    } catch (e) {
      errorMessage = (e as Error).message;
    }
    assert.equal(
      errorMessage.includes("$value"),
      true,
      "Error message should mention the property name",
    );
  });

  it("error message mentions $checked property name", () => {
    let errorMessage = "";
    try {
      h("cf-checkbox", { $checked: false });
    } catch (e) {
      errorMessage = (e as Error).message;
    }
    assert.equal(
      errorMessage.includes("$checked"),
      true,
      "Error message should mention the property name",
    );
  });

  it("error message for $checked includes checkbox example", () => {
    let errorMessage = "";
    try {
      h("cf-checkbox", { $checked: false });
    } catch (e) {
      errorMessage = (e as Error).message;
    }
    assert.equal(
      errorMessage.includes("cf-checkbox"),
      true,
      "Error message for $checked should include checkbox example",
    );
  });

  it("error message for $value includes input example", () => {
    let errorMessage = "";
    try {
      h("cf-input", { $value: "test" });
    } catch (e) {
      errorMessage = (e as Error).message;
    }
    assert.equal(
      errorMessage.includes("cf-input"),
      true,
      "Error message for $value should include input example",
    );
  });
});
