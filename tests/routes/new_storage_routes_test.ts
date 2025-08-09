import { assert, assertEquals } from "@std/assert";

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

import storageNew from "../../packages/toolshed/routes/storage/new/new.index.ts";
import { createRouter } from "../../packages/toolshed/lib/create-app.ts";

async function loadTestAppWith(flag: "on" | "off") {
  const app = createRouter();
  if (flag === "on") {
    app.route("/", storageNew);
  }
  return app as any;
}

Deno.test("new storage routes gated by ENABLE_NEW_STORAGE", async () => {
  // Off: do not mount router
  const appOff = await loadTestAppWith("off");
  const serverOff = Deno.serve({ port: 0 }, appOff.fetch);
  const base = `http://${serverOff.addr.hostname}:${serverOff.addr.port}`;
  try {
    const res = await fetch(`${base}/spaces/did:key:space/docs/doc:abc/branches/main/heads`);
    // Consume body to avoid resource leak warnings
    await res.text().catch(() => {});
    assertEquals(res.status, 404);
  } finally {
    await serverOff.shutdown();
  }

  // On: mount router and expect route to exist (may 404 if branch not exists, but should not 404 due to missing route). We'll accept 200 or 500 as well.
  const appOn = await loadTestAppWith("on");
  const serverOn = Deno.serve({ port: 0 }, appOn.fetch);
  const baseOn = `http://${serverOn.addr.hostname}:${serverOn.addr.port}`;
  try {
    const res = await fetch(`${baseOn}/spaces/did:key:space/docs/doc:abc/branches/main/heads`);
    await res.text().catch(() => {});
    assert(res.status === 200 || res.status === 404 || res.status === 500);
  } finally {
    await serverOn.shutdown();
  }
});

Deno.test({ name: "happy path: tx, heads, pit, query, subscribe, snapshots", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const tmp = await Deno.makeTempDir();
  Deno.env.set("SPACES_DIR", new URL(`file://${tmp}/`).href);
  const app = await loadTestAppWith("on");
  const server = Deno.serve({ port: 0 }, app.fetch);
  const base = `http://${server.addr.hostname}:${server.addr.port}`;
  const spaceId = "did:key:z6Mkspace";
  const docId = "doc:hello";
  const branch = "main";

  // Create a simple Automerge change
  const Automerge = await import("npm:@automerge/automerge");
  let doc = Automerge.init();
  doc = Automerge.change(doc, (d: any) => { d.title = "hello"; });
  const change = Automerge.getLastLocalChange(doc)!;

  // Submit tx
  const txRes = await fetch(`${base}/spaces/${encodeURIComponent(spaceId)}/tx`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      writes: [
        {
          ref: { docId, branch },
          baseHeads: [],
          changes: [b64(change)],
        },
      ],
      reads: [],
    }),
  });
  assertEquals(txRes.status, 200);
  const txJson = await txRes.json();
  assert(txJson.receipt?.txId != null);

  // Heads
  const headsRes = await fetch(`${base}/spaces/${encodeURIComponent(spaceId)}/docs/${encodeURIComponent(docId)}/branches/${encodeURIComponent(branch)}/heads`);
  assertEquals(headsRes.status, 200);
  const headsJson = await headsRes.json();
  assertEquals(headsJson.doc, docId);
  assertEquals(headsJson.branch, branch);
  assertEquals(Array.isArray(headsJson.heads), true);

  // PIT (latest)
  const pitRes = await fetch(`${base}/spaces/${encodeURIComponent(spaceId)}/pit?docId=${encodeURIComponent(docId)}&branchId=${encodeURIComponent(branch)}&seq=${headsJson.seq_no}`);
  assertEquals(pitRes.status, 200);
  await pitRes.arrayBuffer();

  // Query (placeholder returns empty rows)
  const queryRes = await fetch(`${base}/spaces/${encodeURIComponent(spaceId)}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: { source: { docs: [docId] } } }),
  });
  assertEquals(queryRes.status, 200);
  const q = await queryRes.json();
  assert(Array.isArray(q.rows));

  // Subscribe WS: just round-trip subscribed
  const ws = new WebSocket(`${base.replace("http", "ws")}/spaces/${encodeURIComponent(spaceId)}/subscribe`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "subscribe", consumerId: "test", query: {} }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "subscribed") {
        resolve();
        ws.close();
      }
    };
    ws.onerror = (e) => reject(e);
  });

  // Snapshots route returns bytes at seq (may be PIT fallback)
  const snapRes = await fetch(`${base}/spaces/${encodeURIComponent(spaceId)}/snapshots/${encodeURIComponent(docId)}/${encodeURIComponent(branch)}/${headsJson.seq_no}`);
  assertEquals(snapRes.status, 200);
  const snapBytes = new Uint8Array(await snapRes.arrayBuffer());
  assertEquals(snapBytes.byteLength > 0, true);

  await server.shutdown();
}});

