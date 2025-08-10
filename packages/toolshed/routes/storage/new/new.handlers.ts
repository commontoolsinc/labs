import type { AppRouteHandler } from "@/lib/types.ts";
import type { SpaceStorage } from "../../../../storage/src/interface.ts";
import { openSpaceStorage } from "@commontools/storage";
import { openSqlite } from "../../../../storage/src/store/db.ts";

const spaces = new Map<string, Promise<SpaceStorage>>();

async function getSpace(spaceDid: string): Promise<SpaceStorage> {
  let s = spaces.get(spaceDid);
  if (!s) {
    let spacesDir: URL;
    const envDir = Deno.env.get("SPACES_DIR");
    if (envDir) {
      spacesDir = new URL(envDir);
    } else {
      const cwd = Deno.cwd();
      const url = new URL(
        `.spaces/`,
        `file://${cwd.endsWith("/") ? cwd : cwd + "/"}`,
      );
      spacesDir = url;
    }
    await Deno.mkdir(spacesDir, { recursive: true }).catch(() => {});
    s = openSpaceStorage(spaceDid, { spacesDir });
    spaces.set(spaceDid, s);
  }
  return await s;
}

export const heads: AppRouteHandler<typeof import("./new.routes.ts").heads> =
  async (c: any) => {
    const { spaceId, docId, branchId } = c.req.param();
    const s = await getSpace(spaceId);
    const st = await s.getBranchState(docId, branchId);
    return c.json({
      doc: docId,
      branch: branchId,
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
  const { spaceId } = c.req.param();
  const body = await c.req.json();
  const s = await getSpace(spaceId);
  const req = {
    clientTxId: body.clientTxId,
    reads: (body.reads ?? []),
    writes: body.writes.map((w: any) => ({
      ref: w.ref,
      baseHeads: w.baseHeads,
      changes: (w.changes as string[]).map((b64) => ({
        bytes: decodeBase64(b64),
      })),
    })),
  };
  const receipt = await s.submitTx(req);
  return c.json({ receipt });
};

export const pit: AppRouteHandler<typeof import("./new.routes.ts").pit> =
  async (
    c: any,
  ) => {
    const { spaceId } = c.req.param();
    const { docId, branchId } = c.req.query();
    const seq = Number(c.req.query("seq"));
    const envDir = Deno.env.get("SPACES_DIR");
    const base = envDir
      ? new URL(envDir)
      : new URL(`.spaces/`, `file://${Deno.cwd()}/`);
    const { db } = await openSqlite({
      url: new URL(`./${spaceId}.sqlite`, base),
    });
    const { getAutomergeBytesAtSeq } = await import(
      "../../../../storage/src/store/pit.ts"
    );
    const bytes = getAutomergeBytesAtSeq(db, null, docId, branchId, seq);
    return new Response(bytes, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
  };

export const query: AppRouteHandler<typeof import("./new.routes.ts").query> =
  async (
    c: any,
  ) => {
    // Minimal placeholder: return empty results for now; evaluator lives in storage pkg but is not exported
    return c.json({ rows: [] });
  };

// Single WS endpoint for subscriptions
export async function wsHandler(c: any) {
  const { spaceId } = c.req.param();
  const envDir = Deno.env.get("SPACES_DIR");
  const base = envDir
    ? new URL(envDir)
    : new URL(`.spaces/`, `file://${Deno.cwd()}/`);
  await Deno.mkdir(base, { recursive: true }).catch(() => {});
  const dbFile = new URL(`./${spaceId}.sqlite`, base);
  console.log(`[ws] opening DB for space ${spaceId} at ${dbFile.href}`);
  const { db } = await openSqlite({ url: dbFile });

  const { socket, response } = Deno.upgradeWebSocket(c.req.raw);

  let subscriptionId: number | null = null;
  let lastSentDelivery = 0;
  let closed = false;

  socket.onmessage = (ev: MessageEvent) => {
    try {
      const msg = JSON.parse(
        typeof ev.data === "string"
          ? ev.data
          : new TextDecoder().decode(ev.data),
      );
      if (msg.type === "subscribe") {
        const consumerId: string = msg.consumerId;
        const query = msg.query ?? {};
        // upsert subscription by (space, consumer)
        const row = db.prepare(
          `SELECT id FROM subscriptions WHERE space_id = :space_id AND consumer_id = :consumer_id LIMIT 1`,
        ).get({ space_id: spaceId, consumer_id: consumerId }) as
          | { id: number }
          | undefined;
        if (row) {
          subscriptionId = row.id;
          db.run(
            `UPDATE subscriptions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id`,
            { id: subscriptionId },
          );
        } else {
          db.run(
            `INSERT INTO subscriptions(space_id, query_json, consumer_id) VALUES(:space_id, :query_json, :consumer_id)`,
            {
              space_id: spaceId,
              query_json: JSON.stringify(query),
              consumer_id: consumerId,
            },
          );
          const got = db.prepare(`SELECT last_insert_rowid() AS id`).get() as {
            id: number;
          };
          subscriptionId = got.id;
        }
        // find last acked delivery
        const lastAck = db.prepare(
          `SELECT MAX(delivery_no) AS last FROM subscription_deliveries WHERE subscription_id = :sid AND acked = 1`,
        ).get({ sid: subscriptionId }) as { last: number } | undefined;
        lastSentDelivery = lastAck?.last ?? 0;
        console.log(
          `[ws] subscribed sid=${subscriptionId} lastAck=${lastSentDelivery}`,
        );
        socket.send(JSON.stringify({ type: "subscribed", subscriptionId }));
      } else if (msg.type === "ack") {
        if (!subscriptionId) return;
        const deliveryNo: number = msg.deliveryNo;
        db.run(
          `UPDATE subscription_deliveries SET acked = 1 WHERE subscription_id = :sid AND delivery_no = :dno`,
          { sid: subscriptionId, dno: deliveryNo },
        );
        console.log(`[ws] ack sid=${subscriptionId} dno=${deliveryNo}`);
      }
    } catch (e) {
      console.error("ws message error", e);
    }
  };

  async function pump() {
    const BATCH_LIMIT = 100; // max deliveries per tick
    const MAX_BUFFERED = 1_000_000; // ~1MB buffered bytes threshold
    while (!closed) {
      try {
        if (subscriptionId) {
          const rows = db.prepare(
            `SELECT delivery_no, payload FROM subscription_deliveries WHERE subscription_id = :sid AND delivery_no > :last ORDER BY delivery_no ASC LIMIT :lim`,
          ).all({
            sid: subscriptionId,
            last: lastSentDelivery,
            lim: BATCH_LIMIT,
          }) as { delivery_no: number; payload: Uint8Array }[];
          if (rows.length > 0) {
            console.log(
              `[ws] pump found ${rows.length} deliveries starting at ${
                lastSentDelivery + 1
              }`,
            );
          }
          for (const r of rows) {
            if (closed) break;
            lastSentDelivery = r.delivery_no;
            const payloadStr = new TextDecoder().decode(r.payload);
            const msg = JSON.stringify({
              type: "deliver",
              subscriptionId,
              deliveryNo: r.delivery_no,
              payload: JSON.parse(payloadStr),
            });
            // backpressure: if buffered too high, wait
            const buffered = (socket as any).bufferedAmount ?? 0;
            if (buffered > MAX_BUFFERED) {
              await new Promise((res) => setTimeout(res, 50));
            }
            socket.send(msg);
          }
        }
        await new Promise((res) => setTimeout(res, 50));
      } catch (e) {
        console.error("ws pump error", e);
        await new Promise((res) => setTimeout(res, 100));
      }
    }
  }

  socket.onclose = () => {
    closed = true;
    console.log("[ws] closed");
  };
  socket.onerror = (e) => {
    closed = true;
    console.error("[ws] error", e);
  };

  pump();
  return response;
}

export const snapshot: AppRouteHandler<
  typeof import("./new.routes.ts").snapshot
> = async (c: any) => {
  const { spaceId, docId, branchId, seq } = c.req.param();
  const spacesDir = new URL(Deno.env.get("SPACES_DIR") ?? `file://./.spaces/`);
  const { db } = await openSqlite({
    url: new URL(`./${spaceId}.sqlite`, spacesDir),
  });
  const { getAutomergeBytesAtSeq } = await import(
    "../../../../storage/src/store/pit.ts"
  );
  const bytes = getAutomergeBytesAtSeq(db, null, docId, branchId, Number(seq));
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "application/octet-stream" },
  });
};

export const mergeInto: AppRouteHandler<
  typeof import("./new.routes.ts").mergeInto
> = async (c: any) => {
  const { spaceId, docId, from, to } = c.req.param();
  const s = await getSpace(spaceId);
  const mergedHead = await s.mergeBranches(docId, from, to, {
    closeSource: true,
  });
  return c.json({ mergedHead });
};
