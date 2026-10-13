import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";

import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase("cfc-prepared-digest-records");
const space = signer.did();

describe("extended-storage-transaction", () => {
  describe("buildPreparedDigestInput()", () => {
    // A commit's digest input is rebuilt after every activity the
    // transaction journals, and a boundary pass journals some of its own, so
    // the records already built are what a rebuild hands out: the same
    // objects, so the hash cache keyed by their identity answers for them.

    let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
    let runtime: Runtime | undefined;

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
      runtime = undefined;
      storageManager = undefined;
    });

    const address = (id: string) => ({
      space,
      scope: "space" as const,
      id: `of:${id}` as URI,
      path: [] as string[],
    });

    it("hands out the records it built before for the activity it saw before", () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const tx = runtime.edit() as ExtendedStorageTransaction;
      try {
        tx.readOrThrow({ ...address("read-a"), path: ["value"] });
        tx.writeValueOrThrow(address("written-a"), { n: 1 });
        const first = tx.accessForTestingOnly.buildPreparedDigestInput();
        expect(first.consumedReads).toHaveLength(1);
        expect(first.writes).toHaveLength(1);
        expect(first.writeAttemptLog).toHaveLength(1);

        tx.readOrThrow({ ...address("read-b"), path: ["value"] });
        tx.writeValueOrThrow(address("written-b"), { n: 2 });
        const second = tx.accessForTestingOnly.buildPreparedDigestInput();
        expect(second.consumedReads).toHaveLength(2);
        expect(second.consumedReads[0]).toBe(first.consumedReads[0]);
        expect(second.writes).toHaveLength(2);
        expect(second.writes).toContain(first.writes[0]);
        expect(second.writeAttemptLog).toHaveLength(2);
        expect(second.writeAttemptLog[0]).toBe(first.writeAttemptLog[0]);
        expect(second.consumedReads[1].journalIndex).toBeGreaterThan(
          second.consumedReads[0].journalIndex!,
        );
        expect(Object.isFrozen(second.consumedReads[1])).toBe(true);
      } finally {
        tx.abort();
      }
    });
  });
});
