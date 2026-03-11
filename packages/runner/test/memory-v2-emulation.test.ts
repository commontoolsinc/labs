import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { Cell } from "../src/cell.ts";

const signer = await Identity.fromPassphrase("memory-v2-emulation");
const space = signer.did();

describe("Memory v2 emulation", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let cell: Cell<{ hello: string }>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      memoryVersion: "v2",
    });
    tx = runtime.edit();
    cell = runtime.getCell(space, "memory-v2-emulation-cell", undefined, tx);
  });

  afterEach(async () => {
    await tx.commit();
    await storageManager.close();
    await new Promise((resolve) => setTimeout(resolve, 1));
  });

  it("persists and reloads documents through the runtime cutover seam", async () => {
    cell.set({ hello: "world" });

    await tx.commit();
    await runtime.idle();

    const provider = storageManager.open(space);
    await provider.sync(cell.getAsNormalizedFullLink().id);
    await storageManager.synced();

    const persisted = provider.get(cell.getAsNormalizedFullLink().id);

    expect(persisted?.value).toEqual({ hello: "world" });
  });

  it("ignores legacy label side-writes on the v2 path", async () => {
    const provider = storageManager.open(space);
    const uri = `of:memory-v2-labels-${Date.now()}` as const;

    const result = await provider.send([{
      uri,
      value: {
        value: { hello: "labels" },
        labels: { classification: ["confidential"] },
      },
    }]);

    expect(result).toEqual({ ok: {} });
    expect(provider.get(uri)).toEqual({
      value: { hello: "labels" },
    });
  });
});
