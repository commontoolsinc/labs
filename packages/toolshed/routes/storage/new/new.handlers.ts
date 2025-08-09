import type { AppRouteHandler } from "@/lib/types.ts";
import type { SpaceStorage } from "@commontools/storage/interface";
import { openSqlite } from "@commontools/storage/src/sqlite/db.ts";
// TODO(#storage-sqlite): wire to SQLite-backed SpaceStorage factory when available

const spaces = new Map<string, SpaceStorage>();

function getSpace(spaceDid: string): SpaceStorage {
  const s = spaces.get(spaceDid);
  if (!s) {
    throw new Error("Space storage not initialized (SQLite provider pending)");
  }
  return s;
}

export const createDoc: AppRouteHandler<
  typeof import("./new.routes.ts").createDoc
> = async (c: any) => {
  const { space } = c.req.param();
  const { docId, branch } = await c.req.json();
  const s = getSpace(space);
  await s.getOrCreateBranch(docId, branch ?? "main");
  return c.json({ ok: true });
};

export const heads: AppRouteHandler<typeof import("./new.routes.ts").heads> =
  async (c: any) => {
    const { space, docId } = c.req.param();
    const branch = c.req.query("branch") ?? "main";
    const s = getSpace(space);
    const st = await s.getBranchState(docId, branch);
    return c.json({
      docId,
      branch,
      heads: [...st.heads],
      seq_no: st.seqNo,
      epoch: st.epoch,
      root_ref: st.rootRef,
    });
  };

function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const tx: AppRouteHandler<typeof import("./new.routes.ts").tx> = async (
  c: any,
) => {
  const { space } = c.req.param();
  const body = await c.req.json();
  const s = getSpace(space);
  const req = {
    reads: body.reads,
    writes: body.writes.map((w: any) => ({
      ref: w.ref,
      baseHeads: w.baseHeads,
      changes: (w.changes as string[]).map((b64) => ({
        bytes: decodeBase64(b64),
      })),
    })),
  };
  const receipt = await s.submitTx(req);
  return c.json({ ok: true, receipt });
};

// Single WS endpoint for storage
export async function wsHandler(c: any) {
  const { space } = c.req.param();
  const spacesDir = new URL(Deno.env.get("SPACES_DIR") ?? `file://./.spaces/`);
  await Deno.mkdir(spacesDir, { recursive: true }).catch(() => {});
  const { db } = await openSqlite({ url: new URL(`./${space}.sqlite`, spacesDir) });

  const { socket, response } = Deno.upgradeWebSocket(c.req.raw);

  let subscriptionId: number | null = null;
  let lastSentDelivery = 0;
  let closed = false;

  socket.onmessage = (ev: MessageEvent) => {
    try {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
      if (msg.type === 'subscribe') {
        const consumerId: string = msg.consumerId;
        const query = msg.query ?? {};
        // upsert subscription by (space, consumer)
        const row = db.prepare(
          `SELECT id FROM subscriptions WHERE space_id = :space_id AND consumer_id = :consumer_id LIMIT 1`
        ).get({ space_id: space, consumer_id: consumerId }) as { id: number } | undefined;
        if (row) {
          subscriptionId = row.id;
          db.run(`UPDATE subscriptions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id`, { id: subscriptionId });
        } else {
          db.run(
            `INSERT INTO subscriptions(space_id, query_json, consumer_id) VALUES(:space_id, :query_json, :consumer_id)`,
            { space_id: space, query_json: JSON.stringify(query), consumer_id: consumerId },
          );
          const got = db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number };
          subscriptionId = got.id;
        }
        // find last acked delivery
        const lastAck = db.prepare(
          `SELECT MAX(delivery_no) AS last FROM subscription_deliveries WHERE subscription_id = :sid AND acked = 1`
        ).get({ sid: subscriptionId }) as { last: number } | undefined;
        lastSentDelivery = lastAck?.last ?? 0;
        socket.send(JSON.stringify({ type: 'subscribed', subscriptionId }));
      } else if (msg.type === 'ack') {
        if (!subscriptionId) return;
        const deliveryNo: number = msg.deliveryNo;
        db.run(
          `UPDATE subscription_deliveries SET acked = 1 WHERE subscription_id = :sid AND delivery_no = :dno`,
          { sid: subscriptionId, dno: deliveryNo },
        );
      }
    } catch (e) {
      console.error('ws message error', e);
    }
  };

  async function pump() {
    while (!closed) {
      try {
        if (subscriptionId) {
          const rows = db.prepare(
            `SELECT delivery_no, payload FROM subscription_deliveries WHERE subscription_id = :sid AND delivery_no > :last ORDER BY delivery_no ASC`
          ).all({ sid: subscriptionId, last: lastSentDelivery }) as { delivery_no: number; payload: Uint8Array }[];
          for (const r of rows) {
            lastSentDelivery = r.delivery_no;
            const payloadStr = new TextDecoder().decode(r.payload);
            socket.send(JSON.stringify({ type: 'deliver', subscriptionId, deliveryNo: r.delivery_no, payload: JSON.parse(payloadStr) }));
          }
        }
        await new Promise((res) => setTimeout(res, 50));
      } catch (e) {
        console.error('ws pump error', e);
        await new Promise((res) => setTimeout(res, 100));
      }
    }
  }

  socket.onclose = () => { closed = true; };
  socket.onerror = () => { closed = true; };

  pump();
  return response;
}
