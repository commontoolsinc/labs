/**
 * Expected sequence (WS v2: get-only returns complete and no deliver)
 *
 * 1. Start WS v2 server on an ephemeral port.
 * 2. Start two connections.
 * 3. First the first connection, seed the document using deterministic genesis:
 *    - createGenesisDoc(doc:s1)
 *    - send /storage/tx with baseHeads=[genesis] and a single change.
 * 3. One the second send /storage/get with query {docId:"doc:s1", path:[],
 *    schema:false}.
 * 4. Expect a content deliver followed by task/return with is.type ===
 *    "complete".
 * 5. On the first connection, make another change on the document and send a
 *    transaction.
 * 6. From now on, fail if there are any updates for doc:s1 on the second
 *    connection.
 * 7. On the first connection, create doc:s2 (again, as always, using
 *    createGenesisDoc) and send it as transaction.
 * 8. On the second connection, send /storage/get with query {docId:"doc:s2",
 *    path:[], schema:false}.
 * 9. Expect a content delivery of doc:s2 only and task/return with is.type ===
 *    "complete".
 */
import { assertEquals, assertRejects } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { computeGenesisHead, createGenesisDoc } from "../src/store/genesis.ts";

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
  const waitOpen = (sock: WebSocket) =>
    new Promise<void>((resolve) => {
      if (sock.readyState === WebSocket.OPEN) return resolve();
      sock.onopen = () => resolve();
    });

  // Seed the doc/branch first using a separate websocket to avoid dynamic lib leaks
  let seedHeads: string[] = [];
  let seededDoc: Automerge.Doc<any> | null = null;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("seed timeout")), 3000);
    const wsSeed = new WebSocket(
      `ws://localhost:${PORT}/api/storage/new/v2/${
        encodeURIComponent(spaceDid)
      }/ws`,
    );
    wsSeed.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m && m.the === "task/return" && m.is?.txId !== undefined) {
        seedHeads = m.is?.results?.[0]?.newHeads ?? [];
        clearTimeout(t);
        wsSeed.close();
        resolve();
      }
    };
    wsSeed.onopen = () => {
      const docId = "doc:s1";
      const base = createGenesisDoc<any>(docId);
      const after = Automerge.change(base, (x: any) => {
        x.seed = true;
      });
      const c1 = Automerge.getLastLocalChange(after)!;
      seededDoc = after as any;
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
              changes: [{ bytes: btoa(String.fromCharCode(...c1)) }],
            }],
          },
          prf: [],
        },
        authorization: { signature: [], access: {} },
      }));
    };
  });

  // Now open the client connection for get-only operations
  const ws = new WebSocket(
    `ws://localhost:${PORT}/api/storage/new/v2/${
      encodeURIComponent(spaceDid)
    }/ws`,
  );
  await waitOpen(ws);

  // Expect one deliver (current snapshot or delta) followed by complete; then ensure no further delivers
  let sawInitialDeliver = false;
  const decodeB64 = (s: string): Uint8Array => {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("complete timeout")), 7000);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m && m.type === "deliver") {
        // Validate payload shape under new protocol
        if (Array.isArray(m.docs) && m.docs.length > 0) {
          const d = m.docs[0];
          if (d.kind === "snapshot") {
            // Should be base64 automerge bytes
            const _bytes = decodeB64(d.body as string);
            // consume bytes to avoid linter warning
            if (_bytes.length < 0) {
              // no-op
            }
          } else if (d.kind === "delta") {
            // If server chose to send delta, it must be array of base64 change bytes
            const _changes = (d.body as string[]).map(decodeB64);
            if (_changes.length < 0) {
              // no-op
            }
          }
        }
        sawInitialDeliver = true;
      }
      if (m && m.the === "task/return" && m.is?.type === "complete") {
        clearTimeout(t);
        resolve();
      }
    };
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
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else ws.onopen = () => ws.send(JSON.stringify(msg));
  });
  if (!sawInitialDeliver) throw new Error("expected initial deliver for get");

  // Now ensure we do not receive any deliver frames in a short window
  // Produce next change by editing the locally seeded doc
  const docId = "doc:s1";
  let cur = Automerge.change(seededDoc as any, (x: any) => {
    x.bump = (x.bump || 0) + 1;
  });
  const nextChange = Automerge.getLastLocalChange(cur)!;
  const sendTx = {
    invocation: {
      iss: "did:key:test",
      cmd: "/storage/tx",
      sub: spaceDid,
      args: {
        reads: [],
        writes: [{
          ref: { docId: "doc:s1", branch: "main" },
          baseHeads: seedHeads,
          changes: [{ bytes: btoa(String.fromCharCode(...nextChange)) }],
        }],
      },
      prf: [],
    },
    authorization: { signature: [], access: {} },
  };
  ws.send(JSON.stringify(sendTx));
  const noMore = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => resolve(), 1000);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m && m.type === "deliver") {
        clearTimeout(t);
        reject(new Error("unexpected deliver after get complete"));
      }
    };
  });
  await noMore;

  // Create a second document on the first connection
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("seed s2 timeout")), 3000);
    const s2 = new WebSocket(
      `ws://localhost:${PORT}/api/storage/new/v2/${
        encodeURIComponent(spaceDid)
      }/ws`,
    );
    s2.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m && m.the === "task/return" && m.is?.txId !== undefined) {
        clearTimeout(t);
        resolve();
        s2.close();
      }
    };
    s2.onopen = () => {
      const docId2 = "doc:s2";
      const base2 = createGenesisDoc<any>(docId2);
      const after2 = Automerge.change(base2, (x: any) => {
        x.seed = true;
      });
      const c2 = Automerge.getLastLocalChange(after2)!;
      const changeB64_2 = btoa(String.fromCharCode(...c2));
      s2.send(JSON.stringify({
        invocation: {
          iss: "did:key:test",
          cmd: "/storage/tx",
          sub: spaceDid,
          args: {
            reads: [],
            writes: [{
              ref: { docId: docId2, branch: "main" },
              baseHeads: [computeGenesisHead(docId2)],
              changes: [{ bytes: changeB64_2 }],
            }],
          },
          prf: [],
        },
        authorization: { signature: [], access: {} },
      }));
    };
  });

  // Issue a second get for doc:s2 and expect only s2 delivered and then complete
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("second get timeout")), 5000);
    let sawDeliverForS2 = false;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m && m.type === "deliver") {
        const docIds = new Set((m.docs ?? []).map((d: any) => d.docId));
        if (docIds.size !== 1 || !docIds.has("doc:s2")) {
          clearTimeout(t);
          reject(new Error("expected deliver for only doc:s2"));
          return;
        }
        sawDeliverForS2 = true;
      }
      if (m && m.the === "task/return" && m.is?.type === "complete") {
        if (!sawDeliverForS2) {
          clearTimeout(t);
          reject(new Error("expected initial deliver for get doc:s2"));
          return;
        }
        clearTimeout(t);
        resolve();
      }
    };
    const msg = {
      invocation: {
        iss: "did:key:test",
        cmd: "/storage/get",
        sub: spaceDid,
        args: {
          consumerId: "g2",
          query: { docId: "doc:s2", path: [], schema: false },
        },
        prf: [],
      },
      authorization: { signature: [], access: {} },
    };
    // Ensure the socket is open and previous listeners won't interfere
    // Socket is already open here, just send
    ws.send(JSON.stringify(msg));
  });

  ws.close();
  try {
    p.kill();
    await p.status;
  } catch {
    // ignore
  }
  clearTimeout(watchdog);
});
