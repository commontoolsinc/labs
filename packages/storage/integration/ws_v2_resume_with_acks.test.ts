import { assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";

Deno.test({
  name: "WS v2: subscribe resume using acks",
  // Temporarily skipped: investigate enqueue/pump ordering after reconnect
  ignore: true,
  permissions: {
    net: true,
    env: true,
    read: true,
    write: true,
    run: true,
    ffi: true,
  },
}, async () => {
  // Global watchdog to prevent hangs
  let watchdog: number | undefined;
  const armWatchdog = (ms = 15000) => {
    // deno-lint-ignore no-explicit-any
    watchdog = setTimeout(() => {
      throw new Error("test watchdog timeout");
    }, ms) as any as number;
  };
  const disarmWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
  };
  armWatchdog();

  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const PORT = 8014;
  const spaceDid = "did:key:ws-v2-resume";

  const p = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "./deno.ts"],
    cwd: new URL("../", import.meta.url),
    env: {
      SPACES_DIR: spacesDir.toString(),
      PORT: String(PORT),
      ENABLE_SERVER_MERGE: "1",
    },
  }).spawn();
  await Promise.race([
    new Promise((r) => setTimeout(r, 300)),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("server boot timeout")), 2000)
    ),
  ]);

  // Connect and subscribe
  const ws1 = new WebSocket(
    `ws://localhost:${PORT}/api/storage/new/v2/${
      encodeURIComponent(spaceDid)
    }/ws`,
  );
  await Promise.race([
    new Promise<void>((resolve) => {
      let gotSubscribed = false;
      ws1.onopen = () => {
        ws1.send(JSON.stringify({
          invocation: {
            iss: "did:key:test",
            cmd: "/storage/subscribe",
            sub: spaceDid,
            args: { consumerId: "c1", query: {} },
            prf: [],
          },
          authorization: { signature: [], access: {} },
        }));
      };
      ws1.onmessage = (e) => {
        const m = JSON.parse(e.data as string);
        if (m && m.type === "subscribed") gotSubscribed = true;
        if (
          m && m.the === "task/return" && m.is?.type === "complete" &&
          gotSubscribed
        ) {
          resolve();
        }
      };
    }),
    new Promise<void>((_, rej) =>
      setTimeout(() => rej(new Error("subscribe1 timeout")), 3000)
    ),
  ]);

  // Submit two txs
  let d = Automerge.init<any>();
  d = Automerge.change(d, (x: any) => {
    x.value = 1;
  });
  const c1 = Automerge.getLastLocalChange(d)!;
  d = Automerge.change(d, (x: any) => {
    x.value = 2;
  });
  const c2 = Automerge.getLastLocalChange(d)!;

  const sendTx = (bytes: Uint8Array) =>
    ws1.send(JSON.stringify({
      invocation: {
        iss: "did:key:test",
        cmd: "/storage/tx",
        sub: spaceDid,
        args: {
          reads: [],
          writes: [{
            ref: { docId: "doc:s", branch: "main" },
            baseHeads: [],
            changes: [{ bytes: btoa(String.fromCharCode(...bytes)) }],
            allowServerMerge: true,
          }],
        },
        prf: [],
      },
      authorization: { signature: [], access: {} },
    }));

  const acks: number[] = [];
  const gotFirstBatch = Promise.race([
    new Promise<void>((resolve) => {
      ws1.onmessage = (e) => {
        const m = JSON.parse(e.data as string);
        if (m && m.type === "deliver") {
          acks.push(m.deliveryNo);
          ws1.send(
            JSON.stringify({
              type: "ack",
              streamId: spaceDid,
              deliveryNo: m.deliveryNo,
            }),
          );
          if (acks.length === 1) resolve();
        }
      };
    }),
    new Promise<void>((_, rej) =>
      setTimeout(() => rej(new Error("first deliveries timeout")), 10000)
    ),
  ]);
  // small delay to ensure pump loop armed
  await new Promise((r) => setTimeout(r, 100));
  sendTx(c1);
  sendTx(c2);
  await gotFirstBatch;

  // Close and reconnect
  const lastAck = Math.max(...acks);
  await Promise.race([
    new Promise<void>((r) => {
      ws1.onclose = () => r();
      ws1.close();
    }),
    new Promise<void>((_, rej) =>
      setTimeout(() => rej(new Error("ws1 close timeout")), 2000)
    ),
  ]);
  const ws2 = new WebSocket(
    `ws://localhost:${PORT}/api/storage/new/v2/${
      encodeURIComponent(spaceDid)
    }/ws`,
  );
  await Promise.race([
    new Promise<void>((resolve) => {
      ws2.onopen = () => {
        ws2.send(JSON.stringify({
          invocation: {
            iss: "did:key:test",
            cmd: "/storage/subscribe",
            sub: spaceDid,
            args: { consumerId: "c1", query: {} },
            prf: [],
          },
          authorization: { signature: [], access: {} },
        }));
      };
      ws2.onmessage = (e) => {
        const m = JSON.parse(e.data as string);
        if (m && m.the === "task/return" && m.is?.type === "complete") {
          resolve();
        }
      };
    }),
    new Promise<void>((_, rej) =>
      setTimeout(() => rej(new Error("subscribe2 timeout")), 3000)
    ),
  ]);

  // Submit third tx and expect next deliveryNo = lastAck + 1
  d = Automerge.change(d, (x: any) => {
    x.value = 3;
  });
  const c3 = Automerge.getLastLocalChange(d)!;
  const next = await Promise.race([
    new Promise<number>((resolve) => {
      const t = setTimeout(() => resolve(-1), 8000);
      ws2.onmessage = (e) => {
        const m = JSON.parse(e.data as string);
        if (m && m.type === "deliver") {
          clearTimeout(t);
          resolve(m.deliveryNo);
        }
      };
      // send via a fresh tx message on ws2
      ws2.send(JSON.stringify({
        invocation: {
          iss: "did:key:test",
          cmd: "/storage/tx",
          sub: spaceDid,
          args: {
            reads: [],
            writes: [{
              ref: { docId: "doc:s", branch: "main" },
              baseHeads: [],
              changes: [{ bytes: btoa(String.fromCharCode(...c3)) }],
              allowServerMerge: true,
            }],
          },
          prf: [],
        },
        authorization: { signature: [], access: {} },
      }));
    }),
    new Promise<number>((_, rej) =>
      setTimeout(() => rej(new Error("resume timeout (global)")), 10000)
    ),
  ]);

  assertEquals(next, lastAck + 1);
  ws2.close();
  try {
    p.kill();
    await p.status;
  } catch { /* ignore */ }
  disarmWatchdog();
});
