/**
 * Expected sequence (WS v2: subscribe complete and deliver/ack via tx)
 *
 * 1. Start WS v2 server on an ephemeral port.
 * 2. Seed the document using deterministic genesis:
 *    - createGenesisDoc(doc:s1)
 *    - send /storage/tx with baseHeads=[genesis] and a single change
 * 3. Open client WS and send /storage/subscribe with query {docId:"doc:s1",
 *    path:[], schema:false}.
 * 4. Expect initial backfill deliver (epoch-batched), then complete.
 * 5. Test concludes after verifying the deliver structure, receiving the
 *    completion signal, and sending the ACK.
 */
import { assert, assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { computeGenesisHead, createGenesisDoc } from "../src/store/genesis.ts";

Deno.test({
  name: "WS v2: subscribe complete and deliver/ack via tx",
  permissions: {
    net: true,
    env: true,
    read: true,
    write: true,
    run: true,
    ffi: true,
  },
}, async () => {
  // Avoid hangs
  const watchdog = setTimeout(() => {
    throw new Error("watchdog timeout ws_v2.basic");
  }, 10000);
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const PORT = 8012;

  // Start storage v2 server
  const p = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "./deno.ts"],
    cwd: new URL("../", import.meta.url),
    env: {
      SPACES_DIR: spacesDir.toString(),
      PORT: String(PORT),
      ENABLE_SERVER_MERGE: "1",
    },
  }).spawn();

  // Small delay to boot
  await new Promise((r) => setTimeout(r, 400));

  const spaceDid = "did:key:ws-v2";
  const ws = new WebSocket(
    `ws://localhost:${PORT}/api/storage/new/v2/${
      encodeURIComponent(spaceDid)
    }/ws`,
  );

  // Seed using a separate socket so subscribe backfill will still deliver on primary ws
  {
    const wsSeed = new WebSocket(
      `ws://localhost:${PORT}/api/storage/new/v2/${
        encodeURIComponent(spaceDid)
      }/ws`,
    );
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("seed timeout")), 3000);
      wsSeed.onmessage = (e) => {
        const m = JSON.parse(e.data as string);
        if (m && m.the === "task/return" && m.is?.txId !== undefined) {
          clearTimeout(t);
          resolve();
        }
      };
      wsSeed.onopen = () => {
        const docId = "doc:s1";
        const base = createGenesisDoc<any>(docId);
        const after = Automerge.change(base, (x: any) => {
          x.init = true;
        });
        const preChange = Automerge.getLastLocalChange(after)!;
        const preTx = {
          invocation: {
            iss: "did:key:test",
            cmd: "/storage/tx",
            sub: spaceDid,
            args: {
              reads: [],
              writes: [{
                ref: { docId, branch: "main" },
                baseHeads: [computeGenesisHead(docId)],
                changes: [{ bytes: btoa(String.fromCharCode(...preChange)) }],
              }],
            },
            prf: [],
          },
          authorization: { signature: [], access: {} },
        };
        wsSeed.send(JSON.stringify(preTx));
      };
    });
    wsSeed.close();
  }

  const got = await new Promise<{ epoch: number; docs: any[] }>(
    (resolve, reject) => {
      const t = setTimeout(() => reject(new Error("subscribe timeout")), 6000);
      const msg = {
        invocation: {
          iss: "did:key:test",
          cmd: "/storage/subscribe",
          sub: spaceDid,
          args: {
            consumerId: "c1",
            query: { docId: "doc:s1", path: [], schema: false },
          },
          prf: [],
        },
        authorization: { signature: [], access: {} },
      };
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      else ws.onopen = () => ws.send(JSON.stringify(msg));
      let deliver: { epoch: number; docs: any[] } | null = null;
      let sawComplete = false;
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data as string);
        if (m && m.type === "deliver") {
          try {
            assert(typeof m.epoch === "number");
            assert(Array.isArray(m.docs));
            ws.send(
              JSON.stringify({
                type: "ack",
                streamId: spaceDid,
                epoch: m.epoch,
              }),
            );
            deliver = { epoch: m.epoch, docs: m.docs };
            if (sawComplete) {
              clearTimeout(t);
              resolve(deliver);
            }
          } catch (err) {
            clearTimeout(t);
            reject(err);
          }
        }
        if (m && m.the === "task/return" && m.is?.type === "complete") {
          sawComplete = true;
          if (deliver) {
            clearTimeout(t);
            resolve(deliver);
          }
        }
      };
    },
  );

  assert(got.epoch >= 1);
  assert(got.docs.length >= 1);

  ws.close();
  try {
    p.kill();
    await p.status;
  } catch { /* ignore */ }
  clearTimeout(watchdog);
});
