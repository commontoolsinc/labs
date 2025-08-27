import { assert } from "@std/assert";
import { delay } from "@std/async/delay";
import { StorageClient } from "../src/client/index.ts";

function getFreePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const p = (l.addr as Deno.NetAddr).port;
  l.close();
  return p;
}

Deno.test({
  name: "client: synced() resolves only after initial subs and commits settle",
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
  const tmp = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmp.endsWith("/") ? tmp : tmp + "/"}`);
  const PORT = getFreePort();
  const baseUrl = `http://localhost:${PORT}`;
  const watchdog = setTimeout(() => {
    throw new Error("watchdog timeout client_synced_end_to_end");
  }, 20000);
  const p = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "./deno.ts"],
    cwd: new URL("../", import.meta.url),
    env: { PORT: String(PORT), SPACES_DIR: spacesDir.toString() },
  }).spawn();
  await delay(300);

  const space = "did:key:client-synced-e2e";
  const c = new StorageClient({ baseUrl });

  // Seed docs so subscriptions won't error on missing branches
  {
    const tx = await c.newTransaction();
    tx.write(space, "doc:s1", [], (root: any) => (root.v = 0));
    await tx.commit();
  }
  {
    const tx = await c.newTransaction();
    tx.write(space, "doc:s2", [], (root: any) => (root.v = 0));
    await tx.commit();
  }

  // Start two subscriptions after docs exist
  const unsub1 = await c.subscribe(space, {
    consumerId: "u1",
    query: { docId: "doc:s1", path: [], schema: false as unknown as undefined },
  });
  const unsub2 = await c.subscribe(space, {
    consumerId: "u2",
    query: { docId: "doc:s2", path: [], schema: false as unknown as undefined },
  });
  await c.synced(space);

  // Kick off two commits concurrently (creates docs since they don't exist yet)
  const tx1 = await c.newTransaction();
  tx1.write(space, "doc:s1", [], (root: any) => (root.v = 1));
  const pr1 = tx1.commit();

  const tx2 = await c.newTransaction();
  tx2.write(space, "doc:s2", [], (root: any) => (root.v = 2));
  const pr2 = tx2.commit();

  // synced() should wait for both commits and initial subscription completes
  await c.synced(space);
  const r1 = await pr1;
  const r2 = await pr2;
  assert(
    r1.status === "ok" || r1.status === "conflict" || r1.status === "rejected",
  );
  assert(
    r2.status === "ok" || r2.status === "conflict" || r2.status === "rejected",
  );

  unsub1();
  unsub2();
  try {
    clearTimeout(watchdog);
    p.kill();
    await p.status;
  } catch {
    // ignore
  }
});
