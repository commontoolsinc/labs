// Basic cell operations: creating cells, getting/setting values, path navigation,
// raw access, source cells, and cell utility functions.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commontools/utils/equal-ignoring-symbols";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import type { StorableValue } from "@commontools/memory/interface";
import { isCell } from "../src/cell.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { isCellResult } from "../src/query-result-proxy.ts";
import { ID, JSONSchema, type Pattern } from "../src/builder/types.ts";
import { isPrimitiveCellLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

const richSigner = await Identity.fromPassphrase("test rich raw");
const richSpace = richSigner.did();

describe("Cell", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });

    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should create a cell with initial value", () => {
    const c = runtime.getCell<number>(
      space,
      "should create a cell with initial value",
      undefined,
      tx,
    );
    c.set(10);
    expect(c.get()).toBe(10);
  });

  it("should update cell value using send", () => {
    const c = runtime.getCell<number>(
      space,
      "should update cell value using send",
      undefined,
      tx,
    );
    c.set(10);
    c.send(20);
    expect(c.get()).toBe(20);
  });

  it("should convert Error instances to @Error wrapper on set", () => {
    const c = runtime.getCell<unknown>(
      space,
      "should convert Error instances to @Error wrapper on set",
      undefined,
      tx,
    );
    const error = new TypeError("something went wrong");
    c.set(error);

    // Error should be converted to @Error wrapper during set
    const result = c.get() as { "@Error": Record<string, unknown> } | undefined;
    expect(result).toHaveProperty("@Error");
    expect(result!["@Error"].name).toBe("TypeError");
    expect(result!["@Error"].message).toBe("something went wrong");
    expect(typeof result!["@Error"].stack).toBe("string");
  });

  it("should preserve Error cause property on set", () => {
    const c = runtime.getCell<unknown>(
      space,
      "should preserve Error cause property on set",
      undefined,
      tx,
    );
    const cause = new Error("root cause");
    const error = new Error("wrapper error", { cause });
    c.set(error);

    // Error cause should be recursively converted to @Error wrapper
    const result = c.get() as { "@Error": Record<string, unknown> } | undefined;
    expect(result).toHaveProperty("@Error");
    expect(result!["@Error"].message).toBe("wrapper error");
    const causeWrapper = result!["@Error"].cause as {
      "@Error": Record<string, unknown>;
    };
    expect(causeWrapper).toHaveProperty("@Error");
    expect(causeWrapper["@Error"].message).toBe("root cause");
  });

  it("should call toJSON() on plain objects during set", () => {
    const c = runtime.getCell<unknown>(
      space,
      "should call toJSON() on plain objects during set",
      undefined,
      tx,
    );
    const objWithToJSON = {
      secret: "internal",
      toJSON() {
        return { exposed: true };
      },
    };
    c.set({ data: objWithToJSON });

    const result = c.get() as { data: unknown } | undefined;
    // toJSON() should have been called, so we get { exposed: true } not { secret, toJSON }
    expect(result?.data).toEqual({ exposed: true });
  });

  it("should preserve sparse arrays during set", () => {
    const c = runtime.getCell<unknown>(
      space,
      "should preserve sparse arrays during set",
      undefined,
      tx,
    );
    const sparse: unknown[] = [];
    sparse[0] = "a";
    sparse[2] = "c"; // hole at index 1
    c.set({ arr: sparse });

    const result = c.get() as { arr: unknown[] } | undefined;
    // Sparse array holes should be preserved
    expect(result?.arr[0]).toBe("a");
    expect(1 in (result?.arr ?? [])).toBe(false);
    expect(result?.arr[2]).toBe("c");
    expect(result?.arr.length).toBe(3);
  });

  it("should preserve shared sparse arrays and preserve sharing", () => {
    const c = runtime.getCell<unknown>(
      space,
      "should preserve shared sparse arrays and preserve sharing",
      undefined,
      tx,
    );
    const sparse: unknown[] = [];
    sparse[0] = 1;
    sparse[3] = 2; // holes at indices 1 and 2
    // Same sparse array referenced twice
    c.set([sparse, sparse]);

    const result = c.get() as unknown[][] | undefined;
    // Both should preserve holes
    expect(result?.[0][0]).toBe(1);
    expect(1 in (result?.[0] ?? [])).toBe(false);
    expect(2 in (result?.[0] ?? [])).toBe(false);
    expect(result?.[0][3]).toBe(2);
    expect(result?.[0].length).toBe(4);
    // Both should reference the same array (sharing preserved)
    expect(result?.[0]).toBe(result?.[1]);
  });

  it("should preserve holes and add IDs to objects in sparse arrays", () => {
    const c = runtime.getCell<unknown>(
      space,
      "should preserve holes and add IDs to objects in sparse arrays",
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const sparse: any[] = new Array(4);
    sparse[0] = "hello";
    sparse[1] = { name: "Alice" };
    // index 2 is a hole
    sparse[3] = { name: "Bob" };
    c.set(sparse);

    // deno-lint-ignore no-explicit-any
    const result = c.get() as any[];
    expect(result[0]).toBe("hello");
    // Objects should have their properties
    expect(result[1]).toHaveProperty("name", "Alice");
    // Hole at index 2 should be preserved
    expect(2 in result).toBe(false);
    // Object at index 3 should have its properties
    expect(result[3]).toHaveProperty("name", "Bob");
    expect(result.length).toBe(4);
  });

  it("should call toJSON() on arrays with toJSON method during set", () => {
    const c = runtime.getCell<unknown>(
      space,
      "should call toJSON() on arrays with toJSON method during set",
      undefined,
      tx,
    );
    const arrWithToJSON = [1, 2, 3] as unknown[] & { toJSON?: () => unknown };
    arrWithToJSON.toJSON = () => "custom-array-value";
    c.set({ arr: arrWithToJSON });

    const result = c.get() as { arr: unknown } | undefined;
    // toJSON() should have been called
    expect(result?.arr).toBe("custom-array-value");
  });

  it("should convert -0 to 0 during set", () => {
    const c = runtime.getCell<unknown>(
      space,
      "should convert -0 to 0 during set",
      undefined,
      tx,
    );
    c.set({ value: -0 });

    const result = c.get() as { value: number } | undefined;
    expect(result?.value).toBe(0);
    // Verify it's actually 0, not -0
    expect(Object.is(result?.value, 0)).toBe(true);
    expect(Object.is(result?.value, -0)).toBe(false);
  });

  it("should throw when setting NaN", () => {
    const c = runtime.getCell<unknown>(
      space,
      "should throw when setting NaN",
      undefined,
      tx,
    );
    expect(() => c.set({ value: NaN })).toThrow(
      "Cannot store non-finite number",
    );
  });

  it("should throw when setting Infinity", () => {
    const c = runtime.getCell<unknown>(
      space,
      "should throw when setting Infinity",
      undefined,
      tx,
    );
    expect(() => c.set({ value: Infinity })).toThrow(
      "Cannot store non-finite number",
    );
    expect(() => c.set({ value: -Infinity })).toThrow(
      "Cannot store non-finite number",
    );
  });

  it("should throw when setting Symbol", () => {
    const c = runtime.getCell<unknown>(
      space,
      "should throw when setting Symbol",
      undefined,
      tx,
    );
    expect(() => c.set({ value: Symbol("test") })).toThrow(
      "Cannot store symbol",
    );
  });

  it("should throw when setting BigInt", () => {
    const c = runtime.getCell<unknown>(
      space,
      "should throw when setting BigInt",
      undefined,
      tx,
    );
    expect(() => c.set({ value: BigInt(123) })).toThrow("Cannot store bigint");
  });

  it("should create a proxy for the cell", () => {
    const c = runtime.getCell<{ x: number; y: number }>(
      space,
      "should create a proxy for the cell",
      undefined,
      tx,
    );
    c.set({ x: 1, y: 2 });
    const proxy = c.getAsQueryResult();
    expect(proxy.x).toBe(1);
    expect(proxy.y).toBe(2);
  });

  it("should get value at path", () => {
    const c = runtime.getCell<{ a: { b: { c: number } } }>(
      space,
      "should get value at path",
      undefined,
      tx,
    );
    c.set({ a: { b: { c: 42 } } });
    expect(c.key("a").key("b").key("c").get()).toBe(42);
  });

  it("should get raw value using getRaw", () => {
    const cell = runtime.getCell<{ x: number; y: number }>(
      space,
      "should get raw value using getRaw",
      undefined,
      tx,
    );
    cell.set({ x: 1, y: 2 });
    expect(cell.getRaw()).toEqual({ x: 1, y: 2 });
  });

  it("should set raw value using setRaw", () => {
    const cell = runtime.getCell<{ x: number; y: number }>(
      space,
      "should set raw value using setRaw",
      undefined,
      tx,
    );
    cell.set({ x: 1, y: 2 });
    cell.setRaw({ x: 10, y: 20 });
    expect(cell.getRaw()).toEqual({ x: 10, y: 20 });
  });

  it("should work with primitive values in getRaw/setRaw", () => {
    const cell = runtime.getCell<number>(
      space,
      "should work with primitive values in getRaw/setRaw",
      undefined,
      tx,
    );
    cell.set(42);

    expect(cell.getRaw()).toBe(42);

    cell.setRaw(100);
    expect(cell.getRaw()).toBe(100);
  });

  it("should work with arrays in getRaw/setRaw", () => {
    const cell = runtime.getCell<number[]>(
      space,
      "should work with arrays in getRaw/setRaw",
      undefined,
      tx,
    );
    cell.set([1, 2, 3]);

    expect(cell.getRaw()).toEqual([1, 2, 3]);

    cell.setRaw([4, 5, 6]);
    expect(cell.getRaw()).toEqual([4, 5, 6]);
  });

  it("should respect path in getRaw/setRaw for nested properties", () => {
    const c = runtime.getCell<{ nested: { value: number } }>(
      space,
      "should respect path in getRaw/setRaw for nested properties",
      undefined,
      tx,
    );
    c.set({ nested: { value: 42 } });
    const nestedCell = c.key("nested").key("value");

    // getRaw should return only the nested value
    expect(nestedCell.getRaw()).toBe(42);

    // same for setRaw, should update only the nested value
    nestedCell.setRaw(100);
    expect(nestedCell.getRaw()).toBe(100);

    // Verify the document structure is preserved
    expect(c.get()).toEqual({ nested: { value: 100 } });
  });

  it("should set and get the source cell", () => {
    // Create two cells
    const sourceCell = runtime.getCell<{ foo: number }>(
      space,
      "source cell for setSourceCell/getSourceCell test",
      undefined,
      tx,
    );
    sourceCell.set({ foo: 123 });

    const targetCell = runtime.getCell<{ bar: string }>(
      space,
      "target cell for setSourceCell/getSourceCell test",
      undefined,
      tx,
    );
    targetCell.set({ bar: "baz" });

    // Initially, getSourceCell should return undefined
    expect(targetCell.getSourceCell()).toBeUndefined();

    // Set the source cell
    targetCell.setSourceCell(sourceCell);

    // Now getSourceCell should return a Cell with the same value as sourceCell
    const retrievedSource = targetCell.getSourceCell();
    expect(isCell(retrievedSource)).toBe(true);
    expect(retrievedSource?.get()).toEqual({ foo: 123 });

    // Changing the source cell's value should be reflected
    sourceCell.set({ foo: 456 });
    expect(retrievedSource?.get()).toEqual({ foo: 456 });
  });

  it("should update pattern output when argument is changed via getArgumentCell", async () => {
    // Create a simple doubling pattern
    const doublePattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "number" } },
        required: ["input"],
      },
      resultSchema: {
        type: "object",
        properties: { output: { type: "number" } },
      },
      result: { output: { $alias: { path: ["internal", "doubled"] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (args: { input: number }) => (args.input * 2),
          },
          inputs: { input: { $alias: { path: ["argument", "input"] } } },
          outputs: { $alias: { path: ["internal", "doubled"] } },
        },
      ],
    };

    // Instantiate the pattern with initial argument
    const resultCell = runtime.getCell(space, "doubling pattern instance");
    runtime.setup(undefined, doublePattern, { input: 5 }, resultCell);
    runtime.start(resultCell);

    // Verify initial output (use pull to trigger computation)
    const initial = (await resultCell.pull()) as { output: number };
    expect(initial?.output).toEqual(10);

    // Get the argument cell and update it
    const argumentCell = resultCell.getArgumentCell<{ input: number }>();
    expect(argumentCell).toBeDefined();
    expect(argumentCell?.get()).toEqual({ input: 5 });

    // Update the argument via the argument cell
    const updateTx = runtime.edit();
    argumentCell!.withTx(updateTx).set({ input: 7 });
    updateTx.commit();

    // Verify the output has changed (use pull to trigger re-computation)
    const updated = await resultCell.pull();
    expect(updated).toEqual({ output: 14 });

    // Update again to verify reactivity
    const updateTx2 = runtime.edit();
    argumentCell!.withTx(updateTx2).set({ input: 100 });
    updateTx2.commit();

    // Verify final output
    const final = await resultCell.pull();
    expect(final).toEqual({ output: 200 });
  });

  it("should translate circular references into links", () => {
    const schema = {
      $ref: "#/$defs/Root",
      $defs: {
        Root: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            z: { $ref: "#/$defs/Root" },
          },
          required: ["x", "y", "z"],
        },
      },
    } as const satisfies JSONSchema;
    const c = runtime.getCell(
      space,
      "should translate circular references into links",
      schema,
      tx,
    );
    const data: any = { x: 1, y: 2 };
    data.z = data;
    c.set(data);

    const proxy = c.getAsQueryResult();
    expect(proxy.z).toBe(proxy);

    const value = c.get();
    expect(value.z.z.z).toBe(value.z.z);

    const raw = c.getRaw();
    expect(raw?.z).toMatchObject({ "/": { [LINK_V1_TAG]: { path: [] } } });
  });

  it("should translate circular references into links across cells", () => {
    const schema = {
      $ref: "#/$defs/Root",
      $defs: {
        Root: {
          type: "object",
          properties: {
            list: {
              type: "array",
              items: {
                type: "object",
                properties: { parent: { $ref: "#/$defs/Root" } },
                asCell: true,
                required: ["parent"],
              },
            },
          },
          required: ["list"],
        },
      },
    } as const satisfies JSONSchema;
    const c = runtime.getCell(
      space,
      "should translate circular references into links",
      schema,
      tx,
    );
    const inner: any = { [ID]: 1 }; // ID will turn this into a separate cell
    const outer: any = { list: [inner] };
    inner.parent = outer;
    c.set(outer);

    const proxy = c.getAsQueryResult();
    expect(proxy.list[0].parent).toBe(proxy);

    const { id } = c.getAsNormalizedFullLink();
    const innerCell = c.get().list[0];
    const raw = innerCell.getRaw();
    expect(raw).toMatchObject({
      parent: { "/": { [LINK_V1_TAG]: { id } } },
    });
  });
});

describe("Cell utility functions", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });

    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should identify a cell", () => {
    const c = runtime.getCell(
      space,
      "should identify a cell",
      undefined,
      tx,
    );
    c.set(10);
    expect(isCell(c)).toBe(true);
    expect(isCell({})).toBe(false);
  });

  it("should identify a cell reference", () => {
    const c = runtime.getCell<{ x: number }>(
      space,
      "should identify a cell reference",
      undefined,
      tx,
    );
    c.set({ x: 10 });
    const ref = c.key("x").getAsLink();
    expect(isPrimitiveCellLink(ref)).toBe(true);
    expect(isPrimitiveCellLink({})).toBe(false);
  });

  it("should identify a cell proxy", () => {
    const c = runtime.getCell<{ x: number }>(
      space,
      "should identify a cell proxy",
      undefined,
      tx,
    );
    c.set({ x: 1 });
    const proxy = c.getAsQueryResult();
    expect(isCellResult(proxy)).toBe(true);
    expect(isCellResult({})).toBe(false);
  });

  describe("getRawUntyped / setRawUntyped / getRawUntypedMutable", () => {
    it("getRawUntyped returns the same value as getRaw for typed data", () => {
      const cell = runtime.getCell<{ a: number }>(
        space,
        "getRawUntyped basic",
        undefined,
        tx,
      );
      cell.set({ a: 1 });
      expect(cell.getRawUntyped()).toEqual(cell.getRaw());
    });

    it("setRawUntyped accepts a link value that does not match T", () => {
      const target = runtime.getCell<number>(
        space,
        "setRawUntyped link target",
        undefined,
        tx,
      );
      target.set(99);

      const cell = runtime.getCell<string>(
        space,
        "setRawUntyped link source",
        undefined,
        tx,
      );
      cell.set("hello");

      // Write a sigil link via setRawUntyped — this would not type-check
      // with setRaw because a link object is not assignable to string.
      const link = target.getAsWriteRedirectLink();
      cell.setRawUntyped(link as StorableValue);

      // The raw untyped read should return the link structure.
      const raw = cell.getRawUntyped();
      expect(raw).toBeDefined();
      expect(typeof raw === "object" && raw !== null && "/" in raw).toBe(true);
    });

    it("setRawUntyped accepts undefined", () => {
      const cell = runtime.getCell<number>(
        space,
        "setRawUntyped undefined",
        undefined,
        tx,
      );
      cell.set(42);
      cell.setRawUntyped(undefined);
      expect(cell.getRawUntyped()).toBeUndefined();
    });

    it("getRawUntypedMutable returns undefined for an empty cell", () => {
      const cell = runtime.getCell<{ x: number }>(
        space,
        "getRawUntypedMutable empty",
        undefined,
        tx,
      );
      expect(cell.getRawUntypedMutable()).toBeUndefined();
    });

    it("getRawUntypedMutable returns a value equal to getRaw", () => {
      const cell = runtime.getCell<{ x: number; y: number }>(
        space,
        "getRawUntypedMutable basic",
        undefined,
        tx,
      );
      cell.set({ x: 10, y: 20 });
      expect(cell.getRawUntypedMutable()).toEqual(cell.getRaw());
    });
  });
});

// Separate top-level describe with richStorableValues enabled for frozen-ness.
describe("Cell raw methods: frozen-or-not (richStorableValues ON)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: richSigner });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: {
        richStorableValues: true,
        canonicalHashing: true,
      },
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("getRaw returns a frozen object", () => {
    const cell = runtime.getCell<{ a: number; b: number[] }>(
      richSpace,
      "getRaw frozen",
      undefined,
      tx,
    );
    cell.set({ a: 1, b: [2, 3] });
    const raw = cell.getRaw();
    expect(raw).toBeDefined();
    expect(Object.isFrozen(raw)).toBe(true);
    expect(Object.isFrozen((raw as { b: readonly number[] }).b)).toBe(true);
  });

  it("getRawUntyped returns a frozen object", () => {
    const cell = runtime.getCell<{ x: number[] }>(
      richSpace,
      "getRawUntyped frozen",
      undefined,
      tx,
    );
    cell.set({ x: [1, 2] });
    const raw = cell.getRawUntyped();
    expect(raw).toBeDefined();
    expect(Object.isFrozen(raw)).toBe(true);
    expect(Object.isFrozen((raw as { x: readonly number[] }).x)).toBe(true);
  });

  it("getRawUntypedMutable returns a mutable deep copy", () => {
    const cell = runtime.getCell<{ items: number[] }>(
      richSpace,
      "getRawUntypedMutable mutable",
      undefined,
      tx,
    );
    cell.set({ items: [10, 20] });

    const mutable = cell.getRawUntypedMutable() as { items: number[] };
    expect(mutable).toBeDefined();
    expect(Object.isFrozen(mutable)).toBe(false);
    expect(Object.isFrozen(mutable.items)).toBe(false);

    // Verify it's a copy — mutating doesn't affect the cell.
    mutable.items.push(30);
    expect((cell.getRaw() as { items: readonly number[] }).items).toEqual([
      10,
      20,
    ]);
  });

  it("getRaw and getRawUntyped agree, both frozen", () => {
    const cell = runtime.getCell<{ v: string }>(
      richSpace,
      "raw agreement frozen",
      undefined,
      tx,
    );
    cell.set({ v: "hello" });
    const typed = cell.getRaw();
    const untyped = cell.getRawUntyped();
    expect(typed).toEqual(untyped);
    expect(Object.isFrozen(typed)).toBe(true);
    expect(Object.isFrozen(untyped)).toBe(true);
  });
});
