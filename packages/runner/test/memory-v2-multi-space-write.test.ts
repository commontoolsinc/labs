import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";

const signerA = await Identity.fromPassphrase("multi-space-write-a");
const signerB = await Identity.fromPassphrase("multi-space-write-b");
const spaceA = signerA.did();
const spaceB = signerB.did();

const addr = (space: MemorySpace, id: `${string}:${string}`) => ({
  space,
  scope: "space" as const,
  id,
  path: [] as string[],
});

describe("multi-space write transactions", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signerA });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL("http://localhost:8000"),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("rejects a write to a second space by default", () => {
    const tx = runtime.edit();
    tx.writeValueOrThrow(addr(spaceA, "of:default-a"), { v: 1 });
    expect(() => tx.writeValueOrThrow(addr(spaceB, "of:default-b"), { v: 2 }))
      .toThrow();
  });

  it("writes and commits to multiple spaces when opted in", async () => {
    const tx = runtime.edit();
    tx.enableMultiSpaceWrites?.();
    tx.writeValueOrThrow(addr(spaceA, "of:multi-a"), { v: 1 });
    tx.writeValueOrThrow(addr(spaceB, "of:multi-b"), { v: 2 });

    // read-your-writes works across both spaces within the same transaction
    expect(tx.readValueOrThrow(addr(spaceA, "of:multi-a"))).toEqual({ v: 1 });
    expect(tx.readValueOrThrow(addr(spaceB, "of:multi-b"))).toEqual({ v: 2 });

    const result = await tx.commit();
    expect(result.error).toBeUndefined();

    // both spaces are durable in a fresh transaction
    const verify = runtime.edit();
    expect(verify.readValueOrThrow(addr(spaceA, "of:multi-a"))).toEqual({
      v: 1,
    });
    expect(verify.readValueOrThrow(addr(spaceB, "of:multi-b"))).toEqual({
      v: 2,
    });
  });

  it("commits each written space with an explicit order", async () => {
    const tx = runtime.edit();
    tx.enableMultiSpaceWrites?.([spaceB, spaceA]);
    tx.writeValueOrThrow(addr(spaceA, "of:order-a"), { v: 10 });
    tx.writeValueOrThrow(addr(spaceB, "of:order-b"), { v: 20 });

    const result = await tx.commit();
    expect(result.error).toBeUndefined();

    const verify = runtime.edit();
    expect(verify.readValueOrThrow(addr(spaceA, "of:order-a"))).toEqual({
      v: 10,
    });
    expect(verify.readValueOrThrow(addr(spaceB, "of:order-b"))).toEqual({
      v: 20,
    });
  });

  it("still single-space commits when opted in but only one space written", async () => {
    const tx = runtime.edit();
    tx.enableMultiSpaceWrites?.();
    tx.writeValueOrThrow(addr(spaceA, "of:single"), { v: 7 });

    const result = await tx.commit();
    expect(result.error).toBeUndefined();

    const verify = runtime.edit();
    expect(verify.readValueOrThrow(addr(spaceA, "of:single"))).toEqual({
      v: 7,
    });
  });
});
