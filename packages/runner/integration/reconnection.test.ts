#!/usr/bin/env -S deno run -A

import { assertEquals } from "@std/assert";
import app from "../../toolshed/app.ts";
import { Identity } from "@commontools/identity";
import { Runtime, type JSONSchema } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

const waitFor = async (
  predicate: () => boolean,
  timeout = 5000,
): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const createRuntime = (identity: Identity, base: URL) =>
  new Runtime({
    apiUrl: base,
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", base),
      memoryVersion: "v2",
    }),
    memoryVersion: "v2",
  });

Deno.test(
  "memory v2 runtime re-establishes subscriptions after server restart",
  async () => {
    const identity = await Identity.fromPassphrase(
      `runner-memory-v2-reconnect-${Date.now()}`,
    );
    let server = Deno.serve({ port: 0 }, app.fetch);
    const port = server.addr.port;
    const base = new URL(`http://${server.addr.hostname}:${port}`);
    const space = identity.did();

    const counterSchema = {
      type: "object",
      properties: {
        count: { type: "number" },
      },
      required: ["count"],
    } as const satisfies JSONSchema;

    try {
      const runtime1 = createRuntime(identity, base);
      let tx = runtime1.edit();
      const counterCell = runtime1.getCell(
        space,
        "runner-v2-reconnect-counter",
        counterSchema,
        tx,
      );
      counterCell.set({ count: 1 });
      await tx.commit();
      await runtime1.storageManager.synced();
      await runtime1.dispose();

      const subscriberRuntime = createRuntime(identity, base);
      const subscriberCell = subscriberRuntime.getCell(
        space,
        "runner-v2-reconnect-counter",
        counterSchema,
      );
      await subscriberCell.sync();
      await subscriberRuntime.storageManager.synced();
      assertEquals(subscriberCell.get(), { count: 1 });

      let sawReconnectUpdate = false;
      subscriberCell.sink((value) => {
        if (value?.count === 2) {
          sawReconnectUpdate = true;
        }
      });

      await server.shutdown();
      server = Deno.serve({ port }, app.fetch);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const writerRuntime = createRuntime(identity, base);
      const writerCell = writerRuntime.getCell(
        space,
        "runner-v2-reconnect-counter",
        counterSchema,
      );
      await writerCell.sync();
      tx = writerRuntime.edit();
      writerCell.withTx(tx).set({ count: 2 });
      await tx.commit();
      await writerRuntime.storageManager.synced();

      await waitFor(() => sawReconnectUpdate);
      assertEquals(subscriberCell.get(), { count: 2 });

      await writerRuntime.dispose();
      await subscriberRuntime.dispose();
    } finally {
      await server.shutdown();
    }
  },
);
