/**
 * Tests for CT-1240: query result proxy ownKeys / enumeration
 *
 * Verifies that Object.keys(), spread, Object.entries(), and
 * JSON.stringify work correctly on query result proxies.
 */
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Runtime } from "../src/runtime.ts";
import { createQueryResultProxy } from "../src/query-result-proxy.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { canonicalizeBoundaryActivity } from "../src/cfc/canonical-activity.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("CT-1240: query result proxy enumeration", () => {
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

  it("Object.keys() returns correct keys for a flat object", () => {
    const cell = runtime.getCell<{ a: number; b: string; c: boolean }>(
      space,
      "test-flat-keys",
      undefined,
      tx,
    );
    cell.set({ a: 1, b: "hello", c: true });

    const proxy = createQueryResultProxy<{ a: number; b: string; c: boolean }>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
    );

    const keys = Object.keys(proxy);
    expect(keys).toContain("a");
    expect(keys).toContain("b");
    expect(keys).toContain("c");
    expect(keys.length).toBe(3);
  });

  it("static descendant reads log shape/value without parent enumeration", () => {
    const cell = runtime.getCell<
      { error: { code: number; details: { reason: string } } }
    >(
      space,
      "test-static-descendant-observations",
      undefined,
      tx,
    );
    cell.set({
      error: {
        code: 403,
        details: { reason: "scope-insufficient" },
      },
    });

    const proxy = createQueryResultProxy<
      { error: { code: number; details: { reason: string } } }
    >(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
      "skip",
    );

    expect(proxy.error.code).toBe(403);

    const canonical = canonicalizeBoundaryActivity(tx.journal.activity());
    expect(
      canonical.reads.some((read) =>
        read.path === "/error" && read.op === "enumerate"
      ),
    ).toBe(false);
    expect(
      canonical.reads.some((read) =>
        read.path === "/error" && read.op === "shape"
      ),
    ).toBe(true);
    expect(
      canonical.reads.some((read) =>
        read.path === "/error/code" && read.op === "shape"
      ),
    ).toBe(true);
    expect(
      canonical.reads.some((read) =>
        read.path === "/error/code" && read.op === "value"
      ),
    ).toBe(true);
  });

  it("followRef is logged on the reference path before reading the target", () => {
    const targetCell = runtime.getCell<{ code: number; status: string }>(
      space,
      "test-followref-target",
      undefined,
      tx,
    );
    targetCell.set({
      code: 403,
      status: "PERMISSION_DENIED",
    });

    const sourceCell = runtime.getCell<{ error: typeof targetCell }>(
      space,
      "test-followref-source",
      undefined,
      tx,
    );
    sourceCell.set({ error: targetCell });

    const proxy = createQueryResultProxy<{ error: { code: number } }>(
      runtime,
      tx,
      sourceCell.getAsNormalizedFullLink(),
      0,
      false,
      "skip",
    );

    expect(proxy.error.code).toBe(403);

    const reads = canonicalizeBoundaryActivity(tx.journal.activity()).reads
      .filter((read) => read.cfc?.op !== undefined);
    const followRefIndex = reads.findIndex((read) =>
      read.id === sourceCell.getAsNormalizedFullLink().id &&
      read.path === "/error" &&
      read.op === "followRef"
    );
    const targetShapeIndex = reads.findIndex((read) =>
      read.id === targetCell.getAsNormalizedFullLink().id &&
      read.path === "/code" &&
      read.op === "shape"
    );
    const targetValueIndex = reads.findIndex((read) =>
      read.id === targetCell.getAsNormalizedFullLink().id &&
      read.path === "/code" &&
      read.op === "value"
    );

    expect(
      reads.some((read) =>
        read.id === sourceCell.getAsNormalizedFullLink().id &&
        read.path === "/error" &&
        read.op === "shape"
      ),
    ).toBe(true);
    expect(followRefIndex).toBeGreaterThanOrEqual(0);
    expect(targetShapeIndex).toBeGreaterThan(followRefIndex);
    expect(targetValueIndex).toBeGreaterThan(followRefIndex);
  });

  it("spread copies all properties with correct values", () => {
    const cell = runtime.getCell<
      { method: string; url: string; headers: { auth: string } }
    >(
      space,
      "test-spread",
      undefined,
      tx,
    );
    cell.set({
      method: "POST",
      url: "https://example.com",
      headers: { auth: "Bearer tok" },
    });

    const proxy = createQueryResultProxy<
      { method: string; url: string; headers: { auth: string } }
    >(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
    );

    const spread = { ...proxy };
    expect(Object.keys(spread)).toContain("method");
    expect(Object.keys(spread)).toContain("url");
    expect(Object.keys(spread)).toContain("headers");
    // Values from spread should be accessible
    expect(String(spread.method)).toBe("POST");
    expect(String(spread.url)).toBe("https://example.com");
  });

  it("Object.entries() returns key-value pairs", () => {
    const cell = runtime.getCell<{ x: number; y: number }>(
      space,
      "test-entries",
      undefined,
      tx,
    );
    cell.set({ x: 10, y: 20 });

    const proxy = createQueryResultProxy<{ x: number; y: number }>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
    );

    const entries = Object.entries(proxy);
    expect(entries.length).toBe(2);
    const keySet = entries.map(([k]) => k);
    expect(keySet).toContain("x");
    expect(keySet).toContain("y");
  });

  it("Object.keys() logs parent enumeration plus child shape observations", () => {
    const cell = runtime.getCell<
      { error: { code: number; status: string; details: { reason: string } } }
    >(
      space,
      "test-enumeration-observations",
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

    const canonical = canonicalizeBoundaryActivity(tx.journal.activity());
    expect(
      canonical.reads.some((read) =>
        read.path === "/error" && read.op === "enumerate"
      ),
    ).toBe(true);
    expect(
      canonical.reads.some((read) =>
        read.path === "/error/code" && read.op === "shape"
      ),
    ).toBe(true);
    expect(
      canonical.reads.some((read) =>
        read.path === "/error/status" && read.op === "shape"
      ),
    ).toBe(true);
    expect(
      canonical.reads.some((read) =>
        read.path === "/error/details" && read.op === "shape"
      ),
    ).toBe(true);
  });

  it("nested objects: spreading preserves sub-proxies", () => {
    const cell = runtime.getCell<
      { opts: { a: number; b: number }; extra: string }
    >(
      space,
      "test-nested-spread",
      undefined,
      tx,
    );
    cell.set({ opts: { a: 1, b: 2 }, extra: "hi" });

    const proxy = createQueryResultProxy<
      { opts: { a: number; b: number }; extra: string }
    >(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
    );

    const spread = { ...proxy };
    expect(Object.keys(spread)).toContain("opts");
    expect(Object.keys(spread)).toContain("extra");
    // The nested value should be accessible
    expect(Number(spread.opts.a)).toBe(1);
    expect(Number(spread.opts.b)).toBe(2);
  });

  it("JSON.stringify works on proxy", () => {
    const cell = runtime.getCell<{ name: string; count: number }>(
      space,
      "test-json-stringify",
      undefined,
      tx,
    );
    cell.set({ name: "test", count: 42 });

    const proxy = createQueryResultProxy<{ name: string; count: number }>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
    );

    const json = JSON.stringify(proxy);
    const parsed = JSON.parse(json);
    expect(parsed.name).toBe("test");
    expect(parsed.count).toBe(42);
  });

  it("array proxy: Object.keys() returns indices", () => {
    const cell = runtime.getCell<number[]>(
      space,
      "test-array-keys",
      undefined,
      tx,
    );
    cell.set([10, 20, 30]);

    const proxy = createQueryResultProxy<number[]>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
    );

    const keys = Object.keys(proxy);
    expect(keys).toContain("0");
    expect(keys).toContain("1");
    expect(keys).toContain("2");
  });

  it("array at() reads only the selected slot without parent enumeration", () => {
    const cell = runtime.getCell<number[]>(
      space,
      "test-array-at-observations",
      undefined,
      tx,
    );
    cell.set([10, 20, 30]);

    const proxy = createQueryResultProxy<number[]>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
      "skip",
    );

    expect(proxy.at(1)).toBe(20);

    const observedReads = canonicalizeBoundaryActivity(tx.journal.activity())
      .reads.filter((read) =>
        read.cfc?.op !== undefined && !read.internalVerifierRead
      );
    expect(
      observedReads.some((read) =>
        read.path === "/" && read.op === "enumerate"
      ),
    ).toBe(false);
    expect(
      observedReads.some((read) => read.path === "/" && read.op === "count"),
    ).toBe(true);
    expect(
      observedReads.some((read) => read.path === "/1" && read.op === "shape"),
    ).toBe(true);
    expect(
      observedReads.some((read) => read.path === "/1" && read.op === "value"),
    ).toBe(true);
    expect(
      observedReads.some((read) => read.path === "/0" && read.op !== undefined),
    ).toBe(false);
    expect(
      observedReads.some((read) => read.path === "/2" && read.op !== undefined),
    ).toBe(false);
  });

  it("empty object returns empty keys", () => {
    const cell = runtime.getCell<Record<string, never>>(
      space,
      "test-empty-keys",
      undefined,
      tx,
    );
    cell.set({});

    const proxy = createQueryResultProxy<Record<string, never>>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
    );

    expect(Object.keys(proxy)).toEqual([]);
  });

  it("'in' operator returns true for existing keys and false for missing keys", () => {
    const cell = runtime.getCell<{ a: number; b: string }>(
      space,
      "test-has-trap",
      undefined,
      tx,
    );
    cell.set({ a: 1, b: "hello" });

    const proxy = createQueryResultProxy<{ a: number; b: string }>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
    );

    expect("a" in proxy).toBe(true);
    expect("b" in proxy).toBe(true);
    expect("c" in proxy).toBe(false);
    expect("nonExistentKey" in proxy).toBe(false);
  });

  it("after mutation via set trap, ownKeys reflects new state", () => {
    const cell = runtime.getCell<{ a: number; b?: number }>(
      space,
      "test-mutation-keys",
      undefined,
      tx,
    );
    cell.set({ a: 1 });

    const frame = {
      cause: "test-frame-enum",
      space,
      runtime,
      tx,
      generatedIdCounter: 0,
      inHandler: true,
      opaqueRefs: new Set(),
    };
    pushFrame(frame);

    try {
      const proxy = createQueryResultProxy<Record<string, number>>(
        runtime,
        tx,
        cell.getAsNormalizedFullLink(),
        0,
        true,
      );

      expect(Object.keys(proxy)).toEqual(["a"]);

      proxy.b = 2;

      // After mutation, new key should be visible
      const keysAfter = Object.keys(proxy);
      expect(keysAfter).toContain("a");
      expect(keysAfter).toContain("b");
    } finally {
      popFrame(frame);
    }
  });
});
