import { assert } from "@std/assert";
import * as Automerge from "@automerge/automerge";

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
      const docInit = Automerge.change(Automerge.init<any>(), (x: any) => {
        x.init = true;
      });
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
              ref: { docId: "doc:s1", branch: "main" },
              baseHeads: [],
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

  const subscribeAndExpectBackfill = (ws: WebSocket, consumerId: string) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("deliver timeout")), 5000);
      const send = () => {
        const msg = {
          invocation: {
            iss: "did:key:test",
            cmd: "/storage/subscribe",
            sub: spaceDid,
            args: {
              consumerId,
              query: { docId: "doc:s1", path: [], schema: false },
            },
            prf: [],
          },
          authorization: { signature: [], access: {} },
        };
        ws.send(JSON.stringify(msg));
      };
      if (ws.readyState === WebSocket.OPEN) send();
      else ws.onopen = send;
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

  await Promise.all([
    subscribeAndExpectBackfill(ws1, "c1"),
    subscribeAndExpectBackfill(ws2, "c2"),
  ]);

  // Prepare the tx deliver handler first, then send tx
  let d = Automerge.init<any>();
  d = Automerge.change(d, (x: any) => {
    x.value = 1;
  });
  const c1 = Automerge.getLastLocalChange(d)!;

  // Expect a deliver on both sockets; ack by epoch
  const expectDeliver = (ws: WebSocket) =>
    new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("deliver timeout")), 5000);
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
            clearTimeout(t);
            resolve(m.epoch);
          } catch (err) {
            clearTimeout(t);
            reject(err);
          }
        }
      };
    });

  const changeB64 = btoa(String.fromCharCode(...c1));
  const tx = {
    invocation: {
      iss: "did:key:test",
      cmd: "/storage/tx",
      sub: spaceDid,
      args: {
        reads: [],
        writes: [{
          ref: { docId: "doc:s1", branch: "main" },
          baseHeads: [],
          changes: [{ bytes: changeB64 }],
        }],
      },
      prf: [],
    },
    authorization: { signature: [], access: {} },
  };
  ws1.send(JSON.stringify(tx));

  const [e1, e2] = await Promise.all([expectDeliver(ws1), expectDeliver(ws2)]);
  assert(e1 >= 1 && e2 >= 1);

  ws1.close();
  ws2.close();
  try {
    p.kill();
    await p.status;
  } catch {}
  clearTimeout(watchdog);
});
