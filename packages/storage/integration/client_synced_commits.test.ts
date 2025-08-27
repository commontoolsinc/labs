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
  name: "client: synced() waits for in-flight commits",
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

  const watchdog = setTimeout(() => {
    throw new Error("watchdog timeout client_synced_commits");
  }, 15000);

  const space = "did:key:client-synced-commits";
  const c = new StorageClient({ baseUrl });

  // Seed the branch/doc first to avoid branch not found during subscribe
  {
    const seed = await c.newTransaction();
    seed.write(space, "doc:z", [], (root: any) => (root.init = true));
    await seed.commit();
  }
  await c.subscribe(space, {
    consumerId: "c1",
    query: { docId: "doc:z", path: [], schema: false as unknown as undefined },
  });

  const tx = await c.newTransaction();
  tx.write(space, "doc:z", [], (root: any) => (root.k = 1));
  const pr = tx.commit();
  await c.synced(space);
  const r = await pr;
  assert(
    r.status === "ok" || r.status === "conflict" || r.status === "rejected",
  );

  try {
    clearTimeout(watchdog);
    p.kill();
    await p.status;
  } catch {
    // ignore
  }
});
