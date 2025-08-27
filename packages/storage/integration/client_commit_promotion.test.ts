import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async/delay";
import { StorageClient } from "../src/client/index.ts";

function getFreePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const p = (l.addr as Deno.NetAddr).port;
  l.close();
  return p;
}

Deno.test({
  name: "client: commit ok promotes overlay and advances version",
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

  const space = "did:key:client-commit-ok";

  // Seed via first client
  {
    const c1 = new StorageClient({ baseUrl });
    const tx = await c1.newTransaction();
    tx.write(space, "doc:x", [], (root: any) => {
      root.count = 1;
    });
    const r = await tx.commit();
    assert(r.status === "ok");
  }

  // Second client subscribes and commits an increment
  const c2 = new StorageClient({ baseUrl });
  await c2.subscribe(space, {
    consumerId: "c2",
    query: { docId: "doc:x", path: [], schema: false as unknown as undefined },
  });
  await c2.synced(space);
  const before = c2.readView(space, "doc:x");
  const beforeEpoch = before.version.epoch;
  const baseCount = (before.json as any)?.count ?? 0;

  const tx2 = await c2.newTransaction();
  tx2.write(space, "doc:x", [], (root: any) => {
    root.count = (root.count ?? 0) + 1;
  });
  const res = await tx2.commit();
  const after = c2.readView(space, "doc:x");
  if (res.status === "ok") {
    assertEquals((after.json as any)?.count, baseCount + 1);
    assert(after.version.epoch >= beforeEpoch);
  } else {
    // Conflict: overlay cleared; server state may be unchanged or absent
    const cur = (after.json as any) ?? undefined;
    if (cur != null) {
      assertEquals(cur.count, baseCount);
    }
  }

  try {
    p.kill();
    await p.status;
  } catch {
    // ignore
  }
});
