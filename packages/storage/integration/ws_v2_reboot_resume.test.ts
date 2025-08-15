import { assert, assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { createGenesisDoc } from "../src/store/genesis.ts";

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function waitOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve) => (ws.onopen = () => resolve()));
}

Deno.test({
  name: "WS v2 reboot: resume with ACK -> no resend, then receive updates",
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
    throw new Error("watchdog timeout ws_v2.reboot_ack");
  }, 15000);

  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const PORT = 8026;
  const spaceDid = "did:key:ws-v2-reboot-ack";
  const wsUrl = `ws://localhost:${PORT}/api/storage/new/v2/${
    encodeURIComponent(spaceDid)
  }/ws`;

  // Start server
  const p = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "./deno.ts"],
    cwd: new URL("../", import.meta.url),
    env: { SPACES_DIR: spacesDir.toString(), PORT: String(PORT) },
  }).spawn();
  await new Promise((r) => setTimeout(r, 400));

  // Two clients connect
  const ws1 = new WebSocket(wsUrl);
  const ws2 = new WebSocket(wsUrl);
  await Promise.all([waitOpen(ws1), waitOpen(ws2)]);

  // First client creates a document
  const docId = "doc:reboot";
  const branch = "main";
  const base = createGenesisDoc<any>(docId, "actor:seed");
  const seeded = Automerge.change(base, (d: any) => {
    d.title = "hello";
  });
  const c1 = Automerge.getLastLocalChange(seeded)!;

  const seedHeads: string[] = Automerge.getHeads(base);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("seed tx timeout")), 3000);
    ws1.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m && m.the === "task/return" && m.is?.txId !== undefined) {
        clearTimeout(t);
        resolve();
      }
    };
    ws1.send(JSON.stringify({
      invocation: {
        iss: "did:key:test",
        cmd: "/storage/tx",
        sub: spaceDid,
        args: {
          reads: [],
          writes: [{
            ref: { docId, branch },
            baseHeads: seedHeads,
            changes: [{ bytes: b64(c1) }],
          }],
        },
        prf: [],
      },
      authorization: { signature: [], access: {} },
    }));
  });

  // Second client says hello (to record a clientId) and subscribes; ACK initial deliver
  const clientId = "client:ack";
  let initialEpoch = -1;
  await waitOpen(ws2);
  ws2.send(JSON.stringify({
    invocation: {
      iss: "did:key:test",
      cmd: "/storage/hello",
      sub: spaceDid,
      args: { clientId, sinceEpoch: -1 },
      prf: [],
    },
    authorization: { signature: [], access: {} },
  }));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("subscribe timeout (ack)")),
      5000,
    );
    let gotDeliver = false;
    ws2.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m && m.type === "deliver") {
        gotDeliver = true;
        initialEpoch = m.epoch as number;
        ws2.send(
          JSON.stringify({ type: "ack", streamId: spaceDid, epoch: m.epoch }),
        );
      }
      if (m && m.the === "task/return" && m.is?.type === "complete") {
        clearTimeout(t);
        if (!gotDeliver) reject(new Error("expected initial deliver"));
        else resolve();
      }
    };
    ws2.send(JSON.stringify({
      invocation: {
        iss: "did:key:test",
        cmd: "/storage/subscribe",
        sub: spaceDid,
        args: { consumerId: "c2", query: { docId, path: [], schema: false } },
        prf: [],
      },
      authorization: { signature: [], access: {} },
    }));
  });

  // Restart server
  try {
    p.kill();
    await p.status;
  } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 200));
  const p2 = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "./deno.ts"],
    cwd: new URL("../", import.meta.url),
    env: { SPACES_DIR: spacesDir.toString(), PORT: String(PORT) },
  }).spawn();
  await new Promise((r) => setTimeout(r, 400));

  // Reconnect clients
  const ws1b = new WebSocket(wsUrl);
  const ws2b = new WebSocket(wsUrl);
  await Promise.all([waitOpen(ws1b), waitOpen(ws2b)]);

  // Second client resumes with sinceEpoch = initialEpoch; expect no resend (only complete)
  ws2b.send(JSON.stringify({
    invocation: {
      iss: "did:key:test",
      cmd: "/storage/hello",
      sub: spaceDid,
      args: { clientId, sinceEpoch: initialEpoch },
      prf: [],
    },
    authorization: { signature: [], access: {} },
  }));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("resubscribe timeout (ack)")),
      5000,
    );
    let sawDeliver = false;
    ws2b.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m && m.type === "deliver") sawDeliver = true;
      if (m && m.the === "task/return" && m.is?.type === "complete") {
        clearTimeout(t);
        if (sawDeliver) {
          reject(new Error("unexpected backfill after resume with ACK"));
        } else resolve();
      }
    };
    ws2b.send(JSON.stringify({
      invocation: {
        iss: "did:key:test",
        cmd: "/storage/subscribe",
        sub: spaceDid,
        args: { consumerId: "c2", query: { docId, path: [], schema: false } },
        prf: [],
      },
      authorization: { signature: [], access: {} },
    }));
  });

  // First client updates document based on earlier state; set listener BEFORE sending
  const after = Automerge.change(seeded, (d: any) => {
    d.count = 1;
  });
  const c2bytes = Automerge.getLastLocalChange(after)!;
  const gotUpdate = await Promise.race([
    new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 8000);
      ws2b.onmessage = (e) => {
        const m = JSON.parse(e.data as string);
        if (m && m.type === "deliver") {
          ws2b.send(
            JSON.stringify({ type: "ack", streamId: spaceDid, epoch: m.epoch }),
          );
          clearTimeout(t);
          resolve(true);
        }
      };
      // send tx after listener armed
      ws1b.send(JSON.stringify({
        invocation: {
          iss: "did:key:test",
          cmd: "/storage/tx",
          sub: spaceDid,
          args: {
            reads: [],
            writes: [{
              ref: { docId, branch },
              baseHeads: Automerge.getHeads(seeded),
              changes: [{ bytes: b64(c2bytes) }],
            }],
          },
          prf: [],
        },
        authorization: { signature: [], access: {} },
      }));
    }),
  ]);
  assert(gotUpdate);

  ws1.close();
  ws2.close();
  ws1b.close();
  ws2b.close();
  try {
    p2.kill();
    await p2.status;
  } catch { /* ignore */ }
  clearTimeout(watchdog);
});

Deno.test({
  name:
    "WS v2 reboot: resume without ACK -> resend on reconnect, then receive updates",
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
    throw new Error("watchdog timeout ws_v2.reboot_noack");
  }, 15000);

  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const PORT = 8027;
  const spaceDid = "did:key:ws-v2-reboot-noack";
  const wsUrl = `ws://localhost:${PORT}/api/storage/new/v2/${
    encodeURIComponent(spaceDid)
  }/ws`;

  // Start server
  const p = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "./deno.ts"],
    cwd: new URL("../", import.meta.url),
    env: { SPACES_DIR: spacesDir.toString(), PORT: String(PORT) },
  }).spawn();
  await new Promise((r) => setTimeout(r, 400));

  // Two clients connect
  const ws1 = new WebSocket(wsUrl);
  const ws2 = new WebSocket(wsUrl);
  await Promise.all([waitOpen(ws1), waitOpen(ws2)]);

  // First client creates a document
  const docId = "doc:reboot2";
  const branch = "main";
  const base = createGenesisDoc<any>(docId, "actor:seed");
  const seeded = Automerge.change(base, (d: any) => {
    d.title = "hello";
  });
  const c1 = Automerge.getLastLocalChange(seeded)!;
  const seedHeads = Automerge.getHeads(base);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("seed tx timeout")), 3000);
    ws1.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m && m.the === "task/return" && m.is?.txId !== undefined) {
        clearTimeout(t);
        resolve();
      }
    };
    ws1.send(JSON.stringify({
      invocation: {
        iss: "did:key:test",
        cmd: "/storage/tx",
        sub: spaceDid,
        args: {
          reads: [],
          writes: [{
            ref: { docId, branch },
            baseHeads: seedHeads,
            changes: [{ bytes: b64(c1) }],
          }],
        },
        prf: [],
      },
      authorization: { signature: [], access: {} },
    }));
  });

  // Second client says hello and subscribes; DO NOT ACK
  const clientId = "client:noack";
  ws2.send(JSON.stringify({
    invocation: {
      iss: "did:key:test",
      cmd: "/storage/hello",
      sub: spaceDid,
      args: { clientId, sinceEpoch: -1 },
      prf: [],
    },
    authorization: { signature: [], access: {} },
  }));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("subscribe timeout (noack)")),
      5000,
    );
    let gotDeliver = false;
    ws2.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m && m.type === "deliver") {
        gotDeliver = true;
        // intentionally do not ACK
      }
      if (m && m.the === "task/return" && m.is?.type === "complete") {
        clearTimeout(t);
        if (!gotDeliver) reject(new Error("expected initial deliver"));
        else resolve();
      }
    };
    ws2.send(JSON.stringify({
      invocation: {
        iss: "did:key:test",
        cmd: "/storage/subscribe",
        sub: spaceDid,
        args: { consumerId: "c2", query: { docId, path: [], schema: false } },
        prf: [],
      },
      authorization: { signature: [], access: {} },
    }));
  });

  // Restart server
  try {
    p.kill();
    await p.status;
  } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 200));
  const p2 = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "./deno.ts"],
    cwd: new URL("../", import.meta.url),
    env: { SPACES_DIR: spacesDir.toString(), PORT: String(PORT) },
  }).spawn();
  await new Promise((r) => setTimeout(r, 400));

  // Reconnect clients
  const ws1b = new WebSocket(wsUrl);
  const ws2b = new WebSocket(wsUrl);
  await Promise.all([waitOpen(ws1b), waitOpen(ws2b)]);

  // Second client issues hello with sinceEpoch = -1 (no resume) and subscribes; expect resend
  ws2b.send(JSON.stringify({
    invocation: {
      iss: "did:key:test",
      cmd: "/storage/hello",
      sub: spaceDid,
      args: { clientId, sinceEpoch: -1 },
      prf: [],
    },
    authorization: { signature: [], access: {} },
  }));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("resubscribe timeout (noack)")),
      6000,
    );
    let delivered = false;
    ws2b.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m && m.type === "deliver") {
        delivered = true;
        // Now ACK to store baseline
        ws2b.send(
          JSON.stringify({ type: "ack", streamId: spaceDid, epoch: m.epoch }),
        );
      }
      if (m && m.the === "task/return" && m.is?.type === "complete") {
        clearTimeout(t);
        if (!delivered) {
          reject(new Error("expected backfill after reboot without ACK"));
        } else resolve();
      }
    };
    ws2b.send(JSON.stringify({
      invocation: {
        iss: "did:key:test",
        cmd: "/storage/subscribe",
        sub: spaceDid,
        args: { consumerId: "c2", query: { docId, path: [], schema: false } },
        prf: [],
      },
      authorization: { signature: [], access: {} },
    }));
  });

  // First client updates document; expect update to arrive to second (arm listener first)
  const after = Automerge.change(seeded, (d: any) => {
    d.bump = 1;
  });
  const c2bytes = Automerge.getLastLocalChange(after)!;
  const gotUpdate = await Promise.race([
    new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 8000);
      ws2b.onmessage = (e) => {
        const m = JSON.parse(e.data as string);
        if (m && m.type === "deliver") {
          ws2b.send(
            JSON.stringify({ type: "ack", streamId: spaceDid, epoch: m.epoch }),
          );
          clearTimeout(t);
          resolve(true);
        }
      };
      ws1b.send(JSON.stringify({
        invocation: {
          iss: "did:key:test",
          cmd: "/storage/tx",
          sub: spaceDid,
          args: {
            reads: [],
            writes: [{
              ref: { docId, branch },
              baseHeads: Automerge.getHeads(seeded),
              changes: [{ bytes: b64(c2bytes) }],
            }],
          },
          prf: [],
        },
        authorization: { signature: [], access: {} },
      }));
    }),
  ]);
  assert(gotUpdate);

  ws1.close();
  ws2.close();
  ws1b.close();
  ws2b.close();
  try {
    p2.kill();
    await p2.status;
  } catch { /* ignore */ }
  clearTimeout(watchdog);
});
