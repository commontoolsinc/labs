/**
 * Tests for the frozen proxy target fix in `query-result-proxy.ts`.
 *
 * When `modernDataModel` is enabled, stored objects are deep-frozen at
 * commit time. After commit, reads in a new transaction return direct
 * references to these frozen objects. The proxy creation function must still
 * wrap them (using an unfrozen stub as the proxy target) so that link
 * resolution and all proxy traps work correctly.
 *
 * These tests simulate the frozen state by deep-freezing values before writing
 * them to the transaction. This is equivalent to what happens after a commit
 * with modernDataModel enabled, without requiring multi-transaction setups
 * that trigger background sync operations.
 */
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createQueryResultProxy } from "../src/query-result-proxy.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import { deepFreeze } from "@commontools/data-model/deep-freeze";

const signer = await Identity.fromPassphrase("test frozen proxy");
const space = signer.did();

/**
 * Helper: write a deep-frozen value into a cell via the transaction, then
 * return a NormalizedFullLink for reading it back through the proxy.
 *
 * This simulates the state of data after a commit with modernDataModel
 * enabled: the value in the transaction's working copy is deep-frozen.
 */
function writeFrozenCell(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  cellName: string,
  value: unknown,
): NormalizedFullLink {
  const cell = runtime.getCell(space, cellName, undefined, tx);
  const link = cell.getAsNormalizedFullLink();
  // Write the value deep-frozen, simulating post-commit heap state.
  tx.writeValueOrThrow(link, deepFreeze(value) as any);
  return link;
}

describe("frozen proxy target: link resolution through frozen objects", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: {
        modernDataModel: true,
        modernHash: true,
      },
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("resolves sigil links inside a frozen stored object (regression)", () => {
    // Set up a target cell with a value to be linked to.
    const targetCell = runtime.getCell<{ answer: number }>(
      space,
      "frozen-link-target",
      undefined,
      tx,
    );
    targetCell.set({ answer: 42 });

    // Set up a cell whose value contains a sigil link to the target.
    // Write it deep-frozen to simulate post-commit state with modernDataModel.
    const sourceLink = writeFrozenCell(
      runtime,
      tx,
      "frozen-link-source",
      {
        ref: targetCell.key("answer").getAsWriteRedirectLink(),
      },
    );

    // Verify the stored value is indeed frozen (precondition).
    const rawValue = tx.readValueOrThrow(sourceLink);
    expect(Object.isFrozen(rawValue)).toBe(true);

    // The bug: createQueryResultProxy returns frozen objects raw (no proxy),
    // so link structures inside them are never resolved.
    const proxy = createQueryResultProxy<{ ref: number }>(
      runtime,
      tx,
      sourceLink,
      0,
      false,
    );

    // With the fix, the proxy should resolve the link and return 42.
    // Without the fix, proxy IS the raw frozen object and proxy.ref is the
    // unresolved sigil link structure.
    const refValue = proxy.ref;
    expect(refValue).toBe(42);
  });
});

describe("frozen proxy target: proxy wrapping and trap behavior", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: {
        modernDataModel: true,
        modernHash: true,
      },
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("wraps a deep-frozen stored object in a proxy (not returned raw)", () => {
    const link = writeFrozenCell(runtime, tx, "frozen-wrap-check", {
      a: 1,
      b: "hello",
    });

    const rawValue = tx.readValueOrThrow(link);
    expect(Object.isFrozen(rawValue)).toBe(true);

    const proxy = createQueryResultProxy<{ a: number; b: string }>(
      runtime,
      tx,
      link,
      0,
      false,
    );

    // The proxy should be an object and property access should work through
    // the get trap (returning sub-proxies or resolved values).
    expect(typeof proxy).toBe("object");
    expect(Number(proxy.a)).toBe(1);
    expect(String(proxy.b)).toBe("hello");
  });

  it("resolves nested links multiple levels deep in a frozen tree", () => {
    // Create a target cell.
    const innerCell = runtime.getCell<{ deep: string }>(
      space,
      "frozen-nested-target",
      undefined,
      tx,
    );
    innerCell.set({ deep: "found it" });

    // Create a cell with nested structure containing a link.
    const outerLink = writeFrozenCell(
      runtime,
      tx,
      "frozen-nested-source",
      {
        level1: {
          level2: {
            link: innerCell.key("deep").getAsWriteRedirectLink(),
          },
        },
      },
    );

    const proxy = createQueryResultProxy<any>(
      runtime,
      tx,
      outerLink,
      0,
      false,
    );

    expect(String(proxy.level1.level2.link)).toBe("found it");
  });

  it("iterates frozen arrays via Symbol.iterator with link resolution", () => {
    // Create target cells for each array element to link to.
    const cell1 = runtime.getCell<number>(
      space,
      "arr-target-1",
      undefined,
      tx,
    );
    cell1.set(10 as any);
    const cell2 = runtime.getCell<number>(
      space,
      "arr-target-2",
      undefined,
      tx,
    );
    cell2.set(20 as any);

    // Write frozen array of links.
    const arrLink = writeFrozenCell(
      runtime,
      tx,
      "frozen-array-iter",
      [
        cell1.getAsWriteRedirectLink(),
        cell2.getAsWriteRedirectLink(),
      ],
    );

    const proxy = createQueryResultProxy<number[]>(
      runtime,
      tx,
      arrLink,
      0,
      false,
    );

    // Iterate via for...of (uses Symbol.iterator).
    const values: number[] = [];
    for (const item of proxy) {
      values.push(Number(item));
    }
    expect(values).toEqual([10, 20]);
  });

  it("Array.isArray returns true for proxied frozen arrays", () => {
    const link = writeFrozenCell(
      runtime,
      tx,
      "frozen-array-isarray",
      [1, 2, 3],
    );

    const rawValue = tx.readValueOrThrow(link);
    expect(Object.isFrozen(rawValue)).toBe(true);
    expect(Array.isArray(rawValue)).toBe(true);

    const proxy = createQueryResultProxy<number[]>(
      runtime,
      tx,
      link,
      0,
      false,
    );

    expect(Array.isArray(proxy)).toBe(true);
  });

  it("returns the same proxy instance for the same frozen value (cache hit)", () => {
    const link = writeFrozenCell(runtime, tx, "frozen-cache-check", {
      x: 99,
    });

    const proxy1 = createQueryResultProxy<{ x: number }>(
      runtime,
      tx,
      link,
      0,
      false,
    );
    const proxy2 = createQueryResultProxy<{ x: number }>(
      runtime,
      tx,
      link,
      0,
      false,
    );

    // Cache should return the same proxy object.
    expect(proxy1).toBe(proxy2);
  });

  it("Object.keys returns correct keys for a proxied frozen object", () => {
    const link = writeFrozenCell(runtime, tx, "frozen-ownkeys", {
      name: "Alice",
      age: 30,
    });

    const proxy = createQueryResultProxy<{ name: string; age: number }>(
      runtime,
      tx,
      link,
      0,
      false,
    );

    const keys = Object.keys(proxy);
    expect(keys).toContain("name");
    expect(keys).toContain("age");
    expect(keys.length).toBe(2);
  });

  it("'in' operator works correctly for proxied frozen objects", () => {
    const link = writeFrozenCell(runtime, tx, "frozen-has-trap", {
      present: true,
    });

    const proxy = createQueryResultProxy<{ present: boolean }>(
      runtime,
      tx,
      link,
      0,
      false,
    );

    expect("present" in proxy).toBe(true);
    expect("missing" in proxy).toBe(false);
  });

  it("spread operator works on proxied frozen objects", () => {
    const link = writeFrozenCell(runtime, tx, "frozen-spread", {
      a: 1,
      b: 2,
    });

    const proxy = createQueryResultProxy<{ a: number; b: number }>(
      runtime,
      tx,
      link,
      0,
      false,
    );

    const spread = { ...proxy };
    expect(Object.keys(spread)).toContain("a");
    expect(Object.keys(spread)).toContain("b");
    expect(Number(spread.a)).toBe(1);
    expect(Number(spread.b)).toBe(2);
  });

  it("frozen array spread yields proxied elements", () => {
    const link = writeFrozenCell(runtime, tx, "frozen-array-spread", [
      10,
      20,
      30,
    ]);

    const proxy = createQueryResultProxy<number[]>(
      runtime,
      tx,
      link,
      0,
      false,
    );

    const spread = [...proxy];
    expect(spread.length).toBe(3);
    expect(Number(spread[0])).toBe(10);
    expect(Number(spread[1])).toBe(20);
    expect(Number(spread[2])).toBe(30);
  });

  it("mixed frozen/unfrozen siblings both resolve correctly", () => {
    // Create a target cell for links.
    const targetCell = runtime.getCell<string>(
      space,
      "mixed-link-target",
      undefined,
      tx,
    );
    targetCell.set("resolved" as any);

    // Write a frozen object with a link in the "kept" branch.
    writeFrozenCell(
      runtime,
      tx,
      "mixed-freeze-state",
      {
        kept: { link: targetCell.getAsWriteRedirectLink() },
        changed: { link: targetCell.getAsWriteRedirectLink() },
      },
    );

    // Now overwrite the "changed" branch with an unfrozen direct value.
    // This simulates structural sharing after a write: "kept" stays frozen,
    // "changed" is a new unfrozen object.
    const cell = runtime.getCell<any>(
      space,
      "mixed-freeze-state",
      undefined,
      tx,
    );
    const link = cell.getAsNormalizedFullLink();
    tx.writeValueOrThrow(
      { ...link, path: [...link.path, "changed"] },
      { value: "direct" },
    );

    const proxy = createQueryResultProxy<any>(
      runtime,
      tx,
      link,
      0,
      false,
    );

    // "kept" sibling is still frozen; its link should resolve.
    expect(String(proxy.kept.link)).toBe("resolved");
    // "changed" sibling was rewritten and should return the direct value.
    expect(String(proxy.changed.value)).toBe("direct");
  });
});

describe("frozen proxy target: legacy behavior with modernDataModel OFF", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // No experimental flags -- modernDataModel defaults to false.
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

  it("returns frozen objects raw when modernDataModel is OFF", () => {
    const link = writeFrozenCell(runtime, tx, "legacy-frozen-raw", {
      a: 1,
      b: 2,
    });

    const rawValue = tx.readValueOrThrow(link);
    expect(Object.isFrozen(rawValue)).toBe(true);

    const result = createQueryResultProxy<{ a: number; b: number }>(
      runtime,
      tx,
      link,
      0,
      false,
    );

    // With modernDataModel OFF, frozen objects should be returned as-is
    // (the original "frozen = terminal" behavior).
    expect(result).toBe(rawValue);
  });
});
