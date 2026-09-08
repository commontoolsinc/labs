import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";

import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase(
  "editWithRetry conflict aggregation test",
);
const space = signer.did();

const valueSchema = {
  type: "object",
  properties: { value: { type: "number" } },
} as const;

describe("editWithRetry conflict aggregation", () => {
  it("repairs every stale confirmed read after one rejected commit", async () => {
    const server = newSharedServer();
    const writerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
    let readerStorage: EmulatedStorageManager | undefined;
    let reader: Runtime | undefined;
    try {
      const seed = writer.edit();
      const staleA = writer.getCell(
        space,
        "aggregated-stale-a",
        valueSchema,
        seed,
      );
      const staleB = writer.getCell(
        space,
        "aggregated-stale-b",
        valueSchema,
        seed,
      );
      staleA.set({ value: 41 });
      staleB.set({ value: 42 });
      const staleIds = [
        staleA.getAsNormalizedFullLink().id,
        staleB.getAsNormalizedFullLink().id,
      ];
      expect((await seed.commit()).error).toBeUndefined();
      await writerStorage.synced();

      readerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
      reader = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: readerStorage,
      });
      const rejections: string[][] = [];
      const awaitReadiness = reader.awaitCommitRetryReadiness.bind(reader);
      reader.awaitCommitRetryReadiness = (error, teardownSignal) => {
        const conflicts = (error as {
          conflicts?: Array<{ of?: unknown }>;
        }).conflicts ?? [];
        rejections.push(
          conflicts.flatMap(({ of }) => typeof of === "string" ? [of] : []),
        );
        return awaitReadiness(error, teardownSignal);
      };

      let runs = 0;
      let observed: Array<{ value?: number } | undefined> = [];
      const result = await reader.editWithRetry((tx) => {
        runs++;
        observed = [
          reader!.getCell(space, "aggregated-stale-a", valueSchema, tx).get(),
          reader!.getCell(space, "aggregated-stale-b", valueSchema, tx).get(),
        ];
        reader!.getCell(space, "aggregated-stale-result", valueSchema, tx)
          .set({ value: runs });
      }, 1);

      expect(result.error).toBeUndefined();
      expect(runs).toBe(2);
      expect(observed).toEqual([{ value: 41 }, { value: 42 }]);
      expect(rejections).toEqual([staleIds]);
    } finally {
      await reader?.dispose();
      await writer.dispose();
      await readerStorage?.close();
      await writerStorage.close();
      await server.close();
    }
  });
});
