import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { Cell } from "../src/cell.ts";

type TestProvider = {
  get(uri: string): { value: unknown; source?: { "/": string } } | undefined;
  send(
    batch: {
      uri: string;
      value: { value: unknown; source?: { "/": string }; labels?: unknown };
    }[],
  ): Promise<
    {
      ok?: Record<PropertyKey, never>;
      error?: { name?: string; message?: string };
    }
  >;
  sync(uri: string): Promise<unknown>;
};

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

    const provider = storageManager.open(space) as unknown as TestProvider;
    await provider.sync(cell.getAsNormalizedFullLink().id);
    await storageManager.synced();

    const persisted = provider.get(cell.getAsNormalizedFullLink().id);

    expect(persisted?.value).toEqual({ hello: "world" });
  });

  it("ignores legacy label side-writes on the v2 path", async () => {
    const provider = storageManager.open(space) as unknown as TestProvider;
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

  it("preserves root objects whose data is exactly a value key on provider sends", async () => {
    const provider = storageManager.open(space) as unknown as TestProvider;
    const uri = `of:memory-v2-value-only-${Date.now()}` as const;

    const result = await provider.send([{
      uri,
      value: {
        value: {
          value: "hello",
        },
      },
    }]);

    expect(result).toEqual({ ok: {} });
    expect(provider.get(uri)).toEqual({
      value: {
        value: "hello",
      },
    });
  });

  it("preserves root objects whose data includes a value key plus siblings", async () => {
    const provider = storageManager.open(space) as unknown as TestProvider;
    const uri = `of:memory-v2-value-siblings-${Date.now()}` as const;

    const result = await provider.send([{
      uri,
      value: {
        value: {
          value: "hello",
          other: "data",
        },
      },
    }]);

    expect(result).toEqual({ ok: {} });
    expect(provider.get(uri)).toEqual({
      value: {
        value: "hello",
        other: "data",
      },
    });
  });

  it("treats source-only provider sends as deletes", async () => {
    const provider = storageManager.open(space) as unknown as TestProvider;
    const uri = `of:memory-v2-source-only-${Date.now()}` as const;

    const seed = await provider.send([{
      uri,
      value: {
        value: { hello: "world" },
      },
    }]);
    expect(seed).toEqual({ ok: {} });
    expect(provider.get(uri)).toEqual({
      value: { hello: "world" },
    });

    const result = await provider.send([{
      uri,
      value: {
        value: undefined,
        source: { "/": "process:1" },
      },
    }]);

    expect(result).toEqual({ ok: {} });
    expect(provider.get(uri)).toBeUndefined();
  });
});
