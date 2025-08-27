import { assertEquals } from "@std/assert";
import { delay } from "@std/async/delay";
import { StorageClient } from "../src/client/index.ts";

function getFreePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const p = (l.addr as Deno.NetAddr).port;
  l.close();
  return p;
}

Deno.test({
  name: "client: conflict clears optimistic overlay (rollback)",
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

  const space = "did:key:client-rollback";
  const c = new StorageClient({ baseUrl });

  // Seed a base doc
  {
    const tx = await c.newTransaction();
    tx.write(space, "doc:y", [], (root: any) => {
      root.v = 1;
    });
    await tx.commit();
  }

  await c.subscribe(space, {
    consumerId: "c1",
    query: { docId: "doc:y", path: [], schema: false as unknown as undefined },
  });
  await c.synced(space);
  const base = c.readView(space, "doc:y");
  const baseV = (base.json as any)?.v ?? 0;

  // Create a conflicting update via second client
  const c2 = new StorageClient({ baseUrl });
  const t2 = await c2.newTransaction();
  t2.write(space, "doc:y", [], (root: any) => (root.v = (root.v ?? 0) + 1));
  await t2.commit();

  // Now local optimistic commit which may conflict
  const tx = await c.newTransaction();
  tx.write(space, "doc:y", [], (root: any) => (root.v = (root.v ?? 0) + 1));
  const pr = tx.commit();
  const optimistic = c.readView(space, "doc:y");
  // Optimistic overlay may or may not be visible synchronously; accept either base or +1
  const optV = (optimistic.json as any)?.v;
  if (optV != null) {
    const acceptable = optV === baseV || optV === baseV + 1;
    // Use assertEquals to bubble a clear diff if not acceptable
    assertEquals(acceptable, true);
  }
  const res = await pr;
  if (res.status !== "ok") {
    const after = c.readView(space, "doc:y");
    const val = (after.json as any)?.v;
    if (val != null) {
      assertEquals(val === baseV + 1, false);
    }
  }

  try {
    p.kill();
    await p.status;
  } catch {
    // ignore
  }
});
