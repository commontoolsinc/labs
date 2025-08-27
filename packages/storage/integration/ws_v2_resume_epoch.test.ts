import { assert, assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { encodeBase64 } from "../src/codec/bytes.ts";
import { createGenesisDoc } from "../src/store/genesis.ts";

// Helper: base64 encode bytes
function b64(bytes: Uint8Array): string {
  return encodeBase64(bytes);
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.onopen = () => resolve();
  });
}

Deno.test({
  name: "WS v2: resume with hello (exact vs stale sinceEpoch)",
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
    throw new Error("watchdog timeout ws_v2.resume_epoch");
  }, 15000);

  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const PORT = 8024;

  // Start storage v2 server
  const p = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "./deno.ts"],
    cwd: new URL("../", import.meta.url),
    env: {
      SPACES_DIR: spacesDir.toString(),
      PORT: String(PORT),
    },
  }).spawn();

  // Give the server a moment to boot
  await new Promise((r) => setTimeout(r, 400));

  const spaceDid = "did:key:ws-v2-resume-epoch";
  const wsUrl = `ws://localhost:${PORT}/api/storage/new/v2/${
    encodeURIComponent(spaceDid)
  }/ws`;

  // Sockets: 0 seeds, 1 exact-resume, 2 stale-resume
  const ws0 = new WebSocket(wsUrl);
  const ws1 = new WebSocket(wsUrl);
  const ws2 = new WebSocket(wsUrl);
  await Promise.all([waitOpen(ws0), waitOpen(ws1), waitOpen(ws2)]);

  // Seed the document via conn0
  const docId = "doc:resume";
  const branch = "main";
  const base = createGenesisDoc<any>(docId);
  const initDoc = Automerge.change(base, (d: any) => {
    d.init = true;
  });
  const initChange = Automerge.getLastLocalChange(initDoc)!;

  // Promise: wait for a tx receipt (returns epoch)
  function sendTx(
    ws: WebSocket,
    change: Uint8Array,
    baseHeads: readonly string[] = Automerge.getHeads(base),
  ) {
    return new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("tx timeout")), 4000);
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data as string);
        if (m && m.the === "task/return" && m.is?.txId !== undefined) {
          clearTimeout(t);
          resolve(m.is.txId as number);
        }
      };
      ws.send(JSON.stringify({
        invocation: {
          iss: "did:key:test",
          cmd: "/storage/tx",
          sub: spaceDid,
          args: {
            reads: [],
            writes: [{
              ref: { docId, branch },
              baseHeads,
              changes: [{ bytes: b64(change) }],
            }],
          },
          prf: [],
        },
        authorization: { signature: [], access: {} },
      }));
    });
  }

  // Helpers: send hello and subscribe
  function sendHello(ws: WebSocket, clientId: string, sinceEpoch: number) {
    ws.send(JSON.stringify({
      invocation: {
        iss: "did:key:test",
        cmd: "/storage/hello",
        sub: spaceDid,
        args: { clientId, sinceEpoch },
        prf: [],
      },
      authorization: { signature: [], access: {} },
    }));
  }

  function subscribe(
    ws: WebSocket,
    consumerId: string,
    onDeliver: (m: any) => void,
    onComplete: () => void,
  ) {
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m && m.type === "deliver") onDeliver(m);
      if (m && m.the === "task/return" && m.is?.type === "complete") {
        onComplete();
      }
    };
    ws.send(JSON.stringify({
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
    }));
  }

  // Seed initial document version
  const epoch1 = await sendTx(ws0, initChange);

  // conn1 and conn2: subscribe and collect initial deliver (ack1)
  const ackedEpochs1: number[] = [];
  const ackedEpochs2: number[] = [];

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("initial subscribe timeout")),
      4000,
    );
    let done1 = false, done2 = false;
    subscribe(
      ws1,
      "c1",
      (m) => {
        // Expect a deliver of initial content
        assert(typeof m.epoch === "number");
        ackedEpochs1.push(m.epoch);
        ws1.send(
          JSON.stringify({ type: "ack", streamId: spaceDid, epoch: m.epoch }),
        );
      },
      () => {
        done1 = true;
        if (done1 && done2) {
          clearTimeout(t);
          resolve();
        }
      },
    );
    subscribe(
      ws2,
      "c2",
      (m) => {
        assert(typeof m.epoch === "number");
        ackedEpochs2.push(m.epoch);
        ws2.send(
          JSON.stringify({ type: "ack", streamId: spaceDid, epoch: m.epoch }),
        );
      },
      () => {
        done2 = true;
        if (done1 && done2) {
          clearTimeout(t);
          resolve();
        }
      },
    );
  });

  assert(ackedEpochs1.length >= 1 && ackedEpochs2.length >= 1);
  const ack1 = ackedEpochs1[0]!; // first observed epoch on both streams
  assertEquals(ack1, epoch1);

  // Track local doc for correct baseHeads per subsequent change
  let localDoc = initDoc;

  // Apply a second change and record ack2 on both connections
  const baseHeads2 = Automerge.getHeads(localDoc);
  localDoc = Automerge.change(localDoc, (d: any) => {
    d.bump = 1;
  });
  const change2 = Automerge.getLastLocalChange(localDoc)!;
  // Attach deliver watchers BEFORE sending tx to avoid race; resolve when both saw epoch2
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("second deliver timeout")),
      6000,
    );
    let got1 = false, got2 = false;
    let epoch2Var: number | null = null;
    const maybeResolve = () => {
      if (got1 && got2) {
        clearTimeout(t);
        resolve();
      }
    };
    ws1.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m && m.type === "deliver") {
        ackedEpochs1.push(m.epoch);
        ws1.send(
          JSON.stringify({ type: "ack", streamId: spaceDid, epoch: m.epoch }),
        );
        if (epoch2Var != null && m.epoch === epoch2Var) {
          got1 = true;
          maybeResolve();
        }
      }
    };
    ws2.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m && m.type === "deliver") {
        ackedEpochs2.push(m.epoch);
        ws2.send(
          JSON.stringify({ type: "ack", streamId: spaceDid, epoch: m.epoch }),
        );
        if (epoch2Var != null && m.epoch === epoch2Var) {
          got2 = true;
          maybeResolve();
        }
      }
    };
    // Now send tx that will produce epoch2 and possibly deliver quickly
    sendTx(ws0, change2, baseHeads2).then((e2) => {
      epoch2Var = e2;
      // If deliveries already processed by previous handlers, acked arrays may already include e2
      if (!got1 && ackedEpochs1.includes(e2)) got1 = true;
      if (!got2 && ackedEpochs2.includes(e2)) got2 = true;
      maybeResolve();
    }).catch((err) => {
      clearTimeout(t);
      reject(err);
    });
  });

  // Determine last acknowledged epoch after second tx
  const ack2 = Math.max(...ackedEpochs1, ...ackedEpochs2);
  assert(ackedEpochs1.includes(ack2) && ackedEpochs2.includes(ack2));

  // Close ws1 and ws2 to simulate disconnect
  await Promise.all([
    new Promise<void>((r) => {
      ws1.onclose = () => r();
      ws1.close();
    }),
    new Promise<void>((r) => {
      ws2.onclose = () => r();
      ws2.close();
    }),
  ]);

  // Reconnect both and send hello with sinceEpoch
  const ws1b = new WebSocket(wsUrl);
  const ws2b = new WebSocket(wsUrl);
  await Promise.all([waitOpen(ws1b), waitOpen(ws2b)]);
  // conn1 exact resume: sinceEpoch == last ACK
  sendHello(ws1b, "c1", ack2);
  // conn2 stale resume: use a fresh clientId with sinceEpoch == ack1 < ack2
  // This ensures the server uses the provided sinceEpoch (no stored row yet)
  sendHello(ws2b, "c2-stale", ack1);

  // Re-subscribe on both and validate behavior
  // conn1: expect no backfill, only complete
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("resubscribe c1 timeout")),
      4000,
    );
    let sawDeliver = false;
    subscribe(
      ws1b,
      "c1",
      (_m) => {
        sawDeliver = true;
      },
      () => {
        if (sawDeliver) {
          clearTimeout(t);
          reject(new Error("unexpected backfill for exact resume"));
          return;
        }
        clearTimeout(t);
        resolve();
      },
    );
  });

  // conn2: expect a backfill deliver (snapshot or delta) before complete
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("resubscribe c2 timeout")),
      5000,
    );
    let sawDeliver = false;
    subscribe(
      ws2b,
      "c2",
      (m) => {
        try {
          assert(typeof m.epoch === "number");
          assert(Array.isArray(m.docs) && m.docs.length >= 1);
          sawDeliver = true;
          // ACK backfill epoch
          ws2b.send(
            JSON.stringify({ type: "ack", streamId: spaceDid, epoch: m.epoch }),
          );
        } catch (err) {
          clearTimeout(t);
          reject(err);
        }
      },
      () => {
        if (!sawDeliver) {
          clearTimeout(t);
          reject(new Error("expected backfill for stale resume"));
          return;
        }
        clearTimeout(t);
        resolve();
      },
    );
  });

  // Apply a third change and expect both conn1b and conn2b to receive it
  const baseHeads3 = Automerge.getHeads(localDoc);
  localDoc = Automerge.change(localDoc, (d: any) => {
    d.bump2 = 1;
  });
  const change3 = Automerge.getLastLocalChange(localDoc)!;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("third deliver timeout")),
      7000,
    );
    let got1 = false, got2 = false;
    let epoch3Var: number | null = null;
    let lastDeliver1: number | null = null;
    let lastDeliver2: number | null = null;
    const maybeResolve = () => {
      if (got1 && got2) {
        clearTimeout(t);
        resolve();
      }
    };
    ws1b.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m && m.type === "deliver") {
        lastDeliver1 = m.epoch as number;
        ws1b.send(
          JSON.stringify({ type: "ack", streamId: spaceDid, epoch: m.epoch }),
        );
        if (epoch3Var != null && lastDeliver1 === epoch3Var) {
          got1 = true;
          maybeResolve();
        }
      }
    };
    ws2b.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m && m.type === "deliver") {
        lastDeliver2 = m.epoch as number;
        ws2b.send(
          JSON.stringify({ type: "ack", streamId: spaceDid, epoch: m.epoch }),
        );
        if (epoch3Var != null && lastDeliver2 === epoch3Var) {
          got2 = true;
          maybeResolve();
        }
      }
    };
    sendTx(ws0, change3, baseHeads3).then((e3) => {
      epoch3Var = e3;
      // In case deliveries already landed
      if (lastDeliver1 === e3) got1 = true;
      if (lastDeliver2 === e3) got2 = true;
      maybeResolve();
    }).catch((err) => {
      clearTimeout(t);
      reject(err);
    });
  });

  // Cleanup
  ws0.close();
  ws1b.close();
  ws2b.close();
  try {
    p.kill();
    await p.status;
  } catch {
    // ignore
  }
  clearTimeout(watchdog);
});
