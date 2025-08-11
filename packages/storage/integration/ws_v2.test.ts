import { assert, assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";

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
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const PORT = 8012;

  // Start storage v2 server
  const p = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "./deno.ts"],
    cwd: new URL("../", import.meta.url),
    env: { SPACES_DIR: spacesDir.toString(), PORT: String(PORT) },
  }).spawn();

  // Small delay to boot
  await new Promise((r) => setTimeout(r, 400));

  const spaceDid = "did:key:ws-v2";
  const ws = new WebSocket(
    `ws://localhost:${PORT}/api/storage/new/v2/${
      encodeURIComponent(spaceDid)
    }/ws`,
  );

  const subscribed = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("subscribe timeout")), 5000);
    ws.onopen = () => {
      const msg = {
        invocation: {
          iss: "did:key:test",
          cmd: "/storage/subscribe",
          sub: spaceDid,
          args: { consumerId: "c1", query: {} },
          prf: [],
        },
        authorization: { signature: [], access: {} },
      };
      ws.send(JSON.stringify(msg));
    };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data as string);
        if (m && m.the === "task/return" && m.is?.type === "complete") {
          clearTimeout(t);
          resolve();
        }
      } catch {
        /* ignore */
      }
    };
  });
  await subscribed;

  // Prepare a small doc change
  const docId = "doc:s1";
  const branch = "main";
  let d = Automerge.init<any>();
  d = Automerge.change(d, (x: any) => {
    x.value = 1;
  });
  const c1 = Automerge.getLastLocalChange(d)!;

  // Submit tx over WS
  const txSent = new Promise<void>((resolve) => {
    const tx = {
      invocation: {
        iss: "did:key:test",
        cmd: "/storage/tx",
        sub: spaceDid,
        args: {
          reads: [],
          writes: [{
            ref: { docId, branch },
            baseHeads: [],
            changes: [{ bytes: c1 }],
          }],
        },
        prf: [],
      },
      authorization: { signature: [], access: {} },
    };
    ws.send(JSON.stringify(tx));
    resolve();
  });
  await txSent;

  // Expect a deliver and ack it
  const gotDeliver = await new Promise<{ deliveryNo: number }>(
    (resolve, reject) => {
      const t = setTimeout(() => reject(new Error("deliver timeout")), 5000);
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data as string);
        if (m && m.type === "deliver") {
          try {
            assert(typeof m.deliveryNo === "number");
            ws.send(
              JSON.stringify({
                type: "ack",
                streamId: spaceDid,
                deliveryNo: m.deliveryNo,
              }),
            );
            clearTimeout(t);
            resolve({ deliveryNo: m.deliveryNo });
          } catch (err) {
            clearTimeout(t);
            reject(err);
          }
        }
      };
    },
  );

  assert(gotDeliver.deliveryNo >= 1);

  ws.close();
  try {
    p.kill();
    await p.status;
  } catch { /* ignore */ }
});
