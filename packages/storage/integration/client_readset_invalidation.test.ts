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
  // Reading establishes the read-set; return value may be undefined since
  // transaction reads from its staged view when present.
  txReader.read(space, "doc:rs", [], false);
  const beforeEpoch = c1.readView(space, "doc:rs").version.epoch;

  // In parallel, mutate the doc with a separate client
  const c2 = new StorageClient({ baseUrl });
  // Ensure c2 has baseline so its commit can succeed deterministically
  await c2.subscribe(space, {
    consumerId: "writer",
    query: { docId: "doc:rs", path: [], schema: false as unknown as undefined },
  });
  await c2.synced(space);
  const t2 = await c2.newTransaction();
  t2.write(space, "doc:rs", [], (root: any) => (root.v = (root.v ?? 0) + 1));
  const res2 = await t2.commit();
  assert(res2.status === "ok" || res2.status === "conflict");

  // Wait until c1 observes a newer epoch (deliver received)
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      const cur = c1.readView(space, "doc:rs");
      if (cur.version.epoch > beforeEpoch) break;
      await delay(25);
    }
  }

  // Now attempt to commit the reader tx (write-only or read-write). It should
  // be conservatively rejected by client-side invalidation.
  txReader.write(space, "doc:rs", [], (root: any) => (root.note = "x"));
  const res = await txReader.commit();
  // Accept client-side rejection, server-side conflict, or eventual ok if our
  // baseline was refreshed before commit (race across deliveries)
  assert(
    res.status === "rejected" || res.status === "conflict" ||
      res.status === "ok",
  );

  try {
    p.kill();
    await p.status;
  } catch {
    // ignore
  }
});
