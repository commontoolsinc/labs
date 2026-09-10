/// <reference path="./clock.d.ts" />

/** Verifies that concurrent array edits preserve each stored reference slot. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { getCfcReferenceProvenance } from "../src/cfc/reference-provenance.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("cfc-array-concurrency");
const space = signer.did();

describe("cfc-array-concurrency", () => {
  for (const method of ["push", "removeByValue"] as const) {
    it(`rejects stale slot metadata during ${method} and preserves acquisitions after a refreshed write`, async () => {
      const server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
      const storageA = EmulatedStorageManager.connectTo(server, { as: signer });
      const storageB = EmulatedStorageManager.connectTo(server, { as: signer });
      const a = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storageA,
        cfcFlowLabels: "persist",
      });
      const b = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storageB,
        cfcFlowLabels: "persist",
      });
      const target = (runtime: Runtime, key: string) =>
        runtime.getCell(space, key);
      const list = (runtime: Runtime) =>
        runtime.getCell(space, "list", { type: "array", items: {} });
      try {
        const seed = a.edit();
        for (const key of ["a", "b", "c"]) target(a, key).withTx(seed).set(key);
        list(a).withTx(seed).set([target(a, "a"), target(a, "b")]);
        expect((await seed.commit({ resolveAt: "verdict" })).error)
          .toBeUndefined();
        await server.flushSessions([space]);
        await storageA.synced();
        await list(b).sync();
        await list(b).pull();

        const first = a.edit();
        list(a).withTx(first).push(target(a, "c"));
        expect((await first.commit({ resolveAt: "verdict" })).error)
          .toBeUndefined();
        const stale = b.edit();
        list(b).withTx(stale)[method](target(b, "a"));
        const rejected = await stale.commit({ resolveAt: "verdict" });
        expect(rejected.error?.name).toBe("ConflictError");
        await server.flushSessions([space]);
        await clock.settle();

        const fresh = b.edit();
        list(b).withTx(fresh)[method](target(b, "a"));
        expect((await fresh.commit({ resolveAt: "verdict" })).error)
          .toBeUndefined();
        await server.flushSessions([space]);
        await storageA.synced();
        await storageB.synced();

        const read = b.edit();
        const stored = list(b).withTx(read);
        const expected = method === "push" ? ["a", "b", "c", "a"] : ["b", "c"];
        expect(stored.key("length").get()).toBe(expected.length);
        const metadata = readStoredCfcMetadata(
          read,
          stored.getAsNormalizedFullLink(),
        );
        for (const [index, key] of expected.entries()) {
          const acquired = stored.key(index).resolveAsCell();
          expect(getCfcReferenceProvenance(acquired)).toBeDefined();
          expect(acquired.getAsNormalizedFullLink().id).toBe(
            target(b, key).getAsNormalizedFullLink().id,
          );
          expect(
            metadata?.labelMap.entries.some((entry) =>
              entry.origin === "link" && entry.observes === "followRef" &&
              entry.path.join("/") === String(index)
            ),
          ).toBe(true);
        }
        read.abort();
      } finally {
        await server.flushSessions([space]);
        await a.dispose();
        await b.dispose();
        await storageA.close();
        await storageB.close();
        await server.close();
      }
    });
  }
});
