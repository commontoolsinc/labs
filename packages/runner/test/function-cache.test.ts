import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FunctionCache } from "../src/function-cache.ts";
import type { Module } from "../src/builder/types.ts";

describe("FunctionCache", () => {
  it("should cache and retrieve functions by module", () => {
    const cache = new FunctionCache();
    const module: Module = {
      type: "javascript",
      implementation: "() => 42",
    };
    const fn = () => 42;

    cache.set(module, fn);
    expect(cache.get(module)).toBe(fn);
    expect(cache.has(module)).toBe(true);
    expect(cache.size).toBe(1);
  });

  it("should use JSON.stringify for cache keys", () => {
    const cache = new FunctionCache();
    const module1: Module = {
      type: "javascript",
      implementation: "() => 1",
    };
    const module2: Module = {
      type: "javascript",
      implementation: "() => 1", // Same content
    };
    const fn = () => 1;

    cache.set(module1, fn);
    expect(cache.get(module2)).toBe(fn); // Should retrieve the same function
  });

  it("should overwrite functions with the same module key", () => {
    const cache = new FunctionCache();
    const module: Module = {
      type: "javascript",
      implementation: "() => 1",
    };
    const fn1 = () => 1;
    const fn2 = () => 2;

    cache.set(module, fn1);
    expect(cache.get(module)).toBe(fn1);

    cache.set(module, fn2);
    expect(cache.get(module)).toBe(fn2);
    expect(cache.size).toBe(1);
  });

  it("should differentiate modules with different properties", () => {
    const cache = new FunctionCache();
    const module1: Module = {
      type: "javascript",
      implementation: "() => 1",
    };
    const module2: Module = {
      type: "javascript",
      implementation: "() => 1",
      wrapper: "handler",
    };
    const fn1 = () => 1;
    const fn2 = () => 2;

    cache.set(module1, fn1);
    cache.set(module2, fn2);

    expect(cache.get(module1)).toBe(fn1);
    expect(cache.get(module2)).toBe(fn2);
    expect(cache.size).toBe(2);
  });

  it("should clear all cached functions", () => {
    const cache = new FunctionCache();
    const module1: Module = {
      type: "javascript",
      implementation: "() => 1",
    };
    const module2: Module = {
      type: "javascript",
      implementation: "() => 2",
    };

    cache.set(module1, () => 1);
    cache.set(module2, () => 2);
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.has(module1)).toBe(false);
    expect(cache.has(module2)).toBe(false);
  });

  it("should return undefined for non-cached modules", () => {
    const cache = new FunctionCache();
    const module: Module = {
      type: "javascript",
      implementation: "() => 1",
    };

    expect(cache.get(module)).toBeUndefined();
    expect(cache.has(module)).toBe(false);
  });
});