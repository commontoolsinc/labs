import { assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../src/provider.ts";

Deno.test({
  name: "WS subscriptions: ordering, acks, resume, multi-consumer",
  permissions: { net: true, env: true, read: true, write: true },
}, async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  Deno.env.set("SPACES_DIR", spacesDir.toString());
  Deno.env.set("ENABLE_NEW_STORAGE", "1");

  // Start toolshed server
  const p = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "../../toolshed/index.ts"],
    cwd: new URL("../../toolshed/", import.meta.url),
  }).spawn();

  // Small delay to boot
  await new Promise((r) => setTimeout(r, 500));

  try {
    const spaceDid = "did:key:ws-sub-test";
    const space = await openSpaceStorage(spaceDid, { spacesDir });

    // Create doc and submit changes
    const docId = "doc:s1";
    const branch = "main";
    await space.getOrCreateBranch(docId, branch);
    let d = Automerge.change(Automerge.init<any>(), (x) => {
      x.value = 1;
    });
    const c1 = Automerge.getLastLocalChange(d)!;
    d = Automerge.change(
      Automerge.load(Automerge.save(Automerge.from({ value: 1 }) as any)),
      (x: any) => {
        x.value = 2;
      },
    );
    const c2 = Automerge.getLastLocalChange(d)!;

    // Connect two consumers
    const ws1 = new WebSocket(
      `ws://localhost:8000/api/storage/new/v1/${
        encodeURIComponent(spaceDid)
      }/ws`,
    );
    const ws2 = new WebSocket(
      `ws://localhost:8000/api/storage/new/v1/${
        encodeURIComponent(spaceDid)
      }/ws`,
    );

    const deliveries1: any[] = [];
    const deliveries2: any[] = [];

    await new Promise<void>((resolve) => {
      let ready = 0;
      function readyInc() {
        ready += 1;
        if (ready === 2) resolve();
      }
      ws1.onopen = () => {
        ws1.send(
          JSON.stringify({ type: "subscribe", consumerId: "c1", query: {} }),
        );
      };
      ws2.onopen = () => {
        ws2.send(
          JSON.stringify({ type: "subscribe", consumerId: "c2", query: {} }),
        );
      };
      ws1.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "subscribed") readyInc();
      };
      ws2.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "subscribed") readyInc();
      };
    });

    // Submit two txs
    await space.submitTx({
      reads: [],
      writes: [{
        ref: { docId, branch },
        baseHeads: [],
        changes: [{ bytes: c1 }],
      }],
    });
    await space.submitTx({
      reads: [],
      writes: [{
        ref: { docId, branch },
        baseHeads: [],
        changes: [{ bytes: c2 }],
      }],
    });

    // Collect deliveries and ack
    const acked1: number[] = [];
    const acked2: number[] = [];
    const done = new Promise<void>((resolve) => {
      function maybeDone() {
        if (deliveries1.length >= 2 && deliveries2.length >= 2) resolve();
      }
      ws1.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "deliver") {
          deliveries1.push(m);
          acked1.push(m.deliveryNo);
          ws1.send(
            JSON.stringify({
              type: "ack",
              subscriptionId: m.subscriptionId,
              deliveryNo: m.deliveryNo,
            }),
          );
          maybeDone();
        }
      };
      ws2.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "deliver") {
          deliveries2.push(m);
          acked2.push(m.deliveryNo);
          ws2.send(
            JSON.stringify({
              type: "ack",
              subscriptionId: m.subscriptionId,
              deliveryNo: m.deliveryNo,
            }),
          );
          maybeDone();
        }
      };
    });

    await Promise.race([
      done,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("timeout")), 5000)
      ),
    ]);

    // Verify ordering and no duplication
    const nos1 = deliveries1.map((d) => d.deliveryNo);
    const nos2 = deliveries2.map((d) => d.deliveryNo);
    assertEquals(nos1, [...nos1].sort((a, b) => a - b));
    assertEquals(nos2, [...nos2].sort((a, b) => a - b));

    // Close ws1 and reconnect to test resume
    ws1.close();
    const ws1b = new WebSocket(
      `ws://localhost:8000/api/storage/new/v1/${
        encodeURIComponent(spaceDid)
      }/ws`,
    );
    await new Promise<void>((resolve) => {
      ws1b.onopen = () => {
        ws1b.send(
          JSON.stringify({ type: "subscribe", consumerId: "c1", query: {} }),
        );
      };
      ws1b.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "subscribed") resolve();
      };
    });

    // Write third change
    let d3 = Automerge.change(Automerge.init<any>(), (x) => {
      x.value = 3;
    });
    const c3 = Automerge.getLastLocalChange(d3)!;
    await space.submitTx({
      reads: [],
      writes: [{
        ref: { docId, branch },
        baseHeads: [],
        changes: [{ bytes: c3 }],
      }],
    });

    const resumeDelivered = await new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("resume timeout")), 5000);
      ws1b.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "deliver") {
          clearTimeout(t);
          resolve(m);
        }
      };
    });

    assertEquals(resumeDelivered.deliveryNo, Math.max(...acked1) + 1);

    ws1b.close();
    ws2.close();
  } finally {
    try {
      p.kill();
    } catch {}
  }
});
