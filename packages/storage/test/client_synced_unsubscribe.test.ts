import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async/delay";
import * as AM from "@automerge/automerge";
import { createGenesisDoc } from "../src/store/genesis.ts";
import { StorageClient } from "../src/client/index.ts";

Deno.test({
  name:
    "client: synced waits for pending subscriptions; unsubscribe returns fn",
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
  const PORT = 8033;
  const baseUrl = `http://localhost:${PORT}`;
  const p = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "./deno.ts"],
    cwd: new URL("../", import.meta.url),
    env: { PORT: String(PORT) },
  }).spawn();
  await delay(300);

  const watchdog = setTimeout(() => {
    throw new Error("watchdog timeout client_synced");
  }, 15000);

  // Seed two docs
  const seed = async (docId: string) => {
    const ws = new WebSocket(
      `${baseUrl.replace("http", "ws")}/api/storage/new/v2/${
        encodeURIComponent("did:key:client-synced")
      }/ws`,
    );
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("seed timeout")), 3000);
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data));
        if (m && m.the === "task/return" && m.is?.txId !== undefined) {
          clearTimeout(t);
          resolve();
          ws.close();
        }
      };
      ws.onopen = () => {
        (async () => {
          const base = createGenesisDoc<any>(docId);
          const after = AM.change(base, (d: any) => {
            d.x = 1;
          });
          const c = AM.getLastLocalChange(after)!;
          const changeB64 = btoa(String.fromCharCode(...c));
          const msg = {
            invocation: {
              iss: "did:key:test",
              cmd: "/storage/tx",
              sub: "did:key:client-synced",
              args: {
                reads: [],
                writes: [{
                  ref: { docId, branch: "main" },
                  baseHeads: AM.getHeads(base),
                  changes: [{ bytes: changeB64 }],
                }],
              },
              prf: [],
            },
            authorization: { signature: [], access: {} },
          } as const;
          ws.send(JSON.stringify(msg));
        })().catch(reject);
      };
      ws.onerror = (e) => reject(e);
    });
  };

  await seed("doc:a");
  await seed("doc:b");

  const c = new StorageClient({ baseUrl });
  const space = "did:key:client-synced";

  // Kick off two subscriptions without awaiting
  const p1 = c.subscribe(space, {
    consumerId: "c1",
    query: { docId: "doc:a", path: [], schema: false as unknown as undefined },
  });
  const p2 = c.subscribe(space, {
    consumerId: "c2",
    query: { docId: "doc:b", path: [], schema: false as unknown as undefined },
  });
  // synced() should resolve only after both pending complete
  await c.synced(space);

  // Ensure readView has versions populated
  const a = c.readView(space, "doc:a");
  const b = c.readView(space, "doc:b");
  assert(typeof a.version.epoch === "number");
  assert(typeof b.version.epoch === "number");

  // Unsubscribe path
  const unsub = await p2; // resolve one subscribe to get unsubscribe fn
  assertEquals(typeof unsub, "function");
  unsub();

  clearTimeout(watchdog);
  try {
    p.kill();
    await p.status;
  } catch {
    // ignore
  }
});
