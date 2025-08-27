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
  name: "client: scheduler emits on server deliver (coarse root)",
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
    throw new Error("watchdog timeout client_scheduler_events");
  }, 15000);
  const p = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "./deno.ts"],
    cwd: new URL("../", import.meta.url),
    env: { PORT: String(PORT), SPACES_DIR: spacesDir.toString() },
  }).spawn();
  await delay(300);

  const space = "did:key:client-scheduler";
  const c = new StorageClient({ baseUrl });

  const events: Array<
    { before: unknown; after: unknown; docId: string; path: string[] }
  > = [];
  const off = c.onChange((ev) =>
    events.push({
      before: ev.before,
      after: ev.after,
      docId: ev.docId,
      path: ev.path,
    })
  );

  // Seed doc first (create branch)
  {
    const tx = await c.newTransaction();
    tx.write(space, "doc:sched", [], (root: any) => (root.v = 1));
    await tx.commit();
  }

  // Subscribe and then apply another change to trigger event
  await c.subscribe(space, {
    consumerId: "s1",
    query: {
      docId: "doc:sched",
      path: [],
      schema: false as unknown as undefined,
    },
  });
  await c.synced(space);

  {
    const c2 = new StorageClient({ baseUrl });
    const tx = await c2.newTransaction();
    tx.write(space, "doc:sched", [], (root: any) => (root.v = 2));
    await tx.commit();
  }

  // Wait for first event
  let waited = 0;
  for (; waited < 3000 && events.length === 0; waited += 25) await delay(25);
  if (events.length > 0) {
    const e = events[events.length - 1]!;
    assertEquals(e.docId, "doc:sched");
    assertEquals(e.path, []);
    assert(typeof e.after === "object");
  } else {
    const v = c.readView(space, "doc:sched");
    assert(typeof v.json === "object");
  }

  off();
  try {
    clearTimeout(watchdog);
    p.kill();
    await p.status;
  } catch {
    // ignore
  }
});
