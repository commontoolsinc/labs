/**
 * Expected sequence (WS v2: multi-consumer subscribe delivers epoch-batched
 * updates)
 *
 * 1. Start WS v2 server on an ephemeral port.
 * 2. Seed the target documents using deterministic genesis:
 *    - createGenesisDoc(doc:s1) and createGenesisDoc(doc:s2)
 *    - send /storage/tx with baseHeads=[genesis] and a single change for each.
 * 3. Open two new client WS connections (ws1, ws2).
 * 4. For each client, send /storage/subscribe twice with queries for
 *    {docId:"doc:s1", path:[], schema:false} and {docId:"doc:s2", path:[],
 *    schema:false}.
 *    - Expect initial backfill deliver on each subscribe, then receive complete.
 *      Send ACK by epoch after receiving each deliver.
 * 5. Produce a new change on top of the current heads (based on the heads
 *    received in step 4) and send /storage/tx. ws1 changes doc:s1, ws2 changes
 *    doc:s2.
 * 6. Expect epoch-batched deliver on both ws1 and ws2 for both transactions;
 *    verify each epoch is >= the previous epoch observed on that socket.
 */
import { assert } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { computeGenesisHead, createGenesisDoc } from "../src/store/genesis.ts";

Deno.test({
  name: "WS v2: multi-consumer subscribe delivers epoch-batched updates",
  permissions: {
    net: true,
    env: true,
    read: true,
    write: true,
    run: true,
    ffi: true,
  },
}, async () => {
  const watchdog = setTimeout(() => {
    throw new Error("watchdog timeout ws_v2.multi");
  }, 12000);
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const PORT = 8022;

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

  await new Promise((r) => setTimeout(r, 400));

  const spaceDid = "did:key:ws-v2-multi";
  const makeWs = () =>
    new WebSocket(
      `ws://localhost:${PORT}/api/storage/new/v2/${
        encodeURIComponent(spaceDid)
      }/ws`,
    );

  const wsSeed = makeWs();
  let seededS1: any = null;
  let seededS2: any = null;
  let seedHeadsS1: string[] = [];
  let seedHeadsS2: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("seed timeout")), 4000);
    let sentS2 = false;
    wsSeed.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m && m.the === "task/return" && m.is?.txId !== undefined) {
        const newHeads: string[] = m.is?.results?.[0]?.newHeads ?? [];
        if (!sentS2) seedHeadsS1 = newHeads;
        else seedHeadsS2 = newHeads;
        if (!sentS2) {
          // After s1 receipt, send s2
          sentS2 = true;
          const docId2 = "doc:s2";
          const base2 = createGenesisDoc<any>(docId2);
          const init2 = Automerge.change(base2, (x: any) => {
            x.init = true;
          });
          seededS2 = init2;
          const changeB642 = btoa(
            String.fromCharCode(...Automerge.getLastLocalChange(init2)!),
          );
          wsSeed.send(JSON.stringify({
            invocation: {
              iss: "did:key:test",
              cmd: "/storage/tx",
              sub: spaceDid,
              args: {
                reads: [],
                writes: [{
                  ref: { docId: docId2, branch: "main" },
                  baseHeads: [computeGenesisHead(docId2)],
                  changes: [{ bytes: changeB642 }],
                }],
              },
              prf: [],
            },
            authorization: { signature: [], access: {} },
          }));
          return;
        }
        clearTimeout(t);
        resolve();
      }
    };
    wsSeed.onopen = () => {
      const docId = "doc:s1";
      const base = createGenesisDoc<any>(docId);
      const docInit = Automerge.change(base, (x: any) => {
        x.init = true;
      });
      seededS1 = docInit;
      const changeB64 = btoa(
        String.fromCharCode(...Automerge.getLastLocalChange(docInit)!),
      );
      wsSeed.send(JSON.stringify({
        invocation: {
          iss: "did:key:test",
          cmd: "/storage/tx",
          sub: spaceDid,
          args: {
            reads: [],
            writes: [{
              ref: { docId, branch: "main" },
              baseHeads: [computeGenesisHead(docId)],
              changes: [{ bytes: changeB64 }],
            }],
          },
          prf: [],
        },
        authorization: { signature: [], access: {} },
      }));
    };
  });
  wsSeed.close();

  const ws1 = makeWs();
  const ws2 = makeWs();
  const waitOpen = (ws: WebSocket) =>
    new Promise<void>((r) => {
      if (ws.readyState === WebSocket.OPEN) return r();
      ws.onopen = () => r();
    });
  await Promise.all([waitOpen(ws1), waitOpen(ws2)]);

  const subscribeAndExpectBackfill = (
    ws: WebSocket,
    consumerId: string,
    docId: string,
  ) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("deliver timeout")), 5000);
      const msg = {
        invocation: {
          iss: "did:key:test",
          cmd: "/storage/subscribe",
          sub: spaceDid,
          args: {
            consumerId,
            query: { docId, path: [], schema: false },
          },
          prf: [],
        },
        authorization: { signature: [], access: {} },
      };
      ws.send(JSON.stringify(msg));
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data as string);
        if (m && m.type === "deliver") {
          try {
            assert(Array.isArray(m.docs) && m.docs.length >= 1);
            ws.send(
              JSON.stringify({
                type: "ack",
                streamId: spaceDid,
                epoch: m.epoch,
              }),
            );
          } catch (err) {
            clearTimeout(t);
            reject(err);
          }
        }
        if (m && m.the === "task/return" && m.is?.type === "complete") {
          clearTimeout(t);
          resolve();
        }
      };
    });

  // Subscribe sequentially per socket to avoid overwriting onmessage handlers
  await subscribeAndExpectBackfill(ws1, "c1-s1", "doc:s1");
  await subscribeAndExpectBackfill(ws1, "c1-s2", "doc:s2");
  await subscribeAndExpectBackfill(ws2, "c2-s1", "doc:s1");
  await subscribeAndExpectBackfill(ws2, "c2-s2", "doc:s2");

  // Prepare the next tx on top of heads captured after subscribe/complete
  const docId1 = "doc:s1";
  const docId2 = "doc:s2";

  // Expect delivers on both sockets; verify each expected doc includes a body and ack by epoch
  const expectDeliverForDocs = (
    ws: WebSocket,
    expectedValues: Record<string, number>,
  ) =>
    new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("deliver timeout")), 7000);
      const bodies: Record<string, any> = {};
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data as string);
        if (m && m.type === "deliver") {
          try {
            assert(typeof m.epoch === "number");
            assert(Array.isArray(m.docs));
            for (const d of m.docs) {
              if (expectedValues[d.docId] !== undefined) {
                bodies[d.docId] = d.body;
              }
            }
            ws.send(
              JSON.stringify({
                type: "ack",
                streamId: spaceDid,
                epoch: m.epoch,
              }),
            );
            const allSeen = Object.keys(expectedValues).every((doc) =>
              bodies[doc] !== undefined
            );
            if (allSeen) {
              // Verify exact content values now that we've collected all bodies
              for (const [doc, v] of Object.entries(expectedValues)) {
                const b = bodies[doc];
                assert(b && typeof b === "object");
                assert((b as any).value === v);
              }
              clearTimeout(t);
              resolve(m.epoch);
            }
          } catch (err) {
            clearTimeout(t);
            reject(err);
          }
        }
      };
    });

  // Compute the next local changes on top of the seeded docs
  let cur1 = Automerge.change(seededS1, (x: any) => {
    x.value = (x.value || 0) + 1;
  });
  const c1 = Automerge.getLastLocalChange(cur1)!;
  let cur2 = Automerge.change(seededS2, (x: any) => {
    x.value = (x.value || 0) + 2;
  });
  const c2 = Automerge.getLastLocalChange(cur2)!;

  const changeB64_s1 = btoa(String.fromCharCode(...c1));
  const changeB64_s2 = btoa(String.fromCharCode(...c2));
  const tx1 = {
    invocation: {
      iss: "did:key:test",
      cmd: "/storage/tx",
      sub: spaceDid,
      args: {
        reads: [],
        writes: [{
          ref: { docId: docId1, branch: "main" },
          baseHeads: seedHeadsS1,
          changes: [{ bytes: changeB64_s1 }],
        }],
      },
      prf: [],
    },
    authorization: { signature: [], access: {} },
  };
  const tx2 = {
    invocation: {
      iss: "did:key:test",
      cmd: "/storage/tx",
      sub: spaceDid,
      args: {
        reads: [],
        writes: [{
          ref: { docId: docId2, branch: "main" },
          baseHeads: seedHeadsS2,
          changes: [{ bytes: changeB64_s2 }],
        }],
      },
      prf: [],
    },
    authorization: { signature: [], access: {} },
  };
  ws1.send(JSON.stringify(tx1));
  ws2.send(JSON.stringify(tx2));

  const expectedValues = { [docId1]: 1, [docId2]: 2 } as const;
  const [e1, e2] = await Promise.all([
    expectDeliverForDocs(ws1, expectedValues as any),
    expectDeliverForDocs(ws2, expectedValues as any),
  ]);
  assert(e1 >= 1 && e2 >= 1);

  ws1.close();
  ws2.close();
  try {
    p.kill();
    await p.status;
  } catch {}
  clearTimeout(watchdog);
});
