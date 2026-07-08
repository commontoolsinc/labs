#!/usr/bin/env -S deno run -A

import { assertEquals } from "@std/assert";
import app from "../../toolshed/app.ts";
import { Identity } from "@commonfabric/identity";
import { type JSONSchema, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { defer } from "@commonfabric/utils/defer";

const createRuntime = (identity: Identity, base: URL) =>
  new Runtime({
    apiUrl: base,
    storageManager: StorageManager.open({
      as: identity,
      memoryHost: new URL(base),
    }),
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

      const gotReconnectUpdate = defer<void>();
      subscriberCell.sink((value) => {
        if (value?.count === 2) {
          gotReconnectUpdate.resolve();
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

      await gotReconnectUpdate.promise;
      assertEquals(subscriberCell.get(), { count: 2 });

      await writerRuntime.dispose();
      await subscriberRuntime.dispose();
    } finally {
      await server.shutdown();
    }
  },
);
