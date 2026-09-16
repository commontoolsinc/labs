// A BDD suite whose first `it` rides the read-repair backstop and whose
// second `it` resets the logger counters. The guard wraps a whole `describe`
// as one `Deno.test`, so a guard that read the logger's own count would see it
// zeroed by the reset before the wrapper ran, and the ride would pass silently.
// The guard records firings in a store the reset cannot reach, so this suite
// still fails. Not a `.test.ts` file: the package task never selects it; the
// guard's pin (`test/silent-backstop-guard.test.ts`) runs it in a subprocess
// under the package preload and expects it to FAIL.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resetAllLoggerCounts } from "@commonfabric/utils/logger";
import { Identity } from "@commonfabric/identity";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { Runtime } from "../../src/runtime.ts";
import { toMemorySpaceAddress } from "../../src/link-utils.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("conflict read-repair backstop");
const space = signer.did();

const valueSchema = {
  type: "object",
  properties: { value: { type: "number" } },
} as const;

describe("a backstop firing survives a later logger reset", () => {
  it("rides the read-repair backstop", async () => {
    const server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    const smA = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtimeA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smA,
    });
    const smB = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtimeB = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smB,
    });
    try {
      const txA = runtimeA.edit();
      const shared = runtimeA.getCell(space, "backstop-doc", valueSchema, txA);
      shared.set({ value: 1 });
      const address = toMemorySpaceAddress(shared.getAsNormalizedFullLink());
      const accepted = await txA.commit({ resolveAt: "verdict" });
      expect(accepted.error).toBeUndefined();

      const txB = runtimeB.edit();
      txB.read(address);
      runtimeB.getCell(space, "backstop-own-doc", valueSchema, txB).set({
        value: 2,
      });
      const refused = await txB.commit();
      expect(refused.error?.name).toBe("ConflictError");
    } finally {
      await runtimeB.dispose({ closeStorage: false });
      await runtimeA.dispose({ closeStorage: false });
      await smB.close();
      await smA.close();
      await server.close();
    }
  });

  it("resets the logger counters the guard once read", () => {
    // The old guard read `storage.v2`'s resettable count; this would erase the
    // ride above before the wrapper checked. The firing store is untouched.
    resetAllLoggerCounts();
  });
});
