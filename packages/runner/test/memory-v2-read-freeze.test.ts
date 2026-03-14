import { assert, assertEquals, assertThrows } from "@std/assert";
import { Identity } from "@commontools/identity";
import {
  resetStorableValueConfig,
  setStorableValueConfig,
} from "@commontools/memory/storable-value";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("memory-v2-read-freeze");
const space = signer.did();
const type = "application/json" as const;

Deno.test("memory v2 raw reads freeze the returned subtree without exposing mutable state", async () => {
  setStorableValueConfig({ richStorableValues: true });
  const storage = StorageManager.emulate({
    as: signer,
    memoryVersion: "v2",
  });

  try {
    const tx = storage.edit();
    const writeResult = tx.write({
      space,
      id: "of:memory-v2-read-freeze",
      type,
      path: [],
    }, {
      value: {
        profile: { name: "Ada", title: "Dr" },
        stats: { visits: 3 },
      },
    });
    assert(writeResult.ok);

    const profile = tx.read({
      space,
      id: "of:memory-v2-read-freeze",
      type,
      path: ["value", "profile"],
    }).ok?.value as { name: string; title: string } | undefined;
    assert(profile);
    assert(Object.isFrozen(profile));
    assertThrows(() => {
      profile.name = "Grace";
    }, TypeError);

    const full = tx.read({
      space,
      id: "of:memory-v2-read-freeze",
      type,
      path: ["value"],
    }).ok?.value as
      | {
        profile: { name: string; title: string };
        stats: { visits: number };
      }
      | undefined;
    assert(full);
    assert(Object.isFrozen(full));
    assert(Object.isFrozen(full.profile));
    assertEquals(full.profile.name, "Ada");
    assertEquals(full.stats.visits, 3);
  } finally {
    await storage.close();
    resetStorableValueConfig();
  }
});
