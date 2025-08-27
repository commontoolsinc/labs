import { assertEquals } from "@std/assert";
import { delay } from "@std/async/delay";
import * as AM from "@automerge/automerge";
import { createGenesisDoc } from "../src/store/genesis.ts";
import { StorageClient } from "../src/client/index.ts";

Deno.test(
  {
    name: "client: subscribe + get populate store and synced resolves",
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
    // Global timeout to avoid hangs during dev server interactions
    fn: async () => {
      const PORT = 8032;
      const baseUrl = `http://localhost:${PORT}`;
      // Start storage dev server
      const p = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "./deno.ts"],
        cwd: new URL("../", import.meta.url),
        env: { PORT: String(PORT) },
      }).spawn();
      // give server a moment
      await delay(300);

      const watchdog = setTimeout(() => {
        throw new Error("watchdog timeout client_basic");
      }, 15000);

      // Seed doc:hello so subscribe doesn't error on missing branch
      const spaceDid = "did:key:client-basic";
      const ws = new WebSocket(
        `${baseUrl.replace("http", "ws")}/api/storage/new/v2/${
          encodeURIComponent(spaceDid)
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
            const docId = "doc:hello";
            const base = createGenesisDoc<any>(docId);
            const after = AM.change(base, (d: any) => {
              d.hello = "world";
            });
            const cbytes = AM.getLastLocalChange(after)!;
            const { encodeBase64 } = await import("../src/codec/bytes.ts");
            const changeB64 = encodeBase64(cbytes);
            const msg = {
              invocation: {
                iss: "did:key:test",
                cmd: "/storage/tx",
                sub: spaceDid,
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

      // Import client from package source
      const c = new StorageClient({ baseUrl });
      const space = spaceDid;

      // Subscribe to the doc
      const unsubscribe = await c.subscribe(space, {
        consumerId: "test",
        query: {
          docId: "doc:hello",
          path: [],
          schema: false as unknown as undefined,
        },
      });

      // Use get to fetch; resolves after complete
      await c.get(space, {
        consumerId: "g1",
        query: {
          docId: "doc:hello",
          path: [],
          schema: false as unknown as undefined,
        },
      });
      const v0 = c.readView(space, "doc:hello");
      assertEquals(typeof v0.version.epoch, "number");

      // Tear down
      clearTimeout(watchdog);
      unsubscribe();
      try {
        p.kill();
        await p.status;
      } catch {
        // ignore
      }
    },
    // 20s overall timeout for this test
    // deno-lint-ignore no-explicit-any
  } as any & { deadline: number },
);
