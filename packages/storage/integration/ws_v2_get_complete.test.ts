import { assertEquals, assertRejects } from "@std/assert";
import * as Automerge from "@automerge/automerge";

Deno.test({
  name: "WS v2: get-only returns complete and no deliver",
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
    throw new Error("watchdog timeout ws_v2.get");
  }, 8000);
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const PORT = 8013;

  const p = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "./deno.ts"],
    cwd: new URL("../", import.meta.url),
    env: {
      SPACES_DIR: spacesDir.toString(),
      PORT: String(PORT),
      ENABLE_SERVER_MERGE: "1",
    },
  }).spawn();

  await new Promise((r) => setTimeout(r, 300));

  const spaceDid = "did:key:ws-v2-get";
  const ws = new WebSocket(
    `ws://localhost:${PORT}/api/storage/new/v2/${
      encodeURIComponent(spaceDid)
    }/ws`,
  );

  // Wait for complete
  // Seed the doc/branch first
  const pre = new WebSocket(
    `ws://localhost:${PORT}/api/storage/new/v2/${
      encodeURIComponent(spaceDid)
    }/ws`,
  );
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("seed timeout")), 3000);
    pre.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m && m.the === "task/return" && m.is?.txId !== undefined) {
        clearTimeout(t);
        resolve();
      }
    };
    pre.onopen = () => {
      const preDoc = Automerge.change(Automerge.init<any>(), (x: any) => {
        x.seed = true;
      });
      const changeB64 = btoa(
        String.fromCharCode(...Automerge.getLastLocalChange(preDoc)!),
      );
      pre.send(JSON.stringify({
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
  pre.close();

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("complete timeout")), 3000);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m && m.the === "task/return" && m.is?.type === "complete") {
        clearTimeout(t);
        resolve();
      }
    };
    ws.onopen = () => {
      const msg = {
        invocation: {
          iss: "did:key:test",
          cmd: "/storage/get",
          sub: spaceDid,
          args: {
            consumerId: "g1",
            query: { docId: "doc:s1", path: [], schema: false },
          },
          prf: [],
        },
        authorization: { signature: [], access: {} },
      };
      ws.send(JSON.stringify(msg));
    };
  });

  // Now ensure we do not receive any deliver frames in a short window
  const noDeliver = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => resolve(), 500);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m && m.type === "deliver") {
        clearTimeout(t);
        reject(new Error("unexpected deliver after get-only"));
      }
    };
  });
  await noDeliver;

  ws.close();
  try {
    p.kill();
    await p.status;
  } catch { /* ignore */ }
  clearTimeout(watchdog);
});
