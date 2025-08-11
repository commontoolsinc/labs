import { openSqlite } from "../store/db.ts";
import type { Database } from "@db/sqlite";
import type {
  Ack,
  Authorization,
  Complete,
  Deliver,
  StorageGet,
  StorageSubscribe,
  TaskReturn,
  UCAN,
} from "./protocol.ts";

// WS handler for storage v2: supports get and subscribe with Deliver frames and Complete task/return
export async function handleWs(
  req: Request,
  spaceId: string,
): Promise<Response> {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response(
      JSON.stringify({ error: { message: "Upgrade required" } }),
      {
        status: 400,
        headers: { "content-type": "application/json" },
      },
    );
  }

  const { socket, response } = Deno.upgradeWebSocket(req);

  // Open per-space DB
  const envDir = Deno.env.get("SPACES_DIR");
  const base = envDir
    ? new URL(envDir)
    : new URL(`.spaces/`, `file://${Deno.cwd()}/`);
  await Deno.mkdir(base, { recursive: true }).catch(() => {});
  const dbFile = new URL(`./${spaceId}.sqlite`, base);
  const { db } = await openSqlite({ url: dbFile });

  const state = new SessionState(db, spaceId, socket);
  state.start();
  return response;
}

class SessionState {
  private closed = false;
  private lastSentDelivery = new Map<number, number>(); // subscriptionId -> last deliveryNo sent
  private streamId: string;

  constructor(
    private db: Database,
    private spaceId: string,
    private socket: WebSocket,
  ) {
    this.streamId = spaceId;
  }

  start() {
    this.socket.onmessage = (ev) => this.onMessage(ev);
    this.socket.onclose = () => {
      this.closed = true;
    };
    this.socket.onerror = () => {
      this.closed = true;
    };
    this.pump();
  }

  private decodeJSON(data: string | ArrayBufferLike | Blob): any {
    if (typeof data === "string") return JSON.parse(data);
    if (data instanceof Blob) {
      return JSON.parse(new TextDecoder().decode(data as any));
    }
    return JSON.parse(new TextDecoder().decode(data as ArrayBuffer));
  }

  private encodeJSON(v: unknown): string {
    return JSON.stringify(v);
  }

  private jobOf(invocation: any): `job:${string}` {
    // Minimal refer() placeholder: use a hash of the serialized invocation; replace with merkle-reference if desired.
    const bytes = new TextEncoder().encode(JSON.stringify(invocation));
    const digest = Array.from(bytes).reduce(
      (a, b) => ((a * 33) ^ b) >>> 0,
      5381,
    ).toString(16);
    return `job:${digest}` as const;
  }

  private onMessage(ev: MessageEvent) {
    try {
      const msg = this.decodeJSON(ev.data);
      if (msg && msg.type === "ack") {
        const ack = msg as Ack;
        this.handleAck(ack);
        return;
      }

      // Treat other messages as UCAN-wrapped invocations
      const { invocation, authorization } = msg as UCAN<
        StorageGet | StorageSubscribe
      >;
      // TODO(@storage-auth): verify UCAN and capabilities (read) here
      if (invocation.cmd === "/storage/get") {
        this.handleGet(invocation as StorageGet, authorization);
      } else if (invocation.cmd === "/storage/subscribe") {
        this.handleSubscribe(invocation as StorageSubscribe, authorization);
      }
    } catch (e) {
      console.error("ws v2 message error", e);
    }
  }

  private handleAck(ack: Ack) {
    // Persist last acked delivery
    // We only track per-subscription; use highest deliveryNo for all active subs in this stream
    const subs = this.db.prepare(
      `SELECT id FROM subscriptions WHERE space_id = :space`,
    ).all({ space: this.spaceId }) as { id: number }[];
    for (const s of subs) {
      this.db.run(
        `UPDATE subscription_deliveries SET acked = 1 WHERE subscription_id = :sid AND delivery_no <= :dno`,
        { sid: s.id, dno: ack.deliveryNo },
      );
    }
  }

  private handleGet(inv: StorageGet, _auth: Authorization<StorageGet>) {
    const jobId = this.jobOf(inv);
    // Upsert subscription by (space, consumer)
    const consumerId = inv.args.consumerId;
    let row = this.db.prepare(
      `SELECT id FROM subscriptions WHERE space_id = :space AND consumer_id = :consumer LIMIT 1`,
    ).get({ space: this.spaceId, consumer: consumerId }) as
      | { id: number }
      | undefined;
    if (!row) {
      this.db.run(
        `INSERT INTO subscriptions(space_id, query_json, consumer_id) VALUES(:space, :query, :consumer)`,
        {
          space: this.spaceId,
          query: JSON.stringify(inv.args.query ?? {}),
          consumer: consumerId,
        },
      );
      row = this.db.prepare(`SELECT last_insert_rowid() AS id`).get() as {
        id: number;
      };
    } else {
      this.db.run(
        `UPDATE subscriptions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), query_json = :query WHERE id = :id`,
        { id: row.id, query: JSON.stringify(inv.args.query ?? {}) },
      );
    }
    const subscriptionId = row.id;
    this.lastSentDelivery.set(
      subscriptionId,
      this.getLastAcked(subscriptionId),
    );

    // Emit Complete for one-shot get (no ongoing subscription)
    const complete: Complete = {
      type: "complete",
      at: {},
      streamId: this.streamId as any,
      filterId: String(subscriptionId),
    };
    const ret: TaskReturn<StorageGet, Complete> = {
      the: "task/return",
      of: jobId,
      is: complete,
    };
    this.socket.send(this.encodeJSON(ret));

    // One-shot: we do not keep sending deliver frames for this filterId specifically
  }

  private handleSubscribe(
    inv: StorageSubscribe,
    _auth: Authorization<StorageSubscribe>,
  ) {
    const jobId = this.jobOf(inv);
    const consumerId = inv.args.consumerId;
    let row = this.db.prepare(
      `SELECT id FROM subscriptions WHERE space_id = :space AND consumer_id = :consumer LIMIT 1`,
    ).get({ space: this.spaceId, consumer: consumerId }) as
      | { id: number }
      | undefined;
    if (!row) {
      this.db.run(
        `INSERT INTO subscriptions(space_id, query_json, consumer_id) VALUES(:space, :query, :consumer)`,
        {
          space: this.spaceId,
          query: JSON.stringify(inv.args.query ?? {}),
          consumer: consumerId,
        },
      );
      row = this.db.prepare(`SELECT last_insert_rowid() AS id`).get() as {
        id: number;
      };
    } else {
      this.db.run(
        `UPDATE subscriptions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), query_json = :query WHERE id = :id`,
        { id: row.id, query: JSON.stringify(inv.args.query ?? {}) },
      );
    }
    const subscriptionId = row.id;
    this.lastSentDelivery.set(
      subscriptionId,
      this.getLastAcked(subscriptionId),
    );

    // Send Complete to signal initial snapshot done (v1 infra does not stream snapshot rows yet)
    const complete: Complete = {
      type: "complete",
      at: {},
      streamId: this.streamId as any,
      filterId: String(subscriptionId),
    };
    const ret: TaskReturn<StorageSubscribe, Complete> = {
      the: "task/return",
      of: jobId,
      is: complete,
    };
    this.socket.send(this.encodeJSON(ret));
  }

  private getLastAcked(subscriptionId: number): number {
    const lastAck = this.db.prepare(
      `SELECT MAX(delivery_no) AS last FROM subscription_deliveries WHERE subscription_id = :sid AND acked = 1`,
    ).get({ sid: subscriptionId }) as { last: number } | undefined;
    return lastAck?.last ?? 0;
  }

  private async pump() {
    const BATCH_LIMIT = 100;
    const MAX_BUFFERED = 1_000_000;
    while (!this.closed) {
      try {
        const rows = this.db.prepare(
          `SELECT subscription_id, delivery_no, payload FROM subscription_deliveries WHERE delivery_no > (
             SELECT IFNULL(MAX(delivery_no), 0) FROM subscription_deliveries sd2
             WHERE sd2.subscription_id = subscription_id AND sd2.delivery_no <= :last
           ) ORDER BY subscription_id ASC, delivery_no ASC LIMIT :lim`,
        ).all({ last: 0, lim: BATCH_LIMIT }) as {
          subscription_id: number;
          delivery_no: number;
          payload: Uint8Array;
        }[];

        for (const r of rows) {
          if (this.closed) break;
          const last = this.lastSentDelivery.get(r.subscription_id) ?? 0;
          if (r.delivery_no <= last) continue;
          this.lastSentDelivery.set(r.subscription_id, r.delivery_no);
          const payloadStr = new TextDecoder().decode(r.payload);
          const deliver: Deliver = {
            type: "deliver",
            streamId: this.streamId as any,
            filterId: String(r.subscription_id),
            deliveryNo: r.delivery_no,
            payload: JSON.parse(payloadStr),
          };
          const buffered = (this.socket as any).bufferedAmount ?? 0;
          if (buffered > MAX_BUFFERED) {
            await new Promise((res) => setTimeout(res, 50));
          }
          this.socket.send(this.encodeJSON(deliver));
        }
      } catch (e) {
        console.error("ws v2 pump error", e);
        await new Promise((res) => setTimeout(res, 100));
      }

      await new Promise((res) => setTimeout(res, 50));
    }
  }
}
