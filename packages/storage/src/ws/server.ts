import { openSqlite } from "../store/db.ts";
import { getSpacesDir, isWsAuthRequired } from "../config.ts";
import { requireCapsOnRequest } from "./ucan.ts";
import type { Database } from "@db/sqlite";
import type {
  Ack,
  Authorization,
  Complete,
  Deliver,
  StorageGet,
  StorageSubscribe,
  StorageTx,
  StorageTxResult,
  TaskReturn,
  UCAN,
} from "./protocol.ts";

// WebSocket v2 handler for storage: multiplexes get/subscribe/tx over a single connection.
// Deliver frames are decoupled from task/return; initial completion is signaled via Complete.
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

  // Enforce UCAN capability on upgrade for read access to the space (opt-in via env)
  if (isWsAuthRequired()) {
    const authProbe = requireCapsOnRequest(req, [
      { can: "storage/read", with: `space:${spaceId}` },
    ]);
    if (authProbe) return authProbe;
  }

  const { socket, response } = Deno.upgradeWebSocket(req);

  // Open per-space DB
  const base = getSpacesDir();
  await Deno.mkdir(base, { recursive: true }).catch(() => {});
  const dbFile = new URL(`./${spaceId}.sqlite`, base);
  const handle = await openSqlite({ url: dbFile });
  const db = handle.db;

  const state = new SessionState(db, spaceId, socket);
  state.start(() => handle.close().catch(() => {}));
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

  private flushDeliveriesFor(subscriptionId: number, limit = 1000): void {
    try {
      const last = this.lastSentDelivery.get(subscriptionId) ?? 0;
      const rows = this.db.prepare(
        `SELECT delivery_no, payload FROM subscription_deliveries
         WHERE subscription_id = :sid AND delivery_no > :last
         ORDER BY delivery_no ASC LIMIT :lim`,
      ).all({ sid: subscriptionId, last, lim: limit }) as {
        delivery_no: number;
        payload: Uint8Array;
      }[];
      for (const r of rows) {
        if (this.closed) break;
        this.lastSentDelivery.set(subscriptionId, r.delivery_no);
        const payloadStr = new TextDecoder().decode(r.payload);
        const deliver: Deliver = {
          type: "deliver",
          streamId: this.streamId as any,
          filterId: String(subscriptionId),
          deliveryNo: r.delivery_no,
          payload: JSON.parse(payloadStr),
        };
        this.socket.send(this.encodeJSON(deliver));
      }
    } catch (e) {
      console.error("ws v2 immediate flush error", e);
    }
  }
  start(onClose?: () => void) {
    this.socket.onmessage = (ev) => this.onMessage(ev);
    this.socket.onclose = () => {
      this.closed = true;
      onClose?.();
    };
    this.socket.onerror = () => {
      this.closed = true;
      onClose?.();
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

  private getMaxDelivery(subscriptionId: number): number {
    const row = this.db.prepare(
      `SELECT MAX(delivery_no) AS mx FROM subscription_deliveries WHERE subscription_id = :sid`,
    ).get({ sid: subscriptionId }) as { mx: number } | undefined;
    return row?.mx ?? 0;
  }

  private logDeliveryState(where: string, subscriptionId: number) {
    try {
      const lastAck = this.getLastAcked(subscriptionId);
      const maxNo = this.getMaxDelivery(subscriptionId);
      console.log(
        `[ws-v2] ${where} sid=${subscriptionId} lastAck=${lastAck} maxDelivery=${maxNo} lastSent=${
          this.lastSentDelivery.get(subscriptionId) ?? 0
        }`,
      );
    } catch {
      // ignore logging errors
    }
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

  private async onMessage(ev: MessageEvent) {
    try {
      const msg = this.decodeJSON(ev.data);
      if (msg && msg.type === "ack") {
        const ack = msg as Ack;
        this.handleAck(ack);
        return;
      }

      // Treat other messages as UCAN-wrapped invocations
      const { invocation, authorization } = msg as UCAN<
        StorageGet | StorageSubscribe | StorageTx
      >;
      // TODO(@storage-auth): verify UCAN and capabilities (read/write) here
      if (invocation.cmd === "/storage/get") {
        this.handleGet(invocation as StorageGet, authorization);
      } else if (invocation.cmd === "/storage/subscribe") {
        this.handleSubscribe(invocation as StorageSubscribe, authorization);
      } else if (invocation.cmd === "/storage/tx") {
        await this.handleTx(invocation as StorageTx, authorization);
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
    this.logDeliveryState("after-subscribe:set", subscriptionId);

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

  private async handleSubscribe(
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
    this.logDeliveryState("after-subscribe:set", subscriptionId);

    // Post-subscribe ack so client can safely send txs after durable upsert
    this.socket.send(this.encodeJSON({ type: "subscribed", subscriptionId }));
    // Immediately flush any pending deliveries for this subscription id
    void this.flushDeliveriesFor(subscriptionId);

    // Small micro-delay to ensure DB visibility and pump wake before sending complete
    await new Promise((res) => setTimeout(res, 25));

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

  private async handleTx(
    inv: StorageTx,
    _auth: Authorization<StorageTx>,
  ) {
    const jobId = this.jobOf(inv);
    // TODO(@storage-auth): verify per-tx signature and delegation chain; enforce storage/write for space
    const { openSpaceStorage } = await import("../provider.ts");
    const spacesDir = new URL(
      Deno.env.get("SPACES_DIR") ?? `file://./.spaces/`,
    );
    const s = await openSpaceStorage(this.spaceId, { spacesDir });

    // Normalize WS tx args: decode base64 or numeric arrays to Uint8Array
    const decodeB64 = (s: string): Uint8Array => {
      const bin = atob(s);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    };
    const toBytes = (v: unknown): Uint8Array => {
      if (v instanceof Uint8Array) return v;
      if (typeof v === "string") return decodeB64(v);
      if (Array.isArray(v)) return new Uint8Array(v as number[]);
      // last resort: try to coerce objects with numeric indices
      try {
        const arr = Array.from(v as any);
        return new Uint8Array(arr as number[]);
      } catch {
        return new Uint8Array();
      }
    };
    const req = inv.args as any;
    const normalized = {
      clientTxId: req.clientTxId,
      reads: (req.reads ?? []).map((r: any) => ({
        ref: r.ref,
        heads: r.heads,
      })),
      writes: (req.writes ?? []).map((w: any) => ({
        ref: w.ref,
        baseHeads: w.baseHeads ?? [],
        changes: (w.changes ?? []).map((c: any) => ({
          bytes: toBytes(c.bytes),
        })),
        allowServerMerge: w.allowServerMerge,
      })),
    };

    const receipt = await s.submitTx(normalized as any);
    // Nudge pump to deliver any newly enqueued rows immediately and log state
    for (const sid of this.lastSentDelivery.keys()) {
      this.logDeliveryState("after-tx:before-flush", sid);
      void this.flushDeliveriesFor(sid);
      this.logDeliveryState("after-tx:after-flush", sid);
    }
    const ret: TaskReturn<StorageTx, StorageTxResult> = {
      the: "task/return",
      of: jobId,
      is: receipt,
    };
    this.socket.send(this.encodeJSON(ret));
  }

  private async pump() {
    const BATCH_LIMIT = 100;
    const MAX_BUFFERED = 1_000_000;
    while (!this.closed) {
      try {
        // For each active subscription, fetch next batch after last sent
        for (const [sid, last] of this.lastSentDelivery.entries()) {
          const rows = this.db.prepare(
            `SELECT delivery_no, payload FROM subscription_deliveries
             WHERE subscription_id = :sid AND delivery_no > :last
             ORDER BY delivery_no ASC LIMIT :lim`,
          ).all({ sid, last, lim: BATCH_LIMIT }) as {
            delivery_no: number;
            payload: Uint8Array;
          }[];

          for (const r of rows) {
            if (this.closed) break;
            this.lastSentDelivery.set(sid, r.delivery_no);
            const payloadStr = new TextDecoder().decode(r.payload);
            const deliver: Deliver = {
              type: "deliver",
              streamId: this.streamId as any,
              filterId: String(sid),
              deliveryNo: r.delivery_no,
              payload: JSON.parse(payloadStr),
            };
            const buffered = (this.socket as any).bufferedAmount ?? 0;
            if (buffered > MAX_BUFFERED) {
              await new Promise((res) => setTimeout(res, 50));
            }
            this.socket.send(this.encodeJSON(deliver));
          }
        }
      } catch (e) {
        console.error("ws v2 pump error", e);
        await new Promise((res) => setTimeout(res, 100));
      }

      await new Promise((res) => setTimeout(res, 50));
    }
  }
}
