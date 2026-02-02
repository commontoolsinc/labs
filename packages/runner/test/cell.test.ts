import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commontools/utils/equal-ignoring-symbols";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { isCell } from "../src/cell.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { isCellResult } from "../src/query-result-proxy.ts";
import { toCell } from "../src/back-to-cell.ts";
import { ID, JSONSchema, type Recipe } from "../src/builder/types.ts";
import { popFrame, pushFrame } from "../src/builder/recipe.ts";
import { Runtime } from "../src/runtime.ts";
import { txToReactivityLog } from "../src/scheduler.ts";
import { addCommonIDfromObjectID } from "../src/data-updating.ts";
import {
  areLinksSame,
  isPrimitiveCellLink,
  parseLink,
} from "../src/link-utils.ts";
import { areNormalizedLinksSame } from "../src/link-utils.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

const signer2 = await Identity.fromPassphrase("test operator 2");
const space2 = signer2.did();

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

  it("should densify sparse arrays during set", () => {
    const c = runtime.getCell<unknown>(
      space,
      "should densify sparse arrays during set",
      undefined,
      tx,
    );
    const sparse: unknown[] = [];
    sparse[0] = "a";
    sparse[2] = "c"; // hole at index 1
    c.set({ arr: sparse });

    const result = c.get() as { arr: unknown[] } | undefined;
    // Sparse array should be densified with null in the hole
    expect(result?.arr).toEqual(["a", null, "c"]);
  });

  it("should densify shared sparse arrays and preserve sharing", () => {
    const c = runtime.getCell<unknown>(
      space,
      "should densify shared sparse arrays and preserve sharing",
      undefined,
      tx,
    );
    const sparse: unknown[] = [];
    sparse[0] = 1;
    sparse[3] = 2; // holes at indices 1 and 2
    // Same sparse array referenced twice
    c.set([sparse, sparse]);

    const result = c.get() as unknown[][] | undefined;
    // Both should be densified
    expect(result?.[0]).toEqual([1, null, null, 2]);
    expect(result?.[1]).toEqual([1, null, null, 2]);
    // Both should reference the same array (sharing preserved)
    expect(result?.[0]).toBe(result?.[1]);
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

  it("should update recipe output when argument is changed via getArgumentCell", async () => {
    // Create a simple doubling recipe
    const doubleRecipe: Recipe = {
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

    // Instantiate the recipe with initial argument
    const resultCell = runtime.getCell(space, "doubling recipe instance");
    runtime.setup(undefined, doubleRecipe, { input: 5 }, resultCell);
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
});

describe("createProxy", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
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

  it("should create a proxy for nested objects", () => {
    const c = runtime.getCell<{ a: { b: { c: number } } }>(
      space,
      "should create a proxy for nested objects",
      undefined,
      tx,
    );
    c.set({ a: { b: { c: 42 } } });
    const proxy = c.getAsQueryResult();
    expect(proxy.a.b.c).toBe(42);
  });

  it("should handle $alias in objects", () => {
    const c = runtime.getCell(
      space,
      "should handle $alias in objects",
      undefined,
      tx,
    );
    c.setRaw({ x: { $alias: { path: ["y"] } }, y: 42 });
    const proxy = c.getAsQueryResult();
    expect(proxy.x).toBe(42);
  });

  it("should handle nested cells", () => {
    const innerCell = runtime.getCell<number>(
      space,
      "should handle nested cells inner",
      undefined,
      tx,
    );
    innerCell.set(42);
    const outerCell = runtime.getCell<{ x: any }>(
      space,
      "should handle nested cells outer",
      undefined,
      tx,
    );
    outerCell.set({ x: innerCell });
    const proxy = outerCell.getAsQueryResult();
    expect(proxy.x).toBe(42);
  });

  it.skip("should support modifying array methods and log reads and writes", () => {
    const c = runtime.getCell<{ array: number[] }>(
      space,
      "should support modifying array methods and log reads and writes",
    );
    c.set({ array: [1, 2, 3] });
    const proxy = c.getAsQueryResult();
    const log = txToReactivityLog(tx);
    expect(log.reads.length).toBe(1);
    expect(proxy.array.length).toBe(3);
    // only read array, but not the elements
    expect(log.reads.length).toBe(2);

    proxy.array.push(4);
    expect(proxy.array.length).toBe(4);
    expect(proxy.array[3]).toBe(4);
    expect(
      log.writes.some((write) =>
        write.path[0] === "array" && write.path[1] === "3"
      ),
    ).toBe(true);
  });

  it.skip("should handle array methods on previously undefined arrays", () => {
    const c = runtime.getCell<{ data: any }>(
      space,
      "should handle array methods on previously undefined arrays",
    );
    c.set({ data: {} });
    const proxy = c.getAsQueryResult();

    // Array doesn't exist yet
    expect(proxy.data.array).toBeUndefined();

    // Create an array using push
    proxy.data.array = [];
    proxy.data.array.push(1);
    expect(proxy.data.array.length).toBe(1);
    expect(proxy.data.array[0]).toBe(1);

    // Add more items
    proxy.data.array.push(2, 3);
    expect(proxy.data.array.length).toBe(3);
    expect(proxy.data.array[2]).toBe(3);

    // Check that writes were logged
    const log = txToReactivityLog(tx);
    expect(
      log.writes.some((write) =>
        write.path[0] === "data" && write.path[1] === "array"
      ),
    ).toBe(true);
  });

  it("should handle array results from array methods", () => {
    const c = runtime.getCell<{ array: number[] }>(
      space,
      "should handle array results from array methods",
      undefined,
      tx,
    );
    c.set({ array: [1, 2, 3, 4, 5] });
    const proxy = c.getAsQueryResult();

    // Methods that return arrays should return query result proxies
    const mapped = proxy.array.map((n: number) => n * 2);
    expect(isCellResult(mapped)).toBe(false);
    expect(mapped.length).toBe(5);
    expect(mapped[0]).toBe(2);
    expect(mapped[4]).toBe(10);

    const filtered = proxy.array.filter((n: number) => n % 2 === 0);
    expect(isCellResult(filtered)).toBe(false);
    expect(filtered.length).toBe(2);
    expect(filtered[0]).toBe(2);
    expect(filtered[1]).toBe(4);

    const sliced = proxy.array.slice(1, 4);
    expect(isCellResult(sliced)).toBe(false);
    expect(sliced.length).toBe(3);
    expect(sliced[0]).toBe(2);
    expect(sliced[2]).toBe(4);
  });

  it("should support spreading array query results with for...of", () => {
    const c = runtime.getCell<{ items: { name: string }[] }>(
      space,
      "should support spreading array query results",
      undefined,
      tx,
    );
    c.set({ items: [{ name: "a" }, { name: "b" }, { name: "c" }] });
    const proxy = c.getAsQueryResult();

    // Use for...of loop to iterate over the array
    const collected: any[] = [];
    for (const item of proxy.items) {
      collected.push(item);
    }

    expect(collected.length).toBe(3);

    // Each element should be a query result proxy (for objects)
    expect(isCellResult(collected[0])).toBe(true);
    expect(isCellResult(collected[1])).toBe(true);
    expect(isCellResult(collected[2])).toBe(true);

    // We can access properties through the proxies
    expect(collected[0].name).toBe("a");
    expect(collected[1].name).toBe("b");
    expect(collected[2].name).toBe("c");
  });

  it("should support spreading array query results with spread operator", () => {
    const c = runtime.getCell<{ items: { id: number }[] }>(
      space,
      "should support spreading array with spread operator",
      undefined,
      tx,
    );
    c.set({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const proxy = c.getAsQueryResult();

    // Spread the array into a new array
    const spread = [...proxy.items];

    expect(spread.length).toBe(3);

    // Each element should be a query result proxy (for objects)
    expect(isCellResult(spread[0])).toBe(true);
    expect(isCellResult(spread[1])).toBe(true);
    expect(isCellResult(spread[2])).toBe(true);

    // Verify we can access properties
    expect(spread[0].id).toBe(1);
    expect(spread[1].id).toBe(2);
    expect(spread[2].id).toBe(3);
  });

  it("should support spreading nested array query results", () => {
    const c = runtime.getCell<{ nested: { data: { value: number }[][] } }>(
      space,
      "should support spreading nested arrays",
      undefined,
      tx,
    );
    c.set({
      nested: {
        data: [[{ value: 1 }, { value: 2 }], [{ value: 3 }, { value: 4 }]],
      },
    });
    const proxy = c.getAsQueryResult();

    // Spread the outer array
    const outerSpread = [...proxy.nested.data];
    expect(outerSpread.length).toBe(2);

    // Each inner array should be a query result proxy
    expect(isCellResult(outerSpread[0])).toBe(true);
    expect(isCellResult(outerSpread[1])).toBe(true);

    // Spread an inner array
    const innerSpread = [...outerSpread[0]];
    expect(innerSpread.length).toBe(2);

    // Elements of the inner array should also be query result proxies (for objects)
    expect(isCellResult(innerSpread[0])).toBe(true);
    expect(isCellResult(innerSpread[1])).toBe(true);

    // Verify we can access properties
    expect(innerSpread[0].value).toBe(1);
    expect(innerSpread[1].value).toBe(2);
  });

  it("should support spreading arrays with cell references", () => {
    // Create individual cells to reference
    const cell1 = runtime.getCell<{ name: string; value: number }>(
      space,
      "ref-cell-1",
      undefined,
      tx,
    );
    cell1.set({ name: "first", value: 100 });

    const cell2 = runtime.getCell<{ name: string; value: number }>(
      space,
      "ref-cell-2",
      undefined,
      tx,
    );
    cell2.set({ name: "second", value: 200 });

    const cell3 = runtime.getCell<{ name: string; value: number }>(
      space,
      "ref-cell-3",
      undefined,
      tx,
    );
    cell3.set({ name: "third", value: 300 });

    // Create an array cell containing references to other cells
    const arrayCell = runtime.getCell<any[]>(
      space,
      "array-with-refs",
      undefined,
      tx,
    );
    arrayCell.set([cell1, cell2, cell3]);

    const proxy = arrayCell.getAsQueryResult();

    // Spread the array
    const spread = [...proxy];

    expect(spread.length).toBe(3);

    // Each element should be a query result proxy
    expect(isCellResult(spread[0])).toBe(true);
    expect(isCellResult(spread[1])).toBe(true);
    expect(isCellResult(spread[2])).toBe(true);

    // Verify we can access the referenced cells' data
    expect(spread[0].name).toBe("first");
    expect(spread[0].value).toBe(100);
    expect(spread[1].name).toBe("second");
    expect(spread[1].value).toBe(200);
    expect(spread[2].name).toBe("third");
    expect(spread[2].value).toBe(300);

    // Use for...of to iterate
    const names: string[] = [];
    for (const item of proxy) {
      names.push(item.name);
    }
    expect(names).toEqual(["first", "second", "third"]);
  });

  it.skip("should support pop() and only read the popped element", () => {
    const c = runtime.getCell<{ a: number[] }>(
      space,
      "should support pop() and only read the popped element",
    );
    c.set({ a: [] as number[] });
    const proxy = c.getAsQueryResult();
    proxy.a = [1, 2, 3];
    const result = proxy.a.pop();
    const log = txToReactivityLog(tx);
    const pathsRead = log.reads.map((r) => r.path.join("."));
    expect(pathsRead).toContain("a.2");
    // TODO(seefeld): diffAndUpdate could be more optimal here, right now it'll
    // mark as read the whole array since it isn't aware of the pop operation.
    // expect(pathsRead).not.toContain("a.0");
    // expect(pathsRead).not.toContain("a.1");
    expect(result).toEqual(3);
    expect(proxy.a).toEqual([1, 2]);
  });

  it.skip("should correctly sort() with cell references", () => {
    const c = runtime.getCell<{ a: number[] }>(
      space,
      "should correctly sort() with cell references",
    );
    c.set({ a: [] as number[] });
    const proxy = c.getAsQueryResult();
    proxy.a = [3, 1, 2];
    const result = proxy.a.sort();
    expect(result).toEqual([1, 2, 3]);
    expect(proxy.a).toEqual([1, 2, 3]);
  });

  it.skip("should support readonly array methods and log reads", () => {
    const c = runtime.getCell<number[]>(
      space,
      "should support readonly array methods and log reads",
    );
    c.set([1, 2, 3]);
    const proxy = c.getAsQueryResult();
    const result = proxy.find((x: any) => x === 2);
    expect(result).toBe(2);
    expect(c.get()).toEqual([1, 2, 3]);
    const log = txToReactivityLog(tx);
    expect(log.reads.map((r) => r.path)).toEqual([[], ["0"], ["1"], ["2"]]);
    expect(log.writes).toEqual([]);
  });

  it.skip("should support mapping over a proxied array", () => {
    const c = runtime.getCell<{ a: number[] }>(
      space,
      "should support mapping over a proxied array",
    );
    c.set({ a: [1, 2, 3] });
    const proxy = c.getAsQueryResult();
    const result = proxy.a.map((x: any) => x + 1);
    expect(result).toEqual([2, 3, 4]);
    const log = txToReactivityLog(tx);
    expect(log.reads.map((r) => r.path)).toEqual([
      [],
      ["a"],
      ["a", "0"],
      ["a", "1"],
      ["a", "2"],
    ]);
  });

  it.skip("should allow changing array lengths by writing length", () => {
    const c = runtime.getCell<number[]>(
      space,
      "should allow changing array lengths by writing length",
    );
    c.set([1, 2, 3]);
    const proxy = c.getAsQueryResult();
    proxy.length = 2;
    expect(c.get()).toEqual([1, 2]);
    const log = txToReactivityLog(tx);
    expect(areLinksSame(log.writes[0], c.key("length").getAsLink()))
      .toBe(true);
    expect(areLinksSame(log.writes[1], c.key(2).getAsLink())).toBe(
      true,
    );
    proxy.length = 4;
    const cLink = c.getAsNormalizedFullLink();
    expect(c.get()).toEqual([1, 2, undefined, undefined]);
    expect(log.writes.length).toBe(5);
    expect(log.writes[2].id).toBe(cLink.id);
    expect(log.writes[2].path).toEqual(["length"]);
    expect(log.writes[3].id).toBe(cLink.id);
    expect(log.writes[3].path).toEqual([2]);
    expect(log.writes[4].id).toBe(cLink.id);
    expect(log.writes[4].path).toEqual([3]);
  });

  it.skip("should allow changing array by splicing", () => {
    const c = runtime.getCell<number[]>(
      space,
      "should allow changing array by splicing",
    );
    c.set([1, 2, 3]);
    const proxy = c.getAsQueryResult();
    proxy.splice(1, 1, 4, 5);
    expect(c.get()).toEqual([1, 4, 5, 3]);
    const log = txToReactivityLog(tx);
    const cLink = c.getAsNormalizedFullLink();
    expect(log.writes.length).toBe(3);
    expect(log.writes[0].id).toBe(cLink.id);
    expect(log.writes[0].path).toEqual(["1"]);
    expect(log.writes[1].id).toBe(cLink.id);
    expect(log.writes[1].path).toEqual(["2"]);
    expect(log.writes[2].id).toBe(cLink.id);
    expect(log.writes[2].path).toEqual(["3"]);
  });
});

describe("Proxy", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
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

  it("should return a Sendable for stream aliases", async () => {
    const c = runtime.getCell<{ stream: { $stream: true } }>(
      space,
      "should return a Sendable for stream aliases",
      undefined,
      tx,
    );
    c.setRaw({ stream: { $stream: true } });
    tx.commit();

    tx = runtime.edit();

    const streamCell = c.key("stream");

    expect(streamCell).toHaveProperty("send");

    let lastEventSeen: any = null;
    let eventCount = 0;

    runtime.scheduler.addEventHandler(
      (_tx: IExtendedStorageTransaction, event: any) => {
        eventCount++;
        lastEventSeen = event;
      },
      streamCell.getAsNormalizedFullLink(),
    );

    streamCell.send({ $stream: true });
    await runtime.idle();

    // The stream property returns a Cell (stream kind) rather than raw { $stream: true }
    // because createQueryResultProxy detects stream markers and returns stream cells
    expect(c.get().stream).toHaveProperty("send");
    expect(eventCount).toBe(1);
    expect(lastEventSeen).toEqual({ $stream: true });
  });

  it("should convert cells and proxies to links when sending events", async () => {
    const c = runtime.getCell<any>(
      space,
      "should convert cells and proxies to links when sending events",
    );
    c.withTx(tx).setRaw({ stream: { $stream: true } });
    tx.commit();
    tx = runtime.edit();

    const streamCell = c.key("stream");

    let lastEventSeen: any = null;
    let eventCount = 0;

    runtime.scheduler.addEventHandler(
      (_tx: IExtendedStorageTransaction, event: any) => {
        eventCount++;
        lastEventSeen = event;
      },
      streamCell.getAsNormalizedFullLink(),
    );

    const c2 = runtime.getCell(
      space,
      "should convert cells and proxies to links when sending events: payload",
      {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
      } as const satisfies JSONSchema,
      tx,
    );
    c2.withTx(tx).set({ x: 1, y: 2 });
    tx.commit();
    tx = runtime.edit();

    // Create event, with cell, query result and circular reference.
    const event: any = { a: c2, b: c2.getAsQueryResult() };
    event.c = event;

    streamCell.send(event);

    await runtime.idle();

    expect(eventCount).toBe(1);
    const { id } = c2.getAsNormalizedFullLink();
    expect(lastEventSeen).toEqual(
      {
        a: { "/": { [LINK_V1_TAG]: { id, path: [], space } } },
        b: { "/": { [LINK_V1_TAG]: { id, path: [], space } } },
        c: { "/": { [LINK_V1_TAG]: { path: [] } } },
      },
    );
  });
});

describe("asCell", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
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

  it("should create a simple cell interface", () => {
    const simpleCell = runtime.getCell<{ x: number; y: number }>(
      space,
      "should create a simple cell interface",
      undefined,
      tx,
    );
    simpleCell.set({ x: 1, y: 2 });

    expect(simpleCell.get()).toEqual({ x: 1, y: 2 });

    simpleCell.set({ x: 3, y: 4 });
    expect(simpleCell.get()).toEqual({ x: 3, y: 4 });

    simpleCell.send({ x: 5, y: 6 });
    expect(simpleCell.get()).toEqual({ x: 5, y: 6 });
  });

  it("should create a simple cell for nested properties", () => {
    const c = runtime.getCell<{ nested: { value: number } }>(
      space,
      "should create a simple cell for nested properties",
      undefined,
      tx,
    );
    c.set({ nested: { value: 42 } });
    const nestedCell = c.key("nested").key("value");

    expect(nestedCell.get()).toBe(42);

    nestedCell.set(100);
    expect(c.get()).toEqual({ nested: { value: 100 } });
  });

  it("should support the key method for nested access", () => {
    const simpleCell = runtime.getCell<{ a: { b: { c: number } } }>(
      space,
      "should support the key method for nested access",
      undefined,
      tx,
    );
    simpleCell.set({ a: { b: { c: 42 } } });

    const nestedCell = simpleCell.key("a").key("b").key("c");
    expect(nestedCell.get()).toBe(42);

    nestedCell.set(100);
    expect(simpleCell.get()).toEqual({ a: { b: { c: 100 } } });
  });

  it("should call sink only when the cell changes on the subpath", async () => {
    const c = runtime.getCell<{ a: { b: number; c: number }; d: number }>(
      space,
      "should call sink only when the cell changes on the subpath",
      undefined,
      tx,
    );
    c.set({ a: { b: 42, c: 10 }, d: 5 });
    tx.commit();
    tx = runtime.edit();
    const values: number[] = [];
    c.key("a").key("b").sink((value) => {
      values.push(value);
    });
    expect(values).toEqual([42]); // Initial call
    c.withTx(tx).key("d").set(50);
    tx.commit();
    tx = runtime.edit();
    c.withTx(tx).key("a").key("c").set(100);
    tx.commit();
    tx = runtime.edit();
    c.withTx(tx).key("a").key("b").set(42);
    tx.commit();
    tx = runtime.edit();
    expect(values).toEqual([42]); // Didn't get called again
    c.withTx(tx).key("a").key("b").set(300);
    tx.commit();
    await runtime.idle();
    expect(c.get()).toEqual({ a: { b: 300, c: 100 }, d: 50 });
    expect(values).toEqual([42, 300]); // Got called again
  });

  it("does not trigger sink for changes in the same change group", async () => {
    const c = runtime.getCell<number>(
      space,
      "sink-change-group",
      undefined,
      tx,
    );
    c.set(0);
    await tx.commit();
    tx = runtime.edit();

    const changeGroup = {};
    const values: number[] = [];
    const cancel = c.sink((value) => {
      values.push(value);
    }, { changeGroup });

    await runtime.idle();
    expect(values).toEqual([0]);

    const sameGroupTx = runtime.edit({ changeGroup });
    c.withTx(sameGroupTx).set(1);
    await sameGroupTx.commit();
    await runtime.idle();
    expect(values).toEqual([0]);

    const otherGroupTx = runtime.edit({ changeGroup: {} });
    c.withTx(otherGroupTx).set(2);
    await otherGroupTx.commit();
    await runtime.idle();
    expect(values).toEqual([0, 2]);

    const noGroupTx = runtime.edit();
    c.withTx(noGroupTx).set(3);
    await noGroupTx.commit();
    await runtime.idle();
    expect(values).toEqual([0, 2, 3]);

    cancel();
  });

  it("should trigger sink when linked cell changes and is read during callback", async () => {
    // This test verifies that cell reads happening DURING the sink callback
    // are properly tracked for reactivity. The fix moves txToReactivityLog()
    // to after the callback so that reads like JSON.stringify traversing
    // through linked cells are captured in the subscription.

    // Create an inner cell that will be linked to
    const innerCell = runtime.getCell<{ value: string }>(
      space,
      "sink-callback-reads-inner",
      undefined,
      tx,
    );
    innerCell.set({ value: "initial" });

    // Create a container cell with schema: true (no validation, raw access)
    // that contains a link to the inner cell
    const containerCell = runtime.getCell<{ nested: unknown }>(
      space,
      "sink-callback-reads-container",
      true, // schema: true means no schema validation
      tx,
    );
    containerCell.setRaw({
      nested: innerCell.getAsLink(),
    });

    tx.commit();
    tx = runtime.edit();

    // Track callback invocations - use JSON.stringify to force reading
    // through the link during the callback
    const callbackResults: string[] = [];
    const cancel = containerCell.sink((value) => {
      // This read through the linked cell happens DURING the callback.
      // Before the fix, this read wasn't tracked, so changes to innerCell
      // wouldn't trigger this sink to re-run.
      const serialized = JSON.stringify(value);
      callbackResults.push(serialized);
    });

    // Should have been called once with initial value
    expect(callbackResults.length).toBe(1);
    expect(callbackResults[0]).toContain("initial");

    // Now update the inner cell
    innerCell.withTx(tx).set({ value: "updated" });
    tx.commit();
    tx = runtime.edit();

    await runtime.idle();

    // The sink should have been triggered again because we read through
    // the link during the callback
    expect(callbackResults.length).toBe(2);
    expect(callbackResults[1]).toContain("updated");

    cancel();
  });

  it("behaves correctly when setting a cell to itself", () => {
    const c = runtime.getCell<{ a: number }>(
      space,
      "behaves correctly when setting a cell to itself",
      undefined,
      tx,
    );
    c.set({ a: 1 });
    c.set(c);
    expect(c.get()).toEqual({ a: 1 });
  });

  it("behaves correctly when setting a cell to itself, any schema", () => {
    const c = runtime.getCell<{ a: number }>(
      space,
      "behaves correctly when setting a cell to itself, any schema",
      undefined,
      tx,
    );
    c.set({ a: 1 });
    c.set(c.get());
    expect(c.get()).toEqual({ a: 1 });
  });

  it("behaves correctly when setting a cell to itself, asCell schema", () => {
    const c = runtime.getCell(
      space,
      "behaves correctly when setting a cell to itself, asCell schema",
      {
        type: "object",
        properties: { a: { type: "number" } },
        required: ["a"],
        asCell: true,
      } as const satisfies JSONSchema,
      tx,
    );
    c.set({ a: 1 });
    c.set(c.get());
    expect(c.get().get()).toEqualIgnoringSymbols({ a: 1 });
  });
});

describe("asCell with schema", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
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

  it("should validate and transform according to schema", () => {
    const c = runtime.getCell<{
      name: string;
      age: number;
      tags: string[];
      nested: { value: number };
    }>(
      space,
      "should validate and transform according to schema",
      undefined,
      tx,
    );
    c.set({
      name: "test",
      age: 42,
      tags: ["a", "b"],
      nested: {
        value: 123,
      },
    });

    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
        tags: {
          type: "array",
          items: { type: "string" },
        },
        nested: {
          type: "object",
          properties: {
            value: { type: "number" },
          },
          required: ["value"],
        },
      },
      required: ["name", "age", "tags", "nested"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);
    const value = cell.get() as any;

    expect(value.name).toBe("test");
    expect(value.age).toBe(42);
    expect(value.tags).toEqualIgnoringSymbols(["a", "b"]);
    expect(value.nested.value).toBe(123);
  });

  it("should return a Cell for reference properties", () => {
    const c = runtime.getCell<{
      id: number;
      metadata: {
        createdAt: string;
        type: string;
      };
    }>(
      space,
      "should return a Cell for reference properties",
      undefined,
      tx,
    );
    c.set({
      id: 1,
      metadata: {
        createdAt: "2025-01-06",
        type: "user",
      },
    });

    const schema = {
      type: "object",
      properties: {
        id: { type: "number" },
        metadata: {
          type: "object",
          asCell: true,
        },
      },
      required: ["id", "metadata"],
    } as const satisfies JSONSchema;

    const value = c.asSchema(schema).get();

    expect(value.id).toBe(1);
    expect(isCell(value.metadata)).toBe(true);

    // The metadata cell should behave like a normal cell
    const metadataValue = value.metadata.get();
    expect(metadataValue.createdAt).toBe("2025-01-06");
    expect(metadataValue.type).toBe("user");
  });

  it("should handle recursive schemas with $ref", () => {
    const c = runtime.getCell<{
      name: string;
      children: Array<{
        name: string;
        children: any[];
      }>;
    }>(
      space,
      "should handle recursive schemas with $ref",
      undefined,
      tx,
    );
    c.set({
      name: "root",
      children: [
        {
          name: "child1",
          children: [],
        },
        {
          name: "child2",
          children: [
            {
              name: "grandchild",
              children: [],
            },
          ],
        },
      ],
    });

    const schema = {
      $ref: "#/$defs/Root",
      $defs: {
        Root: {
          type: "object",
          properties: {
            name: { type: "string" },
            children: {
              type: "array",
              items: { $ref: "#/$defs/Root" },
            },
          },
          required: ["name", "children"],
        },
      },
    } as const satisfies JSONSchema;

    const value = c.asSchema(schema).get();

    expect(value.name).toBe("root");
    expect(value.children[0].name).toBe("child1");
    expect(value.children[1].name).toBe("child2");
    expect(value.children[1].children[0].name).toBe("grandchild");
  });

  it("should propagate schema through key() navigation", () => {
    const c = runtime.getCell<{
      user: {
        profile: {
          name: string;
          settings: {
            theme: string;
            notifications: boolean;
          };
        };
        metadata: {
          id: string;
          type: string;
        };
      };
    }>(
      space,
      "should propagate schema through key() navigation",
      undefined,
      tx,
    );
    c.set({
      user: {
        profile: {
          name: "John",
          settings: {
            theme: "dark",
            notifications: true,
          },
        },
        metadata: {
          id: "123",
          type: "admin",
        },
      },
    });

    const schema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            profile: {
              type: "object",
              properties: {
                name: { type: "string" },
                settings: {
                  type: "object",
                  asCell: true,
                },
              },
              required: ["name", "settings"],
            },
            metadata: {
              type: "object",
              asCell: true,
            },
          },
          required: ["profile", "metadata"],
        },
      },
      required: ["user"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);
    const userCell = cell.key("user");
    const profileCell = userCell.key("profile");

    const value = profileCell.get();
    expect(value.name).toBe("John");
    expect(isCell(value.settings)).toBe(true);

    // Test that references are preserved through the entire chain
    const userValue = userCell.get();
    expect(isCell(userValue.metadata)).toBe(true);
  });

  it("should fall back to query result proxy when no schema is present", () => {
    const c = runtime.getCell<{
      data: {
        value: number;
        nested: {
          str: string;
        };
      };
    }>(
      space,
      "should fall back to query result proxy when no schema is present",
      undefined,
      tx,
    );
    c.set({
      data: {
        value: 42,
        nested: {
          str: "hello",
        },
      },
    });

    const value = c.get();

    // Should behave like a query result proxy
    expect(value.data.value).toBe(42);
    expect(value.data.nested.str).toBe("hello");
  });

  it("should allow changing schema with asSchema", () => {
    const c = runtime.getCell<{
      id: number;
      metadata: {
        createdAt: string;
        type: string;
      };
    }>(
      space,
      "should allow changing schema with asSchema",
      undefined,
      tx,
    );
    c.set({
      id: 1,
      metadata: {
        createdAt: "2025-01-06",
        type: "user",
      },
    });

    // Start with a schema that doesn't mark metadata as a reference
    const initialSchema = {
      type: "object",
      properties: {
        id: { type: "number" },
        metadata: {
          type: "object",
          properties: {
            createdAt: { type: "string" },
            type: { type: "string" },
          },
        },
      },
      required: ["id", "metadata"],
    } as const satisfies JSONSchema;

    // Create a schema that marks metadata as a reference
    const referenceSchema = {
      type: "object",
      properties: {
        id: { type: "number" },
        metadata: {
          type: "object",
          properties: {
            createdAt: { type: "string" },
            type: { type: "string" },
          },
          asCell: true,
        },
      },
      required: ["id", "metadata"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(initialSchema);
    const value = cell.get();

    // With initial schema, metadata is not a Cell
    expect(value.id).toBe(1);
    expect(isCell(value.metadata)).toBe(false);
    expect(value.metadata.createdAt).toBe("2025-01-06");

    // Switch to reference schema
    const referenceCell = cell.asSchema(referenceSchema);
    const refValue = referenceCell.get();

    // Now metadata should be a Cell
    expect(refValue.id).toBe(1);
    expect(isCell(refValue.metadata)).toBe(true);

    // But we can still get the raw value
    const metadataValue = refValue.metadata.get();
    expect(metadataValue.createdAt).toBe("2025-01-06");
    expect(metadataValue.type).toBe("user");
  });

  it("should handle objects with additional properties as references", () => {
    const c = runtime.getCell<{
      id: number;
      context: {
        user: { name: string };
        settings: { theme: string };
        data: { value: number };
      };
    }>(
      space,
      "should handle objects with additional properties as references",
      undefined,
      tx,
    );
    c.set({
      id: 1,
      context: {
        user: { name: "John" },
        settings: { theme: "dark" },
        data: { value: 42 },
      },
    });

    const schema = {
      type: "object",
      properties: {
        id: { type: "number" },
        context: {
          type: "object",
          additionalProperties: {
            type: "object",
            asCell: true,
          },
        },
      },
      required: ["id", "context"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);
    const value = cell.get();

    // Regular property works normally
    expect(value.id).toBe(1);

    // Each property in context should be a Cell
    expect(isCell(value.context.user)).toBe(true);
    expect(isCell(value.context.settings)).toBe(true);
    expect(isCell(value.context.data)).toBe(true);

    // But we can still get their values
    expect(value.context.user.get().name).toBe("John");
    expect(value.context.settings.get().theme).toBe("dark");
    expect(value.context.data.get().value).toBe(42);
  });

  it("should handle additional properties with just reference: true", () => {
    const c = runtime.getCell<{
      context: {
        number: number;
        string: string;
        object: { value: number };
        array: number[];
      };
    }>(
      space,
      "should handle additional properties with just reference: true",
      undefined,
      tx,
    );
    c.set({
      context: {
        number: 42,
        string: "hello",
        object: { value: 123 },
        array: [1, 2, 3],
      },
    });

    const schema = {
      type: "object",
      properties: {
        context: {
          type: "object",
          additionalProperties: { asCell: true },
        },
      },
      required: ["context"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);
    const value = cell.get();

    // All properties in context should be Cells regardless of their type
    expect(isCell(value.context.number)).toBe(true);
    expect(isCell(value.context.string)).toBe(true);
    expect(isCell(value.context.object)).toBe(true);
    expect(isCell(value.context.array)).toBe(true);

    // Values should be preserved
    expect(value.context.number.get()).toBe(42);
    expect(value.context.string.get()).toBe("hello");
    expect(value.context.object.get()).toEqual({ value: 123 });
    expect(value.context.array.get()).toEqual([1, 2, 3]);
  });

  it("should handle references in underlying cell", () => {
    // Create a cell with a reference
    const innerCell = runtime.getCell<{ value: number }>(
      space,
      "should handle references in underlying cell",
      undefined,
      tx,
    );
    innerCell.set({ value: 42 });

    // Create a cell that uses that reference
    const c = runtime.getCell<{
      context: {
        inner: any;
      };
    }>(
      space,
      "should handle references in underlying cell outer",
      undefined,
      tx,
    );
    c.set({
      context: {
        inner: innerCell,
      },
    });

    const schema = {
      type: "object",
      properties: {
        context: {
          type: "object",
          additionalProperties: { asCell: true },
        },
      },
      required: ["context"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);
    const value = cell.get();

    // The inner reference should be preserved but wrapped in a new Cell
    expect(isCell(value.context.inner)).toBe(true);
    expect(value.context.inner.get().value).toBe(42);

    // Changes to the original cell should propagate
    innerCell.send({ value: 100 });
    expect(value.context.inner.get().value).toBe(100);
  });

  it("should handle all types of references in underlying cell", () => {
    // Create cells with different types of references
    const innerCell = runtime.getCell<{ value: number }>(
      space,
      "should handle all types of references in underlying cell: inner",
      undefined,
      tx,
    );
    innerCell.set({ value: 42 });
    const cellRef = innerCell.getAsLink();
    const aliasRef = innerCell.getAsWriteRedirectLink();

    // Create a cell that uses all reference types
    const c = runtime.getCell<{
      context: {
        cell: any;
        reference: any;
        alias: any;
      };
    }>(
      space,
      "should handle all types of references in underlying cell main",
      undefined,
      tx,
    );
    c.set({
      context: {
        cell: innerCell,
        reference: cellRef,
        alias: aliasRef,
      },
    });

    const schema = {
      type: "object",
      properties: {
        context: {
          type: "object",
          additionalProperties: { asCell: true },
        },
      },
      required: ["context"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);
    const value = cell.get();

    // All references should be preserved but wrapped in Cells
    expect(isCell(value.context.cell)).toBe(true);
    expect(isCell(value.context.reference)).toBe(true);
    expect(isCell(value.context.alias)).toBe(true);

    // All should point to the same value
    expect(value.context.cell.get().value).toBe(42);
    expect(value.context.reference.get().value).toBe(42);
    expect(value.context.alias.get().value).toBe(42);

    // Changes to the original cell should propagate to all references
    innerCell.send({ value: 100 });
    expect(value.context.cell.get().value).toBe(100);
    expect(value.context.reference.get().value).toBe(100);
    expect(value.context.alias.get().value).toBe(100);
  });

  it.skip("should handle nested references", () => {
    // Create a chain of references
    const innerCell = runtime.getCell<{ value: number }>(
      space,
      "should handle nested references: inner",
      undefined,
      tx,
    );
    innerCell.set({ value: 42 });

    const ref1 = innerCell.getAsLink();

    const ref2Cell = runtime.getCell<{ ref: any }>(
      space,
      "should handle nested references: ref2",
      undefined,
      tx,
    );
    ref2Cell.set({ ref: ref1 });
    const ref2 = ref2Cell.key("ref").getAsLink();

    const ref3Cell = runtime.getCell<{ ref: any }>(
      space,
      "should handle nested references: ref3",
      undefined,
      tx,
    );
    ref3Cell.setRaw({ ref: ref2 });
    const ref3 = ref3Cell.key("ref").getAsLink();

    // Create a cell that uses the nested reference
    const cell = runtime.getCell<{
      context: {
        nested: any;
      };
    }>(
      space,
      "should handle nested references main",
      {
        type: "object",
        properties: {
          context: {
            type: "object",
            additionalProperties: { asCell: true },
          },
        },
        required: ["context"],
      } as const satisfies JSONSchema,
      tx,
    );
    cell.set({
      context: {
        nested: ref3,
      },
    });

    const value = cell.get() as any;

    // The nested reference should be followed all the way to the inner value
    expect(isCell(value.context.nested)).toBe(true);
    expect(value.context.nested.get().value).toBe(42);

    // Check that 4 unique documents were read (by entity ID)
    const log = txToReactivityLog(tx);
    const readEntityIds = new Set(log.reads.map((r) => r.id));
    expect(readEntityIds.size).toBe(4);

    // Verify each cell was read using equals()
    const readCells = log.reads.map((r) => runtime.getCellFromLink(r));
    expect(readCells.some((c2) => c2.equals(cell))).toBe(true);
    expect(readCells.some((c2) => c2.equals(ref3Cell))).toBe(true);
    expect(readCells.some((c2) => c2.equals(ref2Cell))).toBe(true);
    expect(readCells.some((c2) => c2.equals(innerCell))).toBe(true);

    // Changes to the original cell should propagate through the chain
    innerCell.send({ value: 100 });
    expect(value.context.nested.get().value).toBe(100);
  });

  it("should handle array schemas in key() navigation", () => {
    const c = runtime.getCell<{
      items: Array<{ name: string; value: number }>;
    }>(
      space,
      "should handle array schemas in key() navigation",
      undefined,
      tx,
    );
    c.set({
      items: [
        { name: "item1", value: 1 },
        { name: "item2", value: 2 },
      ],
    });

    const schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              value: { type: "number" },
            },
            required: ["name", "value"],
          },
        },
      },
      required: ["items"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);
    const itemsCell = cell.key("items");
    const firstItemCell = itemsCell.key(0);
    const secondItemCell = itemsCell.key(1);

    expect(firstItemCell.get()).toEqualIgnoringSymbols({
      name: "item1",
      value: 1,
    });
    expect(secondItemCell.get()).toEqualIgnoringSymbols({
      name: "item2",
      value: 2,
    });
  });

  it("should handle additionalProperties in key() navigation", () => {
    const c = runtime.getCell<{
      defined: string;
      [key: string]: any;
    }>(
      space,
      "should handle additionalProperties in key() navigation",
      undefined,
      tx,
    );
    c.set({
      defined: "known property",
      extra1: { value: 1 },
      extra2: { value: 2 },
    });

    const schema = {
      type: "object",
      properties: {
        defined: { type: "string" },
      },
      additionalProperties: {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      },
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);

    // Test defined property
    const definedCell = cell.key("defined");
    expect(definedCell.get()).toBe("known property");

    // Test additional properties
    const extra1Cell = cell.key("extra1");
    const extra2Cell = cell.key("extra2");
    expect(extra1Cell.get()).toEqualIgnoringSymbols({ value: 1 });
    expect(extra2Cell.get()).toEqualIgnoringSymbols({ value: 2 });
  });

  it("should handle additionalProperties: true in key() navigation", () => {
    const c = runtime.getCell<{
      defined: string;
      [key: string]: any;
    }>(
      space,
      "should handle additionalProperties: true in key() navigation",
      undefined,
      tx,
    );
    c.set({
      defined: "known property",
      extra: { anything: "goes" },
    });

    const schema = {
      type: "object",
      properties: {
        defined: { type: "string" },
      },
      additionalProperties: {
        type: "object",
        properties: { anything: { asCell: true } },
      },
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);

    // Test defined property
    const definedCell = cell.key("defined");
    expect(definedCell.get()).toBe("known property");

    // Test additional property with a schema that generates a reference
    const extraCell = cell.key("extra");
    const extraValue = extraCell.get();
    expect(isCell(extraValue.anything)).toBe(true);
  });

  it("should partially update object values using update method", () => {
    const c = runtime.getCell<{
      name: string;
      age: number;
      tags: string[];
    }>(
      space,
      "should partially update object values using update method",
      undefined,
      tx,
    );
    c.set({ name: "test", age: 42, tags: ["a", "b"] });

    c.update({ age: 43, tags: ["a", "b", "c"] });
    expect(c.get()).toEqual({
      name: "test",
      age: 43,
      tags: ["a", "b", "c"],
    });

    // Should preserve unmodified fields
    c.update({ name: "updated" });
    expect(c.get()).toEqual({
      name: "updated",
      age: 43,
      tags: ["a", "b", "c"],
    });
  });

  it("should handle update when there is no previous value", () => {
    const c = runtime.getCell<
      { name: string; age: number } | undefined
    >(
      space,
      "should handle update when there is no previous value",
      undefined,
      tx,
    );
    c.set(undefined);

    c.update({ name: "test", age: 42 });
    expect(c.get()).toEqual({
      name: "test",
      age: 42,
    });

    // Should still work for subsequent updates
    c.update({ age: 43 });
    expect(c.get()).toEqual({
      name: "test",
      age: 43,
    });
  });

  it("should push values to array using push method", () => {
    const c = runtime.getCell<{ items: number[] }>(
      space,
      "push-test",
      undefined,
      tx,
    );
    c.set({ items: [1, 2, 3] });
    const arrayCell = c.key("items");
    expect(arrayCell.get()).toEqual([1, 2, 3]);
    arrayCell.push(4);
    expect(arrayCell.get()).toEqual([1, 2, 3, 4]);

    arrayCell.push(5);
    expect(arrayCell.get()).toEqual([1, 2, 3, 4, 5]);
  });

  it("should throw when pushing values to `null`", () => {
    const c = runtime.getCell<{ items: null }>(
      space,
      "push-to-null",
      undefined,
      tx,
    );
    c.set({ items: null });
    const arrayCell = c.key("items");
    expect(arrayCell.get()).toBeNull();

    // @ts-ignore - types correctly disallowed pushing to non-array
    expect(() => arrayCell.push(1)).toThrow();
  });

  it("should push values to undefined array with schema default", () => {
    const schema = {
      type: "array",
      default: [10, 20],
    } as const satisfies JSONSchema;

    const c = runtime.getCell<{ items?: number[] }>(
      space,
      "push-to-undefined-schema",
      undefined,
      tx,
    );
    c.set({});
    const arrayCell = c.key("items").asSchema(schema);

    arrayCell.push(30);
    expect(arrayCell.get()).toEqualIgnoringSymbols([10, 20, 30]);

    arrayCell.push(40);
    expect(arrayCell.get()).toEqualIgnoringSymbols([10, 20, 30, 40]);
  });

  it("should push values to undefined array with reused IDs", () => {
    const c = runtime.getCell<{ items?: any[] }>(
      space,
      "push-to-undefined-schema-stable-id",
      undefined,
      tx,
    );
    c.set({});
    const arrayCell = c.key("items");

    arrayCell.push({ [ID]: "test3", "value": 30 });
    expect(arrayCell.get()).toEqualIgnoringSymbols([
      { "value": 30 },
    ]);

    arrayCell.push({ [ID]: "test3", "value": 40 });
    expect(arrayCell.get()).toEqualIgnoringSymbols([
      { "value": 40 }, // happens to overwrite, because IDs are the same
      { "value": 40 },
    ]);
  });

  it("should transparently update ids when context changes", () => {
    const testCell = runtime.getCell<any>(
      space,
      "should transparently update ids when context changes",
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            nested: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  value: { type: "number" },
                },
              },
            },
          },
        },
      } as const satisfies JSONSchema,
      tx,
    );
    testCell.set(undefined);

    const initialData = [
      {
        id: "item1",
        name: "First Item",
        nested: [{ id: "nested1", value: 1 }, { id: "nested2", value: 2 }],
      },
      {
        id: "item1",
        name: "Second Item",
        nested: [{ id: "nested1", value: 3 }, { id: "nested2", value: 4 }],
      },
    ];
    const initialDataCopy = JSON.parse(JSON.stringify(initialData));
    addCommonIDfromObjectID(initialDataCopy);

    const frame1 = pushFrame({
      generatedIdCounter: 0,
      cause: "context 1",
      opaqueRefs: new Set(),
    });
    testCell.set(initialDataCopy);
    popFrame(frame1);

    expect(isPrimitiveCellLink(testCell.getRaw()[0])).toBe(true);
    expect(isPrimitiveCellLink(testCell.getRaw()[1])).toBe(true);
    expect(testCell.get()[0].name).toEqual("First Item");
    expect(testCell.get()[1].name).toEqual("Second Item");
    expect(testCell.key("0").key("nested").key("0").key("id").get()).toEqual(
      "nested1",
    );
    expect(testCell.get()[0].nested[0].id).toEqual("nested1");
    expect(testCell.get()[0].nested[1].id).toEqual("nested2");
    expect(testCell.get()[1].nested[0].id).toEqual("nested1");
    expect(testCell.get()[1].nested[1].id).toEqual("nested2");

    const linkFromContext1 = parseLink(testCell.getRaw()[0], testCell)!;

    const returnedData = JSON.parse(JSON.stringify(testCell.get()));
    addCommonIDfromObjectID(returnedData);

    const frame2 = pushFrame({
      generatedIdCounter: 0,
      cause: "context 2",
      opaqueRefs: new Set(),
    });
    testCell.set(returnedData);
    popFrame(frame2);

    expect(isPrimitiveCellLink(testCell.getRaw()[0])).toBe(true);
    expect(isPrimitiveCellLink(testCell.getRaw()[1])).toBe(true);
    expect(testCell.get()[0].name).toEqual("First Item");
    expect(testCell.get()[1].name).toEqual("Second Item");

    // Let's make sure we got a different ids with the different context
    expect(
      areNormalizedLinksSame(
        parseLink(testCell.getRaw()[0], testCell)!,
        linkFromContext1,
      ),
    ).toBe(false);

    expect(testCell.get()).toEqualIgnoringSymbols(initialData);
  });

  it("should push values that are already cells reusing the reference", () => {
    const c = runtime.getCell<{ items: { value: number }[] }>(
      space,
      "should push values that are already cells reusing the reference",
      undefined,
      tx,
    );
    c.set({ items: [] });
    const arrayCell = c.key("items");

    const d = runtime.getCell<{ value: number }>(
      space,
      "should push values that are already cells reusing the reference d",
      undefined,
      tx,
    );
    d.set({ value: 1 });
    const dCell = d;

    arrayCell.push(d);
    arrayCell.push(dCell);
    arrayCell.push(d.getAsQueryResult());

    const rawItems = c.getRaw()?.items;
    const expectedCellLink = d.getAsNormalizedFullLink();

    expect(rawItems?.map((item) => parseLink(item, c))).toEqual([
      expectedCellLink,
      expectedCellLink,
      expectedCellLink,
    ]);
  });

  it("should handle push method on non-array values", () => {
    const c = runtime.getCell<{ value: string }>(
      space,
      "should handle push method on non-array values",
      undefined,
      tx,
    );
    c.set({ value: "not an array" });
    const cell = c.key("value");

    // @ts-ignore - types correctly disallowed pushing to non-array
    expect(() => cell.push(42)).toThrow();
  });

  it("should create new entities when pushing to array in frame, but reuse IDs", () => {
    const frame = pushFrame();
    const c = runtime.getCell<{ items: any[] }>(
      space,
      "push-with-id",
      undefined,
      tx,
    );
    c.set({ items: [] });
    const arrayCell = c.key("items");
    arrayCell.push({ value: 42 });
    expect(frame.generatedIdCounter).toEqual(1);
    arrayCell.push({ [ID]: "test", value: 43 });
    expect(frame.generatedIdCounter).toEqual(1); // No increment = no ID generated from it
    popFrame(frame);
    expect(isPrimitiveCellLink(c.getRaw()?.items[0])).toBe(true);
    expect(isPrimitiveCellLink(c.getRaw()?.items[1])).toBe(true);
    expect(arrayCell.get()).toEqualIgnoringSymbols([
      { value: 42 },
      { value: 43 },
    ]);
  });
});

describe("getAsLink method", () => {
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

  it("should return new sigil format", () => {
    const cell = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-test",
      undefined,
      tx,
    );
    cell.set({ value: 42 });

    // Get the new sigil format
    const link = cell.getAsLink();

    // Verify structure
    expect(link["/"]).toBeDefined();
    expect(link["/"][LINK_V1_TAG]).toBeDefined();
    expect(link["/"][LINK_V1_TAG].id).toBeDefined();
    expect(link["/"][LINK_V1_TAG].path).toBeDefined();

    // Verify id has of: prefix
    expect(link["/"][LINK_V1_TAG].id).toMatch(/^of:/);

    // Verify path is empty array
    expect(link["/"][LINK_V1_TAG].path).toEqual([]);

    // Verify space is included if present
    expect(link["/"][LINK_V1_TAG].space).toBe(space);
  });

  it("should return correct path for nested cells", () => {
    const c = runtime.getCell<{ nested: { value: number } }>(
      space,
      "getAsLink-nested-test",
      undefined,
      tx,
    );
    c.set({ nested: { value: 42 } });
    const nestedCell = c.key("nested").key("value");

    const link = nestedCell.getAsLink();

    expect(link["/"][LINK_V1_TAG].path).toEqual(["nested", "value"]);
  });

  it("should return sigil format for both getAsLink and toJSON", () => {
    const cell = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-json-test",
      undefined,
      tx,
    );
    cell.set({ value: 42 });

    const link = cell.getAsLink();
    const json = cell.toJSON();

    // getAsLink returns sigil format
    expect(link).toHaveProperty("/");
    expect(link["/"][LINK_V1_TAG]).toBeDefined();

    // toJSON now also returns sigil format (includes space for cross-space references)
    expect(json).toHaveProperty("/");
    expect((json as any)["/"][LINK_V1_TAG]).toBeDefined();
    expect((json as any)["/"][LINK_V1_TAG].id).toBeDefined();
    expect((json as any)["/"][LINK_V1_TAG].path).toEqual([]);
    // Verify space is included for cross-space resolution
    expect((json as any)["/"][LINK_V1_TAG].space).toEqual(space);
  });

  it("should create relative links with base parameter - same document", () => {
    const c = runtime.getCell<{ value: number; other: string }>(
      space,
      "getAsLink-base-test",
      undefined,
      tx,
    );
    c.set({ value: 42, other: "test" });
    const cell = c.key("value");

    // Link relative to base cell (same document)
    const link = cell.getAsLink({ base: c });

    // Should omit id and space since they're the same
    expect(link["/"][LINK_V1_TAG].id).toBeUndefined();
    expect(link["/"][LINK_V1_TAG].space).toBeUndefined();
    expect(link["/"][LINK_V1_TAG].path).toEqual(["value"]);
  });

  it("should create relative links with base parameter - different document", () => {
    const c1 = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-base-test-1",
      undefined,
      tx,
    );
    c1.set({ value: 42 });
    const c2 = runtime.getCell<{ other: string }>(
      space,
      "getAsLink-base-test-2",
      undefined,
      tx,
    );
    c2.set({ other: "test" });
    const cell = c1.key("value");

    // Link relative to base cell (different document, same space)
    const link = cell.getAsLink({ base: c2 });

    // Should include id but not space since space is the same
    expect(link["/"][LINK_V1_TAG].id).toBeDefined();
    expect(link["/"][LINK_V1_TAG].id).toMatch(/^of:/);
    expect(link["/"][LINK_V1_TAG].space).toBeUndefined();
    expect(link["/"][LINK_V1_TAG].path).toEqual(["value"]);
  });

  it("should create relative links with base parameter - different space", () => {
    const c1 = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-base-test-1",
      undefined,
      tx,
    );
    c1.set({ value: 42 });
    const tx2 = runtime.edit(); // We're writing into a different space!
    const c2 = runtime.getCell<{ other: string }>(
      space2,
      "getAsLink-base-test-2",
      undefined,
      tx2,
    );
    c2.set({ other: "test" });
    tx2.commit();
    const cell = c1.key("value");

    // Link relative to base cell (different space)
    const link = cell.getAsLink({ base: c2 });

    // Should include both id and space since they're different
    expect(link["/"][LINK_V1_TAG].id).toBeDefined();
    expect(link["/"][LINK_V1_TAG].id).toMatch(/^of:/);
    expect(link["/"][LINK_V1_TAG].space).toBe(space);
    expect(link["/"][LINK_V1_TAG].path).toEqual(["value"]);
  });

  it("should include schema when includeSchema is true", () => {
    const c = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-schema-test",
      undefined,
      tx,
    );
    c.set({ value: 42 });
    const schema = { type: "number", minimum: 0 } as const;
    const cell = c.key("value").asSchema(schema);

    // Link with schema included
    const link = cell.getAsLink({ includeSchema: true });

    expect(link["/"][LINK_V1_TAG].schema).toEqual(schema);
    expect(link["/"][LINK_V1_TAG].id).toBeDefined();
    expect(link["/"][LINK_V1_TAG].path).toEqual(["value"]);
  });

  it("should not include schema when includeSchema is false", () => {
    const c = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-no-schema-test",
      undefined,
      tx,
    );
    c.set({ value: 42 });
    const schema = { type: "number", minimum: 0 } as const;
    const cell = c.key("value").asSchema(schema);

    // Link without schema
    const link = cell.getAsLink({ includeSchema: false });

    expect(link["/"][LINK_V1_TAG].schema).toBeUndefined();
  });

  it("should not include schema when includeSchema is undefined", () => {
    const c = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-default-schema-test",
      undefined,
      tx,
    );
    c.set({ value: 42 });
    const cell = c.key("value");

    // Link with default options (no schema)
    const link = cell.getAsLink();

    expect(link["/"][LINK_V1_TAG].schema).toBeUndefined();
  });

  it("should handle both base and includeSchema options together", () => {
    const schema = { type: "number", minimum: 0 } as const satisfies JSONSchema;
    const c1 = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-combined-test-1",
      schema,
      tx,
    );
    c1.set({ value: 42 });
    const c2 = runtime.getCell<{ other: string }>(
      space,
      "getAsLink-combined-test-2",
      undefined,
      tx,
    );
    const cell = c1.key("value").asSchema(schema);

    // Link with both base and schema options
    const link = cell.getAsLink({ base: c2, includeSchema: true });

    // Should include id (different docs) but not space (same space)
    expect(link["/"][LINK_V1_TAG].id).toBeDefined();
    expect(link["/"][LINK_V1_TAG].space).toBeUndefined();
    expect(link["/"][LINK_V1_TAG].path).toEqual(["value"]);
    expect(link["/"][LINK_V1_TAG].schema).toEqual(schema);
  });

  it("should handle cell without schema when includeSchema is true", () => {
    const c = runtime.getCell<{ value: number }>(
      space,
      "getAsLink-no-cell-schema-test",
      undefined,
      tx,
    );
    c.set({ value: 42 });
    const cell = c.key("value"); // No schema provided

    // Link with includeSchema but cell has no schema
    const link = cell.getAsLink({ includeSchema: true });

    expect(link["/"][LINK_V1_TAG].schema).toBeUndefined();
  });
});

describe("getAsWriteRedirectLink method", () => {
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

  it("should return new sigil alias format", () => {
    const c = runtime.getCell<{ value: number }>(
      space,
      "getAsWriteRedirectLink-test",
      undefined,
      tx,
    );
    c.set({ value: 42 });
    const cell = c;

    // Get the new sigil alias format
    const alias = cell.getAsWriteRedirectLink();

    // Verify structure
    expect(alias["/"]).toBeDefined();
    expect(alias["/"][LINK_V1_TAG]).toBeDefined();
    expect(alias["/"][LINK_V1_TAG].id).toBeDefined();
    expect(alias["/"][LINK_V1_TAG].path).toBeDefined();
    expect(alias["/"][LINK_V1_TAG].overwrite).toBe("redirect");

    // Verify id has of: prefix
    expect(alias["/"][LINK_V1_TAG].id).toMatch(/^of:/);

    // Verify path is empty array
    expect(alias["/"][LINK_V1_TAG].path).toEqual([]);

    // Verify space is included if present
    expect(alias["/"][LINK_V1_TAG].space).toBe(space);
  });

  it("should return correct path for nested cells", () => {
    const c = runtime.getCell<{ nested: { value: number } }>(
      space,
      "getAsWriteRedirectLink-nested-test",
      undefined,
      tx,
    );
    c.set({ nested: { value: 42 } });
    const nestedCell = c.key("nested").key("value");

    const alias = nestedCell.getAsWriteRedirectLink();

    expect(alias["/"][LINK_V1_TAG].path).toEqual(["nested", "value"]);
  });

  it("should omit space when baseSpace matches", () => {
    const cell = runtime.getCell(
      space,
      "getAsWriteRedirectLink-baseSpace-test",
      undefined,
      tx,
    );

    // Get alias with same base space
    const alias = cell.getAsWriteRedirectLink({ baseSpace: space });

    // Should omit space
    expect(alias["/"][LINK_V1_TAG].space).toBeUndefined();
  });
});

describe("getImmutableCell", () => {
  describe("asCell", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
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

    it("should create a cell with the correct schema", () => {
      const schema = {
        type: "object",
        properties: { value: { type: "number" } },
      } as const satisfies JSONSchema;
      const cell = runtime.getImmutableCell(space, { value: 42 }, schema, tx);
      expect(cell.get()).toEqualIgnoringSymbols({ value: 42 });
    });
  });
});

describe("toCell and toOpaqueRef hooks", () => {
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

  describe("Basic hook functionality", () => {
    it("should add toCell and toOpaqueRef symbols to objects returned from Cell.get()", () => {
      const schema = {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ value: number }>(
        space,
        "hook-basic-object",
        schema,
        tx,
      );
      c.set({ value: 42 });

      const result = c.get();
      expect(toCell in result).toBe(true);
      expect(typeof (result as any)[toCell]).toBe("function");
    });

    it("should add hooks to arrays returned from Cell.get()", () => {
      const schema = {
        type: "array",
        items: { type: "number" },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<number[]>(
        space,
        "hook-basic-array",
        schema,
        tx,
      );
      c.set([1, 2, 3]);

      const result = c.get();
      expect(toCell in result).toBe(true);
    });

    it("should not add hooks to primitive values", () => {
      const numberCell = runtime.getCell<number>(
        space,
        "hook-basic-number",
        undefined,
        tx,
      );
      numberCell.set(42);
      const numberResult = numberCell.get();
      expect(toCell in Object(numberResult)).toBe(false);

      const stringCell = runtime.getCell<string>(
        space,
        "hook-basic-string",
        undefined,
        tx,
      );
      stringCell.set("hello");
      const stringResult = stringCell.get();
      expect(toCell in Object(stringResult)).toBe(false);

      const boolCell = runtime.getCell<boolean>(
        space,
        "hook-basic-bool",
        undefined,
        tx,
      );
      boolCell.set(true);
      const boolResult = boolCell.get();
      expect(toCell in Object(boolResult)).toBe(false);
    });

    it("should not add hooks to existing cells", () => {
      const innerCell = runtime.getCell<{ inner: number }>(
        space,
        "hook-basic-inner-cell",
        undefined,
        tx,
      );
      innerCell.set({ inner: 42 });

      const schema = {
        type: "object",
        properties: {
          cell: {},
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ cell: any }>(
        space,
        "hook-basic-outer-cell",
        schema,
        tx,
      );
      c.set({ cell: innerCell });

      const result = c.get();
      // The outer object gets hooks
      expect(toCell in result).toBe(true);

      // When a cell is stored in another cell, it's dereferenced to its value
      // The value itself doesn't have hooks (no schema on inner cell)
      expect(isCell(result.cell)).toBe(false);
      expect(result.cell).toEqual({ inner: 42 });
      expect(toCell in result.cell).toBe(false);
    });

    it("should not add hooks to query result proxies", () => {
      const c = runtime.getCell<{ value: number }>(
        space,
        "hook-basic-query-result",
        undefined,
        tx,
      );
      c.set({ value: 42 });

      const proxy = c.getAsQueryResult();
      expect(isCellResult(proxy)).toBe(true);
      // Query results don't have the hooks because they're proxies, not plain objects
      expect(toCell in proxy).toBe(false);
    });
  });

  describe("toCell behavior", () => {
    it("should return a cell pointing to the original data", () => {
      const schema = {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ value: number }>(
        space,
        "hook-getcelllink-basic",
        schema,
        tx,
      );
      c.set({ value: 42 });

      const result = c.get();
      const linkedCell = (result as any)[toCell]();

      expect(isCell(linkedCell)).toBe(true);
      // The linked cell returns the same result with hooks
      const linkedResult = linkedCell.get();
      // Compare just the value property, not the whole object with symbols
      expect(linkedResult.value).toBe(42);
      expect(linkedCell.equals(c)).toBe(true);
    });

    it("should return cells for nested paths", () => {
      const schema = {
        type: "object",
        properties: {
          a: {
            type: "object",
            properties: {
              b: {
                type: "object",
                properties: {
                  c: { type: "number" },
                },
              },
            },
          },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ a: { b: { c: number } } }>(
        space,
        "hook-getcelllink-nested",
        schema,
        tx,
      );
      c.set({ a: { b: { c: 42 } } });

      const nestedValue = c.key("a").key("b").get();
      const linkedCell = (nestedValue as any)[toCell]();

      expect(isCell(linkedCell)).toBe(true);
      const linkedResult = linkedCell.get();
      expect(linkedResult.c).toBe(42);
      expect(linkedCell.equals(c.key("a").key("b"))).toBe(true);
    });

    it("should allow mutations through the returned cell", () => {
      const schema = {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ value: number }>(
        space,
        "hook-getcelllink-mutation",
        schema,
        tx,
      );
      c.set({ value: 42 });

      const result = c.get();
      const linkedCell = (result as any)[toCell]();

      linkedCell.set({ value: 100 });
      const updatedResult = c.get();
      expect(updatedResult.value).toBe(100);
    });

    it("should work with array elements", () => {
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
              },
            },
          },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ items: { name: string }[] }>(
        space,
        "hook-getcelllink-array",
        schema,
        tx,
      );
      c.set({ items: [{ name: "first" }, { name: "second" }] });

      const itemValue = c.key("items").key(0).get();
      const linkedCell = (itemValue as any)[toCell]();

      expect(isCell(linkedCell)).toBe(true);
      const linkedResult = linkedCell.get();
      expect(linkedResult.name).toBe("first");

      linkedCell.set({ name: "updated" });
      const updatedItems = c.get().items;
      expect(updatedItems[0].name).toBe("updated");
    });

    it("should maintain the same link with array elements", () => {
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
              },
            },
          },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ items: { name: string }[] }>(
        space,
        "hook-getcelllink-array",
        schema,
        tx,
      );
      c.set({ items: [{ name: "first" }, { name: "second" }] });

      const itemValue = c.key("items").key(0).get();
      const itemCell = c.key("items").key(0);
      const linkedCell = (itemValue as any)[toCell]();
      expect(linkedCell.getAsNormalizedFullLink()).toEqual(
        itemCell.getAsNormalizedFullLink(),
      );

      expect(isCell(linkedCell)).toBe(true);
      const linkedResult = linkedCell.get();
      expect(linkedResult.name).toBe("first");

      linkedCell.set({ name: "updated" });
      const updatedItems = c.get().items;
      expect(updatedItems[0].name).toBe("updated");
    });
  });

  describe("Recipe integration", () => {
    it("should pass query results for recipes without argumentSchema", () => {
      const inputCell = runtime.getCell<{ value: number }>(
        space,
        "hook-recipe-no-schema",
        undefined,
        tx,
      );
      inputCell.set({ value: 42 });

      // Simulate what runner.ts does when no argumentSchema
      const argument = inputCell.getAsQueryResult([], tx);

      // Should be a proxy, not have hooks
      expect(isCellResult(argument)).toBe(true);
      expect(toCell in argument).toBe(false);
      expect(argument.value).toBe(42);
    });

    it("should pass objects with hooks for recipes with argumentSchema", () => {
      const schema = {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      } as const satisfies JSONSchema;

      const inputCell = runtime.getCell<{ value: number }>(
        space,
        "hook-recipe-with-schema",
        schema,
        tx,
      );
      inputCell.set({ value: 42 });

      // Simulate what runner.ts does with argumentSchema
      const argument = inputCell.asSchema(schema).get();

      // Should have hooks
      expect(toCell in argument).toBe(true);
      expect(argument.value).toBe(42);
    });

    it("should allow recipe code to convert back to cells", () => {
      const schema = {
        type: "object",
        properties: {
          data: { type: "string" },
        },
      } as const satisfies JSONSchema;

      const inputCell = runtime.getCell<{ data: string }>(
        space,
        "hook-recipe-convert",
        schema,
        tx,
      );
      inputCell.set({ data: "test" });

      const argument = inputCell.asSchema(schema).get();

      // Recipe code can use toCell to get back to the cell
      const cellFromHook = (argument as any)[toCell]();
      expect(isCell(cellFromHook)).toBe(true);
      const cellResult = cellFromHook.get();
      expect(cellResult.data).toBe("test");

      // Can mutate through the cell
      cellFromHook.set({ data: "updated" });
      const updatedResult = inputCell.get();
      expect(updatedResult.data).toBe("updated");
    });
  });

  describe("Schema interactions", () => {
    it("should add hooks to schema-validated results", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name", "age"],
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ name: string; age: number }>(
        space,
        "hook-schema-basic",
        schema,
        tx,
      );
      c.set({ name: "John", age: 30 });

      const result = c.get();
      expect(toCell in result).toBe(true);
    });

    it("top level defaults work for cells with undefined value", () => {
      const schema = {
        type: "object",
        properties: {
          value: { type: "number", default: 10 },
        },
        default: { value: 100 },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ value?: number }>(
        space,
        "hook-schema-default",
        schema,
        tx,
      );

      const result = c.get();
      expect(result.value).toBe(100);
      expect(toCell in result).toBe(true);
    });

    it("should add hooks to default values from schema", () => {
      const schema = {
        type: "object",
        properties: {
          value: { type: "number", default: 100 },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ value?: number }>(
        space,
        "hook-schema-default",
        schema,
        tx,
      );
      c.set({});

      const result = c.get();
      expect(result.value).toBe(100);
      expect(toCell in result).toBe(true);
    });

    it("defaults for missing properties", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string", default: "Bob" },
          address: {
            type: "object",
            properties: {
              street: { type: "string", default: "234 Street" },
              city: { type: "string", default: "Citysville" },
            },
            default: {
              street: "123 Street",
              city: "Townsville",
            },
          },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<
        { name?: string; address?: { street?: string; city?: string } }
      >(
        space,
        "hook-schema-default",
        schema,
        tx,
      );
      c.set({});

      let result = c.get();
      expect(result.name).toBe("Bob");
      expect(result.address).toEqualIgnoringSymbols({
        street: "123 Street",
        city: "Townsville",
      });

      c.set({ name: "Ted" });
      result = c.get();
      expect(result.name).toBe("Ted");
      // address missing, so we get the default for the address property
      expect(result.address).toEqualIgnoringSymbols({
        street: "123 Street",
        city: "Townsville",
      });

      c.set({ name: "Ted", address: { street: "123 Avenue" } });
      result = c.get();
      expect(result.name).toBe("Ted");
      // address present, but city missing, so we get the default for city
      expect(result.address).toEqualIgnoringSymbols({
        street: "123 Avenue",
        city: "Citysville",
      });
    });

    it("should not double-wrap asCell properties", () => {
      const schema = {
        type: "object",
        properties: {
          regular: { type: "string" },
          cellProp: {
            type: "object",
            properties: { value: { type: "number" } },
            asCell: true,
          },
        },
        required: ["regular", "cellProp"],
      } as const satisfies JSONSchema;

      const c = runtime.getCell<
        { regular: string; cellProp: { value: number } }
      >(
        space,
        "hook-schema-ascell",
        schema,
        tx,
      );
      c.set({ regular: "test", cellProp: { value: 42 } });

      const result = c.asSchema(schema).get();
      expect(toCell in result).toBe(true);

      // cellProp should be a cell, not have hooks
      expect(isCell(result.cellProp)).toBe(true);
      // Cells themselves have toOpaqueRef (part of Cell interface) but not toCell
      expect(toCell in result.cellProp).toBe(false);
    });

    it("should add hooks to additionalProperties results", () => {
      const schema = {
        type: "object",
        properties: {
          known: { type: "string" },
        },
        additionalProperties: { type: "number" },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ known: string; [key: string]: any }>(
        space,
        "hook-schema-additional",
        schema,
        tx,
      );
      c.set({ known: "test", extra1: 10, extra2: 20 });

      const result = c.asSchema(schema).get();
      expect(toCell in result).toBe(true);
      expect(result.extra1).toBe(10);
      expect(result.extra2).toBe(20);
    });

    it("should add hooks to array items", () => {
      const schema = {
        type: "array",
        items: {
          type: "object",
          properties: { value: { type: "number" } },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ value: number }[]>(
        space,
        "hook-schema-array",
        schema,
        tx,
      );
      c.set([{ value: 1 }, { value: 2 }]);

      const result = c.asSchema(schema).get();
      expect(toCell in result).toBe(true);

      // Each item should also have hooks
      expect(toCell in result[0]).toBe(true);
      expect(toCell in result[1]).toBe(true);
    });
  });

  describe("Edge cases", () => {
    it("should handle null and undefined values", () => {
      const schema = {
        type: "object",
        properties: {
          nullable: { type: ["string", "null"] },
          optional: { type: "string" },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ nullable: string | null; optional?: string }>(
        space,
        "hook-edge-null",
        schema,
        tx,
      );
      c.set({ nullable: null });

      const result = c.get();
      expect(toCell in result).toBe(true);
      expect(result.nullable).toBe(null);
      expect(result.optional).toBeUndefined();
    });

    it("should handle empty objects and arrays", () => {
      const schema = {
        type: "object",
        properties: {
          emptyObj: { type: "object" },
          emptyArr: { type: "array" },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<
        { emptyObj: Record<string, never>; emptyArr: any[] }
      >(
        space,
        "hook-edge-empty",
        schema,
        tx,
      );
      c.set({ emptyObj: {}, emptyArr: [] });

      const result = c.get();
      expect(toCell in result).toBe(true);

      // Empty objects and arrays should also have hooks
      expect(toCell in result.emptyObj).toBe(true);
      expect(toCell in result.emptyArr).toBe(true);
    });

    it("should handle deeply nested structures", () => {
      const schema = {
        type: "object",
        properties: {
          level1: {
            type: "object",
            properties: {
              level2: {
                type: "object",
                properties: {
                  level3: {
                    type: "object",
                    properties: {
                      value: { type: "number" },
                    },
                  },
                },
              },
            },
          },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<any>(
        space,
        "hook-edge-deep",
        schema,
        tx,
      );
      c.set({
        level1: {
          level2: {
            level3: {
              value: 42,
            },
          },
        },
      });

      const result = c.get();

      // Each level should have hooks
      expect(toCell in result).toBe(true);
      expect(toCell in result.level1).toBe(true);
      expect(toCell in result.level1.level2).toBe(true);
      expect(toCell in result.level1.level2.level3).toBe(true);

      // Can navigate to deep cells
      const deepCell = (result.level1.level2.level3 as any)[toCell]();
      expect(isCell(deepCell)).toBe(true);
      expect(deepCell.get().value).toBe(42);
    });

    it("should handle circular references gracefully", () => {
      const schema = {
        $ref: "#/$defs/Root",
        $defs: {
          Root: {
            type: "object",
            properties: {
              name: { type: "string" },
              self: { $ref: "#/$defs/Root" },
            },
          },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<any>(
        space,
        "hook-edge-circular",
        schema,
        tx,
      );

      const data: any = { name: "circular" };
      data.self = data;
      c.set(data);

      const result = c.get();
      expect(toCell in result).toBe(true);
      expect(result.name).toBe("circular");
      // With circular references, the self reference points back to the same data
      expect(result.self.name).toBe("circular");
      expect(result.self.self.name).toBe("circular"); // Can navigate infinitely
    });
  });
});

describe("Cell success callbacks", () => {
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

  it("should call onCommit callback after Cell.set() commits successfully", async () => {
    const cell = runtime.getCell<number>(
      space,
      "callback-set-test",
      undefined,
      tx,
    );

    let callbackCalled = false;
    let callbackTx: IExtendedStorageTransaction | undefined;

    cell.set(42, (committedTx) => {
      callbackCalled = true;
      callbackTx = committedTx;
    });

    expect(callbackCalled).toBe(false);
    await tx.commit();
    expect(callbackCalled).toBe(true);
    expect(callbackTx).toBe(tx);
    expect(cell.get()).toBe(42);
  });

  it("should call onCommit callback after Cell.send() commits successfully", async () => {
    const cell = runtime.getCell<number>(
      space,
      "callback-send-test",
      undefined,
      tx,
    );
    cell.set(10);

    let callbackCalled = false;
    let callbackTx: IExtendedStorageTransaction | undefined;

    cell.send(20, (committedTx) => {
      callbackCalled = true;
      callbackTx = committedTx;
    });

    expect(callbackCalled).toBe(false);
    await tx.commit();
    expect(callbackCalled).toBe(true);
    expect(callbackTx).toBe(tx);
    expect(cell.get()).toBe(20);
  });

  it("should handle multiple callbacks on same transaction", async () => {
    const cell1 = runtime.getCell<number>(
      space,
      "callback-multiple-1",
      undefined,
      tx,
    );
    const cell2 = runtime.getCell<number>(
      space,
      "callback-multiple-2",
      undefined,
      tx,
    );

    let callback1Called = false;
    let callback2Called = false;
    const callOrder: number[] = [];

    cell1.set(1, () => {
      callback1Called = true;
      callOrder.push(1);
    });

    cell2.set(2, () => {
      callback2Called = true;
      callOrder.push(2);
    });

    expect(callback1Called).toBe(false);
    expect(callback2Called).toBe(false);

    await tx.commit();

    expect(callback1Called).toBe(true);
    expect(callback2Called).toBe(true);
    expect(callOrder).toEqual([1, 2]);
  });

  it("should not call callback if transaction fails", () => {
    const cell = runtime.getCell<number>(
      space,
      "callback-fail-test",
      undefined,
      tx,
    );

    let callbackCalled = false;

    cell.set(42, () => {
      callbackCalled = true;
    });

    // Abort the transaction instead of committing
    tx.abort("test abort");

    expect(callbackCalled).toBe(false);
  });

  it("should handle errors in callback gracefully", async () => {
    const cell = runtime.getCell<number>(
      space,
      "callback-error-test",
      undefined,
      tx,
    );

    let callback1Called = false;
    let callback2Called = false;

    cell.set(1, () => {
      callback1Called = true;
      throw new Error("Callback error");
    });

    cell.set(2, () => {
      callback2Called = true;
    });

    await tx.commit();

    // First callback threw but second should still be called
    expect(callback1Called).toBe(true);
    expect(callback2Called).toBe(true);
  });

  it("should allow cell operations without callback", async () => {
    const cell = runtime.getCell<number>(
      space,
      "callback-optional-test",
      undefined,
      tx,
    );

    // Should work fine without callback (backward compatible)
    cell.set(42);
    await tx.commit();
    expect(cell.get()).toBe(42);
  });

  it("should call onCommit callback even when transaction commit fails", async () => {
    const cell = runtime.getCell<number>(
      space,
      "callback-commit-fail-test",
      undefined,
      tx,
    );

    let callbackCalled = false;
    let receivedTx: IExtendedStorageTransaction | undefined;

    cell.set(42, (committedTx) => {
      callbackCalled = true;
      receivedTx = committedTx;
    });

    // Cause the transaction to fail by aborting it, then commit
    tx.abort("intentional abort for test");
    await tx.commit();

    // Even though aborted, callback should still be called after commit
    expect(callbackCalled).toBe(true);
    expect(receivedTx).toBe(tx);

    // Verify the transaction actually failed
    const status = tx.status();
    expect(status.status).toBe("error");
  });

  describe("set operations with arrays", () => {
    it("should add IDs to objects when setting an array", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<{ name: string; value: number }[]>(
        space,
        "array-set-test",
        { type: "array" },
        tx,
      );

      const objects = [
        { name: "first", value: 1 },
        { name: "second", value: 2 },
      ];

      cell.set(objects);
      popFrame(frame);

      const result = cell.asSchema({
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, value: { type: "number" } },
          asCell: true,
        },
      }).get();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
      expect(isCell(result[0])).toBe(true);
      expect(isCell(result[1])).toBe(true);
      const link0 = result[0].getAsNormalizedFullLink();
      const link1 = result[1].getAsNormalizedFullLink();
      expect(link0.id).not.toBe(link1.id);
      expect(link0.path).toEqual([]);
      expect(link1.path).toEqual([]);
      expect(result[0].get().name).toBe("first");
      expect(result[1].get().name).toBe("second");
    });

    it("should preserve existing IDs when setting an array", () => {
      const initialDataCell = runtime.getCell<{ name: string; value: number }>(
        space,
        "array-set-preserve-id-test-initial",
        {
          type: "object",
          properties: { name: { type: "string" }, value: { type: "number" } },
        },
        tx,
      );
      initialDataCell.set({ name: "first", value: 1 });

      const frame = pushFrame();
      const cell = runtime.getCell<{ name: string; value: number }[]>(
        space,
        "array-set-preserve-id-test",
        { type: "array" },
        tx,
      );

      const objects = [
        initialDataCell,
        { name: "second", value: 2 },
      ];

      cell.set(objects);
      popFrame(frame);

      const result = cell.asSchema({
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, value: { type: "number" } },
          asCell: true,
        },
      }).get();
      expect(isCell(result[0])).toBe(true);
      expect(isCell(result[1])).toBe(true);
      const link0 = result[0].getAsNormalizedFullLink();
      const link1 = result[1].getAsNormalizedFullLink();
      expect(link0.id).toBe(initialDataCell.getAsNormalizedFullLink().id);
      expect(link0.id).not.toBe(link1.id);
    });
  });

  describe("push operations with default values", () => {
    it("should use default values from schema when pushing to empty array", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<{ name: string; count: number }[]>(
        space,
        "push-with-defaults-test",
        {
          type: "array",
          default: [{ name: "default", count: 0 }],
        },
        tx,
      );

      cell.push({ name: "new", count: 5 });
      popFrame(frame);

      const result = cell.get();
      expect(result.length).toBe(2);
      expect(result[0].name).toBe("default");
      expect(result[0].count).toBe(0);
      expect(result[1].name).toBe("new");
      expect(result[1].count).toBe(5);
    });

    it("should add IDs to default values from schema", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<{ name: string }[]>(
        space,
        "push-defaults-with-id-test",
        {
          type: "array",
          default: [{ name: "default1" }, { name: "default2" }],
        },
        tx,
      );

      cell.push({ name: "new" });
      popFrame(frame);

      const result = cell.asSchema({
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" } },
          asCell: true,
        },
      }).get();
      expect(result.length).toBe(3);
      expect(isCell(result[0])).toBe(true);
      expect(isCell(result[1])).toBe(true);
      expect(isCell(result[2])).toBe(true);
      const link0 = result[0].getAsNormalizedFullLink();
      const link1 = result[1].getAsNormalizedFullLink();
      const link2 = result[2].getAsNormalizedFullLink();
      expect(link0.id).not.toBe(link1.id);
      expect(link1.id).not.toBe(link2.id);
      expect(link0.id).not.toBe(link2.id);
    });

    it("should push objects with IDs even without schema defaults", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<{ value: number }[]>(
        space,
        "push-no-defaults-test",
        { type: "array" },
        tx,
      );

      cell.push({ value: 1 }, { value: 2 });
      popFrame(frame);

      const result = cell.asSchema({
        type: "array",
        items: {
          type: "object",
          properties: { value: { type: "number" } },
          asCell: true,
        },
      }).get();
      expect(result.length).toBe(2);
      expect(isCell(result[0])).toBe(true);
      expect(isCell(result[1])).toBe(true);
      const link0 = result[0].getAsNormalizedFullLink();
      const link1 = result[1].getAsNormalizedFullLink();
      expect(link0.id).not.toBe(link1.id);
    });
  });

  describe("remove and removeAll operations", () => {
    it("should remove first matching primitive from array", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<number[]>(
        space,
        "remove-primitive-test",
        { type: "array", items: { type: "number" } },
        tx,
      );

      cell.set([1, 2, 3, 2, 4]);
      cell.remove(2);
      popFrame(frame);

      const result = cell.get();
      expect(result).toEqual([1, 3, 2, 4]);
    });

    it("should remove all matching primitives from array", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<number[]>(
        space,
        "removeall-primitive-test",
        { type: "array", items: { type: "number" } },
        tx,
      );

      cell.set([1, 2, 3, 2, 4, 2]);
      cell.removeAll(2);
      popFrame(frame);

      const result = cell.get();
      expect(result).toEqual([1, 3, 4]);
    });

    it("should remove first matching object from array using link comparison", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<{ name: string }[]>(
        space,
        "remove-object-test",
        {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" } },
            asCell: true,
          },
        },
        tx,
      );

      cell.push({ name: "alice" }, { name: "bob" }, { name: "charlie" });

      // Get the cell reference for bob
      const items = cell.get();
      const bobCell = items[1];

      cell.remove(bobCell);
      popFrame(frame);

      const result = cell.asSchema({
        type: "array",
        items: { type: "object", properties: { name: { type: "string" } } },
      }).get();
      expect(result.length).toBe(2);
      expect(result[0].name).toBe("alice");
      expect(result[1].name).toBe("charlie");
    });

    it("should remove all matching objects from array using link comparison", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<{ name: string }[]>(
        space,
        "removeall-object-test",
        {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" } },
            asCell: true,
          },
        },
        tx,
      );

      cell.push({ name: "alice" }, { name: "bob" }, { name: "alice-copy" });

      // Get the cell reference for alice
      const items = cell.get();
      const aliceCell = items[0];

      // Remove all instances of alice (should only remove the first one since they're different cells)
      cell.removeAll(aliceCell);
      popFrame(frame);

      const result = cell.asSchema({
        type: "array",
        items: { type: "object", properties: { name: { type: "string" } } },
      }).get();
      expect(result.length).toBe(2);
      expect(result[0].name).toBe("bob");
      expect(result[1].name).toBe("alice-copy");
    });

    it("should do nothing when removing element not in array", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<number[]>(
        space,
        "remove-not-found-test",
        { type: "array", items: { type: "number" } },
        tx,
      );

      cell.set([1, 2, 3]);
      cell.remove(5);
      popFrame(frame);

      const result = cell.get();
      expect(result).toEqual([1, 2, 3]);
    });

    it("should do nothing when removeAll finds no matches", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<number[]>(
        space,
        "removeall-not-found-test",
        { type: "array", items: { type: "number" } },
        tx,
      );

      cell.set([1, 2, 3]);
      cell.removeAll(5);
      popFrame(frame);

      const result = cell.get();
      expect(result).toEqual([1, 2, 3]);
    });

    it("should throw error when removing from non-array", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<{ value: number }>(
        space,
        "remove-non-array-test",
        { type: "object", properties: { value: { type: "number" } } },
        tx,
      );

      cell.set({ value: 42 });

      expect(() => (cell as any).remove(42)).toThrow(
        "Can't remove from non-array value",
      );
      popFrame(frame);
    });

    it("should handle removing null from array", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<(number | null)[]>(
        space,
        "remove-null-test",
        { type: "array" },
        tx,
      );

      cell.set([1, null, 2, 3, null]);
      cell.remove(null);
      popFrame(frame);

      const result = cell.get();
      expect(result).toEqual([1, 2, 3, null]);
    });

    it("should handle removing strings from array", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<string[]>(
        space,
        "remove-string-test",
        { type: "array", items: { type: "string" } },
        tx,
      );

      cell.set(["apple", "banana", "cherry", "banana"]);
      cell.removeAll("banana");
      popFrame(frame);

      const result = cell.get();
      expect(result).toEqual(["apple", "cherry"]);
    });
  });

  describe("resolveAsCell", () => {
    it("should resolve a cell reference to the actual cell", () => {
      const innerCell = runtime.getCell<number>(
        space,
        "inner-cell",
        { type: "number" },
        tx,
      );
      innerCell.set(42);

      const outerCell = runtime.getCell<{ inner: unknown }>(
        space,
        "outer-cell",
        {
          type: "object",
          properties: {
            inner: { type: "number" },
          },
        },
        tx,
      );
      outerCell.set({ inner: innerCell });

      const resolvedCell = outerCell.key("inner").resolveAsCell();

      expect(resolvedCell.equals(innerCell)).toBe(true);
    });

    it("should resolve nested cell link similar to wish().result pattern", () => {
      // This test mimics the wish() result pattern where:
      // - A piece (targetPiece) exists with some data
      // - A wish result wraps it: { result: <link to targetPiece> }
      // - navigateTo receives wish.result which has path ["result"]
      // - We need to resolve to the actual targetPiece (path [])

      // Create the "target piece" - a cell with path []
      const targetPiece = runtime.getCell<{ title: string }>(
        space,
        "target-piece",
        { type: "object", properties: { title: { type: "string" } } },
        tx,
      );
      targetPiece.set({ title: "My Target Piece" });

      // Create the "wish result" that wraps the target piece
      // This mimics what wish() does: { result: cellToPiece }
      const wishResult = runtime.getCell<{ result: unknown }>(
        space,
        "wish-result",
        { type: "object", properties: { result: {} } },
        tx,
      );
      wishResult.set({ result: targetPiece });

      // Get the cell at path ["result"] - this is what navigateTo receives
      const resultCell = wishResult.key("result");

      // Verify the cell has non-empty path
      const link = resultCell.getAsNormalizedFullLink();
      expect(link.path.length).toBeGreaterThan(0);

      // Test: Can resolveAsCell() resolve this to the target piece?
      const resolved = resultCell.resolveAsCell();
      const resolvedLink = resolved.getAsNormalizedFullLink();

      // This is the key test: does resolveAsCell() give us path []?
      expect(resolvedLink.path.length).toBe(0);
      expect(resolved.equals(targetPiece)).toBe(true);
    });

    it("should follow chain of links to root", () => {
      // Test a chain: A.result -> B.result -> C (the final piece)
      // This tests "following links until there are no more links"

      const finalPiece = runtime.getCell<{ title: string }>(
        space,
        "final-piece",
        { type: "object", properties: { title: { type: "string" } } },
        tx,
      );
      finalPiece.set({ title: "Final Piece" });

      const middleCell = runtime.getCell<{ result: unknown }>(
        space,
        "middle-cell",
        { type: "object", properties: { result: {} } },
        tx,
      );
      middleCell.set({ result: finalPiece });

      const outerCell = runtime.getCell<{ result: unknown }>(
        space,
        "outer-cell",
        { type: "object", properties: { result: {} } },
        tx,
      );
      outerCell.set({ result: middleCell.key("result") });

      // Start from outer.result
      const startCell = outerCell.key("result");
      expect(startCell.getAsNormalizedFullLink().path.length).toBeGreaterThan(
        0,
      );

      // Test resolveAsCell
      const resolved = startCell.resolveAsCell();
      const resolvedLink = resolved.getAsNormalizedFullLink();

      // Does it resolve all the way to the final piece?
      expect(resolvedLink.path.length).toBe(0);
      expect(resolved.equals(finalPiece)).toBe(true);
    });
  });

  describe("cell.equals() instance method", () => {
    it("should return true when comparing a cell to itself", () => {
      const cell = runtime.getCell<number>(
        space,
        "self-compare",
        undefined,
        tx,
      );
      cell.set(42);
      expect(cell.equals(cell)).toBe(true);
    });

    it("should return false when comparing different cells", () => {
      const cell1 = runtime.getCell<number>(space, "cell1", undefined, tx);
      const cell2 = runtime.getCell<number>(space, "cell2", undefined, tx);
      cell1.set(42);
      cell2.set(42);
      expect(cell1.equals(cell2)).toBe(false);
    });

    it("should return true for cells pointing to the same location", () => {
      const cell1 = runtime.getCell<number>(
        space,
        "same-location",
        undefined,
        tx,
      );
      const cell2 = runtime.getCell<number>(
        space,
        "same-location",
        undefined,
        tx,
      );
      expect(cell1.equals(cell2)).toBe(true);
    });

    it("should resolve links before comparing", () => {
      const targetCell = runtime.getCell<number>(
        space,
        "target",
        undefined,
        tx,
      );
      targetCell.set(100);

      const linkingCell = runtime.getCell<number>(
        space,
        "linking",
        undefined,
        tx,
      );
      linkingCell.set(targetCell);

      // After resolving, linkingCell should equal targetCell
      expect(linkingCell.equals(targetCell)).toBe(true);
    });

    it("should handle chains of links when resolving", () => {
      const cell3 = runtime.getCell<number>(space, "final", undefined, tx);
      cell3.set(999);

      const cell2 = runtime.getCell<number>(space, "middle", undefined, tx);
      cell2.set(cell3);

      const cell1 = runtime.getCell<number>(space, "first", undefined, tx);
      cell1.set(cell2);

      // All should resolve to the same final location
      expect(cell1.equals(cell3)).toBe(true);
      expect(cell2.equals(cell3)).toBe(true);
      expect(cell1.equals(cell2)).toBe(true);
    });

    it("should return false when comparing with plain objects", () => {
      const cell = runtime.getCell<number>(space, "test", undefined, tx);
      cell.set(42);
      expect(cell.equals({ value: 42 })).toBe(false);
    });

    it("should handle null and undefined comparisons", () => {
      const cell = runtime.getCell<number>(space, "test", undefined, tx);
      expect(cell.equals(null as any)).toBe(false);
      expect(cell.equals(undefined as any)).toBe(false);
    });

    it("should work with nested cell structures", () => {
      const innerCell = runtime.getCell<number>(space, "inner", undefined, tx);
      innerCell.set(42);

      const outerCell = runtime.getCell<{ value: any }>(
        space,
        "outer",
        undefined,
        tx,
      );
      outerCell.set({ value: innerCell });

      const resolvedInner = outerCell.key("value").resolveAsCell();
      expect(resolvedInner.equals(innerCell)).toBe(true);
    });
  });

  describe("cell.equalLinks() instance method", () => {
    it("should return true when comparing a cell to itself", () => {
      const cell = runtime.getCell<number>(
        space,
        "self-compare",
        undefined,
        tx,
      );
      cell.set(42);
      expect(cell.equalLinks(cell)).toBe(true);
    });

    it("should return false when comparing different cells", () => {
      const cell1 = runtime.getCell<number>(space, "cell1-link", undefined, tx);
      const cell2 = runtime.getCell<number>(space, "cell2-link", undefined, tx);
      cell1.set(42);
      cell2.set(42);
      expect(cell1.equalLinks(cell2)).toBe(false);
    });

    it("should return true for cells pointing to the same location", () => {
      const cell1 = runtime.getCell<number>(space, "same-loc", undefined, tx);
      const cell2 = runtime.getCell<number>(space, "same-loc", undefined, tx);
      expect(cell1.equalLinks(cell2)).toBe(true);
    });

    it("should NOT resolve links before comparing", () => {
      const targetCell = runtime.getCell<number>(
        space,
        "target-link",
        undefined,
        tx,
      );
      targetCell.set(100);

      const linkingCell = runtime.getCell<number>(
        space,
        "linking-link",
        undefined,
        tx,
      );
      linkingCell.set(targetCell);

      // Without resolving, these should be different
      expect(linkingCell.equalLinks(targetCell)).toBe(false);
    });

    it("should return false when both cells link to the same target but are different cells", () => {
      const targetCell = runtime.getCell<number>(
        space,
        "shared-target",
        undefined,
        tx,
      );
      targetCell.set(42);

      const link1 = runtime.getCell<number>(space, "link-a", undefined, tx);
      link1.set(targetCell);

      const link2 = runtime.getCell<number>(space, "link-b", undefined, tx);
      link2.set(targetCell);

      // link1 and link2 are different cells, so they're not equal
      expect(link1.equalLinks(link2)).toBe(false);
    });

    it("should handle chains of links without resolving", () => {
      const cell3 = runtime.getCell<number>(
        space,
        "chain-final",
        undefined,
        tx,
      );
      cell3.set(999);

      const cell2 = runtime.getCell<number>(
        space,
        "chain-middle",
        undefined,
        tx,
      );
      cell2.set(cell3);

      const cell1 = runtime.getCell<number>(
        space,
        "chain-first",
        undefined,
        tx,
      );
      cell1.set(cell2);

      // Without resolving, these should all be different
      expect(cell1.equalLinks(cell3)).toBe(false);
      expect(cell2.equalLinks(cell3)).toBe(false);
      expect(cell1.equalLinks(cell2)).toBe(false);
    });

    it("should return false when comparing with plain objects", () => {
      const cell = runtime.getCell<number>(space, "test-link", undefined, tx);
      cell.set(42);
      expect(cell.equalLinks({ value: 42 })).toBe(false);
    });

    it("should handle null and undefined comparisons", () => {
      const cell = runtime.getCell<number>(space, "test-null", undefined, tx);
      expect(cell.equalLinks(null as any)).toBe(false);
      expect(cell.equalLinks(undefined as any)).toBe(false);
    });

    it("should distinguish between direct value and linked value", () => {
      const valueCell = runtime.getCell<number>(
        space,
        "has-value",
        undefined,
        tx,
      );
      valueCell.set(42);

      const linkCell = runtime.getCell<number>(
        space,
        "has-link",
        undefined,
        tx,
      );
      linkCell.set(valueCell);

      // One has a value, one has a link - they're different
      expect(valueCell.equalLinks(linkCell)).toBe(false);
      expect(linkCell.equalLinks(valueCell)).toBe(false);
    });
  });

  describe("equals() vs equalLinks() comparison", () => {
    it("should show difference between equals and equalLinks with single link", () => {
      const target = runtime.getCell<number>(
        space,
        "compare-target",
        undefined,
        tx,
      );
      target.set(100);

      const linker = runtime.getCell<number>(
        space,
        "compare-linker",
        undefined,
        tx,
      );
      linker.set(target);

      // equals resolves, so they're equal
      expect(linker.equals(target)).toBe(true);
      // equalLinks doesn't resolve, so they're different
      expect(linker.equalLinks(target)).toBe(false);
    });

    it("should show difference with link chains", () => {
      const final = runtime.getCell<number>(space, "chain-end", undefined, tx);
      final.set(42);

      const middle = runtime.getCell<number>(space, "chain-mid", undefined, tx);
      middle.set(final);

      const start = runtime.getCell<number>(
        space,
        "chain-start",
        undefined,
        tx,
      );
      start.set(middle);

      // equals resolves all links
      expect(start.equals(final)).toBe(true);
      expect(middle.equals(final)).toBe(true);

      // equalLinks doesn't resolve
      expect(start.equalLinks(final)).toBe(false);
      expect(middle.equalLinks(final)).toBe(false);
    });

    it("should behave the same for cells without links", () => {
      const cell1 = runtime.getCell<number>(space, "no-link-1", undefined, tx);
      const cell2 = runtime.getCell<number>(space, "no-link-2", undefined, tx);

      cell1.set(42);
      cell2.set(42);

      // Both should return false since cells are different
      expect(cell1.equals(cell2)).toBe(false);
      expect(cell1.equalLinks(cell2)).toBe(false);
    });

    it("should behave the same for same cell references", () => {
      const cell = runtime.getCell<number>(space, "same-ref", undefined, tx);
      cell.set(42);

      // Both should return true for same reference
      expect(cell.equals(cell)).toBe(true);
      expect(cell.equalLinks(cell)).toBe(true);
    });
  });

  describe("asSchemaFromLinks", () => {
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

    it("should return schema if present on the cell", () => {
      const schema: JSONSchema = { type: "string" };
      const c = runtime.getCell(space, "cell-with-schema", schema, tx);
      const schemaCell = c.asSchemaFromLinks();
      expect(schemaCell.schema).toEqual(schema);
    });

    it("should return schema from pattern resultRef if not present on cell", () => {
      // 1. Create the target cell (no schema initially)
      const targetCell = runtime.getCell(space, "target-cell", undefined, tx);

      // 2. Create the pattern cell
      const patternCell = runtime.getCell(space, "pattern-cell", undefined, tx);

      // 3. Set patternCell as the source of targetCell
      targetCell.setSourceCell(patternCell);

      // 4. Create a link to targetCell that includes the desired schema
      const schemaWeWant: JSONSchema = {
        type: "object",
        properties: {
          output: { type: "number" },
        },
      };
      const linkWithSchema = targetCell
        .asSchema(schemaWeWant)
        .getAsLink({ includeSchema: true });

      // 5. Set patternCell's resultRef to point to targetCell using the link with schema
      patternCell.set({ resultRef: linkWithSchema });

      // 6. Verify asSchemaFromLinks picks up the schema from the resultRef link
      const schemaCell = targetCell.asSchemaFromLinks();

      expect(schemaCell.schema).toEqual(schemaWeWant);
    });

    it("should return undefined schema if neither present nor in pattern", () => {
      const c = runtime.getCell(space, "no-schema", undefined, tx);
      const schemaCell = c.asSchemaFromLinks();
      expect(schemaCell.schema).toBeUndefined();
    });
  });

  describe("pull()", () => {
    it("should return the cell value in push mode", async () => {
      const c = runtime.getCell<number>(space, "pull-test-1", undefined, tx);
      c.set(42);
      await tx.commit();
      tx = runtime.edit();

      const value = await c.pull();
      expect(value).toBe(42);
    });

    it("should wait for dependent computations in push mode", async () => {
      // Create a source cell
      const source = runtime.getCell<number>(
        space,
        "pull-source",
        undefined,
        tx,
      );
      source.set(5);
      await tx.commit();
      tx = runtime.edit();

      // Create a computation that depends on source
      const computed = runtime.getCell<number>(
        space,
        "pull-computed",
        undefined,
        tx,
      );

      const action = (actionTx: IExtendedStorageTransaction) => {
        const val = source.withTx(actionTx).get();
        computed.withTx(actionTx).set(val * 2);
      };

      // Run once to set up initial value and log reads
      const setupTx = runtime.edit();
      action(setupTx);
      const log = txToReactivityLog(setupTx);
      await setupTx.commit();

      // Subscribe the computation
      runtime.scheduler.subscribe(action, log, {});

      // Pull should wait for the computation to run
      const value = await computed.pull();
      expect(value).toBe(10);
    });

    it("should work in pull mode", async () => {
      runtime.scheduler.enablePullMode();

      // In pull mode, pull() works the same way - it registers as an effect
      // and waits for the scheduler. The key difference is that pull() ensures
      // the effect mechanism is used, which triggers pull-based execution.
      const c = runtime.getCell<number>(space, "pull-mode-cell", undefined, tx);
      c.set(42);
      await tx.commit();
      tx = runtime.edit();

      const value = await c.pull();
      expect(value).toBe(42);

      // Verify we can pull after updates
      const tx2 = runtime.edit();
      c.withTx(tx2).set(100);
      await tx2.commit();

      const value2 = await c.pull();
      expect(value2).toBe(100);

      runtime.scheduler.disablePullMode();
    });

    it("should handle multiple sequential pulls", async () => {
      const c = runtime.getCell<number>(space, "pull-multi", undefined, tx);
      c.set(1);
      await tx.commit();

      expect(await c.pull()).toBe(1);

      const tx2 = runtime.edit();
      c.withTx(tx2).set(2);
      await tx2.commit();

      expect(await c.pull()).toBe(2);

      const tx3 = runtime.edit();
      c.withTx(tx3).set(3);
      await tx3.commit();

      expect(await c.pull()).toBe(3);
    });

    it("should pull nested cell values", async () => {
      const c = runtime.getCell<{ a: { b: number } }>(
        space,
        "pull-nested",
        undefined,
        tx,
      );
      c.set({ a: { b: 99 } });
      await tx.commit();
      tx = runtime.edit();

      const nested = c.key("a").key("b");
      const value = await nested.pull();
      expect(value).toBe(99);
    });

    it("should not create a persistent effect after pull completes", async () => {
      runtime.scheduler.enablePullMode();

      // Create source and computed cells
      const source = runtime.getCell<number>(
        space,
        "pull-no-persist-source",
        undefined,
        tx,
      );
      source.set(5);
      const computed = runtime.getCell<number>(
        space,
        "pull-no-persist-computed",
        undefined,
        tx,
      );
      computed.set(0);
      await tx.commit();

      // Track how many times the computation runs
      let runCount = 0;

      // Create a computation that multiplies source by 2
      const action = (actionTx: IExtendedStorageTransaction) => {
        runCount++;
        const val = source.withTx(actionTx).get();
        computed.withTx(actionTx).set(val * 2);
      };

      // Run once to set up initial value and capture dependencies
      const setupTx = runtime.edit();
      action(setupTx);
      const log = txToReactivityLog(setupTx);
      await setupTx.commit();

      // Subscribe the computation (as a computation, NOT an effect)
      // In pull mode, computations only run when pulled by effects
      runtime.scheduler.subscribe(action, log, { isEffect: false });

      // Change source to mark the computation as dirty
      const tx1 = runtime.edit();
      source.withTx(tx1).set(6); // Change from 5 to 6 to trigger dirtiness
      await tx1.commit();

      // Reset run count after marking dirty
      runCount = 0;

      // First pull - should trigger the computation because pull() creates
      // a temporary effect that pulls dirty dependencies
      const value1 = await computed.pull();
      expect(value1).toBe(12); // 6 * 2 = 12
      const runsAfterFirstPull = runCount;
      expect(runsAfterFirstPull).toBeGreaterThan(0);

      // Now change the source AFTER pull completed
      const tx2 = runtime.edit();
      source.withTx(tx2).set(7);
      await tx2.commit();

      // Wait for any scheduled work to complete
      await runtime.scheduler.idle();

      // The computation should NOT have run again because:
      // 1. pull() cancelled its temporary effect after completing
      // 2. There are no other effects subscribed
      // 3. In pull mode, computations only run when pulled by effects
      const runsAfterSourceChange = runCount;

      // If pull() created a persistent effect, the computation would run
      // again when source changes. With correct cleanup, it should NOT run.
      expect(runsAfterSourceChange).toBe(runsAfterFirstPull);

      runtime.scheduler.disablePullMode();
    });
  });
});
