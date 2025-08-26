import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async/delay";

function getFreePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const p = (l.addr as Deno.NetAddr).port;
  l.close();
  return p;
}

Deno.test({
  name:
    "client: read-set invalidation rejects tx when doc changes before commit",
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
  const p = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "./deno.ts"],
    cwd: new URL("../", import.meta.url),
    env: { PORT: String(PORT), SPACES_DIR: spacesDir.toString() },
  }).spawn();
  await delay(300);

  const space = "did:key:client-readset";
  const { StorageClient } = await import("../src/client/index.ts");

  const c1 = new StorageClient({ baseUrl });
  // Seed base doc
  {
    const tx = await c1.newTransaction();
    tx.write(space, "doc:rs", [], (root: any) => (root.v = 1));
    const r = await tx.commit();
    assert(r.status === "ok");
  }

  // Subscribe to ensure baseline is present locally
  await c1.subscribe(space, {
    consumerId: "reader",
    query: { docId: "doc:rs", path: [], schema: false as unknown as undefined },
  });
  await c1.synced(space);

  // Open a transaction and read the doc, establishing a read-set
  const txReader = await c1.newTransaction();
  const readVal = txReader.read(space, "doc:rs", [], false) as any;
  assertEquals(typeof readVal?.v, "number");

  // In parallel, mutate the doc with a separate client
  const c2 = new StorageClient({ baseUrl });
  const t2 = await c2.newTransaction();
  t2.write(space, "doc:rs", [], (root: any) => (root.v = (root.v ?? 0) + 1));
  const res2 = await t2.commit();
  assert(res2.status === "ok");

  // Wait for delivery + ack
  await delay(100);

  // Now attempt to commit the reader tx (write-only or read-write). It should
  // be conservatively rejected by client-side invalidation.
  txReader.write(space, "doc:rs", [], (root: any) => (root.note = "x"));
  const res = await txReader.commit();
  assertEquals(res.status, "rejected");

  try {
    p.kill();
    await p.status;
  } catch {
    // ignore
  }
});
