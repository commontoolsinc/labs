import {
  resetDataModelConfig,
  setDataModelConfig,
} from "@commonfabric/data-model/fabric-value";
import {
  assert,
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("memory-v2-read-freeze");
const space = signer.did();
const type = "application/json" as const;

Deno.test("memory v2 raw reads freeze the returned subtree without exposing mutable state", async () => {
  setDataModelConfig(true);
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
    resetDataModelConfig();
  }
});

Deno.test("memory v2 raw reads reuse frozen snapshots until the document changes", async () => {
  setDataModelConfig(true);
  const storage = StorageManager.emulate({
    as: signer,
    memoryVersion: "v2",
  });

  try {
    const tx = storage.edit();
    const id = "of:memory-v2-read-freeze-cache";
    const initialWrite = tx.write({
      space,
      id,
      type,
      path: [],
    }, {
      value: {
        profile: { name: "Ada", title: "Dr" },
        stats: { visits: 3 },
      },
    });
    assert(initialWrite.ok);

    const first = tx.read({
      space,
      id,
      type,
      path: ["value"],
    }).ok?.value as
      | {
        profile: { name: string; title: string };
        stats: { visits: number };
      }
      | undefined;
    const second = tx.read({
      space,
      id,
      type,
      path: ["value"],
    }).ok?.value as
      | {
        profile: { name: string; title: string };
        stats: { visits: number };
      }
      | undefined;

    assert(first);
    assert(second);
    assert(Object.isFrozen(first));
    assertStrictEquals(first, second);

    const update = tx.write({
      space,
      id,
      type,
      path: ["value", "stats", "visits"],
    }, 4);
    assert(update.ok);

    const afterWrite = tx.read({
      space,
      id,
      type,
      path: ["value"],
    }).ok?.value as
      | {
        profile: { name: string; title: string };
        stats: { visits: number };
      }
      | undefined;

    assert(afterWrite);
    assertNotStrictEquals(first, afterWrite);
    assertEquals(afterWrite.stats.visits, 4);
    assert(Object.isFrozen(afterWrite));
  } finally {
    await storage.close();
    resetDataModelConfig();
  }
});

Deno.test("memory v2 raw reads keep prior frozen snapshots stable after sibling writes", async () => {
  setDataModelConfig(true);
  const storage = StorageManager.emulate({
    as: signer,
    memoryVersion: "v2",
  });

  try {
    const tx = storage.edit();
    const id = "of:memory-v2-read-freeze-sibling";
    assert(
      tx.write({
        space,
        id,
        type,
        path: [],
      }, {
        value: {
          profile: { name: "Ada" },
          stats: { visits: 1 },
        },
      }).ok,
    );

    const first = tx.read({
      space,
      id,
      type,
      path: ["value"],
    }).ok?.value as
      | {
        profile: { name: string };
        stats: { visits: number };
      }
      | undefined;
    assert(first);
    assert(Object.isFrozen(first));

    assert(
      tx.write({
        space,
        id,
        type,
        path: ["value", "stats", "visits"],
      }, 2).ok,
    );

    const second = tx.read({
      space,
      id,
      type,
      path: ["value"],
    }).ok?.value as typeof first;
    assert(second);
    assertNotStrictEquals(first, second);
    assertEquals(first.stats.visits, 1);
    assertEquals(second.stats.visits, 2);
    assert(Object.isFrozen(second));
    assert(Object.isFrozen(second.stats));
  } finally {
    await storage.close();
    resetDataModelConfig();
  }
});
