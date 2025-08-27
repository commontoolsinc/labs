#!/usr/bin/env -S deno test -A

import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async/delay";
import { StorageClient } from "../src/client/index.ts";

Deno.test({
  name: "integration: client genesis + optimistic commit reflects in readView",
  permissions: {
    net: true,
    env: true,
    read: true,
    write: true,
    run: true,
    ffi: true,
  },
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const PORT = 8044;
  const baseUrl = `http://localhost:${PORT}`;

  const p = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "./deno.ts"],
    cwd: new URL("../", import.meta.url),
    env: {
      SPACES_DIR: spacesDir.toString(),
      PORT: String(PORT),
      ENABLE_SERVER_MERGE: "1",
    },
  }).spawn();
  await delay(300);

  const watchdog = setTimeout(() => {
    throw new Error("watchdog timeout client_tx_commit.integration");
  }, 15000);

  const spaceDid = "did:key:client-tx-int2";

  // First connection: create doc via client API (genesis write)
  {
    const c1 = new StorageClient({ baseUrl });
    const tx = await c1.newTransaction();
    tx.write(spaceDid, "doc:tx2", [], (root: any) => {
      root.count = 0;
    });
    const res = await tx.commit();
    assert(res.receipt);
  }

  // Second connection: subscribe, wait complete, ensure baseline present, then write and assert optimistic view
  const c2 = new StorageClient({ baseUrl });
  await c2.subscribe(spaceDid, {
    consumerId: "c2",
    query: {
      docId: "doc:tx2",
      path: [],
      schema: false as unknown as undefined,
    },
  });
  await c2.synced(spaceDid);

  // Ensure baseline present in client cache
  for (let i = 0; i < 20; i++) {
    const v = c2.readView(spaceDid, "doc:tx2");
    if (v.version.epoch >= 0) break;
    await delay(50);
  }

  const before = c2.readView(spaceDid, "doc:tx2").json as any;
  const baseCount = typeof before?.count === "number" ? before.count : 0;

  const tx2 = await c2.newTransaction();
  tx2.write(spaceDid, "doc:tx2", [], (root: any) => {
    root.count = (root.count ?? 0) + 1;
  });
  // Start commit but don't await to test optimistic read
  const commitPromise = tx2.commit();
  const optimistic = c2.readView(spaceDid, "doc:tx2").json as any;
  assertEquals(optimistic?.count, baseCount + 1);

  const res2 = await commitPromise;
  assert(res2.status === "ok" || res2.status === "conflict");
  const after = c2.readView(spaceDid, "doc:tx2").json as any;
  if (res2.status === "ok") {
    assertEquals(after?.count, optimistic?.count);
  } else {
    // conflict: optimistic overlay cleared; store may have no baseline yet
    if (after == null) {
      // acceptable
    } else {
      assertEquals(after.count, baseCount);
    }
  }

  clearTimeout(watchdog);
  try {
    p.kill();
    await p.status;
  } catch {
    // ignore
  }
});
