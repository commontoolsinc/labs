import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { createQueryResultProxy } from "../src/query-result-proxy.ts";
import { canonicalizeBoundaryActivity } from "../src/cfc/canonical-activity.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase(
  "cfc convenience decomposition test",
);
const space = signer.did();

describe("CFC convenience read decomposition", () => {
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
    await runtime.dispose();
    await storageManager.close();
  });

  it("decomposes array length reads into a count observation", () => {
    const cell = runtime.getCell<{ items: string[] }>(
      space,
      "cfc-convenience-length",
      undefined,
      tx,
    );
    cell.set({ items: ["alpha", "beta", "gamma"] });

    const proxy = createQueryResultProxy<{ items: string[] }>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
      "skip",
    );

    expect(proxy.items.length).toBe(3);

    const reads = canonicalizeBoundaryActivity(tx.journal.activity()).reads
      .filter((read) => read.cfc?.op !== undefined);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "count"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "enumerate"),
    ).toBe(false);
    expect(
      reads.some((read) => read.path.startsWith("/items/")),
    ).toBe(false);
  });

  it("decomposes Object.keys into parent enumeration and child shape reads", () => {
    const cell = runtime.getCell<
      { error: { code: number; status: string; details: { reason: string } } }
    >(
      space,
      "cfc-convenience-object-keys",
      undefined,
      tx,
    );
    cell.set({
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        details: { reason: "scope-insufficient" },
      },
    });

    const proxy = createQueryResultProxy<
      { error: { code: number; status: string; details: { reason: string } } }
    >(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
      "skip",
    );

    expect(Object.keys(proxy.error)).toEqual(["code", "status", "details"]);

    const reads = canonicalizeBoundaryActivity(tx.journal.activity()).reads
      .filter((read) => read.cfc?.op !== undefined);
    expect(
      reads.some((read) => read.path === "/error" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/error" && read.op === "enumerate"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/error/code" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/error/code" && read.op === "value"),
    ).toBe(false);
    expect(
      reads.some((read) =>
        read.path === "/error/details" && read.op === "value"
      ),
    ).toBe(false);
  });

  it("decomposes hasOwnProperty into a child shape observation", () => {
    const cell = runtime.getCell<
      { error: { code: number; status: string; details: { reason: string } } }
    >(
      space,
      "cfc-convenience-has-own-property",
      undefined,
      tx,
    );
    cell.set({
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        details: { reason: "scope-insufficient" },
      },
    });

    const proxy = createQueryResultProxy<
      { error: { code: number; status: string; details: { reason: string } } }
    >(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
      "skip",
    );

    const hasOwn = Reflect.get(
      proxy.error as object,
      "hasOwnProperty",
    ) as (key: string) => boolean;
    expect(hasOwn("code")).toBe(true);

    const reads = canonicalizeBoundaryActivity(tx.journal.activity()).reads
      .filter((read) => read.cfc?.op !== undefined);
    expect(
      reads.some((read) => read.path === "/error" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/error" && read.op === "enumerate"),
    ).toBe(false);
    expect(
      reads.some((read) => read.path === "/error/code" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/error/code" && read.op === "value"),
    ).toBe(false);
  });

  it("decomposes Object.hasOwn into a child shape observation", () => {
    const cell = runtime.getCell<
      { error: { code: number; status: string; details: { reason: string } } }
    >(
      space,
      "cfc-convenience-object-has-own",
      undefined,
      tx,
    );
    cell.set({
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        details: { reason: "scope-insufficient" },
      },
    });

    const proxy = createQueryResultProxy<
      { error: { code: number; status: string; details: { reason: string } } }
    >(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
      "skip",
    );

    expect(Object.hasOwn(proxy.error, "code")).toBe(true);

    const reads = canonicalizeBoundaryActivity(tx.journal.activity()).reads
      .filter((read) => read.cfc?.op !== undefined);
    expect(
      reads.some((read) => read.path === "/error" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/error" && read.op === "enumerate"),
    ).toBe(false);
    expect(
      reads.some((read) => read.path === "/error/code" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/error/code" && read.op === "value"),
    ).toBe(false);
  });

  it("decomposes propertyIsEnumerable into a child shape observation", () => {
    const cell = runtime.getCell<
      { error: { code: number; status: string; details: { reason: string } } }
    >(
      space,
      "cfc-convenience-property-is-enumerable",
      undefined,
      tx,
    );
    cell.set({
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        details: { reason: "scope-insufficient" },
      },
    });

    const proxy = createQueryResultProxy<
      { error: { code: number; status: string; details: { reason: string } } }
    >(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
      "skip",
    );

    const propertyIsEnumerable = Reflect.get(
      proxy.error as object,
      "propertyIsEnumerable",
    ) as (key: string) => boolean;
    expect(propertyIsEnumerable("code")).toBe(true);

    const reads = canonicalizeBoundaryActivity(tx.journal.activity()).reads
      .filter((read) => read.cfc?.op !== undefined);
    expect(
      reads.some((read) => read.path === "/error" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/error" && read.op === "enumerate"),
    ).toBe(false);
    expect(
      reads.some((read) => read.path === "/error/code" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/error/code" && read.op === "value"),
    ).toBe(false);
  });

  it("decomposes Array.from(proxy.keys()) into structural observations plus child shape", () => {
    const cell = runtime.getCell<{ items: number[] }>(
      space,
      "cfc-convenience-array-keys",
      undefined,
      tx,
    );
    cell.set({ items: [10, 20, 30] });

    const proxy = createQueryResultProxy<{ items: number[] }>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
      "skip",
    );

    expect(Array.from(proxy.items.keys())).toEqual([0, 1, 2]);

    const reads = canonicalizeBoundaryActivity(tx.journal.activity()).reads
      .filter((read) => read.cfc?.op !== undefined);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "enumerate"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "count"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items/0" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items/0" && read.op === "value"),
    ).toBe(false);
    expect(
      reads.some((read) => read.path === "/items/1" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items/1" && read.op === "value"),
    ).toBe(false);
  });

  it("decomposes Array.from(proxy) into structural observations plus child values", () => {
    const cell = runtime.getCell<{ items: number[] }>(
      space,
      "cfc-convenience-array-iterator",
      undefined,
      tx,
    );
    cell.set({ items: [10, 20, 30] });

    const proxy = createQueryResultProxy<{ items: number[] }>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
      "skip",
    );

    expect(Array.from(proxy.items)).toEqual([10, 20, 30]);

    const reads = canonicalizeBoundaryActivity(tx.journal.activity()).reads
      .filter((read) => read.cfc?.op !== undefined);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "enumerate"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "count"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items/0" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items/0" && read.op === "value"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items/1" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items/1" && read.op === "value"),
    ).toBe(true);
  });

  it("decomposes Array.from(proxy.values()) into structural observations plus child values", () => {
    const cell = runtime.getCell<{ items: number[] }>(
      space,
      "cfc-convenience-array-values",
      undefined,
      tx,
    );
    cell.set({ items: [10, 20, 30] });

    const proxy = createQueryResultProxy<{ items: number[] }>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
      "skip",
    );

    expect(Array.from(proxy.items.values())).toEqual([10, 20, 30]);

    const reads = canonicalizeBoundaryActivity(tx.journal.activity()).reads
      .filter((read) => read.cfc?.op !== undefined);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "enumerate"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "count"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items/0" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items/0" && read.op === "value"),
    ).toBe(true);
  });

  it("decomposes Array.from(proxy.entries()) into structural observations plus child values", () => {
    const cell = runtime.getCell<{ items: number[] }>(
      space,
      "cfc-convenience-array-entries",
      undefined,
      tx,
    );
    cell.set({ items: [10, 20, 30] });

    const proxy = createQueryResultProxy<{ items: number[] }>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
      "skip",
    );

    expect(Array.from(proxy.items.entries())).toEqual([
      [0, 10],
      [1, 20],
      [2, 30],
    ]);

    const reads = canonicalizeBoundaryActivity(tx.journal.activity()).reads
      .filter((read) => read.cfc?.op !== undefined);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "enumerate"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "count"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items/0" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items/0" && read.op === "value"),
    ).toBe(true);
  });

  it("decomposes slice into structural observations plus selected child values", () => {
    const cell = runtime.getCell<{ items: number[] }>(
      space,
      "cfc-convenience-array-slice",
      undefined,
      tx,
    );
    cell.set({ items: [10, 20, 30] });

    const proxy = createQueryResultProxy<{ items: number[] }>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
      "skip",
    );

    expect(proxy.items.slice(0, 2)).toEqual([10, 20]);

    const reads = canonicalizeBoundaryActivity(tx.journal.activity()).reads
      .filter((read) => read.cfc?.op !== undefined);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "enumerate"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "count"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items/0" && read.op === "value"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items/1" && read.op === "value"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items/2" && read.op !== undefined),
    ).toBe(false);
  });

  it("decomposes some into structural observations plus visited child values", () => {
    const cell = runtime.getCell<{ items: number[] }>(
      space,
      "cfc-convenience-array-some",
      undefined,
      tx,
    );
    cell.set({ items: [10, 20, 30] });

    const proxy = createQueryResultProxy<{ items: number[] }>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
      "skip",
    );

    expect(proxy.items.some((value) => value >= 20)).toBe(true);

    const reads = canonicalizeBoundaryActivity(tx.journal.activity()).reads
      .filter((read) => read.cfc?.op !== undefined);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "enumerate"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "count"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items/0" && read.op === "value"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items/1" && read.op === "value"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items/2" && read.op !== undefined),
    ).toBe(false);
  });

  it("decomposes includes into structural observations plus visited child values", () => {
    const cell = runtime.getCell<{ items: number[] }>(
      space,
      "cfc-convenience-array-includes",
      undefined,
      tx,
    );
    cell.set({ items: [10, 20, 30] });

    const proxy = createQueryResultProxy<{ items: number[] }>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
      "skip",
    );

    expect(proxy.items.includes(20)).toBe(true);

    const reads = canonicalizeBoundaryActivity(tx.journal.activity()).reads
      .filter((read) => read.cfc?.op !== undefined);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "enumerate"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "count"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items/0" && read.op === "value"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items/1" && read.op === "value"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/items/2" && read.op !== undefined),
    ).toBe(false);
  });
});
