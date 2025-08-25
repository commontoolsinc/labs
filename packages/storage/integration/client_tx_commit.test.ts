#!/usr/bin/env -S deno test -A

import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async/delay";

Deno.test({
  name: "integration: client tx commit over WS returns ok/conflict and remains usable",
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
  const PORT = 8043;
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
  }, 12000);

  const spaceDid = "did:key:client-tx-int";
  const { StorageClient } = await import("../src/client/index.ts");
  const { createGenesisDoc } = await import("../src/store/genesis.ts");
  const AM = await import("@automerge/automerge");

  // Seed base doc via raw WS tx
  {
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
          ws.close();
          resolve();
        }
      };
      ws.onopen = () => {
        const docId = "doc:tx";
        const base = createGenesisDoc<any>(docId);
        const after = AM.change(base, (d: any) => {
          d.count = 0;
        });
        const cbytes = AM.getLastLocalChange(after)!;
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
                changes: [{ bytes: btoa(String.fromCharCode(...cbytes)) }],
              }],
            },
            prf: [],
          },
          authorization: { signature: [], access: {} },
        } as const;
        ws.send(JSON.stringify(msg));
      };
      ws.onerror = (e) => reject(e);
    });
  }

  const client = new StorageClient({ baseUrl });
  await client.subscribe(spaceDid, {
    consumerId: "c1",
    query: { docId: "doc:tx", path: [], schema: false as unknown as undefined },
  });
  await client.synced(spaceDid);
  await client.get(spaceDid, {
    consumerId: "precommit",
    query: { docId: "doc:tx", path: [], schema: false as unknown as undefined },
  });

  // Start a transaction that increments count
  const tx = await client.newTransaction();
  tx.write(spaceDid, "doc:tx", [], (root: any) => {
    root.count = (root.count ?? 0) + 1;
  });
  const res = await tx.commit();
  assert(res.receipt);
  assert(res.status === "ok" || res.status === "conflict");

  // Ensure store remains usable (version present)
  await delay(150);
  const v = client.readView(spaceDid, "doc:tx");
  assertEquals(typeof v.version?.epoch, "number");

  clearTimeout(watchdog);
  try {
    p.kill();
    await p.status;
  } catch {
    // ignore
  }
});
